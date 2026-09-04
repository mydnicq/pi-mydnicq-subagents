/**
 * Child-side system-prompt probe for run history.
 *
 * runner.ts passes this file to every child pi process via --extension. The
 * child's system prompt is assembled at runtime (base prompt, agent body,
 * context files, and any extension's before_agent_start edits); session files
 * never record it, and pi's export pipeline expects the caller to supply it
 * from runtime state. This probe observes the final chained prompt at
 * agent_start — after every extension has finished editing — and writes it to
 * the file named by PI_MYDNICQ_CAPTURE_SYSTEM_PROMPT (set by the parent to the
 * run's history directory). The run-history exporter prefers this capture over
 * its own reconstruction, so the page shows the child's actual prompt.
 *
 * No-op when the env var is unset. Best effort: write failures are ignored so
 * the child run is never affected.
 */

import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Env var holding the path the probe writes the captured system prompt to. */
export const CAPTURE_SYSTEM_PROMPT_ENV = "PI_MYDNICQ_CAPTURE_SYSTEM_PROMPT";

export default function (pi: ExtensionAPI) {
	pi.on("agent_start", async (_event, ctx) => {
		const target = process.env[CAPTURE_SYSTEM_PROMPT_ENV];
		if (!target) return;
		try {
			// Overwrite on every agent start: later turns may chain a different
			// prompt; the latest capture is the one the page should show.
			writeFileSync(target, ctx.getSystemPrompt(), { encoding: "utf8", mode: 0o600 });
		} catch {
			/* best effort — the parent falls back to its composed prompt */
		}
	});
}