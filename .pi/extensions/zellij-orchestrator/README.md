# zellij-orchestrator extension (no shell orchestrator)

This extension now contains the orchestration control plane directly in TypeScript.

## Files

- `index.ts` — extension entrypoint + orchestration logic
- `bin/subagent-worker.mjs` — Node worker runtime run inside Zellij panes

## What changed

- Removed dependency on `bin/orchestrator.sh`
- Removed dependency on `bin/subagent_worker.sh`
- `zellij_orchestrate` now executes actions natively from extension code

## Features

- LLM tool: `zellij_orchestrate`
- Command: `/zj ...`
- Default worker execution runs real `pi -p` tasks
- Optional `--cmd` override per spawned worker
- Managed session persistence via `appendEntry`
- Cleanup on `session_shutdown` (best effort)

## Actions

`init | spawn | assign | wait | collect | status | terminate | demo`

## Worker path discovery

The extension resolves `subagent-worker.mjs` in this order:
1. `PI_ZELLIJ_WORKER_PATH`
2. `<extension_dir>/bin/subagent-worker.mjs`
3. `<cwd>/.pi/extensions/zellij-orchestrator/bin/subagent-worker.mjs`
4. `<cwd>/bin/subagent-worker.mjs`
