/**
 * Child-process runner for subagent delegation.
 *
 * Each delegation spawns a `pi` child process in RPC mode:
 *
 *   pi --mode rpc --session <run-history-session-file> --model <model> \
 *      --thinking <level> --tools <allowlist> [--no-context-files]
 *      [--extension <child-prompt-probe>] [--append-system-prompt <file>]
 *
 * The parent sends commands on the child's stdin (`prompt`, `steer`,
 * `clear_queue`, `abort`) and reads session events and command responses on
 * stdout. This gives the main agent live control over a run.
 *
 * The child persists its session to a private run-history temp file so the
 * transcript can be exported to HTML and followed in a browser while the run
 * is in flight (see run-history.ts).
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

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	AgentToolUpdateCallback,
	BranchSummaryEntry,
	CompactionEntry,
	SessionEntry,
	SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "./loader.ts";
import { composeHistorySystemPrompt } from "./loader.ts";
import { getPiInvocation } from "./pi-invocation.ts";
import { CAPTURE_SYSTEM_PROMPT_ENV, EXPECTED_TOOLS_ENV } from "./child-prompt-probe.ts";
import { ARTIFACTS_ROOT, CHILD_PROMPT_PROBE_PATH, SYSTEM_PROMPT_CAPTURE_FILE_NAME } from "./constants.ts";
import {
	RunHistoryExporter,
	createRunHistoryPaths,
	historyToolInfos,
	runHistoryPathsFor,
	type RunHistoryPaths,
	type RunHistoryStatus,
} from "./run-history.ts";
import {
	type RunAgentContract,
	type RunOutcome,
	type RunRecord,
	type RunStatus,
	updateRunRecord,
	writeRunRecord,
} from "./run-store.ts";

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
	/** Stable run id (run directory basename); absent for pre-run validation failures. */
	runId?: string;
	/** 1 for the original delegation, 2+ for resume attempts. */
	attempt?: number;
	agent: string;
	task: string;
	/** Effective context mode for a fresh run; omitted on resume (context is the existing session). */
	context?: "fresh" | "fork";
	/** Model string passed to the child, e.g. "anthropic/claude-sonnet-4-5". Overwritten
	 *  with the child-reported bare model id once the first assistant message arrives. */
	model: string;
	/** Provider of the model actually used; from the configured reference, then the child. */
	provider?: string;
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
	/** Present when the run was stopped by the main agent. */
	stop?: { by: "user" | "agent"; reason?: string };
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

/** Split a "provider/model-id" reference into its provider prefix and bare model id. */
export function splitModelRef(ref: string): { provider?: string; modelId: string } {
	const slash = ref.indexOf("/");
	if (slash === -1) return { modelId: ref };
	return { provider: ref.slice(0, slash) || undefined, modelId: ref.slice(slash + 1) };
}

