# Skill: zellij-subagents

Use this skill to orchestrate parallel Pi subagents via Zellij.

## Interface (extension-native)

Use the extension command `/zj`:

```text
/zj init <session>
/zj spawn <session> <subagent_id> [--cwd <dir>] [--cmd "<pi_cmd>"]
/zj assign <session> <subagent_id|all> <task_id> <prompt_file>
/zj wait <session> <subagent_id|all> <timeout_sec> [--grace <sec>]
/zj collect <session>
/zj status <session>
/zj terminate <session> [subagent_id|all]
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
