#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ORCH_ROOT="${ORCH_ROOT:-${ROOT_DIR}/.orchestrator}"

usage() {
  cat <<'EOF'
Usage:
  orchestrator.sh init <session>
  orchestrator.sh spawn <session> <subagent_id> [--cwd <dir>] [--cmd <pi_cmd>]
  orchestrator.sh assign <session> <subagent_id|all> <task_id> <prompt_file>
  orchestrator.sh collect <session> [--json]
  orchestrator.sh wait <session> <subagent_id|all> <timeout_sec> [--grace <sec>]
  orchestrator.sh terminate <session> [subagent_id|all]
  orchestrator.sh status <session>
  orchestrator.sh demo <session>

Notes:
- Requires: zellij, bash, python3
- Uses zellij session as external control plane.
- Subagents are long-running worker panes consuming task files.
EOF
}

session_dir() { echo "${ORCH_ROOT}/$1"; }
subagent_dir() { echo "$(session_dir "$1")/subagents/$2"; }
subagent_status_file() { echo "$(subagent_dir "$1" "$2")/status"; }
subagent_handoff_file() { echo "$(subagent_dir "$1" "$2")/handoff.json"; }

ensure_session() {
  local session="$1"
  mkdir -p "$(session_dir "${session}")/subagents"
  zellij attach --create-background "${session}" >/dev/null 2>&1 || true
}

cmd_init() {
  local session="$1"
  ensure_session "${session}"
  cat > "$(session_dir "${session}")/session.env" <<EOF
SESSION_NAME=${session}
ORCH_ROOT=${ORCH_ROOT}
ROOT_DIR=${ROOT_DIR}
EOF
  echo "initialized session=${session} root=$(session_dir "${session}")"
}

cmd_spawn() {
  local session="$1" subagent_id="$2"; shift 2
  local cwd="$(pwd)"
  local pi_cmd=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --cwd) cwd="$2"; shift 2 ;;
      --cmd) pi_cmd="$2"; shift 2 ;;
      *) echo "Unknown arg: $1"; exit 1 ;;
    esac
  done

  ensure_session "${session}"
  local sd
  sd="$(subagent_dir "${session}" "${subagent_id}")"
  mkdir -p "${sd}/"{inbox,done,prompts,logs}

  local worker_cmd
  worker_cmd="ORCH_ROOT='${ORCH_ROOT}' SESSION_NAME='${session}' SUBAGENT_ID='${subagent_id}'"
  if [[ -n "${pi_cmd}" ]]; then
    worker_cmd+=" PI_SUBAGENT_CMD=$(printf %q "${pi_cmd}")"
  fi
  worker_cmd+=" bash $(printf %q "${ROOT_DIR}/bin/subagent_worker.sh")"

  zellij --session "${session}" run --name "agent:${subagent_id}" --cwd "${cwd}" -- bash -lc "${worker_cmd}"

  echo "spawned subagent=${subagent_id} in session=${session}"
}

resolve_targets() {
  local session="$1" target="$2"
  if [[ "${target}" == "all" ]]; then
    find "$(session_dir "${session}")/subagents" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort
  else
    echo "${target}"
  fi
}

cmd_assign() {
  local session="$1" target="$2" task_id="$3" prompt_file="$4"
  ensure_session "${session}"

  if [[ ! -f "${prompt_file}" ]]; then
    echo "prompt file not found: ${prompt_file}" >&2
    exit 1
  fi

  local assigned=0
  while IFS= read -r subagent_id; do
    [[ -z "${subagent_id}" ]] && continue
    local sd
    sd="$(subagent_dir "${session}" "${subagent_id}")"
    if [[ ! -d "${sd}" ]]; then
      echo "skip missing subagent ${subagent_id}" >&2
      continue
    fi
    mkdir -p "${sd}/prompts" "${sd}/inbox"
    cp "${prompt_file}" "${sd}/prompts/${task_id}.md"
    printf 'task_id=%s\ncreated_at=%s\n' "${task_id}" "$(date -u +%FT%TZ)" > "${sd}/inbox/${task_id}.task"
    assigned=$((assigned+1))
    echo "assigned task=${task_id} to subagent=${subagent_id}"
  done < <(resolve_targets "${session}" "${target}")

  if (( assigned == 0 )); then
    echo "no subagents assigned" >&2
    exit 1
  fi
}

cmd_collect() {
  local session="$1" as_json="false"
  shift
  if [[ "${1:-}" == "--json" ]]; then as_json="true"; fi

  local sdir="$(session_dir "${session}")/subagents"
  mkdir -p "${sdir}"

  if [[ "${as_json}" == "true" ]]; then
    python3 - "${sdir}" <<'PY'
import json, pathlib, sys
sdir = pathlib.Path(sys.argv[1])
items = []
for d in sorted([p for p in sdir.iterdir() if p.is_dir()]):
    handoff = d / "handoff.json"
    status = (d / "status").read_text().strip() if (d / "status").exists() else "unknown"
    payload = {"subagent_id": d.name, "status": status, "handoff": None}
    if handoff.exists():
        try:
            payload["handoff"] = json.loads(handoff.read_text())
        except Exception as e:
            payload["handoff"] = {"parse_error": str(e), "raw": handoff.read_text(errors="replace")[:1000]}
    items.append(payload)
print(json.dumps(items, ensure_ascii=False, indent=2))
PY
  else
    while IFS= read -r subagent_id; do
      [[ -z "${subagent_id}" ]] && continue
      local status_file handoff_file
      status_file="$(subagent_status_file "${session}" "${subagent_id}")"
      handoff_file="$(subagent_handoff_file "${session}" "${subagent_id}")"
      echo "--- ${subagent_id} ---"
      if [[ -f "${status_file}" ]]; then
        echo "status: $(cat "${status_file}")"
      else
        echo "status: unknown"
      fi
      if [[ -f "${handoff_file}" ]]; then
        echo "handoff: ${handoff_file}"
      else
        echo "handoff: missing"
      fi
    done < <(find "${sdir}" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort)
  fi
}

