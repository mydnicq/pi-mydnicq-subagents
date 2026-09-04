/**
 * Child-process runner for subagent delegation.
 *
 * Each delegation spawns a fresh `pi` child process in JSON print mode:
 *
 *   pi --mode json -p --session <run-history-session-file> --model <model> \
 *      --thinking <level> --tools <allowlist> [--append-system-prompt <file>] "<prompt>"
 *
 * The child persists its session to a private run-history temp file so the
 * transcript can be exported to HTML and followed in a browser while the run
 * is in flight (see run-history.ts). Its stdout is a stream of JSON events
 * that we parse for assistant messages, usage, and the final output.
 *
 * Nested delegation is disabled by construction: children run with
 * PI_MYDNICQ_SUBAGENT_CHILD=1 and the extension refuses to register the
 * subagent tool in child processes.
 *
 * The child's tool set is the agent's frontmatter `tools` allowlist (builtin pi
 * tool names only, required — no defaults), passed as pi's --tools flag.
 *
 * Fork context (`context: fork` in the agent frontmatter) is implemented as a
 * serialized transcript of the parent conversation, prepended to the child's
 * prompt. The child still runs in a fresh ephemeral session — no parent
 * session files are touched.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	AgentToolUpdateCallback,
	BranchSummaryEntry,
	CompactionEntry,
	SessionEntry,
	SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "./loader.ts";
import { getPiInvocation } from "./pi-invocation.ts";
import {
	RunHistoryExporter,
	createRunHistoryPaths,
	historyToolInfos,
	type RunHistoryStatus,
} from "./run-history.ts";

/** Env var set on child pi processes; the extension skips tool registration when it is present. */
export const CHILD_ENV = "PI_MYDNICQ_SUBAGENT_CHILD";

/** Tail size cap for serialized fork transcripts, in chars. */
export const MAX_TRANSCRIPT_CHARS = 48_000;

/** How much of a tool result to include per transcript line. */
const MAX_TOOL_RESULT_CHARS = 600;

/** How much of a tool call's arguments to include per transcript line. */
const MAX_TOOL_ARGS_CHARS = 200;

/** Usage accumulated across a subagent run. */
export interface SubagentUsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
	/** Context tokens as of the latest assistant message. */
	contextTokens: number;
}

/** Full outcome of a subagent run. Used as the tool result `details` payload. */
export interface SubagentRunDetails {
	agent: string;
	task: string;
	/** Effective context mode: "fork" only when a non-empty transcript was provided. */
	context: "fresh" | "fork";
	/** Model string passed to the child, e.g. "anthropic/claude-sonnet-4-5". */
	model: string;
	/** Child process exit code. */
	exitCode: number;
	/** Final assistant stopReason, when known ("stop", "error", "aborted", ...). */
	stopReason?: string;
	/** Error message reported by the child, when any. */
	errorMessage?: string;
	/** Child stderr output. */
	stderr: string;
	/** Final assistant text (the subagent's answer). */
	output: string;
	/** One-line description of the most recent child activity, for progress display. */
	lastActivity?: string;
	/** Present when the run was stopped from the run card's ■ stop link. */
	stop?: { by: "user"; reason?: string };
	/** Run history export state; present once the child session file exists. */
	history?: RunHistoryStatus;
	usage: SubagentUsageStats;
}

export interface SubagentRunOptions {
	agent: AgentDefinition;
	task: string;
	/** Working directory for the child process. */
	cwd: string;
	/** Parent session uuid; groups the run's history under its session id. */
	sessionUuid: string;
	/** Serialized parent transcript for fork-context agents; omit for fresh. */
	forkTranscript?: string;
	signal?: AbortSignal | undefined;
	onUpdate?: AgentToolUpdateCallback<SubagentRunDetails> | undefined;
}

interface ChildEvent {
	type?: unknown;
	message?: unknown;
}

interface ContentBlock {
	type?: unknown;
	text?: unknown;
	name?: unknown;
	arguments?: unknown;
	isError?: unknown;
	toolName?: unknown;
}

/** True when a run should be surfaced as a failure to the caller. */
export function isFailedRun(run: SubagentRunDetails): boolean {
	return run.exitCode !== 0 || run.stopReason === "error" || run.stopReason === "aborted";
}

