/**
 * Run history HTTP server: one shared, stateless loopback server for ALL pi
 * sessions on the machine, serving exported subagent transcripts by path from
 * the shared run history root directory:
 *
 *   http://127.0.0.1:<port>/<session-uuid>/<agent-runId>/history.html
 *
 * The session uuid links each session's history and exports (local-only setup;
 * no auth beyond the path). Sessions discover the running server through a
 * global registry file (<root>/server.json): whoever binds first writes it,
 * later sessions probe the registered port and reuse it; on a failed probe
 * (holder died) the next session binds a fresh ephemeral port and overwrites
 * the registry. Because serving is path-based, URLs keep working no matter
 * which session's process actually holds the port. Pages are static; a manual
 * browser refresh shows the latest export.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

/** Shared root directory all pi sessions export run history into. */
export const RUN_HISTORY_ROOT = path.join(os.tmpdir(), "pi-mydnicq-history");

/** Magic body of the /__history-ping probe; identifies our server on a port. */
const RUN_HISTORY_SERVER_MAGIC = "pi-mydnicq-history-server v1";

/** Registry file naming the port of the currently running shared server. */
const REGISTRY_FILE_NAME = "server.json";

/** How long to wait for the registry's server to answer the probe. */
const PROBE_TIMEOUT_MS = 300;

/** URL path segment characters allowed (uuids, agent names, hex run ids). */
const PATH_SEGMENT_PATTERN = "[0-9A-Za-z_-]+";

/** Serves GET /<sessionUuid>/<runId>/history.html and /__history-ping. */
function handleHistoryRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
	const match = new RegExp(`^/(${PATH_SEGMENT_PATTERN})/(${PATH_SEGMENT_PATTERN})/history\\.html$`)
		.exec((req.url ?? "").split("?")[0]);
	if (!match) {
		res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("Run history not found");
		return;
	}
	// Segments exclude "/" and "." (regex above), so the path stays inside the root.
	const runDir = path.join(RUN_HISTORY_ROOT, match[1], match[2]);
	let html: string;
	try {
		html = fs.readFileSync(path.join(runDir, "history.html"), "utf8");
	} catch {
		res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
		// ASCII-only body: text/plain responses may be decoded with a legacy
		// charset when the browser ignores the header, which mangles UTF-8 dashes.
		res.end("Run history not exported yet - try again in a moment");
		return;
	}
	res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
	res.end(html);
}

/** Base URL of the listening server, or undefined while it is not listening yet. */
function historyServerBaseUrl(): string | undefined {
	const address = server?.address();
	if (!server || !address || typeof address !== "object") return undefined;
	return `http://127.0.0.1:${address.port}`;
}

interface ServerRegistry {
	port: number;
	pid: number;
	startedAt: number;
}

function registryFilePath(): string {
	return path.join(RUN_HISTORY_ROOT, REGISTRY_FILE_NAME);
}

/** Read the global registry; undefined when absent or malformed. */
function readServerRegistry(): ServerRegistry | undefined {
	try {
		const entry = JSON.parse(fs.readFileSync(registryFilePath(), "utf8")) as ServerRegistry;
		if (entry && typeof entry.port === "number") return entry;
	} catch {
		/* missing or malformed registry */
	}
	return undefined;
}

/** Atomically publish this process as the registry's server holder. */
function writeServerRegistry(port: number): void {
	fs.mkdirSync(RUN_HISTORY_ROOT, { recursive: true });
	const tmp = `${registryFilePath()}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, JSON.stringify({ port, pid: process.pid, startedAt: Date.now() } satisfies ServerRegistry));
	fs.renameSync(tmp, registryFilePath());
}

/**
 * Probe the registry's port: returns its base URL when a live run history
 * server answers there, undefined when the registry is stale or the server died.
 */
async function probeRegisteredServer(): Promise<string | undefined> {
	const entry = readServerRegistry();
	if (!entry) return undefined;
	const base = `http://127.0.0.1:${entry.port}`;
	try {
		const res = await fetch(`${base}/__history-ping`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
		if (res.ok && (await res.text()) === RUN_HISTORY_SERVER_MAGIC) return base;
	} catch {
		/* port dead or held by a foreign app */
	}
	return undefined;
}

let server: http.Server | undefined;
/** In-flight or settled base-URL promise, shared by concurrent callers. */
let listeningUrl: Promise<string | undefined> | null = null;

/**
 * Return the shared server's base URL, starting it if no live server is
 * registered. Concurrent callers share one attempt; settled results are not
 * cached across runs so each run re-probes and fails over when the holder died.
 */
async function ensureRunHistoryServer(): Promise<string | undefined> {
	if (listeningUrl) return listeningUrl;
	const attempt = (async () => {
		const registered = await probeRegisteredServer();
		if (registered) return registered;

		const created = http.createServer(handleHistoryRequest);
		const bound = new Promise<number | undefined>((resolve) => {
			created.once("listening", () => {
				const address = created.address();
				resolve(address && typeof address === "object" ? address.port : undefined);
			});
			created.once("error", () => resolve(undefined));
		});
		created.listen(0, "127.0.0.1");
		const port = await bound;
		if (port === undefined) return undefined;
		writeServerRegistry(port);
		return `http://127.0.0.1:${port}`;
	})();
	listeningUrl = attempt;
	try {
		return await attempt;
	} finally {
		listeningUrl = null;
	}
}

/**
 * URL for one run's history page under its session uuid:
 * <base>/<sessionUuid>/<runIdPath>/history.html. Undefined when no server
 * could be started (caller falls back to the plain file path).
 */
export async function runHistoryPageUrl(urlPath: string): Promise<string | undefined> {
	const base = await ensureRunHistoryServer();
	return base ? `${base}/${urlPath}/history.html` : undefined;
}