/**
 * Run records: persisted state for one subagent run.
 *
 * Every run directory holds a `run.json` next to its `session.jsonl` and
 * `history.html` (see run-history.ts). The record is what lets a finished run
 * be listed and resumed: the launch snapshot (`agentContract`) replays the
 * exact model/thinking/tools/system prompt, `cwd` says where to spawn, `tasks`
 * labels the attempts, and `childPid` tells a live run from a crashed one.
 *
 * Status is one of four stored states — `running | complete | failed |
 * stopped`; "interrupted" is a display label for a `running` record whose
 * child pid is gone (see displayStatus), never a stored state.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { sessionArtifactsDir } from "./run-history.ts";

/** File name of the record inside a run directory. */
export const RUN_RECORD_FILE_NAME = "run.json";

/** Current record format version; unknown versions are refused. */
export const RUN_RECORD_VERSION = 1;

/** Stored run states. */
export type RunStatus = "running" | "complete" | "failed" | "stopped";

/** Launch snapshot a resume replays exactly. */
export interface RunAgentContract {
	model: string;
	thinking: string;
	tools: string[];
	projectContext: boolean;
	systemPrompt: string;
}

/** Persisted state of one subagent run. */
export interface RunRecord {
	version: typeof RUN_RECORD_VERSION;
	agent: string;
	cwd: string;
	status: RunStatus;
	/** Last state change; used for ordering and "updated X ago". */
	updatedAt: string;
	/** Child process pid while running, null once settled. */
	childPid: number | null;
	agentContract: RunAgentContract;
	/** Original task first; one entry per resume attempt. */
	tasks: string[];
}

const RUN_STATUSES: ReadonlySet<string> = new Set(["running", "complete", "failed", "stopped"]);

/** Validate a parsed record; returns the record or a human-readable problem. */
function parseRunRecord(value: unknown): RunRecord | string {
	if (!value || typeof value !== "object" || Array.isArray(value)) return "record is not an object";
	const candidate = value as Record<string, unknown>;
	if (candidate.version !== RUN_RECORD_VERSION) return `unsupported record version "${String(candidate.version)}"`;
	if (typeof candidate.agent !== "string" || !candidate.agent.trim()) return "agent is missing";
	if (typeof candidate.cwd !== "string" || !candidate.cwd.trim()) return "cwd is missing";
	if (typeof candidate.status !== "string" || !RUN_STATUSES.has(candidate.status)) {
		return `status "${String(candidate.status)}" is invalid`;
	}
	if (typeof candidate.updatedAt !== "string") return "updatedAt is missing";
	if (candidate.childPid !== null && !Number.isInteger(candidate.childPid)) return "childPid is invalid";
	const contract = candidate.agentContract;
	if (!contract || typeof contract !== "object" || Array.isArray(contract)) return "agentContract is missing";
	const contractRecord = contract as Record<string, unknown>;
	for (const field of ["model", "thinking", "systemPrompt"] as const) {
		if (typeof contractRecord[field] !== "string") return `agentContract.${field} is invalid`;
	}
	if (!Array.isArray(contractRecord.tools) || contractRecord.tools.some((tool) => typeof tool !== "string")) {
		return "agentContract.tools is invalid";
	}
	if (typeof contractRecord.projectContext !== "boolean") return "agentContract.projectContext is invalid";
	if (!Array.isArray(candidate.tasks) || candidate.tasks.some((task) => typeof task !== "string" || !task.trim())) {
		return "tasks is invalid";
	}
	if (candidate.tasks.length === 0) return "tasks is empty";
	return candidate as unknown as RunRecord;
}

/** Outcome of reading a run directory's record. */
export type RunRecordLoad =
	| { kind: "ok"; record: RunRecord }
	| { kind: "missing" }
	| { kind: "invalid"; message: string };

/** Read and validate the record in one run directory. */
export function loadRunRecord(dir: string): RunRecordLoad {
	const file = path.join(dir, RUN_RECORD_FILE_NAME);
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { kind: "missing" };
		return { kind: "invalid", message: error instanceof Error ? error.message : String(error) };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return { kind: "invalid", message: error instanceof Error ? error.message : String(error) };
	}
	const result = parseRunRecord(parsed);
	if (typeof result === "string") return { kind: "invalid", message: result };
	return { kind: "ok", record: result };
}

