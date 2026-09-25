import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ModelRegistry,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text, getCapabilities, hyperlink } from "@earendil-works/pi-tui";
import { pathToFileURL } from "node:url";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type, type Static } from "typebox";
import { loadProjectAgents, type AgentDefinition, type AgentLoadResult } from "./loader.ts";
import {
	CHILD_ENV,
	DEFAULT_STOP_REASON,
	formatTokens,
	formatUsage,
	isFailedRun,
	listActiveSubagentRuns,
	resumeSubagent,
	runSubagent,
	serializeForkContext,
	splitModelRef,
	subagentModelRef,
	type StoppableSubagentRun,
	type SubagentRunDetails,
} from "./runner.ts";
import { runHistoryPathsFor } from "./run-history.ts";
import { runHistoryPageUrl } from "./run-history-server.ts";
import {
	displayStatus,
	listRuns,
	resolveRun,
	resumability,
	runIsInFlight,
	type KnownRun,
	type RunRecord,
} from "./run-store.ts";

const subagentSchema = Type.Object({
	action: Type.Optional(
		Type.Union([Type.Literal("run"), Type.Literal("resume"), Type.Literal("status")], {
			description: '"run" (default) starts a new subagent run; "resume" continues a finished run; "status" lists this session\'s runs.',
		}),
	),
	agent: Type.Optional(Type.String({ description: 'Agent to run; required for action "run".' })),
	run: Type.Optional(
		Type.String({ description: 'Run id to resume or inspect; required for "resume", optional for "status".' }),
	),
	task: Type.Optional(Type.String({ description: 'Task to delegate for "run", or follow-up task for "resume".' })),
});

export type SubagentToolInput = Static<typeof subagentSchema>;

/** Marker details for text-only results (status reports and lookup errors). */
export interface SubagentTextDetails {
	kind: "text";
}

/** Union of all `subagent` tool result details. */
export type SubagentToolDetails = SubagentRunDetails | SubagentTextDetails;

/** Maximum runs shown by the status listing. */
const MAX_STATUS_RUNS = 10;

/** Roster cached at session_start so slash-command autocomplete stays trust-safe. */
let cachedRoster: AgentLoadResult | null = null;

/**
 * Parent-session model registry, captured from the first extension context we
 * see. Needed to resolve a run's model to its context window for the card's
 * context-usage percentage; absent until a context arrives (percent omitted).
 */
let modelRegistry: ModelRegistry | undefined;

function rememberModelRegistry(ctx: ExtensionContext): void {
	modelRegistry ??= ctx.modelRegistry;
}

/**
 * "ctx NN% of WINDOW" for the run card header — the child's latest context
 * token count as a share of the model's context window. Empty when the model
 * is unknown to pi's registry (no known window) or nothing is counted yet.
 */
function contextUsageText(run: SubagentRunDetails): string {
	if (!modelRegistry) return "";
	const { provider, modelId } = splitModelRef(subagentModelRef(run));
	const model = provider ? modelRegistry.find(provider, modelId) : undefined;
	if (!model || !(model.contextWindow > 0) || run.usage.contextTokens <= 0) return "";
	const percent = (run.usage.contextTokens / model.contextWindow) * 100;
	const label = percent >= 1 ? `${Math.round(percent)}%` : "<1%";
	return `ctx ${label} of ${formatTokens(model.contextWindow)}`;
}

function emptyDetails(agent: string, task: string): SubagentRunDetails {
	return {
		agent,
		task,
		context: "fresh",
		model: "",
		exitCode: 1,
		stderr: "",
		output: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, contextTokens: 0 },
	};
}

