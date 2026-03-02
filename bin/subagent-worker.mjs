#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const ORCH_ROOT = process.env.ORCH_ROOT;
const SESSION_NAME = process.env.SESSION_NAME;
const SUBAGENT_ID = process.env.SUBAGENT_ID;
const PI_SUBAGENT_CMD = process.env.PI_SUBAGENT_CMD || "";
const POLL_MS = Number(process.env.SUBAGENT_POLL_INTERVAL_MS || 1000);

if (!ORCH_ROOT || !SESSION_NAME || !SUBAGENT_ID) {
  console.error("Missing required env vars: ORCH_ROOT, SESSION_NAME, SUBAGENT_ID");
  process.exit(2);
}

const baseDir = path.join(ORCH_ROOT, SESSION_NAME, "subagents", SUBAGENT_ID);
const inboxDir = path.join(baseDir, "inbox");
const doneDir = path.join(baseDir, "done");
const logDir = path.join(baseDir, "logs");
const promptsDir = path.join(baseDir, "prompts");
const statusFile = path.join(baseDir, "status");
const handoffFile = path.join(baseDir, "handoff.json");

for (const d of [inboxDir, doneDir, logDir, promptsDir]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(statusFile, "idle\n", "utf8");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listTasks() {
  if (!fs.existsSync(inboxDir)) return [];
  return fs
    .readdirSync(inboxDir)
    .filter((f) => f.endsWith(".task"))
    .sort()
    .map((f) => path.join(inboxDir, f));
}

async function runCustomCommand(cmd, env) {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", cmd], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    child.on("error", (err) => resolve({ code: 1, stdout, stderr: String(err) }));
  });
}

function writeHandoff(payload) {
  fs.writeFileSync(handoffFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function runTask(taskFile) {
  const taskId = path.basename(taskFile, ".task");
  const promptFile = path.join(promptsDir, `${taskId}.md`);
  const outputFile = path.join(doneDir, `${taskId}.out.txt`);
  const logFile = path.join(logDir, `${taskId}.log`);

  fs.writeFileSync(statusFile, `running:${taskId}\n`, "utf8");

  if (!fs.existsSync(promptFile)) {
    fs.writeFileSync(outputFile, `Missing prompt file for task ${taskId}: ${promptFile}\n`, "utf8");
    writeHandoff({
      task_id: taskId,
      subagent_id: SUBAGENT_ID,
      status: "failed",
      error: "missing prompt file",
      output_file: outputFile,
      agent_end: true,
    });
    fs.renameSync(taskFile, path.join(doneDir, `${taskId}.task`));
    fs.writeFileSync(statusFile, "idle\n", "utf8");
    return;
  }

  if (PI_SUBAGENT_CMD) {
    const result = await runCustomCommand(PI_SUBAGENT_CMD, {
      PROMPT_FILE: promptFile,
      OUTPUT_FILE: outputFile,
      TASK_ID: taskId,
    });
    fs.writeFileSync(logFile, `${result.stdout}${result.stderr}` || `exit_code=${result.code}\n`, "utf8");
    if (!fs.existsSync(outputFile)) {
      fs.writeFileSync(outputFile, `${result.stdout}${result.stderr}` || `exit_code=${result.code}\n`, "utf8");
    }
  } else {
    const prompt = fs.readFileSync(promptFile, "utf8");
    const mock = [
      `[mock-subagent:${SUBAGENT_ID}]`,
      `task_id=${taskId}`,
      "--- prompt ---",
      prompt.trimEnd(),
      "--- end prompt ---",
      "summary=Completed by mock worker. Set PI_SUBAGENT_CMD to run a real Pi command.",
      "",
    ].join("\n");
    fs.writeFileSync(outputFile, mock, "utf8");
    fs.writeFileSync(logFile, "mock run complete\n", "utf8");
  }

  const outputText = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8") : "";
  const summary = outputText.split(/\r?\n/).slice(0, 12).join("\n").slice(0, 4000);
  writeHandoff({
    task_id: taskId,
    subagent_id: SUBAGENT_ID,
    status: "completed",
    summary,
    output_file: outputFile,
    agent_end: true,
  });

  fs.renameSync(taskFile, path.join(doneDir, `${taskId}.task`));
  fs.writeFileSync(statusFile, "idle\n", "utf8");
}

while (true) {
  const tasks = listTasks();
  for (const task of tasks) {
    try {
      await runTask(task);
    } catch (err) {
      fs.writeFileSync(statusFile, "idle\n", "utf8");
      fs.writeFileSync(path.join(logDir, "worker-error.log"), `${new Date().toISOString()} ${String(err)}\n`, {
        encoding: "utf8",
        flag: "a",
      });
    }
  }
  await sleep(POLL_MS);
}
