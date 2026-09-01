/**
 * Loader for project subagent definitions.
 *
 * Agents are defined as Markdown files with YAML frontmatter in
 * `<project>/.pi/agents/*.md`:
 *
 *   ---
 *   name: reviewer
 *   description: Reviews code changes
 *   model: anthropic/claude-sonnet-4-5
 *   thinking: high
 *   context: fork
 *   ---
 *   System prompt goes here.
 *
 * The frontmatter `name` defines the agent name; the Markdown body is the
 * agent's system prompt. The file name is organizational only.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

/** Subdirectory of the project config dir that holds agent files. */
export const AGENTS_DIR_NAME = "agents";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type AgentThinkingLevel = (typeof THINKING_LEVELS)[number];

/** How a subagent inherits context from the parent conversation. */
export const CONTEXT_MODES = ["fresh", "fork"] as const;
export type AgentContextMode = (typeof CONTEXT_MODES)[number];

/** Frontmatter fields understood by this loader; anything else produces a warning. */
const KNOWN_FIELDS = new Set(["name", "description", "model", "thinking", "context"]);

/** A single agent definition parsed from a .md file. */
export interface AgentDefinition {
	/** Unique agent name, referenced by the subagent tool. */
	name: string;
	/** Short description of what the agent is for. */
	description: string;
	/** Model to run the agent on, e.g. "anthropic/claude-sonnet-4-5". */
	model: string;
	/** Thinking level for the agent. */
	thinking: AgentThinkingLevel;
	/** How the child inherits context: "fresh" = new session, "fork" = branch from the parent session. */
	context: AgentContextMode;
	/** System prompt (the Markdown body). */
	systemPrompt: string;
}

export interface AgentLoadDiagnostic {
	file: string;
	message: string;
}

export interface AgentLoadResult {
	/** Agent definitions keyed by agent name (the file name without extension). */
	agents: Map<string, AgentDefinition>;
	/** Non-fatal problems (unknown fields, empty prompt). */
	warnings: AgentLoadDiagnostic[];
	/** Fatal per-file problems (bad YAML, missing required fields). */
	errors: AgentLoadDiagnostic[];
	/** Absolute path of the agents directory that was scanned. */
	agentsDir: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
/** Agent names come from file names; keep them tool-parameter safe. */
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** Split a raw file into frontmatter source and body. frontmatter is null when absent. */
export function splitFrontmatter(raw: string): { frontmatter: string | null; body: string } {
	const match = FRONTMATTER_RE.exec(raw);
	if (!match) return { frontmatter: null, body: raw };
	return { frontmatter: match[1] ?? null, body: raw.slice(match[0].length).trim() };
}

/** Parse a single agent file. Never throws; problems are reported via errors/warnings. */
export function parseAgentDefinition(file: string, raw: string): {
	agent: AgentDefinition | null;
	warnings: AgentLoadDiagnostic[];
	errors: AgentLoadDiagnostic[];
} {
	const warnings: AgentLoadDiagnostic[] = [];
	const errors: AgentLoadDiagnostic[] = [];

	const { frontmatter, body } = splitFrontmatter(raw);
	if (frontmatter === null) {
		// Not an agent file at all (e.g. a stray README) — skip quietly, like pi's skill discovery.
		return { agent: null, warnings, errors };
	}

	let fields: unknown;
	try {
		fields = parseYaml(frontmatter);
	} catch (err) {
		errors.push({ file, message: `Invalid YAML frontmatter: ${err instanceof Error ? err.message : String(err)}` });
		return { agent: null, warnings, errors };
	}

	if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
		errors.push({ file, message: "Frontmatter must be a YAML mapping of key: value pairs." });
		return { agent: null, warnings, errors };
	}

