# Terminology

Project ubiquitous language. Define terms here; use them consistently.

## Background run

A subagent run that continues after the `subagent` tool call returns. Its
outcome arrives later as a completion message.

## Completion message

The `[subagent-result]` message that wakes the main agent when a background run
settles or fails to start. Carries the full outcome; the transcript shows a
short summary.

## Run receipt

The tool result returned when a background run starts: the run id, the agent,
and the configured model. The same card keeps updating as the run works, so it
becomes the run's live card and final result.

## Subagent run card

Inline card in the main chat showing a subagent run's state and live progress
(spinner, agent, context, model, turns, usage, history link) plus its output
preview (Ctrl+O to expand). Not the footer **status line**.

## Subagent system prompt

The Markdown body of an agent file — everything after the YAML frontmatter.
Passed to the subagent as its system prompt; frontmatter fields configure the
run, the body instructs the agent.