function buildToolDescription(roster: AgentLoadResult | null): string {
	const base =
		"Delegate work to a named subagent, continue a finished subagent run, or inspect this " +
		"session's runs. Each run is an isolated pi child process (its own context window) with " +
		"the agent's configured model, thinking level, tools allowlist, and system prompt.";
	const actions =
		"Actions:\n" +
		'- { action: "run", agent, task } (default) — start a new run; the result ends with its run id.\n' +
		'- { action: "resume", run, task } — append follow-up work to a finished run (complete or failed), keeping its full context. Refused for stopped or in-flight runs.\n' +
		'- { action: "status" } — list this session\'s runs; add "run" to show one.';
	const how =
		"Agents are defined as Markdown files with YAML frontmatter in the project's .pi/agents " +
		"directory; the frontmatter name field defines the agent name.";
	if (!roster) return `${base}\n\n${actions}\n\n${how}`;
	if (roster.agents.size === 0) {
		return `${base}\n\n${actions}\n\nNo agents are currently configured in .pi/agents — run calls fail until one is defined.\n\n${how}`;
	}
	const lines = [...roster.agents].map(([name, a]) => `- ${name}: ${a.description}`);
	return `${base}\n\n${actions}\n\nAvailable agents:\n${lines.join("\n")}\n\n${how}`;
}

function unknownAgentText(name: string, roster: AgentLoadResult): string {
	const available = roster.agents.size > 0 ? [...roster.agents.keys()].join(", ") : "(none)";
	const problems = [...roster.errors, ...roster.warnings].map((d) => `- ${d.file}: ${d.message}`).join("\n");
	return (
		`Unknown subagent "${name}". Available: ${available}.\n` +
		`Define agents in ${roster.agentsDir}/<name>.md` +
		(problems ? `\n\nLoad problems:\n${problems}` : "")
	);
}

