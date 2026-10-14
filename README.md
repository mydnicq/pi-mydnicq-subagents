# pi-mydnicq-subagents

A [pi](https://pi.dev) extension for delegating tasks to subagents.

## Tools

- `subagent` — delegate `{ agent, task }` to a configured agent.
  Runs are asynchronous: the tool returns a receipt immediately, and the
  result arrives later as a `[subagent-result]` message that wakes the main agent.
  - `{ action: "resume", run, task }` — continue a finished run (same agent, same context).
  - `{ action: "status" }` — list this session's runs; add `run` to show one.

## Commands

- `/subagent <name> <task>` — delegate manually; the result arrives as a `[subagent-result]` message.
- `/subagents` — list configured agents (`name — description [model]`).

## Features

- **Background runs** — keep working while a subagent runs. The tool returns a
  receipt at once and its run card keeps updating (spinner, model, turns, context,
  history link); the completion message brings the result back and wakes the main
  agent. The main agent ends its turn when it needs the result to continue.
- **Run history** — inspect what a subagent actually did and which tools it
  used, then fine-tune its configuration: every run is exported to a static
  HTML page you can follow in the browser; the run card links to it.
- **Resume a run** — give a finished subagent more work with
  `{ action: "resume", run, task }`: the child continues its existing session, so it
  keeps everything it learned. The resume runs in the background like any other
  run. Each resume is a new attempt on the same run record and the same history page.
- **Stop a run** — press **alt+s** while a background run is in flight to kill it.
  The completion message reports the stop and includes any partial output; the
  session keeps running.

## Defining agents

Each agent is a Markdown file with YAML frontmatter in the project's `.pi/agents` directory.
The **frontmatter `name` field defines the agent name**; the Markdown body is the agent's system prompt.

Example:

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

<!-- system prompt -->
You are a code reviewer. ...
```

| Field | Required | Description |
| --- | --- | --- |
| `name` | yes | Unique agent name; duplicates across files are rejected.<br><br>Values: `[a-z0-9_-]+`<br><br>Default: none (required) |
| `description` | yes | Used by the parent model to pick an agent.<br><br>Values: free text<br><br>Default: none (required) |
| `model` | yes | Model the child runs with.<br><br>Values: `provider/model-id`<br><br>Default: none (required) |
| `thinking` | yes | Thinking level for the child.<br><br>Values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`<br><br>Default: none (required) |
| `context` | yes | How the child inherits parent context:<br>`fresh` — brand-new session; the child only sees the delegated task.<br>`fork` — the child's prompt is prefixed with a serialized transcript of the parent conversation (tool calls summarized, thinking dropped, tail truncated at ~48k chars); the child still runs in a fresh ephemeral session and no parent session files are touched.<br><br>Values: `fresh`, `fork`<br><br>Default: none (required) |
| `tools` | yes | Tool allowlist the child runs with.<br><br>Values: builtin pi tool names `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `powershell` (Windows-only), plus extension/custom tool names registered in the child (e.g. `executor_execute`), comma-separated or YAML list. A declared tool that is not active in the child fails the run before the first model turn.<br><br>Default: none (required) |
| `projectContext` | no | Whether the child loads `AGENTS.md`/`CLAUDE.md` context files and appends them to its system prompt (discovery identical to the main agent).<br><br>Values: `true`, `false`<br><br>Default: `true` |

## Install

```bash
pi install git:github.com/mydnicq/pi-mydnicq-subagents
```

## Local development

```bash
npm install
npm run typecheck
pi -e .        # load the extension in pi without installing
```

## License

MIT