/** Canonical "provider/model" display reference for a run's model. */
export function subagentModelRef(run: SubagentRunDetails): string {
	if (run.provider && run.model && !run.model.includes("/")) return `${run.provider}/${run.model}`;
	return run.model;
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

/** Compact token count, e.g. "800", "1.2k", "1.5M". */
export function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

/** How long a stopped child stays idle for a live resume, in milliseconds. */
const STOP_IDLE_TIMEOUT_MS = 10 * 60_000;

/** How long to wait for an abort to settle before a force kill, in milliseconds. */
const ABORT_TIMEOUT_MS = 10_000;

/** How long to wait for a child to exit after stdin closes, in milliseconds. */
const CLOSE_TIMEOUT_MS = 5_000;

/** Reason recorded when the main agent stops a run. */
export const DEFAULT_STOP_REASON = "stop requested by main agent";

/** Lifecycle state of a live child run. */
export type SubagentRunControlState = "running" | "stopped" | "closed";

/** A live child run the extension can control. */
export interface SubagentRunControl {
	/** Run directory under the shared root — stable, unique id. */
	id: string;
	agent: string;
	/** The current task text. */
	task: string;
	state: SubagentRunControlState;
	/** Queue guidance for the current turn; the child delivers it at the next tool boundary. */
	steer(message: string): Promise<void>;
	/** Cancel the current work and deliver a new task in the same child. */
	interrupt(message: string): Promise<void>;
	/** Cancel the current work and keep the child idle for a live resume or the idle timeout. */
	stop(): Promise<void>;
}

/** A stopped child that a live resume can wake. */
export interface StoppedLiveChild {
	id: string;
	details: SubagentRunDetails;
	done: Promise<SubagentRunDetails>;
	/** Send a new task to the live child. */
	resume(task: string, attempt: number): Promise<void>;
}

interface LiveChildEntry {
	control: SubagentRunControl;
	details: SubagentRunDetails;
	done: Promise<SubagentRunDetails>;
	resume(task: string, attempt: number): Promise<void>;
	close(): void;
}

/** Live children in this process, keyed by run dir. */
const liveChildren = new Map<string, LiveChildEntry>();

/** Snapshot of the subagent runs at work in this process. */
export function listActiveSubagentRuns(): SubagentRunControl[] {
	return [...liveChildren.values()]
		.map((entry) => entry.control)
		.filter((control) => control.state === "running");
}

/** Find a stopped child that a live resume can wake. */
export function findStoppedLiveChild(runDir: string): StoppedLiveChild | undefined {
	const entry = liveChildren.get(runDir);
	if (!entry || entry.control.state !== "stopped") return undefined;
	return {
		id: runDir,
		details: entry.details,
		done: entry.done,
		resume: (task, attempt) => entry.resume(task, attempt),
	};
}

/** Stopped children that a live resume can wake, in this process. */
export function listStoppedLiveChildren(): StoppedLiveChild[] {
	return [...liveChildren.values()]
		.filter((entry) => entry.control.state === "stopped")
		.map((entry) => ({
			id: entry.control.id,
			details: entry.details,
			done: entry.done,
			resume: (task, attempt) => entry.resume(task, attempt),
		}));
}

/** Close every live child. Called when the session shuts down. */
export function closeAllLiveChildren(): void {
	for (const entry of liveChildren.values()) entry.close();
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Write the agent's system prompt to a 0600 temp file under the artifacts root for --append-system-prompt. */
async function writeSystemPromptFile(agentName: string, systemPrompt: string): Promise<{ dir: string; file: string }> {
	const tmpRoot = path.join(ARTIFACTS_ROOT, "tmp");
	await fs.promises.mkdir(tmpRoot, { recursive: true });
	const dir = await fs.promises.mkdtemp(path.join(tmpRoot, "prompt-"));
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

/** Launch snapshot for a run: the agent config a resume replays exactly. */
function agentContractOf(agent: AgentDefinition): RunAgentContract {
	return {
		model: agent.model,
		thinking: agent.thinking,
		tools: [...agent.tools],
		projectContext: agent.projectContext,
		systemPrompt: agent.systemPrompt,
	};
}

/** Initial run record for a fresh delegation. */
function newRunRecord(agent: AgentDefinition, cwd: string, task: string): RunRecord {
	return {
		version: 1,
		agent: agent.name,
		cwd,
		status: "running",
		updatedAt: new Date().toISOString(),
		childPid: null,
		agentContract: agentContractOf(agent),
		tasks: [task],
	};
}

/** Persisted outcome of a settled run; the safety net behind the completion message. */
function outcomeOf(run: SubagentRunDetails): RunOutcome {
	return {
		exitCode: run.exitCode,
		output: run.output,
		stderr: run.stderr,
		...(run.stopReason ? { stopReason: run.stopReason } : {}),
		...(run.errorMessage ? { errorMessage: run.errorMessage } : {}),
		...(run.stop ? { stop: run.stop } : {}),
		usage: { ...run.usage },
		finishedAt: new Date().toISOString(),
	};
}

/** Persist the settled outcome of a run. */
function finalizeRunRecord(dir: string, run: SubagentRunDetails): void {
	const status: RunStatus = run.stop ? "stopped" : isFailedRun(run) ? "failed" : "complete";
	updateRunRecord(dir, { status, childPid: null, result: outcomeOf(run), updatedAt: new Date().toISOString() });
}

/** Best-effort "failed" record update for runs that ended without a result (e.g. abort). */
function failRunRecord(dir: string): void {
	try {
		updateRunRecord(dir, { status: "failed", childPid: null, updatedAt: new Date().toISOString() });
	} catch {
		/* best effort */
	}
}

/** Best-effort child-pid persistence; a failed write must never affect the run. */
function persistChildPid(dir: string, pid: number | null): void {
	try {
		updateRunRecord(dir, { childPid: pid });
	} catch {
		/* best effort */
	}
}

/** Everything one child invocation needs; shared by fresh runs and resumes. */
interface ChildRunSpec {
	/** Pre-initialized outcome (agent, task, model, context/attempt identity). */
	run: SubagentRunDetails;
	/** Run directory layout: session file, HTML export, URL path. */
	historyPaths: RunHistoryPaths;
	/** Launch snapshot used for the child process and the history fallback prompt. */
	config: RunAgentContract;
	/** Fallback system prompt for the history page until the probe capture lands. */
	fallbackSystemPrompt: string;
	/** Initial prompt passed to the child (fork transcript + task, or a resume follow-up). */
	initialPrompt: string;
	cwd: string;
	signal?: AbortSignal | undefined;
	onUpdate?: AgentToolUpdateCallback<SubagentRunDetails> | undefined;
	/** Called with the child pid right after spawn, so the run record can track it. */
	onSpawn?: ((pid: number | null) => void) | undefined;
}

/** One child run handle: its control surface and its final outcome promise. */
interface ChildRunHandle {
	control: SubagentRunControl;
	details: SubagentRunDetails;
	done: Promise<SubagentRunDetails>;
}

interface RpcResponse {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	error?: string;
	data?: unknown;
}

/** Minimal RPC client for one child: JSONL commands on stdin, records on stdout. */
class RpcChannel {
	private readonly pending = new Map<
		string,
		{ resolve: (response: RpcResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
	>();
	private nextId = 0;
	private closed = false;
	private readonly stdin: NodeJS.WritableStream;

	constructor(stdin: NodeJS.WritableStream) {
		this.stdin = stdin;
	}

	/** Route one stdout record: responses to waiters, UI dialogs to a cancel reply, the rest to the event handler. */
	handleLine(line: string, onEvent: (event: ChildEvent) => void): void {
		const event = parseChildEvent(line);
		if (!event) return;
		const record = event as Record<string, unknown>;
		if (record.type === "response") {
			const id = record.id;
			if (typeof id === "string") {
				const pending = this.pending.get(id);
				if (pending) {
					this.pending.delete(id);
					clearTimeout(pending.timer);
					pending.resolve(record as unknown as RpcResponse);
					return;
				}
			}
			return; // A response with no waiter: a command result we do not track.
		}
		// Child extensions can ask for input. No human is present, so cancel dialogs.
		if (record.type === "extension_ui_request" && typeof record.id === "string") {
			const method = record.method;
			if (method === "select" || method === "confirm" || method === "input" || method === "editor") {
				this.write({ type: "extension_ui_response", id: record.id, cancelled: true });
			}
			return;
		}
		onEvent(event);
	}

	/** Send one command and wait for its response. */
	async request(command: Record<string, unknown>, timeoutMs = 30_000): Promise<RpcResponse> {
		if (this.closed) throw new Error("Child process is closed");
		const id = `req-${++this.nextId}`;
		const response = new Promise<RpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`RPC ${String(command.type)} timed out`));
			}, timeoutMs);
			timer.unref?.();
			this.pending.set(id, { resolve, reject, timer });
		});
		this.write({ id, ...command });
		return response;
	}

	/** Reject every waiter and refuse new commands. */
	close(reason: Error): void {
		if (this.closed) return;
		this.closed = true;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(reason);
		}
		this.pending.clear();
	}

	private write(record: unknown): void {
		try {
			this.stdin.write(`${JSON.stringify(record)}\n`);
		} catch {
			/* The close handler rejects pending requests. */
		}
	}
}

