# Skill: zellij-subagents

Use this skill to orchestrate parallel Pi subagents via Zellij.

## Interface (extension-native)

Use friendly extension commands:

```text
/zj-start <session> [worker1 worker2 ...]
/zj-task <session> <worker|all> <taskId> <promptFile|promptText>
/zj-run <session> <worker> <promptFile|promptText>
/zj-wait <session> [worker|all] [timeoutSec] [--grace N]
/zj-results <session>
/zj-stop <session>
/zj-help
```

Or call the tool `zellij_orchestrate` directly.

## Completion semantics

Treat a subagent as complete only when both:
- worker status is `idle`
- `handoff.json` exists and includes `agent_end: true`

## Failure handling

On timeout:
1. assign `_force_wrapup`
2. wait grace period
3. force-terminate target
