#!/usr/bin/env bash
set -euo pipefail

# Required env vars:
#   ORCH_ROOT, SESSION_NAME, SUBAGENT_ID
# Optional env vars:
#   PI_SUBAGENT_CMD (command to execute task; receives PROMPT_FILE, OUTPUT_FILE, TASK_ID env vars)
#   SUBAGENT_POLL_INTERVAL (seconds; default: 1)

: "${ORCH_ROOT:?ORCH_ROOT is required}"
: "${SESSION_NAME:?SESSION_NAME is required}"
: "${SUBAGENT_ID:?SUBAGENT_ID is required}"

POLL_INTERVAL="${SUBAGENT_POLL_INTERVAL:-1}"
BASE_DIR="${ORCH_ROOT}/${SESSION_NAME}/subagents/${SUBAGENT_ID}"
INBOX_DIR="${BASE_DIR}/inbox"
DONE_DIR="${BASE_DIR}/done"
LOG_DIR="${BASE_DIR}/logs"
STATUS_FILE="${BASE_DIR}/status"
HANDOFF_FILE="${BASE_DIR}/handoff.json"

mkdir -p "${INBOX_DIR}" "${DONE_DIR}" "${LOG_DIR}"
printf 'idle\n' > "${STATUS_FILE}"

run_task() {
  local task_file="$1"
  local task_id prompt_file output_file log_file

  task_id="$(basename "${task_file}" .task)"
  prompt_file="${BASE_DIR}/prompts/${task_id}.md"
  output_file="${DONE_DIR}/${task_id}.out.txt"
  log_file="${LOG_DIR}/${task_id}.log"

  mkdir -p "${BASE_DIR}/prompts"

  printf 'running:%s\n' "${task_id}" > "${STATUS_FILE}"

  if [[ ! -f "${prompt_file}" ]]; then
    echo "Missing prompt file for task ${task_id}: ${prompt_file}" > "${output_file}"
    printf '{"task_id":"%s","status":"failed","error":"missing prompt file","subagent_id":"%s"}\n' "${task_id}" "${SUBAGENT_ID}" > "${HANDOFF_FILE}"
    mv "${task_file}" "${DONE_DIR}/${task_id}.task"
    printf 'idle\n' > "${STATUS_FILE}"
    return
  fi

  if [[ -n "${PI_SUBAGENT_CMD:-}" ]]; then
    PROMPT_FILE="${prompt_file}" OUTPUT_FILE="${output_file}" TASK_ID="${task_id}" bash -lc "${PI_SUBAGENT_CMD}" > "${log_file}" 2>&1 || true
  else
    {
      echo "[mock-subagent:${SUBAGENT_ID}]"
      echo "task_id=${task_id}"
      echo "--- prompt ---"
      cat "${prompt_file}"
      echo "--- end prompt ---"
      echo "summary=Completed by mock worker. Set PI_SUBAGENT_CMD to run a real Pi command."
    } > "${output_file}"
    printf 'mock run complete\n' > "${log_file}"
  fi

  python3 - "$task_id" "$SUBAGENT_ID" "$output_file" "$HANDOFF_FILE" <<'PY'
import json, sys, pathlib

task_id, subagent_id, output_file, handoff_file = sys.argv[1:5]
text = pathlib.Path(output_file).read_text(errors="replace") if pathlib.Path(output_file).exists() else ""
summary = text.strip().splitlines()[:12]
payload = {
    "task_id": task_id,
    "subagent_id": subagent_id,
    "status": "completed",
    "summary": "\n".join(summary)[:4000],
    "output_file": output_file,
    "agent_end": True,
}
pathlib.Path(handoff_file).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
PY

  mv "${task_file}" "${DONE_DIR}/${task_id}.task"
  printf 'idle\n' > "${STATUS_FILE}"
}

while true; do
  shopt -s nullglob
  tasks=("${INBOX_DIR}"/*.task)
  shopt -u nullglob

  if (( ${#tasks[@]} > 0 )); then
    for t in "${tasks[@]}"; do
      run_task "${t}"
    done
  fi

  sleep "${POLL_INTERVAL}"
done
