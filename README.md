# Zellij Pi Subagent Orchestrator (Extension-native)

Implements `@plan.md` with an extension-native control plane.

## Current architecture

- **Pi extension control plane**: `.pi/extensions/zellij-orchestrator/index.ts`
- **Worker runtime**: `.pi/extensions/zellij-orchestrator/bin/subagent-worker.mjs` (runs in each Zellij pane)
- **No shell orchestrator required**

## Requirements

- `zellij`
- `node`
- `bash` (only if your `PI_SUBAGENT_CMD` uses it)

## Usage (from Pi)

Tool:
- `zellij_orchestrate`

Command:
- `/zj <action> ...`

Examples:

```text
/zj init demo
/zj spawn demo worker-a
/zj assign demo worker-a task-001 /absolute/path/to/prompt.md
/zj wait demo all 120 --grace 10
/zj collect demo
/zj terminate demo all
```

## Data layout

`<cwd>/.orchestrator/<session>/subagents/<id>/`

Key files:
- `inbox/<task_id>.task`
- `prompts/<task_id>.md`
- `done/<task_id>.out.txt`
- `status`
- `handoff.json`

## Completion semantics

A subagent is complete only when both are true:
- `status == idle`
- `handoff.json.agent_end == true`

## Timeout semantics

On timeout:
1. assign `_force_wrapup`
2. wait grace period
3. force-terminate target

If force-terminated, no synthetic handoff is generated.
