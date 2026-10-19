# pi-mydnicq-subagents

A pi extension that delegates tasks to subagents.

## Tools

Use `subagent` to start a run, control a live run, resume a run, or list runs.
Each run has one pi child process. The tool returns a receipt at once. The
result arrives later as a `[subagent-result]` message. This message wakes the
main agent.

Actions:

- `{ action: "run", agent, task }` — start a run. This is the default.
- `{ action: "steer", run, task }` — send guidance to a live run. The child receives the guidance at its next tool boundary.
- `{ action: "interrupt", run, task }` — cancel the current work. Then send the new task to the same child.
- `{ action: "stop", run }` — cancel the current work. Keep the child idle for a resume.
- `{ action: "resume", run, task }` — continue a stopped run or a finished run.
- `{ action: "status" }` — list the runs in this session. Add `run` to show one run.

## Commands

- `/subagent <name> <task>` — run a subagent from the prompt. The result arrives as a `[subagent-result]` message.
- `/subagents` — list the configured agents. The output shows `name — description [model]`.

## Features

- **Background runs** — start a run and continue your work. The tool returns a
  receipt at once. A one-line card shows each live run in a stack below the
  input area. The card shows the agent, model, usage, and history link. A
  resumed run has a marker. A card leaves the stack when its run settles. The
  completion message brings the result as the final card for the run. Press
  Ctrl+O to expand the card. The card has a history link. The completion message
  wakes the main agent. The main agent ends its turn when it needs the result.
- **Run history** — the extension exports each run to an HTML page. The page
  shows the work of the subagent and the tools that it used. Use the page to tune the
  agent configuration. The run card and the completion card link to the page.
- **Resume a run** — use `{ action: "resume", run, task }` to give more work to
  a stopped run or a finished run. The child continues its session. The child
  keeps its context. A stopped child stays alive for 10 minutes. A quick resume
  uses the same process and no context reload. After 10 minutes, resume starts
  a child on the session file. Each resume is a new attempt on the same run
  record and the same history page.
- **Control a live run** — use `steer` to add guidance. The child receives the
  guidance at its next tool boundary. Use `interrupt` to cancel the current
  work and send a new task. The child keeps its context. Use `stop` to cancel
  the current work and keep the child idle. The stop tool result is final. The
  completion message arrives after a later resume. The card of a stopped run
  leaves the stack at once.

## Agent files

Each agent is a Markdown file. The file has YAML frontmatter and a body. Put
the file in the `.pi/agents` directory. The `name` field defines the agent name.
The body is the subagent system prompt.

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
| `name` | yes | Unique agent name. The loader rejects duplicate names.<br><br>Values: `[a-z0-9_-]+`<br><br>Default: none (required) |
| `description` | yes | The parent model uses this text to pick an agent.<br><br>Values: free text<br><br>Default: none (required) |
| `model` | yes | Model for the child.<br><br>Values: `provider/model-id`<br><br>Default: none (required) |
| `thinking` | yes | Effort level for the child.<br><br>Values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`<br><br>Default: none (required) |
| `context` | yes | How the child gets parent context.<br>`fresh` — the child has a new session and sees only the task.<br>`fork` — the child prompt starts with a parent transcript in text form. The serializer summarizes tool calls, drops thought blocks, and truncates the tail at about 48k characters. The child still runs in a new ephemeral session. No parent session file changes.<br><br>Values: `fresh`, `fork`<br><br>Default: none (required) |
| `tools` | yes | Tool allowlist for the child.<br><br>Values: builtin pi tool names (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `powershell`). Add extension or custom tool names that the child registers (for example `executor_execute`). Separate the names with commas or use a YAML list. A declared tool that is not active in the child fails the run before the first model turn.<br><br>Default: none (required) |
| `projectContext` | no | The child loads `AGENTS.md` and `CLAUDE.md` context files and appends them to its system prompt. The discovery is the same as the main agent.<br><br>Values: `true`, `false`<br><br>Default: `true` |

## Install

Run this command:

```bash
pi install git:github.com/mydnicq/pi-mydnicq-subagents
```

## Local setup

1. Run `npm install`.
2. Run `npm run typecheck`.
3. Run `pi -e .` to load the extension in pi without an install.

## License

This project uses the MIT license.
