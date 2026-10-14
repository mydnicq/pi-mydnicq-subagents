/**
 * Background subagent runs: runs that outlive the `subagent` tool call.
 *
 * A run is launched with `startSubagent`/`startResume` and tracked here so the
 * extension can:
 *
 * - own the abort signal (the tool-call signal must not kill a background run),
 * - stop every tracked run when the session shuts down.
 *
 * The caller collects the outcome from `done` and delivers it as a message.
 * The `result` stored in the run directory is the safety net when delivery
 * fails, so this module never depends on a coordination tool (e.g. intercom).
 */

import {
	startResume,
	startSubagent,
	type ResumeSubagentOptions,
	type StartedSubagentRun,
	type SubagentRunDetails,
	type SubagentRunOptions,
} from "./runner.ts";

/** What the caller asked for; enough to build the receipt and the completion message. */
export interface BackgroundRunReceipt {
	runId: string;
	dir: string;
	agent: string;
	task: string;
	/** Configured model reference the child runs with. */
	model: string;
	action: "run" | "resume";
	attempt: number;
}

/** A tracked run plus its receipt and live state. */
export interface StartedBackgroundRun {
	receipt: BackgroundRunReceipt;
	/** Mutable live run state, shared with the UI card until the run settles. */
	details: SubagentRunDetails;
	done: Promise<SubagentRunDetails>;
}

/** Fresh background-run launch options, plus a progress hook for the live card. */
export interface BackgroundRunOptions extends Omit<SubagentRunOptions, "signal" | "onUpdate"> {
	/** Called on each child progress event so the UI can refresh the live run card. */
	onProgress?: (() => void) | undefined;
}

/** Background resume options, plus a progress hook for the live card. */
export interface BackgroundResumeOptions extends Omit<ResumeSubagentOptions, "signal" | "onUpdate"> {
	/** Called on each child progress event so the UI can refresh the live run card. */
	onProgress?: (() => void) | undefined;
}

/** Abort controllers of runs in flight in this process, keyed by run id. */
const activeControllers = new Map<string, AbortController>();

function track(runId: string, controller: AbortController, done: Promise<SubagentRunDetails>): void {
	activeControllers.set(runId, controller);
	// Release the slot when the run settles. Handling the rejection here keeps
	// the caller's own `done` handlers as the only outcome consumers.
	void done
		.catch(() => undefined)
		.finally(() => {
			activeControllers.delete(runId);
		});
}

/** Start a fresh background run; returns as soon as the run record exists. */
export function startBackgroundRun(options: BackgroundRunOptions): StartedBackgroundRun {
	const { onProgress, ...launch } = options;
	const controller = new AbortController();
	const started = startSubagent({ ...launch, signal: controller.signal, onUpdate: () => onProgress?.() });
	track(started.runId, controller, started.done);
	return {
		receipt: {
			runId: started.runId,
			dir: started.dir,
			agent: options.agent.name,
			task: options.task,
			model: options.agent.model,
			action: "run",
			attempt: 1,
		},
		details: started.details,
		done: started.done,
	};
}

/** Resume a finished run in the background; returns as soon as the record is marked running. */
export function startBackgroundResume(options: BackgroundResumeOptions): StartedBackgroundRun {
	const { onProgress, ...launch } = options;
	const controller = new AbortController();
	const started = startResume({ ...launch, signal: controller.signal, onUpdate: () => onProgress?.() });
	track(started.runId, controller, started.done);
	return {
		receipt: {
			runId: started.runId,
			dir: started.dir,
			agent: options.record.agent,
			task: options.task,
			model: options.record.agentContract.model,
			action: "resume",
			attempt: options.record.tasks.length + 1,
		},
		details: started.details,
		done: started.done,
	};
}

/** Number of background runs still in flight in this process. */
export function backgroundRunCount(): number {
	return activeControllers.size;
}

/**
 * Abort every tracked run. Called when the extension runtime is torn down
 * (quit, reload, or session replacement); children are killed with the
 * session because they belong to this process.
 */
export function stopAllBackgroundRuns(): void {
	for (const controller of activeControllers.values()) controller.abort();
	activeControllers.clear();
}

export type { StartedSubagentRun };