/** Human-readable usage summary, e.g. "3 turns ↑1.2k ↓800 $0.0123". */
export function formatUsage(run: SubagentRunDetails): string {
	const parts: string[] = [];
	if (run.usage.turns > 0) parts.push(`${run.usage.turns} turn${run.usage.turns === 1 ? "" : "s"}`);
	if (run.usage.input > 0) parts.push(`↑${formatTokens(run.usage.input)}`);
	if (run.usage.output > 0) parts.push(`↓${formatTokens(run.usage.output)}`);
	if (run.usage.cacheRead > 0) parts.push(`R${formatTokens(run.usage.cacheRead)}`);
	if (run.usage.cost > 0) parts.push(`$${run.usage.cost.toFixed(4)}`);
	return parts.join(" ");
}

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

/** An in-flight subagent run that can be stopped from the extension UI. */
export interface StoppableSubagentRun {
	/** Run directory under the shared root — stable, unique id. */
	id: string;
	agent: string;
	/** The delegated task text (for picker labels). */
	task: string;
	/** Kill the child process; the run is marked user-stopped. */
	stop(): void;
}

/** Encoded reason reported to the main agent when a run is stopped without a user-provided one. */
export const DEFAULT_STOP_REASON = "user requested stop";

/** Registry of runs currently in flight in this process, keyed by run dir. */
const activeSubagentRuns = new Map<string, StoppableSubagentRun>();

/** Snapshot of the subagent runs currently in flight in this process. */
export function listActiveSubagentRuns(): StoppableSubagentRun[] {
	return [...activeSubagentRuns.values()];
}

/** Write the agent's system prompt to a 0600 temp file for --append-system-prompt. */
async function writeSystemPromptFile(agentName: string, systemPrompt: string): Promise<{ dir: string; file: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-mydnicq-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const file = path.join(dir, `system-prompt-${safeName}.md`);
	await fs.promises.writeFile(file, systemPrompt, { encoding: "utf8", mode: 0o600 });
	return { dir, file };
}

function cleanupPromptFile(tmp: { dir: string; file: string } | null): void {
	if (!tmp) return;
	try {
		fs.unlinkSync(tmp.file);
	} catch {
		/* ignore */
	}
	try {
		fs.rmdirSync(tmp.dir);
	} catch {
		/* ignore */
	}
}