/** Create one live child run. Returns at once; the child starts asynchronously. */
function createChildRun(spec: ChildRunSpec): ChildRunHandle {
	const { run, historyPaths, config, cwd } = spec;
	const ready = deferred<void>();
	void ready.promise.catch(() => undefined); // Spawn failures reach the control callers too.
	const doneDeferred = deferred<SubagentRunDetails>();
	const closed = deferred<void>();
	let history: RunHistoryExporter | undefined;
	let rpc: RpcChannel | undefined;
	let proc: ChildProcess | undefined;
	let state: SubagentRunControlState = "running";
	const isClosed = (): boolean => state === "closed";
	let stopRequested = false;
	let interruptPending = false;
	let closing = false;
	let completed = false;
	let idleTimer: NodeJS.Timeout | undefined;
	let abortBySignal = false;
	let stdoutBuffer = "";
	let tmp: { dir: string; file: string } | null = null;

	const emitUpdate = (): void => {
		if (!history) return;
		run.history = history.getStatus();
		spec.onUpdate?.({
			content: [{ type: "text", text: progressText(run) }],
			details: run,
		});
	};

	const clearIdleTimer = (): void => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = undefined;
	};

	const complete = (): void => {
		if (completed) return;
		completed = true;
		state = "closed";
		clearIdleTimer();
		void (async () => {
			try {
				closing = true;
				rpc?.close(new Error("Child process closed"));
				if (history) run.history = await history.flushExport();
				if (abortBySignal && !run.stop) throw new Error("Subagent was aborted");
				finalizeRunRecord(historyPaths.dir, run);
				doneDeferred.resolve(run);
			} catch (error) {
				if (run.stop) finalizeRunRecord(historyPaths.dir, run);
				else failRunRecord(historyPaths.dir);
				doneDeferred.reject(error);
			} finally {
				liveChildren.delete(historyPaths.dir);
				cleanupPromptFile(tmp);
			}
		})();
	};

	const closeChild = async (): Promise<void> => {
		if (completed) return;
		clearIdleTimer();
		if (!proc) return;
		try {
			proc.stdin?.end();
		} catch {
			/* The close handler completes the run. */
		}
		const timeout = new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
			timer.unref?.();
		});
		await Promise.race([closed.promise, timeout]);
		if (!completed) {
			if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
			await closed.promise;
		}
	};

	const handleAssistantMessage = (message: {
		role?: unknown;
		content?: unknown;
		stopReason?: unknown;
		errorMessage?: unknown;
		usage?: Record<string, unknown>;
		model?: unknown;
		provider?: unknown;
	}): void => {
		// Throttled re-export of the growing transcript for the run history page.
		history?.scheduleExport();

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
		if (typeof message.provider === "string" && message.provider) run.provider = message.provider;

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

	const handleEvent = (event: ChildEvent): void => {
		if (event.type === "agent_settled") {
			if (state === "closed") return;
			if (stopRequested) {
				state = "stopped";
				return; // Keep the child alive for a live resume or the idle timeout.
			}
			if (interruptPending) return; // Wait for the follow-up prompt to settle.
			void closeChild();
			return;
		}
		if (event.type !== "message_end" || !event.message) return;
		const message = event.message as { role?: unknown };
		if (message.role !== "assistant") return;
		handleAssistantMessage(message as Parameters<typeof handleAssistantMessage>[0]);
	};

	const sendPrompt = async (message: string): Promise<void> => {
		const response = await rpc!.request({ type: "prompt", message });
		if (!response.success) {
			run.stopReason = "error";
			run.errorMessage = response.error ?? "The child rejected the prompt.";
			run.exitCode = 1;
			throw new Error(run.errorMessage);
		}
		const disposition = (response.data as { disposition?: unknown } | undefined)?.disposition;
		if (disposition === "handled") void closeChild(); // An input handler consumed the prompt.
	};

	const steer = async (message: string): Promise<void> => {
		if (state !== "running") throw new Error("Run is not running. Use resume to send new instructions.");
		await ready.promise;
		if (state !== "running") throw new Error("Run is not running. Use resume to send new instructions.");
		const response = await rpc!.request({ type: "steer", message });
		if (!response.success) throw new Error(response.error ?? "The child rejected the guidance.");
		run.lastActivity = "guidance sent";
		emitUpdate();
	};

	const interrupt = async (message: string): Promise<void> => {
		if (state !== "running") throw new Error("Run is not running.");
		interruptPending = true;
		await ready.promise;
		if (isClosed()) {
			interruptPending = false;
			throw new Error("Run already finished.");
		}
		await rpc!.request({ type: "clear_queue" });
		try {
			await rpc!.request({ type: "abort" }, ABORT_TIMEOUT_MS);
		} catch {
			interruptPending = false;
			proc?.kill("SIGKILL");
			await closed.promise;
			throw new Error("The child did not stop in time.");
		}
		if (isClosed()) {
			interruptPending = false;
			throw new Error("Run already finished.");
		}
		interruptPending = false;
		run.task = message;
		run.lastActivity = "new instructions";
		emitUpdate();
		try {
			await sendPrompt(message);
		} catch (error) {
			await closeChild();
			throw error;
		}
	};

	const stop = async (): Promise<void> => {
		if (state === "stopped") return;
		if (state === "closed") throw new Error("Run already finished.");
		stopRequested = true;
		run.stop = { by: "agent", reason: DEFAULT_STOP_REASON };
		run.stopReason = run.stopReason ?? "aborted";
		await ready.promise;
		if (isClosed()) throw new Error("Run already finished.");
		await rpc!.request({ type: "clear_queue" });
		try {
			await rpc!.request({ type: "abort" }, ABORT_TIMEOUT_MS);
		} catch {
			proc?.kill("SIGKILL");
			await closed.promise;
			throw new Error("The child did not stop in time.");
		}
		if (isClosed()) throw new Error("Run already finished.");
		state = "stopped";
		try {
			updateRunRecord(historyPaths.dir, {
				status: "stopped",
				result: outcomeOf(run),
				updatedAt: new Date().toISOString(),
			});
		} catch {
			/* best effort */
		}
		clearIdleTimer();
		idleTimer = setTimeout(() => {
			idleTimer = undefined;
			void closeChild();
		}, STOP_IDLE_TIMEOUT_MS);
		idleTimer.unref?.();
		history?.scheduleExport();
		emitUpdate();
	};

	const resume = async (message: string, attempt: number): Promise<void> => {
		if (state !== "stopped") throw new Error("Run is not stopped.");
		stopRequested = false;
		clearIdleTimer();
		state = "running";
		delete run.stop;
		delete run.stopReason;
		delete run.errorMessage;
		run.stderr = "";
		run.output = "";
		run.exitCode = 0;
		run.lastActivity = undefined;
		run.task = message;
		run.attempt = attempt;
		run.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, contextTokens: 0 };
		emitUpdate();
		try {
			await sendPrompt(message);
		} catch (error) {
			await closeChild();
			throw error;
		}
	};

	const control: SubagentRunControl = {
		id: historyPaths.dir,
		get agent() {
			return run.agent;
		},
		get task() {
			return run.task;
		},
		get state() {
			return state;
		},
		steer,
		interrupt,
		stop,
	};

	liveChildren.set(historyPaths.dir, {
		control,
		details: run,
		done: doneDeferred.promise,
		resume,
		close: () => void closeChild(),
	});

	void (async () => {
		try {
			// Persist the child session under the shared run history root, grouped by
			// the parent session uuid, so the transcript can be served by path and
			// followed in a browser while the run is in flight (run-history.ts).
			history = await RunHistoryExporter.create(
				historyPaths,
				spec.fallbackSystemPrompt,
				historyToolInfos(cwd, config.tools),
			);

			const args: string[] = [
				"--mode",
				"rpc",
				"--session",
				historyPaths.sessionFile,
				"--model",
				config.model,
				"--thinking",
				config.thinking,
				"--tools",
				config.tools.join(","),
			];

			// Child-side probe extension: captures the child's final chained system
			// prompt (session files don't record it, and extensions may edit it) so the
			// run-history page can show what the subagent actually saw.
			args.push("--extension", CHILD_PROMPT_PROBE_PATH);

			// Context files (AGENTS.md/CLAUDE.md): the child pi process discovers and
			// appends them itself unless the agent opted out with projectContext: false.
			if (!config.projectContext) args.push("--no-context-files");

			if (config.systemPrompt.trim()) {
				tmp = await writeSystemPromptFile(run.agent, config.systemPrompt);
				args.push("--append-system-prompt", tmp.file);
			}

			history.scheduleExport();
			emitUpdate();

			const invocation = getPiInvocation(args);
			proc = spawn(invocation.command, invocation.args, {
				cwd,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
				env: {
					...process.env,
					[CHILD_ENV]: "1",
					[CAPTURE_SYSTEM_PROMPT_ENV]: path.join(historyPaths.dir, SYSTEM_PROMPT_CAPTURE_FILE_NAME),
					[EXPECTED_TOOLS_ENV]: config.tools.join(","),
				},
			});
			spec.onSpawn?.(proc.pid ?? null);

			rpc = new RpcChannel(proc.stdin!);
			proc.stdout!.on("data", (data: string) => {
				stdoutBuffer += data;
				const lines = stdoutBuffer.split("\n");
				stdoutBuffer = lines.pop() ?? "";
				for (const line of lines) rpc!.handleLine(line, handleEvent);
			});
			proc.stderr!.on("data", (data: string) => {
				run.stderr += data;
				if (run.stderr.length > 64 * 1024) run.stderr = run.stderr.slice(-64 * 1024);
			});
			proc.on("close", (code, signal) => {
				run.exitCode = code ?? (signal ? 1 : 0);
				if (stdoutBuffer.trim()) {
					rpc!.handleLine(stdoutBuffer, handleEvent);
					stdoutBuffer = "";
				}
				closed.resolve();
				complete();
			});
			proc.on("error", (error) => {
				run.stderr += `\n${error.message}`;
				closed.resolve();
				complete();
			});

			if (spec.signal) {
				const onAbort = () => {
					abortBySignal = true;
					void closeChild();
				};
				if (spec.signal.aborted) onAbort();
				else spec.signal.addEventListener("abort", onAbort, { once: true });
			}

			ready.resolve();
			if (!stopRequested && state === "running") await sendPrompt(spec.initialPrompt);
			await closed.promise;
		} catch (error) {
			ready.reject(error);
			run.stopReason = "error";
			// Keep the child stderr as the failure text when the process closes early.
			const message = error instanceof Error ? error.message : String(error);
			if (message !== "Child process closed") run.errorMessage = message;
			run.exitCode = 1;
			if (proc) {
				if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
				await closed.promise;
				complete();
			} else {
				closed.resolve();
				complete();
			}
		}
	})();

	return { control, details: run, done: doneDeferred.promise };
}