/** Atomically write the record (tmp + rename) so readers never see a partial file. */
export function writeRunRecord(dir: string, record: RunRecord): void {
	const file = path.join(dir, RUN_RECORD_FILE_NAME);
	const tmp = `${file}.${process.pid}.tmp`;
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	try {
		fs.renameSync(tmp, file);
	} catch (error) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* ignore */
		}
		throw error;
	}
}

/** Merge a patch into the stored record; throws when the record is missing or invalid. */
export function updateRunRecord(dir: string, patch: Partial<Omit<RunRecord, "version">>): void {
	const load = loadRunRecord(dir);
	if (load.kind !== "ok") {
		throw new Error(`Run record at ${dir} is ${load.kind}${load.kind === "invalid" ? `: ${load.message}` : ""}`);
	}
	writeRunRecord(dir, { ...load.record, ...patch });
}

/** One run with a readable record. */
export interface KnownRun {
	runId: string;
	dir: string;
	record: RunRecord;
}

/** All readable runs under the parent session, newest first. */
export function listRuns(sessionUuid: string): KnownRun[] {
	const root = sessionArtifactsDir(sessionUuid);
	let names: string[];
	try {
		names = fs.readdirSync(root);
	} catch {
		return [];
	}
	const runs: KnownRun[] = [];
	for (const name of names) {
		const dir = path.join(root, name);
		if (!isDirectory(dir)) continue;
		const load = loadRunRecord(dir);
		if (load.kind === "ok") runs.push({ runId: name, dir, record: load.record });
	}
	return runs.sort((left, right) => right.record.updatedAt.localeCompare(left.record.updatedAt));
}

/** Result of resolving a run id (or unique prefix) inside one parent session. */
export type RunLookup =
	| { kind: "ok"; runId: string; dir: string; record: RunRecord }
	| { kind: "unknown" }
	| { kind: "no-record"; runId: string }
	| { kind: "invalid-record"; runId: string; message: string }
	| { kind: "ambiguous"; matches: string[] };

/** Run ids are path segments: agent-name + hex, never dots or slashes. */
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Resolve a run id or unique prefix within one parent session. An exact
 * directory match wins; otherwise a unique prefix resolves and ambiguity is
 * reported with the matching ids.
 */
export function resolveRun(sessionUuid: string, reference: string): RunLookup {
	const ref = reference.trim();
	if (!ref || !RUN_ID_RE.test(ref)) return { kind: "unknown" };
	const root = sessionArtifactsDir(sessionUuid);
	const exactDir = path.join(root, ref);
	if (isDirectory(exactDir)) return loadLookup(ref, exactDir);
	let names: string[];
	try {
		names = fs.readdirSync(root);
	} catch {
		return { kind: "unknown" };
	}
	const matches = names.filter((name) => name.startsWith(ref) && isDirectory(path.join(root, name))).sort();
	if (matches.length === 0) return { kind: "unknown" };
	if (matches.length > 1) return { kind: "ambiguous", matches };
	return loadLookup(matches[0]!, path.join(root, matches[0]!));
}

function loadLookup(runId: string, dir: string): RunLookup {
	const load = loadRunRecord(dir);
	if (load.kind === "ok") return { kind: "ok", runId, dir, record: load.record };
	if (load.kind === "missing") return { kind: "no-record", runId };
	return { kind: "invalid-record", runId, message: load.message };
}

/** True when the pid names a live process (EPERM means alive, owned by someone else). */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** True while the recorded child process is still alive. */
export function runIsInFlight(record: RunRecord): boolean {
	return record.status === "running" && record.childPid !== null && isProcessAlive(record.childPid);
}

/** Stored status, or "interrupted" when a running record's child is gone. */
export type RunDisplayStatus = RunStatus | "interrupted";

export function displayStatus(record: RunRecord): RunDisplayStatus {
	return record.status === "running" && !runIsInFlight(record) ? "interrupted" : record.status;
}

/** Whether a finished run can be resumed, and why not when it cannot. */
export type RunResumability = { resumable: true } | { resumable: false; reason: string };

export function resumability(record: RunRecord, dir: string): RunResumability {
	if (record.status === "stopped") return { resumable: false, reason: "stopped by user" };
	if (runIsInFlight(record)) return { resumable: false, reason: "in flight" };
	if (!fs.existsSync(path.join(dir, "session.jsonl"))) return { resumable: false, reason: "session file missing" };
	if (!isDirectory(record.cwd)) return { resumable: false, reason: "working directory missing" };
	return { resumable: true };
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}
