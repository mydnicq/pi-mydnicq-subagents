/**
 * Run history: HTML export of a subagent run's live session transcript.
 *
 * Each run persists its child session under the shared run history root,
 * grouped by the parent session's uuid (<root>/<sessionUuid>/<runId>), and
 * re-exports that file to an HTML page as the run progresses, reusing pi's
 * built-in /export HTML pipeline. The page carries the agent's system prompt
 * (body plus the appended context-file section — see composeHistorySystemPrompt
 * in loader.ts) and its `tools` allowlist (resolved to builtin pi tool
 * definitions) so the browser view shows what the subagent could see and do. The subagent run
 * card links to the page (one
 * shared loopback server for all pi sessions serves it by path) so the
 * transcript can be followed in a browser while the run is in flight.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SessionManager, createCodingTools, createPowerShellTool } from "@earendil-works/pi-coding-agent";
import { getPiInvocation } from "./pi-invocation.ts";
import { RUN_HISTORY_ROOT, runHistoryPageUrl } from "./run-history-server.ts";

const execFileAsync = promisify(execFile);

/** Minimum interval between HTML re-exports of one run (browser refresh cadence). */
const RUN_HISTORY_EXPORT_INTERVAL_MS = 2_000;

/** Where one run's session file and HTML export live. */
export interface RunHistoryPaths {
	/** Run directory under the shared root: <root>/<sessionUuid>/<runId>. */
	dir: string;
	/** Child session JSONL, written live by the child pi process. */
	sessionFile: string;
	/** HTML export of the transcript; overwritten on every export. */
	htmlFile: string;
	/** URL path under the shared server: <sessionUuid>/<runId>. */
	urlPath: string;
}

/** Tool metadata for the history page's "Available Tools" section. */
export interface HistoryToolInfo {
	name: string;
	description: string;
	parameters: unknown;
}

/**
 * Resolve an agent's `tools` allowlist to builtin pi tool definitions (the
 * loader guarantees every name is a builtin). Names without a matching
 * definition — only possible if pi's builtin set changes under us — fall back
 * to a bare name entry.
 */
export function historyToolInfos(cwd: string, tools: readonly string[]): HistoryToolInfo[] {
	const byName = new Map<string, HistoryToolInfo>();
	for (const tool of [...createCodingTools(cwd), createPowerShellTool(cwd)]) {
		byName.set(tool.name, { name: tool.name, description: tool.description, parameters: tool.parameters });
	}
	return tools.map((name) => byName.get(name) ?? { name, description: name, parameters: undefined });
}

/** Outcome of the most recent HTML export attempt for a run. */
export interface RunHistoryStatus {
	/** HTML page file the run history is exported to (fallback when no server URL). */
	htmlFile: string;
	/** http://127.0.0.1 URL serving the page live; herdr's link opener only opens http(s). */
	url?: string;
	/** Error from the most recent export attempt, when it failed. */
	lastError?: string;
}

/** Parts of pi's export-html module used here (deep import, not a public export). */
interface PiExportHtmlModule {
	/** Export a SessionManager to HTML; state may carry systemPrompt/tools (partial AgentState). */
	exportSessionToHtml(
		sm: unknown,
		state?: { systemPrompt?: string; tools?: Array<{ name: string; description: string; parameters: unknown }> } | undefined,
		options?: { outputPath?: string; themeName?: string } | string,
	): Promise<string>;
	/** Export a session JSONL file to HTML (standalone, no AgentState). */
	exportFromFile(inputPath: string, options?: { outputPath?: string; themeName?: string }): Promise<string>;
}

/**
 * Locate the running pi package's export-html module. Preferred: resolve the
 * package by specifier (works no matter what process.argv[1] is — e.g. volta
 * shims); fallback: walk up from the CLI entry point (process.argv[1], e.g.
 * `<pkg>/dist/bundle/cli.js`).
 */