/** A launched run: its identity exists before this returns; `done` settles with the outcome. */
export interface StartedSubagentRun {
	/** Run directory basename — the stable run id used by status and resume. */
	runId: string;
	/** Absolute run directory under the parent session's artifacts dir. */
	dir: string;
	/** Mutable live run state, updated by the child event stream until it settles. */
	details: SubagentRunDetails;
	/** Resolves with the outcome, or rejects when the run was aborted or could not start. */
	done: Promise<SubagentRunDetails>;
}

/**
 * Start a subagent run and return at once.
 *
 * The run directory and record are written before this returns, so the caller
 * can report the run id while the child is still starting. The caller owns the
 * abort signal and collects the outcome from `done`; the stored record and
 * outcome are the recovery path when that outcome cannot be delivered.
 */
export function startSubagent(options: SubagentRunOptions): StartedSubagentRun {
	const { agent, task, cwd, signal, onUpdate } = options;
	const forkTranscript = options.forkTranscript?.trim() ? options.forkTranscript : undefined;

	const historyPaths = createRunHistoryPaths(options.sessionUuid, agent.name);
	const run: SubagentRunDetails = {
		runId: path.basename(historyPaths.dir),
		attempt: 1,
		agent: agent.name,
		task,
		context: forkTranscript ? "fork" : "fresh",
		model: agent.model,
		provider: splitModelRef(agent.model).provider,
		exitCode: 0,
		stderr: "",
		output: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, contextTokens: 0 },
	};

	writeRunRecord(historyPaths.dir, newRunRecord(agent, cwd, task));
	const handle = createChildRun({
		run,
		historyPaths,
		config: agentContractOf(agent),
		fallbackSystemPrompt: composeHistorySystemPrompt(agent, cwd),
		initialPrompt: forkTranscript ? `${forkTranscript}\n\n---\n\n# Task\n\n${task}` : task,
		cwd,
		signal,
		onUpdate,
		onSpawn: (pid) => persistChildPid(historyPaths.dir, pid),
	});
	return { runId: path.basename(historyPaths.dir), dir: historyPaths.dir, details: run, done: handle.done };
}