/** Extract plain text from a message content value (string or block array). */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content as ContentBlock[]) {
		if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts.join("\n");
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}…`;
}

function singleLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Parse one JSON-mode stdout line; returns the event or null when not parseable. */
function parseChildEvent(line: string): ChildEvent | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		const event = JSON.parse(trimmed) as unknown;
		if (event && typeof event === "object") return event as ChildEvent;
	} catch {
		/* non-JSON line — ignore */
	}
	return null;
}

/**
 * Run a subagent as a child pi process and return its outcome.
 *
 * Throws when the run is aborted via `signal` (Esc). A stop via the keyboard
 * shortcut (alt+s → stopActiveSubagentRuns) is not a throw: the child is
 * killed and the run is returned with `stop` set and the default reason, so
 * the caller can report it to the main agent. All other failures (non-zero
 * exit, child-reported error) are returned as a failed run — callers decide
 * how to surface them.
 */
export async function runSubagent(options: SubagentRunOptions): Promise<SubagentRunDetails> {
	const { agent, task, cwd, signal, onUpdate } = options;
	const forkTranscript = options.forkTranscript?.trim() ? options.forkTranscript : undefined;

	const run: SubagentRunDetails = {
		agent: agent.name,
		task,
		context: forkTranscript ? "fork" : "fresh",
		model: agent.model,
		exitCode: 0,
		stderr: "",
		output: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, contextTokens: 0 },
	};

	// Persist the child session under the shared run history root, grouped by
	// the parent session uuid, so the transcript can be served by path and
	// followed in a browser while the run is in flight (run-history.ts).
	const historyPaths = createRunHistoryPaths(options.sessionUuid, agent.name);
	const history = await RunHistoryExporter.create(
		historyPaths,
		agent.systemPrompt,
		historyToolInfos(cwd, agent.tools),
	);

	// Run card stop support: in-flight runs register themselves so the alt+s
	// keyboard shortcut can stop them in-process (no browser, encoded default
	// reason). The tool's own signal (Esc) still aborts via `signal`.
	let stoppedByUser = false;
	let settled = false;
	let requestKill: (() => void) | null = null;
	const stop = (): void => {
		if (settled) return;
		stoppedByUser = true;
		requestKill?.();
	};
	const activeEntry: StoppableSubagentRun = { id: historyPaths.dir, agent: agent.name, task, stop };
	activeSubagentRuns.set(activeEntry.id, activeEntry);

	const args: string[] = [
		"--mode",
		"json",
		"-p",
		"--session",
		historyPaths.sessionFile,
		"--model",
		agent.model,
		"--thinking",
		agent.thinking,
		"--tools",
		agent.tools.join(","),
	];

	let tmp: { dir: string; file: string } | null = null;
	try {
		if (agent.systemPrompt.trim()) {
			tmp = await writeSystemPromptFile(agent.name, agent.systemPrompt);
			args.push("--append-system-prompt", tmp.file);
		}

		args.push(forkTranscript ? `${forkTranscript}\n\n---\n\n# Task\n\n${task}` : task);

		const emitUpdate = () => {
			run.history = history.getStatus();
			onUpdate?.({
				content: [{ type: "text", text: progressText(run) }],
				details: run,
			});
		};

		// Export right away and emit the first update immediately, so the run
		// card (and its ■ stop link) exists from spawn — not only after the
		// child's first message_end event, which for 1-turn agents is also its
		// last (the link would never appear).
		history.scheduleExport();
		emitUpdate();

		const invocation = getPiInvocation(args);
		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn(invocation.command, invocation.args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, [CHILD_ENV]: "1" },
			});

			let stdoutBuffer = "";
			let aborted = false;

			const killProc = () => {
				aborted = true;
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			};
			// The stop watcher lives outside this scope; expose the kill path to it.
			requestKill = killProc;
			if (signal) {
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}

			const handleEvent = (event: ChildEvent) => {
				if (event.type !== "message_end" || !event.message) return;
				const message = event.message as { role?: unknown; content?: unknown; stopReason?: unknown; errorMessage?: unknown; usage?: Record<string, unknown>; model?: unknown };
				if (message.role !== "assistant") return;

				// Throttled re-export of the growing transcript for the run history page.
				history.scheduleExport();

				run.usage.turns += 1;
				const usage = message.usage;
				if (usage) {
					run.usage.input += typeof usage.input === "number" ? usage.input : 0;
					run.usage.output += typeof usage.output === "number" ? usage.output : 0;
					run.usage.cacheRead += typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
					run.usage.cacheWrite += typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;
					const cost = usage.cost;
					if (cost && typeof cost === "object" && typeof (cost as { total?: unknown }).total === "number") {
						run.usage.cost += (cost as { total: number }).total;
					}
					run.usage.contextTokens = typeof usage.totalTokens === "number" ? usage.totalTokens : run.usage.contextTokens;
				}
				if (typeof message.stopReason === "string") run.stopReason = message.stopReason;
				if (typeof message.errorMessage === "string" && message.errorMessage) run.errorMessage = message.errorMessage;
				if (typeof message.model === "string" && message.model) run.model = message.model;

				// Track the final output and a short "current activity" line.
				const blocks = Array.isArray(message.content) ? (message.content as ContentBlock[]) : [];
				for (const block of blocks) {
					if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
						run.output = block.text;
						run.lastActivity = truncate(singleLine(block.text), 80);
					} else if (block?.type === "toolCall" && typeof block.name === "string") {
						const argsPreview = truncate(singleLine(JSON.stringify(block.arguments ?? {})), MAX_TOOL_ARGS_CHARS);
						run.lastActivity = `${block.name}(${argsPreview})`;
					}
				}
				emitUpdate();
			};

			proc.stdout.on("data", (data: string) => {
				stdoutBuffer += data;
				const lines = stdoutBuffer.split("\n");
				stdoutBuffer = lines.pop() ?? "";
				for (const line of lines) {
					const event = parseChildEvent(line);
					if (event) handleEvent(event);
				}
			});

			proc.stderr.on("data", (data: string) => {
				run.stderr += data;
				if (run.stderr.length > 64 * 1024) run.stderr = run.stderr.slice(-64 * 1024);
			});

			proc.on("close", (code) => {
				settled = true;
				if (stdoutBuffer.trim()) {
					const event = parseChildEvent(stdoutBuffer);
					if (event) handleEvent(event);
				}
				resolve(code ?? (aborted ? 1 : 0));
			});

			proc.on("error", (err) => {
				run.stderr += `\n${err.message}`;
				resolve(1);
			});
		});

		run.exitCode = exitCode;
		// Final export regardless of the throttle window, including aborted runs.
		run.history = await history.flushExport();
		if (stoppedByUser) {
			run.stop = { by: "user", reason: DEFAULT_STOP_REASON };
			run.stopReason = run.stopReason ?? "aborted";
		} else if (signal?.aborted) throw new Error("Subagent was aborted");
		return run;
	} finally {
		activeSubagentRuns.delete(activeEntry.id);
		cleanupPromptFile(tmp);
	}
}

