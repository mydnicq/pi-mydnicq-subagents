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
 *
 * The probe also enforces the requested tool allowlist: pi silently ignores
 * unknown --tools names, so a child would otherwise run with a silently
 * reduced tool surface. When the parent sets PI_MYDNICQ_SUBAGENT_TOOLS, the
 * probe compares it against the child's active tools at agent_start and, if
 * any are missing, writes them to stderr and exits the child with code 1 —
 * before any model turn. The parent surfaces stderr as the run's failure.
 */

import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Env var holding the path the probe writes the captured system prompt to. */
export const CAPTURE_SYSTEM_PROMPT_ENV = "PI_MYDNICQ_CAPTURE_SYSTEM_PROMPT";

/** Env var with the comma-separated tool allowlist requested for this child. */
export const EXPECTED_TOOLS_ENV = "PI_MYDNICQ_SUBAGENT_TOOLS";

export default function (pi: ExtensionAPI) {
	pi.on("agent_start", async (_event, ctx) => {
		const expectedRaw = process.env[EXPECTED_TOOLS_ENV];
		if (expectedRaw !== undefined) {
			const expected = expectedRaw
				.split(",")
				.map((name) => name.trim())
				.filter(Boolean);
			const active = new Set(pi.getActiveTools());
			const missing = expected.filter((name) => !active.has(name));
			if (missing.length > 0) {
				process.stderr.write(
					`Requested tools are not active in the child pi process: ${missing.join(", ")}. ` +
						"Fix the agent's \"tools\" frontmatter or load the extension that registers them.\n",
				);
				process.exit(1);
			}
		}

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