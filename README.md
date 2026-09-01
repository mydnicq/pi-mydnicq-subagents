# pi-mydnicq-subagents

A [pi](https://pi.dev) extension for delegating tasks to subagents.

> Early scaffold — under active development.

## Defining agents

Each agent is a Markdown file with YAML frontmatter in the project's `.pi/agents` directory.
The **file name defines the agent name**; the Markdown body is the agent's system prompt.

```markdown
<!-- .pi/agents/reviewer.md -->
---
name: reviewer
description: Reviews code changes for correctness and style
model: anthropic/claude-sonnet-4-5
thinking: high
context: fork
---

You are a code reviewer. ...
```

- All five frontmatter fields are required:
  - `name` — unique agent name (`[a-z0-9_-]+`); duplicates across files are rejected
  - `description` — used by the parent model to pick an agent
  - `model` — `provider/model-id`
  - `thinking` — `off|minimal|low|medium|high|xhigh|max`
  - `context` — how the child inherits parent context:
    - `fresh` — brand-new session; the child only sees the delegated task
    - `fork` — branches from the parent conversation so the child sees it so far (falls back to `fresh` when there is no persisted parent session to branch from)
- The Markdown body is the agent's system prompt.
- The file name is organizational only — the `name` field defines the agent; naming the file after the agent is recommended.
- There is no `name` field — the file name (without `.md`) defines the agent name; use lowercase letters, digits, `-` or `_`.
- Unknown frontmatter fields log a warning and are ignored.
- Files without frontmatter (e.g. a stray README) are skipped.
- Agents load from the nearest ancestor directory containing `.pi`; use `/subagents` in pi to list what was found.

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