/** Options for continuing a finished run with a follow-up task. */
export interface ResumeSubagentOptions {
	/** Record read from the run directory; already validated by the caller. */
	record: RunRecord;
	/** Absolute run directory under the parent session's artifacts dir. */
	runDir: string;
	/** Parent session uuid, used to rebuild the history URL path. */
	sessionUuid: string;
	task: string;
	signal?: AbortSignal | undefined;
	onUpdate?: AgentToolUpdateCallback<SubagentRunDetails> | undefined;
}

/**
 * Continue a finished run: spawn a child on the run's existing session file
 * (`pi --session <file>` continues it in place) with the launch snapshot as
 * the agent contract, and record the follow-up as a new attempt. Returns at
 * once; the caller collects the outcome from `done`.
 */
export function startResume(options: ResumeSubagentOptions): StartedSubagentRun {
	const { record, runDir, task } = options;
	const contract = record.agentContract;
	const historyPaths = runHistoryPathsFor(options.sessionUuid, path.basename(runDir));
	const run: SubagentRunDetails = {
		runId: path.basename(runDir),
		attempt: record.tasks.length + 1,
		agent: record.agent,
		task,
		model: contract.model,
		provider: splitModelRef(contract.model).provider,
		exitCode: 0,
		stderr: "",
		output: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, contextTokens: 0 },
	};

	updateRunRecord(runDir, {
		status: "running",
		childPid: null,
		// A resume starts a new attempt; the previous outcome is no longer current.
		result: undefined,
		updatedAt: new Date().toISOString(),
		tasks: [...record.tasks, task],
	});
	const handle = createChildRun({
		run,
		historyPaths,
		config: contract,
		fallbackSystemPrompt: contract.systemPrompt,
		initialPrompt: task,
		cwd: record.cwd,
		signal: options.signal,
		onUpdate: options.onUpdate,
		onSpawn: (pid) => persistChildPid(runDir, pid),
	});
	return { runId: path.basename(runDir), dir: runDir, details: run, done: handle.done };
}