function findPiExportHtmlModule(): string | undefined {
	try {
		const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
		const candidate = path.join(path.dirname(entry), "core", "export-html", "index.js");
		if (fs.existsSync(candidate)) return candidate;
	} catch {
		/* specifier resolution unavailable in this runtime */
	}
	const cliEntry = process.argv[1];
	if (!cliEntry) return undefined;
	let dir = path.dirname(cliEntry);
	for (let i = 0; i < 8; i++) {
		const candidate = path.join(dir, "dist", "core", "export-html", "index.js");
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
	return undefined;
}

/**
 * Export a run's session file to its HTML page using pi's /export pipeline:
 * in-process `exportSessionToHtml()` when the module is found (with the
 * agent's system prompt injected — session files don't record it), otherwise
 * a `pi --export <session.jsonl> <output>` subprocess (same pipeline, no
 * system prompt). Works on partial session files, so it is safe to call while
 * the run is still writing the session. Throws on failure; callers decide
 * what to record.
 */
export async function exportRunHistoryToHtml(
	paths: RunHistoryPaths,
	systemPrompt?: string,
	tools?: HistoryToolInfo[],
): Promise<string> {
	const modulePath = findPiExportHtmlModule();
	if (modulePath) {
		const mod = (await import(modulePath)) as PiExportHtmlModule;
		if (systemPrompt || (tools && tools.length > 0)) {
			const sm = SessionManager.open(paths.sessionFile);
			return mod.exportSessionToHtml(sm, { systemPrompt, tools }, { outputPath: paths.htmlFile });
		}
		return mod.exportFromFile(paths.sessionFile, { outputPath: paths.htmlFile });
	}
	const invocation = getPiInvocation(["--export", paths.sessionFile, paths.htmlFile]);
	await execFileAsync(invocation.command, invocation.args);
	return paths.htmlFile;
}

/** Sanitize a path segment for the shared root (uuids pass through unchanged). */
function sanitizePathSegment(value: string): string {
	return value.replace(/[^0-9A-Za-z_-]/g, "_");
}

/**
 * Create the run directory under the shared run history root, grouped by the
 * parent session's uuid so every session's runs are linked under its id:
 * <root>/<sessionUuid>/<agent>-<hex>/.
 */
export function createRunHistoryPaths(sessionUuid: string, agentName: string): RunHistoryPaths {
	const runId = `${sanitizePathSegment(agentName)}-${randomBytes(4).toString("hex")}`;
	const dir = path.join(RUN_HISTORY_ROOT, sanitizePathSegment(sessionUuid), runId);
	fs.mkdirSync(dir, { recursive: true });
	return {
		dir,
		sessionFile: path.join(dir, "session.jsonl"),
		htmlFile: path.join(dir, "history.html"),
		urlPath: `${sanitizePathSegment(sessionUuid)}/${runId}`,
	};
}

/**
 * Serializes and rate-limits HTML re-exports for one run, so a fast stream of
 * child messages cannot spawn a backlog of export jobs. Coalesces requests
 * into at most one in-flight export plus one trailing export per throttle
 * window; flushExport() runs a final export regardless of the window.
 */
export class RunHistoryExporter {
	private readonly paths: RunHistoryPaths;
	private readonly systemPrompt: string | undefined;
	private readonly tools: HistoryToolInfo[] | undefined;
	private lastExportStartedAt = 0;
	private inFlight: Promise<RunHistoryStatus> | null = null;
	private trailingRequest = false;
	private status: RunHistoryStatus;

	constructor(paths: RunHistoryPaths, url: string | undefined, systemPrompt?: string, tools?: HistoryToolInfo[]) {
		this.paths = paths;
		this.systemPrompt = systemPrompt;
		this.tools = tools;
		this.status = { htmlFile: paths.htmlFile, url };
	}

	/** Create the exporter and resolve its page URL on the shared server. */
	static async create(paths: RunHistoryPaths, systemPrompt?: string, tools?: HistoryToolInfo[]): Promise<RunHistoryExporter> {
		const url = await runHistoryPageUrl(paths.urlPath);
		return new RunHistoryExporter(paths, url, systemPrompt, tools);
	}

	/** Current export outcome; read this (not a cached copy) when emitting updates. */
	getStatus(): RunHistoryStatus {
		return this.status;
	}

	/** Request an export: immediate if the throttle window has passed, else one trailing export is queued. */
	scheduleExport(): void {
		if (this.inFlight) {
			this.trailingRequest = true;
			return;
		}
		if (Date.now() - this.lastExportStartedAt < RUN_HISTORY_EXPORT_INTERVAL_MS) {
			this.trailingRequest = true;
			return;
		}
		this.lastExportStartedAt = Date.now();
		this.inFlight = this.runExport().finally(() => {
			this.inFlight = null;
			if (this.trailingRequest) {
				this.trailingRequest = false;
				this.scheduleExport();
			}
		});
	}

	/** Run one export now, after any in-flight export settles (final export at run end). */
	async flushExport(): Promise<RunHistoryStatus> {
		await this.inFlight;
		return this.runExport();
	}

	private async runExport(): Promise<RunHistoryStatus> {
		try {
			await exportRunHistoryToHtml(this.paths, this.systemPrompt, this.tools);
			this.status = { htmlFile: this.paths.htmlFile, url: this.status.url };
		} catch (error) {
			this.status = {
				htmlFile: this.paths.htmlFile,
				url: this.status.url,
				lastError: error instanceof Error ? error.message : String(error),
			};
		}
		return this.status;
	}
}