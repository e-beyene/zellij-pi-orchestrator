# Zellij Pi Subagent Orchestrator (Hybrid: Skill + Extension)

Implements `@plan.md` with a **hybrid path**:
- shell orchestrator + worker runtime (skill-friendly)
- project-local Pi extension control plane

- Spawn subagents in Zellij panes
- Assign tasks by writing prompt files + inbox task files
- Collect structured handoffs (`handoff.json`)
- Wait with timeout + grace + force-terminate behavior

## Requirements

- `zellij` (tested with 0.43.x)
- `bash`
- `python3`

## Quick Start

```bash
cd /private/tmp/zellij-pi-orchestrator
./bin/orchestrator.sh demo demo-session
```

Then inspect state:

```bash
./bin/orchestrator.sh status demo-session
./bin/orchestrator.sh collect demo-session --json
```

Clean up:

```bash
./bin/orchestrator.sh terminate demo-session all
```

## Core Interface

```bash
./bin/orchestrator.sh init <session>
./bin/orchestrator.sh spawn <session> <subagent_id> [--cwd <dir>] [--cmd <pi_cmd>]
./bin/orchestrator.sh assign <session> <subagent_id|all> <task_id> <prompt_file>
./bin/orchestrator.sh wait <session> <subagent_id|all> <timeout_sec> [--grace <sec>]
./bin/orchestrator.sh collect <session> [--json]
./bin/orchestrator.sh terminate <session> [subagent_id|all]
```

## Real Pi command wiring

By default, workers run in mock mode. To run a real command per task:

```bash
./bin/orchestrator.sh spawn my-session worker-a \
  --cmd 'pi run --non-interactive --prompt-file "$PROMPT_FILE" > "$OUTPUT_FILE"'
```

Worker environment variables available to `--cmd`:
- `PROMPT_FILE`
- `OUTPUT_FILE`
- `TASK_ID`

## Extension-first migration

Project-local extension path:

`/private/tmp/zellij-pi-orchestrator/.pi/extensions/zellij-orchestrator/index.ts`

Capabilities:
- LLM tool: `zellij_orchestrate`
- Slash command: `/zj ...`
- Extension state persistence for managed sessions
- Best-effort cleanup on `session_shutdown`

See:
- `/private/tmp/zellij-pi-orchestrator/.pi/extensions/zellij-orchestrator/README.md`

## Data Layout

State root:

`/private/tmp/zellij-pi-orchestrator/.orchestrator/<session>/subagents/<id>/`

Important files:
- `inbox/<task_id>.task`
- `prompts/<task_id>.md`
- `done/<task_id>.out.txt`
- `status`
- `handoff.json`

## Notes / Limitations

- Targeted pane kill is version-sensitive in Zellij CLI; session-wide terminate is most reliable.
- Completion check requires both: `status == idle` and `handoff.json` with `agent_end: true`.
- Timeout flow: wrap-up steer once, grace period, then force-terminate.
- Force-terminate does **not** generate a synthetic `handoff.json`.
- `handoff.json` parsing is best-effort.
