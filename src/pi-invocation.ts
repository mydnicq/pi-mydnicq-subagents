/**
 * Resolution of the pi binary to invoke for child processes and subprocess
 * helpers (e.g. exporting a run history session file to HTML). Shared by the
 * child runner and the run history exporter so both use the same invocation.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Resolve how to invoke the same pi binary this extension is running inside.
 * Mirrors the official subagent example: reuse the current entry script when
 * it exists on disk, fall back to the `pi` executable.
 */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };

	return { command: "pi", args };
}