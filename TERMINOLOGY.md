# Terminology

Project ubiquitous language. Define terms here; use them consistently.

## Background run

A subagent run that continues after the `subagent` tool call returns. Its
outcome arrives later as a completion message.

## Completion message

The `[subagent-result]` message that wakes the main agent when a background run
settles or fails to start. Carries the full outcome; the transcript renders it
as the run's final card (output preview, Ctrl+O to expand, history link).

## Run receipt

The tool result returned when a background run starts: the run id, the agent,
and the configured model. The run then appears as a **subagent run card** in the
**run stack**.

## Subagent run card

One-line live card in the **run stack** (spinner, agent, run id, model, resume
state, usage, history link). Not the footer **status line**.

## Run stack

The stacked **subagent run cards** shown below the editor (input area), at most
8 visible with a `+N more runs` line. A card pops the moment its run settles;
the stack unmounts when empty.

## Subagent system prompt

The Markdown body of an agent file — everything after the YAML frontmatter.
Passed to the subagent as its system prompt; frontmatter fields configure the
run, the body instructs the agent.