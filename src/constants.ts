/**
 * Cross-module constants shared by the child runner, the run-history exporter,
 * the shared history server, and the child-side probe: the artifacts root
 * layout, its env overrides, and the file names/paths these modules agree on.
 */

import { fileURLToPath } from "node:url";
import * as os from "node:os";
import * as path from "node:path";

/** Env override for the parent directory of the artifacts root; the root folder is always `pi-mydnicq-subagents`. */
export const ARTIFACTS_DIR_ENV = "PI_MYDNICQ_SUBAGENTS_ARTIFACTS_DIR";

/** Shared root directory for all extension artifacts: run history, the shared-server registry, and temp files. */
export const ARTIFACTS_ROOT = path.join(
	process.env[ARTIFACTS_DIR_ENV]?.trim() || os.tmpdir(),
	"pi-mydnicq-subagents",
);

/** Name of the child-captured system prompt file inside a run directory (written by child-prompt-probe.ts). */
export const SYSTEM_PROMPT_CAPTURE_FILE_NAME = "system-prompt.md";

/** Absolute path of the child-side probe extension that captures the child's final system prompt for the history page. */
export const CHILD_PROMPT_PROBE_PATH = fileURLToPath(new URL("./child-prompt-probe.ts", import.meta.url));