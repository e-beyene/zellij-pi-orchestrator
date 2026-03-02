# Zellij Orchestrator for Pi

Run and coordinate multiple Pi subagents in parallel using Zellij panes.

This repo provides a **Pi extension** (`zellij-orchestrator`) that adds:
- Tool: `zellij_orchestrate`
- Command: `/zj`

Use it when you want a parent Pi workflow to split work across multiple subagents, then collect structured handoffs.

---

## What this is for

Typical use cases:
- Parallel research (eg, one subagent per subsystem)
- Multi-step workflows (recon → implementation → review)
- Isolating subagent context windows in separate panes
- Durable handoff artifacts (`handoff.json`) per subagent

---

## Requirements

- `pi` installed
- `zellij` installed and on `PATH`
- `node` installed and on `PATH`

Optional:
- A real subagent command via `--cmd` (otherwise worker runs mock mode)

---

## Install / Setup

### Option A: Project-local extension (recommended)

If you cloned this repo, it already contains:

- `.pi/extensions/zellij-orchestrator/index.ts`
- `.pi/extensions/zellij-orchestrator/bin/subagent-worker.mjs`

From repo root:

```bash
cd /path/to/zellij-pi-orchestrator
pi
```

Then in Pi run:

```text
/reload
```

That loads the extension from `.pi/extensions/...`.

### Option B: Install globally for all projects

```bash
mkdir -p ~/.pi/agent/extensions/zellij-orchestrator/bin
cp .pi/extensions/zellij-orchestrator/index.ts ~/.pi/agent/extensions/zellij-orchestrator/index.ts
cp .pi/extensions/zellij-orchestrator/bin/subagent-worker.mjs ~/.pi/agent/extensions/zellij-orchestrator/bin/subagent-worker.mjs
```

Start Pi anywhere and run `/reload`.

---

## Quick Start

Inside Pi:

```text
/zj init demo
/zj spawn demo worker-a
/zj spawn demo worker-b
```

Create two prompt files (or prepare one and reuse), then assign:

```text
/zj assign demo worker-a task-001 /absolute/path/to/task-a.md
/zj assign demo worker-b task-002 /absolute/path/to/task-b.md
/zj wait demo all 120 --grace 10
/zj collect demo
/zj terminate demo all
```

---

## Real subagent execution (instead of mock mode)

When spawning, pass a command that consumes:
- `PROMPT_FILE`
- `OUTPUT_FILE`
- `TASK_ID`

Example:

```text
/zj spawn demo worker-a --cmd "pi -p \"$(cat \"$PROMPT_FILE\")\" > \"$OUTPUT_FILE\""
```

If no `--cmd` is provided, worker writes mock output for testing.

---

## Data model

Runtime state is stored at:

`<cwd>/.orchestrator/<session>/subagents/<id>/`

Key files:
- `inbox/<task_id>.task`
- `prompts/<task_id>.md`
- `done/<task_id>.out.txt`
- `status`
- `handoff.json`

Completion requires **both**:
- `status == idle`
- `handoff.json.agent_end == true`

---

## Commands

`/zj <action> ...`

Actions:
- `init`
- `spawn`
- `assign`
- `wait`
- `collect`
- `status`
- `terminate`
- `demo`

You can also call tool `zellij_orchestrate` directly.

---

## Notes

- Timeout behavior: wrap-up steer once, grace period, then force-terminate.
- If force-terminated, no synthetic handoff is created.
- Targeted pane termination is limited by Zellij CLI capabilities; session-wide terminate is most reliable.
