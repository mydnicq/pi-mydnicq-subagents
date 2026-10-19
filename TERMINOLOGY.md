# Terminology

This file defines the project terms. Use these terms in the code, the docs, and
the UI.

## Background run

A subagent run that continues after the `subagent` tool call returns. The
outcome arrives later as a completion message.

## Completion message

The `[subagent-result]` message that wakes the main agent when a background run
settles or fails to start. The message has the full outcome. The transcript
shows it as the final card for the run (output preview, Ctrl+O to expand,
history link).

## Run receipt

The tool result that the `subagent` tool returns when a background run starts.
It has the run id, the agent, and the configured model. The run then appears as
a **subagent run card** in the **run stack**.

## Subagent run card

A one-line live card in the **run stack**. It shows the spinner, agent, run id,
model, resume state, usage, and history link. It is not the footer **status
line**.

## Run stack

The stack of **subagent run cards** below the editor (input area). It shows at
most 8 cards and a `+N more runs` line. A card pops when its run settles. The
stack unmounts when it is empty.

## Subagent system prompt

The Markdown body of an agent file: everything after the YAML frontmatter. The
extension passes it to the subagent as the system prompt. The frontmatter fields
configure the run. The body instructs the agent.

## Steer

Guidance for a live subagent. The child receives it at its next tool boundary.
A steer never cancels the current work.

## Interrupt

A control action. It cancels the current work of the subagent and sends a new
task to the same child. The child keeps its context.

## Stop

A control action. It cancels the current work of the subagent and keeps the
child idle for a resume. The stop tool result is final. A later resume sends
the completion message.
