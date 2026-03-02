#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const ORCH_ROOT = process.env.ORCH_ROOT;
const SESSION_NAME = process.env.SESSION_NAME;
const SUBAGENT_ID = process.env.SUBAGENT_ID;
const PI_SUBAGENT_CMD = process.env.PI_SUBAGENT_CMD || ""; // optional override
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

async function runProcess(command, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
      shell: false,
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

async function runCustomCommand(cmd, env) {
  return runProcess("bash", ["-lc", cmd], env);
}

async function runDefaultPi(promptFile) {
  const prompt = fs.readFileSync(promptFile, "utf8");
  const text = prompt.trim();
  if (!text) {
    return { code: 1, stdout: "", stderr: `Prompt file is empty: ${promptFile}` };
  }
  // Default behavior: run real Pi task in print mode.
  return runProcess("pi", ["-p", text]);
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

  const result = PI_SUBAGENT_CMD
    ? await runCustomCommand(PI_SUBAGENT_CMD, {
        PROMPT_FILE: promptFile,
        OUTPUT_FILE: outputFile,
        TASK_ID: taskId,
      })
    : await runDefaultPi(promptFile);

  const combinedLogs = `${result.stdout}${result.stderr}` || `exit_code=${result.code}\n`;
  fs.writeFileSync(logFile, combinedLogs, "utf8");

  if (!fs.existsSync(outputFile)) {
    fs.writeFileSync(outputFile, result.stdout || combinedLogs, "utf8");
  }

  const outputText = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8") : "";
  const summary = outputText.split(/\r?\n/).slice(0, 12).join("\n").slice(0, 4000);

  const ok = result.code === 0;
  writeHandoff({
    task_id: taskId,
    subagent_id: SUBAGENT_ID,
    status: ok ? "completed" : "failed",
    error: ok ? undefined : `subagent command exit code ${result.code}`,
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