function progressText(run: SubagentRunDetails): string {
	const parts = [`Subagent "${run.agent}" running (${run.context})`];
	if (run.usage.turns > 0) parts.push(`turn ${run.usage.turns}`);
	if (run.lastActivity) parts.push(run.lastActivity);
	return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Fork context serialization
// ---------------------------------------------------------------------------

/**
 * Serialize parent-session entries into a readable transcript for fork-context
 * agents. Thinking blocks are dropped, tool calls are summarized as one line
 * each, and the result is tail-truncated to `maxChars` chars.
 *
 * Returns an empty string when there is nothing to include.
 */
export function serializeForkContext(entries: readonly SessionEntry[], maxChars = MAX_TRANSCRIPT_CHARS): string {
	const chunks: string[] = [];

	for (const entry of entries) {
		if (entry.type === "message") {
			const message = (entry as SessionMessageEntry).message;
			switch (message.role) {
				case "user":
					pushMessage(chunks, "User", message.content);
					break;
				case "assistant":
					pushAssistant(chunks, message.content);
					break;
				case "toolResult":
					chunks.push(
						`[tool result${message.isError ? " (error)" : ""}] ${truncate(singleLine(textOf(message.content)), MAX_TOOL_RESULT_CHARS)}`,
					);
					break;
				default:
					break; // bashExecution, custom, etc. — not part of the model-facing transcript
			}
		} else if (entry.type === "compaction") {
			const summary = (entry as CompactionEntry).summary;
			if (summary?.trim()) chunks.push(`[context summary] ${singleLine(summary)}`);
		} else if (entry.type === "branch_summary") {
			const summary = (entry as BranchSummaryEntry).summary;
			if (summary?.trim()) chunks.push(`[branch summary] ${singleLine(summary)}`);
		}
	}

	const text = chunks.join("\n\n").trim();
	if (!text) return "";
	if (text.length <= maxChars) return text;
	const omitted = text.length - maxChars;
	return `[... ${omitted} chars of earlier conversation omitted ...]\n\n${text.slice(-maxChars)}`;
}

function pushMessage(chunks: string[], label: string, content: unknown): void {
	let text = textOf(content);
	if (Array.isArray(content)) {
		const images = (content as ContentBlock[]).filter((b) => b?.type === "image").length;
		if (images > 0) text += `${text ? "\n" : ""}[${images} image${images === 1 ? "" : "s"} omitted]`;
	}
	if (!text.trim()) return;
	chunks.push(`${label}:\n${text.trim()}`);
}

function pushAssistant(chunks: string[], content: unknown): void {
	if (!Array.isArray(content)) return;
	const lines: string[] = [];
	for (const block of content as ContentBlock[]) {
		if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
			lines.push(block.text.trim());
		} else if (block?.type === "toolCall" && typeof block.name === "string") {
			const argsPreview = truncate(singleLine(JSON.stringify(block.arguments ?? {})), MAX_TOOL_ARGS_CHARS);
			lines.push(`[tool call] ${block.name}(${argsPreview})`);
		}
		// thinking blocks are dropped
	}
	if (lines.length === 0) return;
	chunks.push(`Assistant:\n${lines.join("\n")}`);
}