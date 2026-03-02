# zellij-orchestrator extension

Project-local Pi extension that promotes the Zellij orchestration logic into an extension control plane.

## Files

- `index.ts` — extension entrypoint
- `../../../bin/orchestrator.sh` — shell control plane
- `../../../bin/subagent_worker.sh` — worker runtime

## Features

- Registers LLM-callable tool: `zellij_orchestrate`
- Registers command: `/zj ...` for direct orchestrator calls
- Tracks managed sessions in extension state (`appendEntry`)
- Best-effort session cleanup on `session_shutdown`

## Tool schema (high level)

`zellij_orchestrate` params:
- `action`: `init|spawn|assign|wait|collect|status|terminate|demo`
- `session`: required
- other fields per action (`subagentId`, `taskId`, `promptFile`/`promptText`, `target`, `timeoutSec`, `graceSec`, `json`, `cwd`, `command`)

## Usage examples

```text
Use zellij_orchestrate to init session "proj-1"
Use zellij_orchestrate to spawn subagentId "research" in session "proj-1"
Use zellij_orchestrate to assign taskId "t1" target "research" with promptText "Find auth files" in session "proj-1"
Use zellij_orchestrate to wait for target "all" timeoutSec 120 in session "proj-1"
Use zellij_orchestrate to collect json=true in session "proj-1"
```

Direct command path:

```text
/zj init proj-1
/zj spawn proj-1 research
/zj status proj-1
/zj terminate proj-1 all
```

## Script discovery

The extension resolves `orchestrator.sh` in this order:
1. `PI_ZELLIJ_ORCH_SCRIPT`
2. `<cwd>/bin/orchestrator.sh`
3. `<cwd>/zellij-pi-orchestrator/bin/orchestrator.sh`
4. `/private/tmp/zellij-pi-orchestrator/bin/orchestrator.sh`
