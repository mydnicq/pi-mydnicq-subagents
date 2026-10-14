import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ModelRegistry,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text, getCapabilities, hyperlink, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { pathToFileURL } from "node:url";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type, type Static } from "typebox";
import { loadProjectAgents, type AgentDefinition, type AgentLoadResult } from "./loader.ts";
import {
	CHILD_ENV,
	formatTokens,
	formatUsage,
	isFailedRun,
	listActiveSubagentRuns,
	serializeForkContext,
	splitModelRef,
	subagentModelRef,
	type StoppableSubagentRun,
	type SubagentRunDetails,
} from "./runner.ts";
import {
	startBackgroundResume,
	startBackgroundRun,
	stopAllBackgroundRuns,
	type BackgroundResumeOptions,
	type BackgroundRunOptions,
	type BackgroundRunReceipt,
	type StartedBackgroundRun,
} from "./background-runs.ts";
import { runHistoryPathsFor } from "./run-history.ts";
import { runHistoryPageUrl } from "./run-history-server.ts";
import {
	displayStatus,
	listRuns,
	resolveRun,
	resumability,
	runIsInFlight,
	type KnownRun,
	type RunOutcome,
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

/** Details of the receipt returned when a background run starts. */
export interface SubagentReceiptDetails {
	kind: "receipt";
	runId: string;
	dir: string;
	agent: string;
	task: string;
	/** Configured model reference the child runs with. */
	model: string;
	action: "run" | "resume";
	attempt: number;
}

/** Union of all `subagent` tool result details. */
export type SubagentToolDetails = SubagentRunDetails | SubagentTextDetails | SubagentReceiptDetails;

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

function buildToolDescription(roster: AgentLoadResult | null): string {
	const base =
		"Delegate work to a named subagent, continue a finished subagent run, or inspect this " +
		"session's runs. Each run is an isolated pi child process (its own context window) with " +
		"the agent's configured model, thinking level, tools allowlist, and system prompt.";
	const actions =
		"Actions:\n" +
		'- { action: "run", agent, task } (default) — start a run in the background; returns a receipt with its run id.\n' +
		'- { action: "resume", run, task } — give a finished run (complete or failed) follow-up work in the background, keeping its full context. Refused for stopped or in-flight runs.\n' +
		'- { action: "status" } — list this session\'s runs; add "run" to show one.';
	const lifecycle =
		"Every run is asynchronous: it keeps working after the tool call returns. When it finishes you " +
		"receive a [subagent-result] message that wakes you and carries the result. Do not poll for " +
		"progress. If the next step needs the result, end your turn and wait for that message. Use " +
		"status to check progress, to recover a result whose message you missed, or to find a run id.";
	const how =
		"Agents are defined as Markdown files with YAML frontmatter in the project's .pi/agents " +
		"directory; the frontmatter name field defines the agent name.";
	if (!roster) return `${base}\n\n${actions}\n\n${lifecycle}\n\n${how}`;
	if (roster.agents.size === 0) {
		return `${base}\n\n${actions}\n\n${lifecycle}\n\nNo agents are currently configured in .pi/agents — run calls fail until one is defined.\n\n${how}`;
	}
	const lines = [...roster.agents].map(([name, a]) => `- ${name}: ${a.description}`);
	return `${base}\n\n${actions}\n\n${lifecycle}\n\nAvailable agents:\n${lines.join("\n")}\n\n${how}`;
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

/** Plain-words hint about the run history page, shown in the expanded completion card. */
function historyHintText(run: SubagentRunDetails): string {
	if (!run.history) return "";
	if (run.history.lastError) return `Run history export failed: ${run.history.lastError}`;
	return `Run history: ${run.history.url ?? run.history.htmlFile}`;
}

/** Gesture hint for opening the ↗ history link (herdr opens pane links on ctrl/cmd-click). */
const HISTORY_OPEN_HINT = "(ctrl/cmd-click to open · refresh the page to see the latest export)";

/** Plain-words line describing a user stop, for the completion card. */
function stopLineText(run: SubagentRunDetails): string {
	const reason = run.stop?.reason ? ` — reason: ${truncate(run.stop.reason, 200)}` : "";
	return `Stopped by user${reason}`;
}

/** Picker label for an active run: agent, task preview, short run id. */
function stopOptionLabel(run: StoppableSubagentRun): string {
	const shortId = path.basename(run.id).slice(-4);
	return `${run.agent} — ${truncate(run.task.replace(/\s+/g, " "), 60)} (${shortId})`;
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

/** Tool result for a launched background run: a receipt the model acts on. */
function receiptResult(receipt: BackgroundRunReceipt): AgentToolResult<SubagentToolDetails> {
	const verb = receipt.action === "resume" ? "resumed" : "started";
	return {
		content: [
			{
				type: "text",
				text:
					`Subagent "${receipt.agent}" ${verb} in the background (run ${receipt.runId}).\n` +
					"It keeps running while you continue. Its result arrives later as a [subagent-result] message that wakes you; if the next step needs the result, end your turn instead of polling.\n" +
					`Check progress with subagent({action:"status",run:"${receipt.runId}"}) or stop it with alt+s.`,
			},
		],
		details: { kind: "receipt", ...receipt },
	};
}

/** Message text delivered when a background run settles. */
function completionMessageText(run: SubagentRunDetails): string {
	const id = run.runId ?? "(unknown)";
	if (run.stop) {
		const partial = run.output?.trim();
		return (
			`Subagent "${run.agent}" (run ${id}) was stopped by the user.` +
			(partial ? `\n\nPartial output before the stop:\n${truncate(partial, 2000)}` : "")
		);
	}
	if (isFailedRun(run)) {
		const reason = run.errorMessage?.trim() || run.stderr.trim() || run.output.trim() || "(no output)";
		return `Subagent "${run.agent}" (run ${id}) failed: ${truncate(reason, 2000)}${runTrailer(run)}`;
	}
	return `Subagent "${run.agent}" (run ${id}) finished with:\n\n${run.output || "(no output)"}${runTrailer(run)}`;
}

/**
 * In-flight run cards, stacked in the input area (a widget below the editor),
 * not in the transcript. Each card is one compact line rebuilt from live state
 * on every render; a card pops the moment its run settles.
 */
const liveRunStack = new Map<string, SubagentRunDetails>();

/** Widget key of the input-area run stack. */
const RUN_STACK_WIDGET_KEY = "subagent-run-stack";

/** Most run cards kept visible at once; the oldest in-flight runs collapse into a "+N" line. */
const MAX_STACK_RUNS = 8;

/** Latest context seen from a tool/command/session handler; mounts and unmounts the stack widget. */
let lastUiContext: ExtensionContext | undefined;

/** TUI captured from the mounted stack widget; used to request repaints. */
let stackWidgetTui: TUI | undefined;

/** Whether the stack widget is currently mounted. */
let stackWidgetMounted = false;

/** Animation frames for in-flight run cards; same glyphs pi uses for its own working indicator. */
const RUN_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Repaint interval for in-flight run cards, in milliseconds. */
const RUN_SPINNER_INTERVAL_MS = 100;

let runSpinnerFrame = 0;
let runSpinnerTimer: NodeJS.Timeout | undefined;

/** Completion card wrapper: a solid left bar on every line. */
class LeftBorderCard implements Component {
	constructor(
		private readonly inner: Component,
		private readonly theme: Theme,
	) {}

	render(width: number): string[] {
		const bar = this.theme.fg("border", "▌ ");
		return this.inner.render(Math.max(1, width - 2)).map((line) => `${bar}${line}`);
	}

	invalidate(): void {
		this.inner.invalidate?.();
	}
}

/** Widget component: renders one compact card line per live run, straight from current state. */
class RunStackWidget implements Component {
	constructor(private readonly theme: Theme) {}

	render(width: number): string[] {
		return renderRunStackLines(this.theme, width);
	}

	invalidate(): void {
		// Stateless: lines are rebuilt from live state on every render.
	}
}

/** Mount, refresh, or unmount the input-area run stack to match live state. */
function refreshRunStackWidget(): void {
	const ctx = lastUiContext;
	if (!ctx?.hasUI || ctx.mode !== "tui") return;
	if (liveRunStack.size === 0) {
		if (stackWidgetMounted) {
			ctx.ui.setWidget(RUN_STACK_WIDGET_KEY, undefined);
			stackWidgetMounted = false;
			stackWidgetTui = undefined;
		}
		return;
	}
	if (!stackWidgetMounted) {
		ctx.ui.setWidget(
			RUN_STACK_WIDGET_KEY,
			(tui, theme) => {
				stackWidgetTui = tui;
				return new RunStackWidget(theme);
			},
			{ placement: "belowEditor" },
		);
		stackWidgetMounted = true;
		return;
	}
	stackWidgetTui?.requestRender();
}

/** Stacked run-card lines: one line per in-flight run, newest visible, overflow counted. */
function renderRunStackLines(theme: Theme, width: number): string[] {
	const runs = [...liveRunStack.values()];
	if (runs.length === 0) return [];
	const hidden = Math.max(0, runs.length - MAX_STACK_RUNS);
	const shown = hidden > 0 ? runs.slice(-MAX_STACK_RUNS) : runs;
	const lines: string[] = [];
	if (hidden > 0) lines.push(theme.fg("dim", `+${hidden} more run${hidden === 1 ? "" : "s"}`));
	for (const run of shown) lines.push(renderRunStackLine(run, theme, width));
	return lines;
}

/** One compact card line for an in-flight run: spinner, agent, run id, resume, model, usage, history link. */
function renderRunStackLine(run: SubagentRunDetails, theme: Theme, width: number): string {
	const icon = theme.fg("accent", RUN_SPINNER_FRAMES[runSpinnerFrame] ?? RUN_SPINNER_FRAMES[0]!);
	const modelRef = subagentModelRef(run);
	const resumed = (run.attempt ?? 1) > 1;
	const parts = [
		`${icon} ${theme.fg("toolTitle", theme.bold(run.agent))}`,
		theme.fg("dim", `run ${run.runId ? run.runId.slice(-4) : "?"}`),
		...(resumed ? [theme.fg("muted", "resumed"), theme.fg("dim", `attempt ${run.attempt}`)] : []),
		...(modelRef ? [theme.fg("muted", modelRef)] : []),
	];
	const usage = formatUsage(run);
	if (usage) parts.push(theme.fg("dim", usage));
	const ctxUsage = contextUsageText(run);
	if (ctxUsage) parts.push(theme.fg("dim", ctxUsage));
	const history = historyLinkText(run, theme);
	if (history) parts.push(history);
	return truncateToWidth(` ${parts.join(" ")}`, Math.max(1, width), "…");
}

/**
 * Keep in-flight run cards animating. The interval runs only while at least
 * one card is unsettled and stops itself when the last run settles.
 */
function ensureRunSpinner(): void {
	if (runSpinnerTimer) return;
	runSpinnerTimer = setInterval(() => {
		if (liveRunStack.size === 0) {
			clearInterval(runSpinnerTimer);
			runSpinnerTimer = undefined;
			return;
		}
		runSpinnerFrame = (runSpinnerFrame + 1) % RUN_SPINNER_FRAMES.length;
		stackWidgetTui?.requestRender();
	}, RUN_SPINNER_INTERVAL_MS);
	runSpinnerTimer.unref?.();
}

function stopRunSpinner(): void {
	if (runSpinnerTimer) clearInterval(runSpinnerTimer);
	runSpinnerTimer = undefined;
}

/**
 * Launch a background run and wire its live card and completion message into the session.
 *
 * The completion message uses triggerTurn so an idle parent wakes and acts; a
 * busy parent receives it at the next turn boundary. Delivery failure is
 * logged only — the outcome is stored in the run directory either way.
 */
function launchBackgroundRun(pi: ExtensionAPI, started: StartedBackgroundRun): AgentToolResult<SubagentToolDetails> {
	const { receipt, details, done } = started;
	liveRunStack.set(receipt.runId, details);
	ensureRunSpinner();
	refreshRunStackWidget();
	const popCard = (): void => {
		liveRunStack.delete(receipt.runId);
		refreshRunStackWidget();
	};
	void done.then(
		(run) => {
			popCard();
			try {
				pi.sendMessage(
					{ customType: "subagent-result", content: completionMessageText(run), display: true, details: run },
					{ triggerTurn: true },
				);
			} catch (error) {
				console.error("Failed to deliver subagent result message:", error);
			}
		},
		(error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			popCard();
			// Runs aborted by session shutdown have no result to report.
			if (message === "Subagent was aborted") return;
			try {
				pi.sendMessage(
					{
						customType: "subagent-result",
						content: `Subagent "${receipt.agent}" (run ${receipt.runId}) could not run: ${truncate(message, 2000)}`,
						display: true,
						details: { kind: "receipt", ...receipt },
					},
					{ triggerTurn: true },
				);
			} catch (deliveryError) {
				console.error("Failed to deliver subagent failure message:", deliveryError);
			}
		},
	);
	return receiptResult(receipt);
}

/** Start a fresh background run with live-card refreshes wired to its progress events. */
function startLiveBackgroundRun(options: BackgroundRunOptions): StartedBackgroundRun {
	let started: StartedBackgroundRun | undefined;
	started = startBackgroundRun({
		...options,
		onProgress: () => {
			if (started) refreshRunStackWidget();
		},
	});
	return started;
}

/** Resume a finished run in the background with the same live-card wiring. */
function startLiveBackgroundResume(options: BackgroundResumeOptions): StartedBackgroundRun {
	let started: StartedBackgroundRun | undefined;
	started = startBackgroundResume({
		...options,
		onProgress: () => {
			if (started) refreshRunStackWidget();
		},
	});
	return started;
}

/**
 * Completion card: the run's final state, shaped like the live stack card.
 *
 * Rendered as the `[subagent-result]` message. Collapsed it shows the header
 * plus an output preview; Ctrl+O expands to the full Markdown output. The full
 * result also stays in the model context.
 */
function renderCompletionCard(run: SubagentRunDetails, expanded: boolean, theme: Theme): Component {
	const stopped = run.stop !== undefined;
	const failed = isFailedRun(run);
	const icon = stopped ? theme.fg("warning", "■") : failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const usage = formatUsage(run);
	const ctxUsage = contextUsageText(run);
	const modelRef = subagentModelRef(run);
	const historyLink = historyLinkText(run, theme);
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

	const output = run.output?.trim();
	if (expanded && output) {
		const container = new Container();
		container.addChild(new Text(header, 0, 0));
		if (stopped) container.addChild(new Text(theme.fg("muted", stopLineText(run)), 0, 0));
		else if (historyLink) container.addChild(new Text(theme.fg("dim", HISTORY_OPEN_HINT), 0, 0));
		else if (run.history) container.addChild(new Text(theme.fg("dim", historyHintText(run)), 0, 0));
		if (failed && (run.errorMessage || run.stderr.trim())) {
			container.addChild(new Text(theme.fg("error", truncate(run.errorMessage ?? run.stderr, 1000)), 0, 0));
		}
		container.addChild(new Markdown(output, 0, 0, getMarkdownTheme()));
		return new LeftBorderCard(container, theme);
	}

	let text = header;
	if (stopped) {
		text += `\n${theme.fg("muted", stopLineText(run))}`;
	} else if (failed && (run.errorMessage || run.stderr.trim())) {
		text += `\n${theme.fg("error", truncate(run.errorMessage ?? run.stderr, 300))}`;
	} else if (output) {
		const lines = output.split("\n").slice(0, 3).map((line) => truncate(line, 200));
		text += `\n${theme.fg("toolOutput", lines.join("\n"))}`;
		if (output.split("\n").length > 3) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	} else {
		text += `\n${theme.fg("muted", "(no output)")}`;
		if (!historyLink && run.history) text += `\n${theme.fg("dim", historyHintText(run))}`;
	}
	return new LeftBorderCard(new Text(text, 0, 0), theme);
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

/** Human-readable lines for a run's stored outcome. */
function outcomeLines(outcome: RunOutcome): string[] {
	const parts = [`exit ${outcome.exitCode}`];
	if (outcome.stop) parts.push("stopped by user");
	// "stop" is the normal assistant stopReason; only surface meaningful ones (error, aborted, length, …).
	else if (outcome.stopReason && outcome.stopReason !== "stop") parts.push(outcome.stopReason);
	if (outcome.usage.turns > 0) parts.push(`${outcome.usage.turns} turn${outcome.usage.turns === 1 ? "" : "s"}`);
	if (outcome.usage.output > 0) parts.push(`↓${formatTokens(outcome.usage.output)}`);
	if (outcome.usage.cost > 0) parts.push(`$${outcome.usage.cost.toFixed(4)}`);
	const lines = [parts.join(" · ")];
	const body = outcome.output.trim() || outcome.errorMessage?.trim() || outcome.stderr.trim();
	if (body) lines.push("", truncate(body, 1500));
	return lines;
}

/** `status <run>`: one run's contract, location, attempt tasks, and stored outcome. */
async function statusDetailText(sessionUuid: string, runId: string, record: RunRecord): Promise<string> {
	const paths = runHistoryPathsFor(sessionUuid, runId);
	const history = (await runHistoryPageUrl(paths.urlPath)) ?? paths.htmlFile;
	const attempts = record.tasks.length;
	const countLabel = attempts > 1 ? `, ${attempts} attempts` : "";
	const lines = [
		`Run ${runId} — ${record.agent} (${displayStatus(record)}${countLabel})`,
		`cwd: ${record.cwd}`,
		`model: ${record.agentContract.model} · thinking ${record.agentContract.thinking} · tools ${record.agentContract.tools.join(",")}`,
		`history: ${history}`,
		"",
		"tasks:",
		...record.tasks.map((task, index) => `  ${index + 1}. ${taskSummary(task)}`),
	];
	if (record.result) lines.push("", "result:", ...outcomeLines(record.result));
	return lines.join("\n");
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

/** "run" action: resolve the agent, launch a background run, return its receipt. */
function executeRun(
	pi: ExtensionAPI,
	params: SubagentToolInput,
	ctx: ExtensionContext,
): AgentToolResult<SubagentToolDetails> {
	const agentName = params.agent?.trim() ?? "";
	const task = params.task?.trim() ?? "";
	const roster = loadProjectAgents(ctx.cwd);
	const agent = roster.agents.get(agentName);
	if (!agent) return textResult(unknownAgentText(agentName, roster));

	rememberModelRegistry(ctx);
	// fork-context agents receive the parent conversation as a serialized transcript.
	const forkTranscript =
		agent.context === "fork" ? serializeForkContext(ctx.sessionManager.buildContextEntries()) || undefined : undefined;

	return launchBackgroundRun(pi, startLiveBackgroundRun({
		agent,
		task,
		cwd: ctx.cwd,
		sessionUuid: ctx.sessionManager.getSessionId(),
		forkTranscript,
	}));
}

/** "resume" action: continue a finished run in the background, return its receipt. */
async function executeResume(
	pi: ExtensionAPI,
	params: SubagentToolInput,
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
	return launchBackgroundRun(pi, startLiveBackgroundResume({
		record,
		runDir: dir,
		sessionUuid,
		task,
	}));
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
	pi: ExtensionAPI,
	params: SubagentToolInput,
	ctx: ExtensionContext,
): Promise<AgentToolResult<SubagentToolDetails>> {
	lastUiContext = ctx;
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
		return executeResume(pi, params, ctx);
	}
	if (!params.agent?.trim()) return textResult('subagent({action:"run"}) requires the agent name in "agent".');
	if (!params.task?.trim()) return textResult('subagent({action:"run"}) requires the task in "task".');
	return executeRun(pi, params, ctx);
}

/** Run a delegation from /subagent in the background; the result arrives as a message. */
async function runCommandDelegation(
	pi: ExtensionAPI,
	agent: AgentDefinition,
	task: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	lastUiContext = ctx;
	const forkTranscript =
		agent.context === "fork" ? serializeForkContext(ctx.sessionManager.buildContextEntries()) || undefined : undefined;

	rememberModelRegistry(ctx);
	const started = startLiveBackgroundRun({
		agent,
		task,
		cwd: ctx.cwd,
		sessionUuid: ctx.sessionManager.getSessionId(),
		forkTranscript,
	});
	launchBackgroundRun(pi, started);
	ctx.ui.notify(
		`Subagent "${agent.name}" started in the background (run ${started.receipt.runId}). Its result arrives in the chat.`,
		"info",
	);
}

function registerSubagentTool(pi: ExtensionAPI, roster: AgentLoadResult | null): void {
	pi.registerTool<typeof subagentSchema, SubagentToolDetails>({
		name: "subagent",
		label: "Subagent",
		description: buildToolDescription(roster),
		promptSnippet: "Delegate a task to a named subagent configured in .pi/agents, resume a finished run, or list this session's runs.",
		promptGuidelines: [
			"Use subagent when a task matches one of the configured subagent descriptions; pass the full, self-contained task text as task.",
			"Runs are asynchronous: after starting one, keep working or end your turn, but never poll for progress. The [subagent-result] message arrives on its own and wakes you; if the next step needs that result, wait for the message instead of guessing.",
			'To give a finished subagent follow-up work that builds on what it already did, resume it with action "resume" and its run id instead of starting a new run.',
			'Use action "status" when you need the run ids of subagents started earlier in this session, to check progress, or to recover a result whose message you missed.',
		],
		parameters: subagentSchema,
		// Runs live in the input-area run stack, not the transcript: "self" drops
		// the standard shell and its spacer when call and result render empty.
		renderShell: "self",
		execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeDelegation(pi, params, ctx);
		},
		renderCall(args, theme) {
			if ((args.action ?? "run") === "status") {
				const target = args.run ? ` ${theme.fg("accent", args.run)}` : "";
				return new Text(`${theme.fg("toolTitle", theme.bold("subagent status"))}${target}`, 0, 0);
			}
			// The run card lives in the input-area run stack, not in the transcript.
			return new Text("", 0, 0);
		},
		renderResult(result, _options, _theme) {
			const details = result.details;
			if ("kind" in details && details.kind === "receipt") return new Text("", 0, 0);
			const first = result.content[0];
			return new Text(first?.type === "text" ? first.text : "(no output)", 0, 0);
		},
	});
}

export default function (pi: ExtensionAPI) {
	// Children spawned by startSubagent carry CHILD_ENV and must not be able to
	// delegate further — skip all registration in child processes.
	if (process.env[CHILD_ENV] === "1") return;

	registerSubagentTool(pi, null);

	// The completion message renders the run's final card: header, output
	// preview (Ctrl+O expands to Markdown), and the history link.
	pi.registerMessageRenderer<SubagentRunDetails | SubagentReceiptDetails>("subagent-result", (message, options, theme) => {
		const details = message.details;
		if (!details || "kind" in details) return undefined;
		return renderCompletionCard(details, options.expanded, theme);
	});

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

	// Background children belong to this process: kill them when the session
	// shuts down (quit, reload, or session replacement).
	pi.on("session_shutdown", () => {
		stopAllBackgroundRuns();
		stopRunSpinner();
		liveRunStack.clear();
		lastUiContext = undefined;
		stackWidgetTui = undefined;
		stackWidgetMounted = false;
	});

	pi.on("session_start", async (_event, ctx) => {
		lastUiContext = ctx;
		// A session replacement clears extension widgets without notifying us.
		stackWidgetTui = undefined;
		stackWidgetMounted = false;
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