/** Result of waking a stopped live child with a new task. */
export interface LiveResumeResult {
	runId: string;
	dir: string;
	details: SubagentRunDetails;
	done: Promise<SubagentRunDetails>;
}

/**
 * Wake a stopped live child with a new task. Returns undefined when the run has
 * no stopped child in this process; the caller then starts a child on the
 * session file.
 */
export async function resumeStoppedChild(options: {
	runDir: string;
	record: RunRecord;
	task: string;
}): Promise<LiveResumeResult | undefined> {
	const entry = liveChildren.get(options.runDir);
	if (!entry || entry.control.state !== "stopped") return undefined;
	const attempt = options.record.tasks.length + 1;
	updateRunRecord(options.runDir, {
		status: "running",
		result: undefined,
		updatedAt: new Date().toISOString(),
		tasks: [...options.record.tasks, options.task],
	});
	await entry.resume(options.task, attempt);
	return {
		runId: path.basename(options.runDir),
		dir: options.runDir,
		details: entry.details,
		done: entry.done,
	};
}

function progressText(run: SubagentRunDetails): string {
	const mode = (run.attempt ?? 1) > 1 ? `resumed, attempt ${run.attempt}` : run.context ?? "fresh";
	const parts = [`Subagent "${run.agent}" running (${mode})`];
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