	const record = fields as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!KNOWN_FIELDS.has(key)) {
			warnings.push({ file, message: `Unknown frontmatter field "${key}" ignored.` });
		}
	}

	const fail = (message: string) => {
		errors.push({ file, message });
		return { agent: null, warnings, errors };
	};

	// `name` is required: it defines the agent name (the file name is organizational only).
	const nameRaw = record.name;
	if (typeof nameRaw !== "string" || nameRaw.trim() === "") {
		return fail('Missing required frontmatter field "name".');
	}
	const name = nameRaw.trim();
	if (!NAME_RE.test(name)) {
		return fail(
			`Invalid "name" value "${nameRaw}" — use lowercase letters, digits, "-" or "_".`,
		);
	}

	// `description` is required: the parent model needs it to pick an agent.
	const description = record.description;
	if (typeof description !== "string" || description.trim() === "") {
		return fail('Missing required frontmatter field "description".');
	}

	// `model` is required: there are no overrides — every agent declares its model.
	const model = record.model;
	if (typeof model !== "string" || model.trim() === "") {
		return fail('Missing required frontmatter field "model".');
	}

	// `thinking` is required: there are no overrides — every agent declares its level.
	const thinkingRaw = record.thinking;
	if (typeof thinkingRaw !== "string") {
		return fail('Missing required frontmatter field "thinking".');
	}
	const thinking = thinkingRaw.trim().toLowerCase();
	if (!THINKING_LEVELS.includes(thinking as AgentThinkingLevel)) {
		return fail(
			`Invalid "thinking" value "${thinkingRaw}" — expected one of: ${THINKING_LEVELS.join(", ")}.`,
		);
	}

	// `context` is required: every agent declares how it inherits parent context.
	const contextRaw = record.context;
	if (typeof contextRaw !== "string") {
		return fail('Missing required frontmatter field "context" ("fresh" or "fork").');
	}
	const context = contextRaw.trim().toLowerCase();
	if (!CONTEXT_MODES.includes(context as AgentContextMode)) {
		return fail(`Invalid "context" value "${contextRaw}" — expected "fresh" or "fork".`);
	}

	if (body.trim() === "") {
		warnings.push({ file, message: "Empty system prompt (Markdown body is empty)." });
	}

	return {
		agent: {
			name,
			description: description.trim(),
			model: model.trim(),
			thinking: thinking as AgentThinkingLevel,
			context: context as AgentContextMode,
			systemPrompt: body,
		},
		warnings,
		errors,
	};
}

/**
 * Walk up from `startDir` to the nearest ancestor containing a config dir
 * (matching pi's project-config resolution). Falls back to `startDir` itself
 * when none is found, so `.pi/agents` created there later is picked up.
 */
export function findProjectConfigDir(startDir: string): string {
	let dir = path.resolve(startDir);
	for (;;) {
		if (isDirectory(path.join(dir, CONFIG_DIR_NAME))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return path.resolve(startDir);
		dir = parent;
	}
}

/** Absolute path of the agents dir for a project dir. */
export function getAgentsDir(projectDir: string): string {
	return path.join(projectDir, CONFIG_DIR_NAME, AGENTS_DIR_NAME);
}

/**
 * Load all agent definitions from `<project>/.pi/agents/*.md`, keyed by the
 * frontmatter `name`. Never throws; per-file problems are collected in
 * warnings/errors.
 */
export function loadProjectAgents(cwd: string): AgentLoadResult {
	const agentsDir = getAgentsDir(findProjectConfigDir(cwd));
	const result: AgentLoadResult = { agents: new Map(), warnings: [], errors: [], agentsDir };

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(agentsDir, { withFileTypes: true });
	} catch {
		return result; // no agents dir (or unreadable) — no agents, no diagnostics
	}

	const nameSources = new Map<string, string>(); // agent name → file that declared it first
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const file = path.join(agentsDir, entry.name);
		let raw: string;
		try {
			raw = fs.readFileSync(file, "utf8");
		} catch (err) {
			result.errors.push({ file, message: `Unreadable: ${err instanceof Error ? err.message : String(err)}` });
			continue;
		}
		const parsed = parseAgentDefinition(file, raw);
		result.warnings.push(...parsed.warnings);
		result.errors.push(...parsed.errors);
		if (!parsed.agent) continue;
		const existing = nameSources.get(parsed.agent.name);
		if (existing) {
			result.errors.push({
				file,
				message: `Duplicate agent name "${parsed.agent.name}" — already defined in ${existing}.`,
			});
			continue;
		}
		nameSources.set(parsed.agent.name, file);
		result.agents.set(parsed.agent.name, parsed.agent);
	}

	return result;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}