function rosterText(roster: AgentLoadResult): string {
	if (roster.agents.size === 0) return `No subagents defined in ${roster.agentsDir}`;
	return [...roster.agents].map(([name, a]) => `${name} — ${a.description}`).join("\n");
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}…`;
}

function failedRunMessage(run: SubagentRunDetails): string {
	const reason = run.errorMessage?.trim() || run.stderr.trim() || run.output.trim() || "(no output)";
	return `Subagent "${run.agent}" ${run.stopReason ?? "failed"} (exit ${run.exitCode}): ${truncate(reason, 2000)}`;
}

/**
 * Clickable "↗ history" link for the subagent run card, pointing at the run's
 * live HTTP-served transcript (herdr's link opener only opens http/https).
 * Empty string when the run has no history yet or the terminal does not
 * support OSC 8 hyperlinks (link is not rendered).
 */
function historyLinkText(run: SubagentRunDetails, theme: Theme): string {
	const url = run.history?.url ??
		(run.history?.htmlFile && getCapabilities().hyperlinks ? pathToFileURL(run.history.htmlFile).href : undefined);
	if (!url) return "";
	return theme.fg("accent", hyperlink("↗ history", url));
}

/** Plain-words hint about the run history page, shown in expanded run cards. */
function historyHintText(run: SubagentRunDetails): string {
	if (!run.history) return "";
	if (run.history.lastError) return `Run history export failed: ${run.history.lastError}`;
	return `Run history: ${run.history.url ?? run.history.htmlFile}`;
}

/** Gesture hint for opening the ↗ history link (herdr opens pane links on ctrl/cmd-click). */
const HISTORY_OPEN_HINT = "(ctrl/cmd-click to open · refresh the page to see the latest export)";

/** Key shown on an in-flight run card; pressing it stops the run in-process. */
const STOP_KEY_HINT = "alt+s stop";

/** Picker label for an active run: agent, task preview, short run id. */
function stopOptionLabel(run: StoppableSubagentRun): string {
	const shortId = path.basename(run.id).slice(-4);
	return `${run.agent} — ${truncate(run.task.replace(/\s+/g, " "), 60)} (${shortId})`;
}

/** Plain-words line describing a user stop, for the run card. */
function stopLineText(run: SubagentRunDetails): string {
	const reason = run.stop?.reason ? ` — reason: ${truncate(run.stop.reason, 200)}` : "";
	return `Stopped by user${reason}`;
}

/** Result text the main agent receives when a run is stopped via alt+s. */
function stoppedRunMessage(run: SubagentRunDetails): string {
	const partial = run.output?.trim();
	return (
		`Subagent "${run.agent}" was stopped by the user. Reason: ${run.stop?.reason ?? DEFAULT_STOP_REASON}.` +
		(partial ? `\n\nPartial output before the stop:\n${truncate(partial, 1000)}` : "")
	);
}

/** Plain-text tool result (status reports and lookup errors); rendered without a run card. */
function textResult(text: string): AgentToolResult<SubagentToolDetails> {
	return { content: [{ type: "text", text }], details: { kind: "text" } };
}

/** Compact run trailer the main agent uses to resume a finished run. */
function runTrailer(run: SubagentRunDetails): string {
	if (!run.runId || run.stop) return "";
	const state = isFailedRun(run) ? "failed" : "complete";
	const attempt = (run.attempt ?? 1) > 1 ? `, attempt ${run.attempt}` : "";
	return `\n\n[run ${run.runId} (${state}${attempt}) — resume with subagent({action:"resume", run:"${run.runId}", task:"…"})]`;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/** Relative time for run listings, e.g. "2m ago". */
function timeAgo(iso: string): string {
	const ms = Date.now() - Date.parse(iso);
	if (!Number.isFinite(ms) || ms < 0) return "just now";
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

/** One-line task summary for status listings. */
function taskSummary(task: string): string {
	return truncate(task.replace(/\s+/g, " ").trim(), 80) || "(no task)";
}

/** "resumable" / "not resumable (reason)" label for a run record. */
function resumabilityLabel(run: KnownRun): string {
	const result = resumability(run.record, run.dir);
	return result.resumable ? "resumable" : `not resumable (${result.reason})`;
}

/** `status` list: every run of the current parent session, newest first. */
function statusListText(runs: KnownRun[]): string {
	if (runs.length === 0) return "No subagent runs in this session.";
	const lines = ["Subagent runs in this session (newest first):", ""];
	for (const run of runs.slice(0, MAX_STATUS_RUNS)) {
		lines.push(
			`${run.runId}  ${displayStatus(run.record)}  attempt ${run.record.tasks.length}  ${run.record.agent}  updated ${timeAgo(run.record.updatedAt)}  — ${resumabilityLabel(run)}`,
		);
		lines.push(`  task: ${taskSummary(run.record.tasks[0] ?? "")}`);
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

/** `status <run>`: one run's contract, location, and attempt tasks. */
async function statusDetailText(sessionUuid: string, runId: string, record: RunRecord): Promise<string> {
	const paths = runHistoryPathsFor(sessionUuid, runId);
	const history = (await runHistoryPageUrl(paths.urlPath)) ?? paths.htmlFile;
	const attempts = record.tasks.length;
	const countLabel = attempts > 1 ? `, ${attempts} attempts` : "";
	return [
		`Run ${runId} — ${record.agent} (${displayStatus(record)}${countLabel})`,
		`cwd: ${record.cwd}`,
		`model: ${record.agentContract.model} · thinking ${record.agentContract.thinking} · tools ${record.agentContract.tools.join(",")}`,
		`history: ${history}`,
		"",
		"tasks:",
		...record.tasks.map((task, index) => `  ${index + 1}. ${taskSummary(task)}`),
	].join("\n");
}

/** Unknown run id: list the session's runs so the caller can pick one. */
function unknownRunText(reference: string, runs: KnownRun[]): string {
	if (runs.length === 0) return `Unknown subagent run "${reference}". No subagent runs in this session.`;
	const lines = [`Unknown subagent run "${reference}". Runs in this session (newest first):`];
	for (const { runId, record } of runs.slice(0, MAX_STATUS_RUNS)) {
		lines.push(
			`- ${runId} (${displayStatus(record)}, attempt ${record.tasks.length}) — ${taskSummary(record.tasks[0] ?? "")}`,
		);
	}
	lines.push(`Pass a full id (or a unique prefix), e.g. subagent({action:"resume", run:"${runs[0]!.runId}", task:"…"})`);
	return lines.join("\n");
}

function ambiguousRunText(reference: string, matches: string[]): string {
	return [`Run id "${reference}" matches several runs:`, ...matches.map((match) => `- ${match}`), "Pass the full id."].join("\n");
}

function noRecordRunText(runId: string): string {
	return `Run "${runId}" has no run record (created before resume support). Start a new run instead.`;
}

function invalidRecordRunText(runId: string, message: string): string {
	return `Run "${runId}" has an unreadable run record (${message}). Start a new run instead.`;
}

/** "run" action: resolve the agent, spawn a fresh child, return its final output. */
async function executeRun(
	params: SubagentToolInput,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<SubagentRunDetails> | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<SubagentToolDetails>> {
	const agentName = params.agent?.trim() ?? "";
	const task = params.task?.trim() ?? "";
	const roster = loadProjectAgents(ctx.cwd);
	const agent = roster.agents.get(agentName);
	if (!agent) {
		return {
			content: [{ type: "text", text: unknownAgentText(agentName, roster) }],
			details: emptyDetails(agentName, task),
		};
	}

	rememberModelRegistry(ctx);
	// fork-context agents receive the parent conversation as a serialized transcript.
	const forkTranscript =
		agent.context === "fork" ? serializeForkContext(ctx.sessionManager.buildContextEntries()) || undefined : undefined;

	const run = await runSubagent({
		agent,
		task,
		cwd: ctx.cwd,
		sessionUuid: ctx.sessionManager.getSessionId(),
		forkTranscript,
		signal,
		onUpdate,
	});
	// Stopped via alt+s: a deliberate user action, so the main agent gets a
	// normal result carrying the encoded reason instead of a thrown error.
	if (run.stop) {
		return {
			content: [{ type: "text", text: stoppedRunMessage(run) }],
			details: run,
		};
	}
	if (isFailedRun(run)) throw new Error(failedRunMessage(run) + runTrailer(run));

	return {
		content: [{ type: "text", text: (run.output || "(no output)") + runTrailer(run) }],
		details: run,
	};
}

/** "resume" action: continue a finished run with a follow-up task. */
async function executeResume(
	params: SubagentToolInput,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<SubagentRunDetails> | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<SubagentToolDetails>> {
	const reference = params.run?.trim() ?? "";
	const task = params.task?.trim() ?? "";
	const sessionUuid = ctx.sessionManager.getSessionId();
	const lookup = resolveRun(sessionUuid, reference);
	if (lookup.kind === "unknown") return textResult(unknownRunText(reference, listRuns(sessionUuid)));
	if (lookup.kind === "ambiguous") return textResult(ambiguousRunText(reference, lookup.matches));
	if (lookup.kind === "no-record") return textResult(noRecordRunText(lookup.runId));
	if (lookup.kind === "invalid-record") return textResult(invalidRecordRunText(lookup.runId, lookup.message));
	const { runId, dir, record } = lookup;

	if (params.agent && params.agent !== record.agent) {
		return textResult(`Run ${runId} belongs to agent "${record.agent}", not "${params.agent}".`);
	}
	if (record.status === "stopped") {
		return textResult(`Run ${runId} was stopped and cannot be resumed. Start a new run instead.`);
	}
	const inProcess = listActiveSubagentRuns().some((active) => active.id === dir);
	if (inProcess || runIsInFlight(record)) {
		return textResult(
			`Run ${runId} is still in flight (started ${timeAgo(record.updatedAt)}). Wait for it to finish, or stop it (alt+s), then resume.`,
		);
	}
	if (!fs.existsSync(path.join(dir, "session.jsonl"))) {
		return textResult(`Run ${runId} cannot be resumed: its session file is missing. Start a new run instead.`);
	}
	if (!isDirectory(record.cwd)) {
		return textResult(
			`Run ${runId} cannot be resumed: its working directory no longer exists (${record.cwd}). Start a new run instead.`,
		);
	}

	rememberModelRegistry(ctx);
	const run = await resumeSubagent({ record, runDir: dir, sessionUuid, task, signal, onUpdate });
	if (run.stop) {
		return {
			content: [{ type: "text", text: stoppedRunMessage(run) }],
			details: run,
		};
	}
	if (isFailedRun(run)) throw new Error(failedRunMessage(run) + runTrailer(run));

	return {
		content: [{ type: "text", text: (run.output || "(no output)") + runTrailer(run) }],
		details: run,
	};
}

/** "status" action: list this session's runs, or show one run in detail. */
async function executeStatus(
	params: SubagentToolInput,
	ctx: ExtensionContext,
): Promise<AgentToolResult<SubagentToolDetails>> {
	const sessionUuid = ctx.sessionManager.getSessionId();
	const reference = params.run?.trim();
	if (reference) {
		const lookup = resolveRun(sessionUuid, reference);
		if (lookup.kind === "unknown") return textResult(unknownRunText(reference, listRuns(sessionUuid)));
		if (lookup.kind === "ambiguous") return textResult(ambiguousRunText(reference, lookup.matches));
		if (lookup.kind === "no-record") return textResult(noRecordRunText(lookup.runId));
		if (lookup.kind === "invalid-record") return textResult(invalidRecordRunText(lookup.runId, lookup.message));
		return textResult(await statusDetailText(sessionUuid, lookup.runId, lookup.record));
	}
	return textResult(statusListText(listRuns(sessionUuid)));
}

/** Tool execution: dispatch on the requested action after the trust gate. */
async function executeDelegation(
	params: SubagentToolInput,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<SubagentRunDetails> | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<SubagentToolDetails>> {
	const action = params.action ?? "run";
	if (!ctx.isProjectTrusted()) {
		const what =
			action === "run" ? "read .pi/agents" : action === "resume" ? "resume subagent runs" : "list subagent runs";
		return textResult(`Project is not trusted — refusing to ${what}.`);
	}
	if (action === "status") return executeStatus(params, ctx);
	if (action === "resume") {
		if (!params.run?.trim()) return textResult('subagent({action:"resume"}) requires the run id in "run".');
		if (!params.task?.trim()) return textResult('subagent({action:"resume"}) requires the follow-up task in "task".');
		return executeResume(params, signal, onUpdate, ctx);
	}
	if (!params.agent?.trim()) return textResult('subagent({action:"run"}) requires the agent name in "agent".');
	if (!params.task?.trim()) return textResult('subagent({action:"run"}) requires the task in "task".');
	return executeRun(params, signal, onUpdate, ctx);
}

/** Run a delegation from /subagent and inject the result into the session. */
async function runCommandDelegation(
	pi: ExtensionAPI,
	agent: AgentDefinition,
	task: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const forkTranscript =
		agent.context === "fork" ? serializeForkContext(ctx.sessionManager.buildContextEntries()) || undefined : undefined;

	rememberModelRegistry(ctx);
	ctx.ui.setStatus("subagent", `${agent.name}: running${forkTranscript ? " (fork)" : ""}`);
	try {
		const run = await runSubagent({ agent, task, cwd: ctx.cwd, sessionUuid: ctx.sessionManager.getSessionId(), forkTranscript });
		ctx.ui.setStatus("subagent", undefined);
		if (run.stop) {
			ctx.ui.notify(`Subagent "${run.agent}" stopped from its run card${run.stop.reason ? ` — ${run.stop.reason}` : ""}.`, "warning");
			return;
		}
		if (isFailedRun(run)) {
			ctx.ui.notify(failedRunMessage(run), "error");
			return;
		}
		const usage = formatUsage(run);
		ctx.ui.notify(`Subagent "${run.agent}" completed${usage ? ` · ${usage}` : ""}`, "info");
		// Deliver the result into the conversation; the main agent reacts on its next turn.
		await pi.sendMessage(
			{
				customType: "subagent-result",
				content: `Subagent "${run.agent}" (${run.context}, ${subagentModelRef(run)}) finished with:\n\n${run.output || "(no output)"}`,
				display: true,
				details: run,
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	} catch (err) {
		ctx.ui.setStatus("subagent", undefined);
		const message = err instanceof Error ? err.message : String(err);
		if (message === "Subagent was aborted") ctx.ui.notify("Subagent aborted.", "warning");
		else ctx.ui.notify(`Subagent "${agent.name}" failed: ${truncate(message, 500)}`, "error");
	}
}

function registerSubagentTool(pi: ExtensionAPI, roster: AgentLoadResult | null): void {
	pi.registerTool<typeof subagentSchema, SubagentToolDetails>({
		name: "subagent",
		label: "Subagent",
		description: buildToolDescription(roster),
		promptSnippet: "Delegate a task to a named subagent configured in .pi/agents, resume a finished run, or list this session's runs.",
		promptGuidelines: [
			"Use subagent when a task matches one of the configured subagent descriptions; pass the full, self-contained task text as task.",
			'To give a finished subagent follow-up work that builds on what it already did, resume it with action "resume" and its run id instead of starting a new run.',
			'Use action "status" when you need the run ids of subagents started earlier in this session.',
		],
		parameters: subagentSchema,
		execute(_toolCallId, params, signal, onUpdate, ctx) {
			return executeDelegation(params, signal, onUpdate, ctx);
		},
		renderCall(args, theme) {
			const action = args.action ?? "run";
			if (action === "status") {
				const target = args.run ? ` ${theme.fg("accent", args.run)}` : "";
				return new Text(`${theme.fg("toolTitle", theme.bold("subagent status"))}${target}`, 0, 0);
			}
			const preview = args.task ? truncate(args.task.replace(/\s+/g, " "), 60) : "...";
			const head =
				action === "resume"
					? `${theme.fg("toolTitle", theme.bold("subagent ↩ "))}${theme.fg("accent", args.run ?? "")}`
					: `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.agent ?? "")}`;
			return new Text(`${head}\n  ${theme.fg("dim", preview)}`, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details;
			if ("kind" in details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "(no output)", 0, 0);
			}
			const run = details;

			const stopped = run.stop !== undefined;
			const failed = isFailedRun(run);
			const icon = stopped
				? theme.fg("warning", "■")
				: failed
					? theme.fg("error", "✗")
					: theme.fg("success", "✓");
			const usage = formatUsage(run);
			const ctxUsage = contextUsageText(run);
			const modelRef = subagentModelRef(run);
			const historyLink = historyLinkText(run, theme);
			// Stop affordance: press alt+s while the run is in flight (no browser).
			const stopHint = isPartial && !failed && !stopped ? theme.fg("dim", ` · ${STOP_KEY_HINT}`) : undefined;
			const resumed = (run.attempt ?? 1) > 1;
			const segments = [
				...(resumed
					? [theme.fg("muted", "resumed"), theme.fg("dim", `attempt ${run.attempt}`)]
					: run.context
						? [theme.fg("muted", run.context)]
						: []),
				...(modelRef ? [theme.fg("muted", modelRef)] : []),
				...(usage ? [theme.fg("dim", usage)] : []),
				...(ctxUsage ? [theme.fg("dim", ctxUsage)] : []),
			];
			let header = `${icon} ${theme.fg("toolTitle", theme.bold(run.agent))} ${segments.join(" · ")}`;
			if (stopped) header += ` ${theme.fg("warning", "[stopped]")}`;
			else if (failed && run.stopReason) header += ` ${theme.fg("error", `[${run.stopReason}]`)}`;
			if (historyLink) header += ` · ${historyLink}`;
			if (stopHint) header += stopHint;

			const output = run.output?.trim();
			if (expanded && output) {
				const container = new Container();
				container.addChild(new Text(header, 0, 0));
				if (stopped) container.addChild(new Text(theme.fg("muted", stopLineText(run)), 0, 0));
				else if (historyLink) container.addChild(new Text(theme.fg("dim", HISTORY_OPEN_HINT), 0, 0));
				else if (run.history) container.addChild(new Text(theme.fg("dim", historyHintText(run)), 0, 0));
				if (failed && run.errorMessage) {
					container.addChild(new Text(theme.fg("error", truncate(run.errorMessage, 1000)), 0, 0));
				}
				container.addChild(new Markdown(output, 0, 0, getMarkdownTheme()));
				return container;
			}

			let text = header;
			if (stopped) {
				text += `\n${theme.fg("muted", stopLineText(run))}`;
			} else if (failed && run.errorMessage) {
				text += `\n${theme.fg("error", truncate(run.errorMessage, 300))}`;
			} else if (output) {
				const lines = output.split("\n").slice(0, 3).map((line) => truncate(line, 200));
				text += `\n${theme.fg("toolOutput", lines.join("\n"))}`;
				if (output.split("\n").length > 3) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
			} else {
				text += `\n${theme.fg("muted", isPartial ? "running…" : "(no output)")}`;
				if (!historyLink && run.history) text += `\n${theme.fg("dim", historyHintText(run))}`;
			}
			return new Text(text, 0, 0);
		},
	});
}

export default function (pi: ExtensionAPI) {
	// Children spawned by runSubagent carry CHILD_ENV and must not be able to
	// delegate further — skip all registration in child processes.
	if (process.env[CHILD_ENV] === "1") return;

	registerSubagentTool(pi, null);

	// alt+s — stop an in-flight subagent run. One run: instant stop with the
	// encoded default reason. Several runs: a picker of the active ones.
	pi.registerShortcut("alt+s", {
		description: "Stop a running subagent",
		handler: async (ctx) => {
			const active = listActiveSubagentRuns();
			if (active.length === 0) {
				ctx.ui.notify("No subagent run in flight.", "warning");
				return;
			}
			let target = active[0]!;
			if (active.length > 1) {
				const options = active.map((run) => stopOptionLabel(run));
				const choice = await ctx.ui.select("Stop which subagent?", options, { timeout: 30_000 });
				if (choice === undefined) return; // cancelled or timed out
				const index = options.indexOf(choice);
				if (index === -1) return;
				target = active[index]!;
			}
			target.stop();
			ctx.ui.notify(`Stopping ${target.agent} — the main agent receives the reason.`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.isProjectTrusted()) return;
		rememberModelRegistry(ctx);
		const result = loadProjectAgents(ctx.cwd);
		cachedRoster = result;
		for (const d of result.errors) ctx.ui.notify(`${d.file}: ${d.message}`, "error");
		for (const d of result.warnings) ctx.ui.notify(`${d.file}: ${d.message}`, "warning");

		// Re-register so the tool description carries the current agent roster.
		registerSubagentTool(pi, result);
		if (result.agents.size > 0) {
			ctx.ui.notify(`Loaded ${result.agents.size} subagent(s) from .pi/agents`, "info");
		}
	});

	// /subagent <name> <task> — delegate manually from the prompt
	pi.registerCommand("subagent", {
		description: "Run a subagent: /subagent <name> <task>",
		getArgumentCompletions: (prefix) => {
			if (prefix.includes(" ")) return null; // agent already picked; no task completions
			if (!cachedRoster || cachedRoster.agents.size === 0) return null;
			const items = [...cachedRoster.agents].map(([name, a]) => ({ value: name, label: `${name} — ${a.description}` }));
			const filtered = items.filter((item) => item.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			if (!ctx.isProjectTrusted()) {
				ctx.ui.notify("Project is not trusted — .pi/agents not loaded.", "warning");
				return;
			}
			const roster = loadProjectAgents(ctx.cwd);
			const trimmed = args.trim();
			if (!trimmed) {
				ctx.ui.notify(rosterText(roster), "info");
				return;
			}
			const separator = trimmed.indexOf(" ");
			const name = separator === -1 ? trimmed : trimmed.slice(0, separator);
			const task = separator === -1 ? "" : trimmed.slice(separator + 1).trim();
			const agent = roster.agents.get(name);
			if (!agent) {
				ctx.ui.notify(unknownAgentText(name, roster), "error");
				return;
			}
			if (!task) {
				ctx.ui.notify(`Usage: /subagent ${name} <task>`, "warning");
				return;
			}
			await runCommandDelegation(pi, agent, task, ctx);
		},
	});

	// /subagents — list the agents the loader found
	pi.registerCommand("subagents", {
		description: "List configured subagents (.pi/agents)",
		handler: async (_args, ctx) => {
			if (!ctx.isProjectTrusted()) {
				ctx.ui.notify("Project is not trusted — .pi/agents not loaded.", "warning");
				return;
			}
			const result = loadProjectAgents(ctx.cwd);
			if (result.agents.size === 0) {
				ctx.ui.notify(`No subagents found in ${result.agentsDir}`, "info");
				return;
			}
			const lines = [...result.agents].map(([name, a]) => `${name} — ${a.description} [${a.model}]`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}