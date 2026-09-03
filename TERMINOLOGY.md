# Terminology

Project ubiquitous language. Define terms here; use them consistently.

## Subagent run card

Inline, status-tinted card in the main chat showing a subagent run's state and
live progress (agent, context, turns, usage). Not the footer **status line**.

## Run (delegation)

One subagent execution: a child `pi` process for a single agent + task
(`SubagentRunDetails`).

## Run history

HTML export of a run's live child-session transcript (pi's /export pipeline),
re-exported while the run is in flight. All sessions share one loopback
server and root dir; runs are grouped under their session's uuid. Opened in
the browser from the run card's **↗ history** link; a manual browser refresh
shows the latest export.