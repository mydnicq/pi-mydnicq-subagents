# pi-mydnicq-subagents

A [pi](https://pi.dev) extension for delegating tasks to subagents.

Delegation spawns each subagent as an isolated `pi` child process
(`--mode json -p --no-session`) with the agent's own model, thinking level,
tool allowlist, and system prompt; the parent receives the child's final text
output. Nested delegation is disabled: child processes cannot run the
`subagent` tool again.

There are two ways to delegate:

- **Manual** — `/subagent <name> <task>` in the prompt. The result is injected
  into the conversation as a `[subagent-result]` message and the main agent gets
  a turn to act on it. `/subagent` without arguments lists the configured
  agents; agent names autocomplete after `/subagent `.
- **Autonomous** — the main model calls the `subagent` tool with
  `{ agent, task }`. The tool description carries the current agent roster
  (refreshed on every session start), so the model can pick an agent on its own.

## Tools and commands

- **Tool `subagent`** — delegate `{ agent, task }`; runs the agent as an
  isolated `pi` child process and returns its final text output.
- **`/subagent <name> <task>`** — delegate manually; the result arrives as a
  `[subagent-result]` message and the main agent gets a turn to act on it.
- **`/subagents`** — list configured agents (`name — description [model]`).

## Run history (follow a run in the browser)

Every run persists its child session under the shared artifacts root
(`$TMPDIR/pi-mydnicq-subagents/<session-uuid>/<agent-runId>/`; override the
parent directory with `PI_MYDNICQ_SUBAGENTS_ARTIFACTS_DIR` — the root folder
is always named `pi-mydnicq-subagents`) and re-exports it to HTML (pi's /export
pipeline) while the run is in flight. The page includes the subagent's actual
final system prompt — captured inside the child by a probe extension at
`agent_start` (the complete prompt, pi's base prompt included, with
modifications from any extension such as `.pi/AGENTS.md` sections appended by
user-level extensions); until the capture lands it falls back to a
reconstruction from the agent body plus the `AGENTS.md`/`CLAUDE.md`
context-file section (`projectContext` off shows the body only) — and its
`tools` allowlist (rendered
with pi's builtin tool descriptions and parameters). One shared loopback server serves
all pi sessions by path (discovered via a global `server.json` registry; a
failed probe makes the next session claim a fresh port), and the subagent run
card shows a **↗ history** link to the run's page under the parent session's
uuid — ctrl/cmd-click it (herdr opens pane links
only for http/https). Pages are static; refresh the browser page to see the
latest export. Terminals without OSC 8 show the plain URL/path instead
(Ctrl+O to expand).

While a run is in flight the card shows `alt+s stop`: pressing **alt+s**
stops the run(s) immediately in-process — no browser, no confirmation. The
main agent receives the run as stopped, with the encoded default reason
("user requested stop") and any partial output. With several runs in
flight, alt+s first shows a picker of the active runs.

## Defining agents

Each agent is a Markdown file with YAML frontmatter in the project's `.pi/agents` directory.
The **frontmatter `name` field defines the agent name**; the Markdown body is the agent's system prompt.

```markdown
<!-- .pi/agents/reviewer.md -->
---
name: reviewer
description: Reviews code changes for correctness and style
model: anthropic/claude-sonnet-4-5
thinking: high
context: fork
tools: read, bash, edit, write, grep, find, ls
projectContext: true
---

You are a code reviewer. ...
```

- All six frontmatter fields are required:
  - `name` — unique agent name (`[a-z0-9_-]+`); duplicates across files are rejected
  - `description` — used by the parent model to pick an agent
  - `model` — `provider/model-id`
  - `thinking` — `off|minimal|low|medium|high|xhigh|max`
  - `context` — how the child inherits parent context:
    - `fresh` — brand-new session; the child only sees the delegated task
    - `fork` — the child's prompt is prefixed with a serialized transcript of
      the parent conversation (tool calls summarized, thinking dropped, tail
      truncated at ~48k chars); the child still runs in a fresh ephemeral
      session and no parent session files are touched
  - `tools` — comma-separated (or YAML list) **builtin pi tool names**; the
    child runs with exactly this allowlist via pi's `--tools` flag. Valid
    names: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`,
    `powershell` (Windows-only). There are no defaults — omitting `tools` or
    naming an unknown tool is a load error.
- One optional frontmatter field:
  - `projectContext` — whether the child loads context files (`AGENTS.md`/
    `CLAUDE.md`) and appends them to its system prompt via pi's own discovery
    (global `~/.pi/agent/AGENTS.md`, ancestor directories, current directory —
    identical to the main agent). Default `true`. Set `projectContext: false`
    to spawn the child with `--no-context-files` so it runs without them.
- The Markdown body is the agent's system prompt.
- The frontmatter `name` field defines the agent name; the file name is
  organizational only — naming the file after the agent is recommended.
- Unknown frontmatter fields log a warning and are ignored.
- Files without frontmatter (e.g. a stray README) are skipped.
- Agents load from the nearest ancestor directory containing `.pi`;
  `/subagents` lists what was found.

## Install

```bash
pi install npm:pi-mydnicq-subagents
```

## Local development

```bash
npm install
npm run typecheck
pi -e .        # load the extension in pi without installing
```

## License

MIT