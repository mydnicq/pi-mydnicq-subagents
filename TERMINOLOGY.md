# Terminology

Project ubiquitous language. Define terms here; use them consistently.

## Subagent run card

Inline, status-tinted card in the main chat showing a subagent run's state and
live progress (agent, context, turns, usage). Not the footer **status line**.

## Subagent system prompt

The Markdown body of an agent file — everything after the YAML frontmatter.
Passed to the subagent as its system prompt; frontmatter fields configure the
run, the body instructs the agent.