cmd_wait() {
  local session="$1" target="$2" timeout_sec="$3"
  shift 3
  local grace=10
  if [[ "${1:-}" == "--grace" ]]; then grace="$2"; fi

  local start now elapsed all_done
  start="$(date +%s)"
  while true; do
    all_done=1
    while IFS= read -r subagent_id; do
      [[ -z "${subagent_id}" ]] && continue
      local status_file handoff_file status
      status_file="$(subagent_status_file "${session}" "${subagent_id}")"
      handoff_file="$(subagent_handoff_file "${session}" "${subagent_id}")"
      status="unknown"
      [[ -f "${status_file}" ]] && status="$(cat "${status_file}")"

      # completion decision: require BOTH status idle + handoff.agent_end=true
      local handoff_ok="false"
      if [[ -f "${handoff_file}" ]]; then
        if python3 - "${handoff_file}" >/dev/null 2>&1 <<'PY'
import json, sys
p = sys.argv[1]
with open(p, 'r', encoding='utf-8') as f:
    payload = json.load(f)
if payload.get('agent_end') is True:
    sys.exit(0)
sys.exit(1)
PY
        then
          handoff_ok="true"
        fi
      fi

      if [[ "${status}" != "idle" || "${handoff_ok}" != "true" ]]; then
        all_done=0
      fi
    done < <(resolve_targets "${session}" "${target}")

    if (( all_done == 1 )); then
      echo "all targeted subagents completed"
      return 0
    fi

    now="$(date +%s)"
    elapsed=$((now - start))
    if (( elapsed >= timeout_sec )); then
      echo "timeout reached (${timeout_sec}s), sending wrap-up steering" >&2
      while IFS= read -r subagent_id; do
        [[ -z "${subagent_id}" ]] && continue
        local sd
        sd="$(subagent_dir "${session}" "${subagent_id}")"
        mkdir -p "${sd}/prompts" "${sd}/inbox"
        printf '%s\n' "Wrap up now. Return a concise handoff immediately." > "${sd}/prompts/_force_wrapup.md"
        printf 'task_id=%s\ncreated_at=%s\n' "_force_wrapup" "$(date -u +%FT%TZ)" > "${sd}/inbox/_force_wrapup.task"
      done < <(resolve_targets "${session}" "${target}")

      sleep "${grace}"
      echo "grace period elapsed, force-terminating target=${target}" >&2
      cmd_terminate "${session}" "${target}" >/dev/null
      return 2
    fi

    sleep 1
  done
}

cmd_terminate() {
  local session="$1" target="${2:-all}"

  if [[ "${target}" == "all" ]]; then
    zellij kill-session "${session}" >/dev/null 2>&1 || true
    echo "terminated session=${session}"
    return 0
  fi

  # Targeted stop: write failure status marker only. No synthetic handoff is generated.
  local sd
  sd="$(subagent_dir "${session}" "${target}")"
  mkdir -p "${sd}"
  printf 'failed:force-terminated\n' > "${sd}/status"
  echo "marked subagent=${target} as force-terminated (session still running)"
}

cmd_status() {
  local session="$1"
  cmd_collect "${session}"
}

cmd_demo() {
  local session="$1"
  mkdir -p "${ROOT_DIR}/examples"
  local p1="${ROOT_DIR}/examples/task-research.md"
  local p2="${ROOT_DIR}/examples/task-summary.md"
  cat > "${p1}" <<'EOF'
Research 3 ways to make shell orchestration robust.
Return concise bullet points.
EOF
  cat > "${p2}" <<'EOF'
Summarize why a handoff.json file is useful for multi-agent workflows.
EOF

  cmd_init "${session}"
  cmd_spawn "${session}" "worker-a"
  cmd_spawn "${session}" "worker-b"
  cmd_assign "${session}" "worker-a" "task-001" "${p1}"
  cmd_assign "${session}" "worker-b" "task-002" "${p2}"
  cmd_wait "${session}" all 25 --grace 3 || true
  cmd_collect "${session}" --json
}

main() {
  local cmd="${1:-}"
  case "${cmd}" in
    init) shift; cmd_init "$@" ;;
    spawn) shift; cmd_spawn "$@" ;;
    assign) shift; cmd_assign "$@" ;;
    collect) shift; cmd_collect "$@" ;;
    wait) shift; cmd_wait "$@" ;;
    terminate) shift; cmd_terminate "$@" ;;
    status) shift; cmd_status "$@" ;;
    demo) shift; cmd_demo "$@" ;;
    ""|-h|--help|help) usage ;;
    *) echo "Unknown command: ${cmd}"; usage; exit 1 ;;
  esac
}

main "$@"
