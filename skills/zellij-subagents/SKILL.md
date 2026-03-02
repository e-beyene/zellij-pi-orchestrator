# Skill: zellij-subagents

Use this skill to orchestrate parallel Pi subagents via Zellij.

## Trigger conditions

Use when the user asks to:
- run multiple subagents in parallel
- split work across workers
- coordinate pane/session-based agent workflows

## Interface

Run orchestrator commands with Pi's `bash` tool:

```bash
/private/tmp/zellij-pi-orchestrator/bin/orchestrator.sh init <session>
/private/tmp/zellij-pi-orchestrator/bin/orchestrator.sh spawn <session> <subagent_id> [--cwd <dir>] [--cmd <pi_cmd>]
/private/tmp/zellij-pi-orchestrator/bin/orchestrator.sh assign <session> <subagent_id|all> <task_id> <prompt_file>
/private/tmp/zellij-pi-orchestrator/bin/orchestrator.sh wait <session> <subagent_id|all> <timeout_sec> [--grace <sec>]
/private/tmp/zellij-pi-orchestrator/bin/orchestrator.sh collect <session> [--json]
/private/tmp/zellij-pi-orchestrator/bin/orchestrator.sh terminate <session> [subagent_id|all]
```

## Recommended workflow

1. `init`
2. `spawn` at least 2 subagents
3. create prompt files for each task
4. `assign` tasks
5. `wait`
6. `collect --json`
7. summarize results
8. `terminate` session

## Completion semantics

Treat a subagent as complete only when both:
- worker status is `idle`
- `handoff.json` exists **and** includes `agent_end: true`

## Failure handling

On timeout:
1. assign a wrap-up steer (`_force_wrapup`)
2. wait grace period
3. terminate and mark failed if still hung
