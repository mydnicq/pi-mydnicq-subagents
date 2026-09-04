---
name: ext-test-env
description: Run tests for this project's pi extension in an isolated live pi session inside a herdr pane. Use whenever the user asks to test, try, or verify the extension (or anything) in a running pi session.
---

# Test env: isolated pi session in a herdr pane

Goal: a pi session in a split pane that loads THIS repo's extension without installing it (`pi -a -e .`).

## A. Environment already set up (check first)

1. Find the test pane by its label (deterministic, no heuristics):
   ```bash
   TEST_PANE=$(herdr pane list | jq -r '.result.panes[] | select(.label == "ext-test" and .focused != true) | .pane_id' | head -1)
   ```
   Empty output → no test pane, go to B. (The `select` skips your own pane — it has `focused: true`.)
2. If found, check it is alive: `herdr pane read "$TEST_PANE" --source recent --lines 10` — expect a pi footer (model + session line). Shell prompt (`$`) means it died → relaunch (step 5 of B, skip setup files).
3. If extension source changed since the session started, restart the session (extensions load once at startup): exit the pi session (Ctrl+C twice via `herdr pane send-keys <pane> C-c`) and re-run the launch command. Use a fresh session — do not `--continue`.
4. Reuse the pane for the test: see "Running a test".

## B. Fresh setup

1. Preconditions: `HERDR_ENV=1`, cwd = repo root. Stop if not inside herdr.
2. Ensure test fixtures exist: `.pi/agents/<name>.md` (frontmatter: name, description, model, thinking, context — all required). `ping.md` is the canonical smoke-test agent.
3. Find your own pane (`herdr pane list` → `focused: true`), then split right:
   ```bash
   NEW_PANE=$(herdr pane split <my-pane> --direction right --no-focus | jq -er '.result.pane.pane_id')
   herdr pane rename "$NEW_PANE" ext-test   # label survives pi restarts; makes pane findable in A.1
   ```
4. Launch pi (uninstalled extension, trusted project files, default model from user settings):
   ```bash
   herdr pane run "$NEW_PANE" "cd <repo-root> && pi -a -e ."
   ```

## Verify availability (do this for every new session)

1. Wait for startup (blocks until the pi footer appears, no polling loop):
   ```bash
   herdr pane wait-output "$NEW_PANE" --match "Full Auto session" --timeout 30000
   ```
   Exit code 0 = ready; timeout = still starting (retry once) or dead (relaunch).
2. Check the `[Extensions]` block:
   - local extension listed (appears as `src`)
3. Functional check: `herdr pane run <pane> "/subagents"`, then read the pane — it must list agents from `.pi/agents` (e.g. `ping — Trivial test agent ...`).

## Running a test

- Turn the user's ask into a concrete prompt or slash command, then: `herdr pane run <pane> "<prompt>"`.
- The pane session runs in Full Auto — no approval needed.
- Poll results: `herdr pane wait-output <pane> --match <marker> --source recent-unwrapped --timeout 120000` (use `recent-unwrapped` so soft wraps don't break matching). It matches existing output instantly, then polls. `--regex` for patterns; no `--timeout` waits forever.
- After a match (or for full output), read the tail: `herdr pane read <pane> --source recent-unwrapped --lines N`.
- For long tests with no known marker, poll `herdr pane list` until the pane's `agent_status` is `idle` or `done`.
- Leave the pane running for follow-up tests; close it only when asked or when stale: `herdr pane close <pane>`.

## Herdr quirks (this install)

- `pane wait-output` replaces sleep+poll loops; `pane rename <id> <label>` sets the `label` field shown in `pane list` (panes start with `label: null`).
- Pane ids compact when panes close — always re-read ids from `pane list` or the `pane split` response (`result.pane.pane_id`). The `ext-test` label persists in the same pane, so only the id needs re-resolving.
- `--no-focus` on split keeps your own pane focused.
- `pane run` = text + real Enter; the TUI's slash-command autocomplete accepts it.
- Recursive `rm -rf` may be blocked by a safety guard.