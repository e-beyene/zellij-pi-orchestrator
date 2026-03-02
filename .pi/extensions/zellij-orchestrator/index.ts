import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const STATE_ENTRY = "zellij-orch-state";

const Action = StringEnum(["init", "spawn", "assign", "wait", "collect", "status", "terminate", "demo"] as const, {
	description: "Orchestrator action",
});

const ParamsSchema = Type.Object({
	action: Action,
	session: Type.String({ description: "Orchestrator session name" }),
	subagentId: Type.Optional(Type.String({ description: "Subagent ID (for spawn)" })),
	target: Type.Optional(Type.String({ description: "Target subagent ID or 'all'" })),
	taskId: Type.Optional(Type.String({ description: "Task ID (for assign)" })),
	promptFile: Type.Optional(Type.String({ description: "Path to prompt file (for assign)" })),
	promptText: Type.Optional(Type.String({ description: "Inline prompt text (for assign)" })),
	timeoutSec: Type.Optional(Type.Number({ description: "Timeout seconds (for wait)" })),
	graceSec: Type.Optional(Type.Number({ description: "Grace seconds after wrap-up steer" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for spawned pane" })),
	command: Type.Optional(Type.String({ description: "Optional custom worker command; overrides default pi -p execution" })),
	json: Type.Optional(Type.Boolean({ description: "Use JSON output for collect" })),
});

type Params = {
	action: "init" | "spawn" | "assign" | "wait" | "collect" | "status" | "terminate" | "demo";
	session: string;
	subagentId?: string;
	target?: string;
	taskId?: string;
	promptFile?: string;
	promptText?: string;
	timeoutSec?: number;
	graceSec?: number;
	cwd?: string;
	command?: string;
	json?: boolean;
};

type CollectItem = {
	subagent_id: string;
	status: string;
	handoff: unknown;
};

function truncate(text: string, max = 12000): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`;
}

function normalizePath(p: string): string {
	return p.startsWith("@") ? p.slice(1) : p;
}

function splitArgs(raw: string): string[] {
	const tokens = raw.match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\S+/g) ?? [];
	return tokens.map((t) => {
		if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
		return t;
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getOrchRoot(cwd: string): string {
	return process.env.PI_ZELLIJ_ORCH_ROOT || path.join(cwd, ".orchestrator");
}

function sessionDir(orchRoot: string, session: string): string {
	return path.join(orchRoot, session);
}

function subagentsDir(orchRoot: string, session: string): string {
	return path.join(sessionDir(orchRoot, session), "subagents");
}

function subagentDir(orchRoot: string, session: string, id: string): string {
	return path.join(subagentsDir(orchRoot, session), id);
}

function readText(file: string): string | null {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

function parseJsonFile(file: string): any | null {
	const raw = readText(file);
	if (!raw) return null;
	try {
		return JSON.parse(raw);
	} catch {
		return { parse_error: true, raw: raw.slice(0, 1000) };
	}
}

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));

function resolveWorkerPath(cwd: string): string {
	const candidates = [
		process.env.PI_ZELLIJ_WORKER_PATH,
		path.join(EXTENSION_DIR, "bin", "subagent-worker.mjs"),
		path.join(cwd, ".pi", "extensions", "zellij-orchestrator", "bin", "subagent-worker.mjs"),
		path.join(cwd, "bin", "subagent-worker.mjs"),
	].filter(Boolean) as string[];

	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) return candidate;
	}
	throw new Error(`Could not locate subagent-worker.mjs. Tried: ${candidates.join(", ")}`);
}

async function zellij(pi: ExtensionAPI, args: string[], signal?: AbortSignal) {
	return pi.exec("zellij", args, { signal, timeout: 120000 });
}

function listSubagentIds(orchRoot: string, session: string): string[] {
	const dir = subagentsDir(orchRoot, session);
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name)
		.sort();
}

function resolveTargets(orchRoot: string, session: string, target?: string): string[] {
	if (!target || target === "all") return listSubagentIds(orchRoot, session);
	return [target];
}

export default function (pi: ExtensionAPI) {
	const managedSessions = new Set<string>();

	const persistState = () => {
		pi.appendEntry(STATE_ENTRY, {
			sessions: Array.from(managedSessions.values()),
			updatedAt: new Date().toISOString(),
		});
	};

	pi.on("session_start", async (_event, ctx) => {
		managedSessions.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_ENTRY) {
				const sessions = (entry.data as any)?.sessions;
				if (Array.isArray(sessions)) for (const s of sessions) if (typeof s === "string") managedSessions.add(s);
			}
		}
		if (managedSessions.size > 0) {
			ctx.ui.setStatus("zellij-orch", `Managed sessions: ${Array.from(managedSessions).join(", ")}`);
		}
	});

	const terminateAll = async (session: string) => {
		await zellij(pi, ["kill-session", session]);
		managedSessions.delete(session);
		persistState();
	};

	pi.on("session_shutdown", async (_event, _ctx) => {
		for (const session of managedSessions) {
			try {
				await zellij(pi, ["kill-session", session]);
			} catch {
				// best effort
			}
		}
	});

	const ensureSession = async (orchRoot: string, session: string) => {
		fs.mkdirSync(subagentsDir(orchRoot, session), { recursive: true });
		await zellij(pi, ["attach", "--create-background", session]);
		fs.writeFileSync(path.join(sessionDir(orchRoot, session), "session.env"), `SESSION_NAME=${session}\nORCH_ROOT=${orchRoot}\n`, "utf8");
	};

	const collect = (orchRoot: string, session: string): CollectItem[] => {
		const ids = listSubagentIds(orchRoot, session);
		return ids.map((id) => {
			const sd = subagentDir(orchRoot, session, id);
			const status = (readText(path.join(sd, "status")) || "unknown").trim() || "unknown";
			const handoff = parseJsonFile(path.join(sd, "handoff.json"));
			return { subagent_id: id, status, handoff };
		});
	};

	const isComplete = (item: CollectItem) => {
		const handoff = item.handoff as any;
		return item.status === "idle" && handoff && handoff.agent_end === true;
	};

	const runAction = async (params: Params, cwd: string, signal?: AbortSignal) => {
		const orchRoot = getOrchRoot(cwd);
		fs.mkdirSync(orchRoot, { recursive: true });

		switch (params.action) {
			case "init": {
				await ensureSession(orchRoot, params.session);
				managedSessions.add(params.session);
				persistState();
				return { status: "ok", text: `initialized session=${params.session}`, details: { orchRoot } };
			}
			case "spawn": {
				if (!params.subagentId) throw new Error("subagentId is required for spawn");
				await ensureSession(orchRoot, params.session);
				managedSessions.add(params.session);
				persistState();

				const sd = subagentDir(orchRoot, params.session, params.subagentId);
				for (const d of ["inbox", "done", "prompts", "logs"]) fs.mkdirSync(path.join(sd, d), { recursive: true });

				const workerPath = resolveWorkerPath(cwd);
				const spawnCwd = params.cwd ? normalizePath(params.cwd) : cwd;
				const envArgs = [
					`ORCH_ROOT=${orchRoot}`,
					`SESSION_NAME=${params.session}`,
					`SUBAGENT_ID=${params.subagentId}`,
				];
				if (params.command) envArgs.push(`PI_SUBAGENT_CMD=${params.command}`);

				const res = await zellij(
					pi,
					[
						"--session",
						params.session,
						"run",
						"--name",
						`agent:${params.subagentId}`,
						"--cwd",
						spawnCwd,
						"--",
						"env",
						...envArgs,
						process.execPath,
						workerPath,
					],
					signal,
				);
				if (res.code !== 0) throw new Error(res.stderr || res.stdout || "zellij spawn failed");
				return {
					status: "ok",
					text: `spawned subagent=${params.subagentId} session=${params.session}`,
					details: { orchRoot, workerPath, stdout: res.stdout, stderr: res.stderr },
				};
			}
			case "assign": {
				if (!params.taskId) throw new Error("taskId is required for assign");
				let prompt = "";
				if (params.promptText) prompt = params.promptText;
				else if (params.promptFile) {
					const p = normalizePath(params.promptFile);
					if (!fs.existsSync(p)) throw new Error(`prompt file not found: ${p}`);
					prompt = fs.readFileSync(p, "utf8");
				} else {
					throw new Error("promptFile or promptText is required for assign");
				}

				const targets = resolveTargets(orchRoot, params.session, params.target);
				let assigned = 0;
				for (const id of targets) {
					const sd = subagentDir(orchRoot, params.session, id);
					if (!fs.existsSync(sd)) continue;
					fs.mkdirSync(path.join(sd, "prompts"), { recursive: true });
					fs.mkdirSync(path.join(sd, "inbox"), { recursive: true });
					fs.writeFileSync(path.join(sd, "prompts", `${params.taskId}.md`), prompt, "utf8");
					fs.writeFileSync(
						path.join(sd, "inbox", `${params.taskId}.task`),
						`task_id=${params.taskId}\ncreated_at=${new Date().toISOString()}\n`,
						"utf8",
					);
					assigned++;
				}
				if (assigned === 0) throw new Error("no subagents assigned");
				return { status: "ok", text: `assigned task=${params.taskId} to ${assigned} subagent(s)`, details: { assigned } };
			}
			case "collect": {
				const items = collect(orchRoot, params.session);
				if (params.json === false) {
					const lines = items.map((i) => `${i.subagent_id}: status=${i.status} handoff=${i.handoff ? "present" : "missing"}`);
					return { status: "ok", text: lines.join("\n") || "no subagents", details: { items } };
				}
				return { status: "ok", text: JSON.stringify(items, null, 2), details: { items } };
			}
			case "status": {
				const items = collect(orchRoot, params.session);
				const done = items.filter(isComplete).length;
				return { status: "ok", text: `session=${params.session} complete=${done}/${items.length}`, details: { items } };
			}
			case "wait": {
				const timeoutSec = params.timeoutSec ?? 120;
				const graceSec = params.graceSec ?? 10;
				const target = params.target ?? "all";
				const started = Date.now();

				while (true) {
					const items = collect(orchRoot, params.session).filter((i) => target === "all" || i.subagent_id === target);
					const done = items.length > 0 && items.every(isComplete);
					if (done) {
						return {
							status: "ok",
							text: `all targeted subagents completed (${items.length})`,
							details: { items, timeout: false },
						};
					}

					if ((Date.now() - started) / 1000 >= timeoutSec) {
						const targets = resolveTargets(orchRoot, params.session, target);
						for (const id of targets) {
							const sd = subagentDir(orchRoot, params.session, id);
							if (!fs.existsSync(sd)) continue;
							fs.mkdirSync(path.join(sd, "prompts"), { recursive: true });
							fs.mkdirSync(path.join(sd, "inbox"), { recursive: true });
							fs.writeFileSync(
								path.join(sd, "prompts", "_force_wrapup.md"),
								"Wrap up now. Return a concise handoff immediately.\n",
								"utf8",
							);
							fs.writeFileSync(
								path.join(sd, "inbox", "_force_wrapup.task"),
								`task_id=_force_wrapup\ncreated_at=${new Date().toISOString()}\n`,
								"utf8",
							);
						}

						await sleep(graceSec * 1000);
						if (target === "all") await terminateAll(params.session);
						else {
							const sd = subagentDir(orchRoot, params.session, target);
							fs.mkdirSync(sd, { recursive: true });
							fs.writeFileSync(path.join(sd, "status"), "failed:force-terminated\n", "utf8");
						}

						return {
							status: "error",
							text: `timeout reached (${timeoutSec}s), force-terminated target=${target}`,
							details: { timeout: true, target },
						};
					}

					await sleep(1000);
				}
			}
			case "terminate": {
				const target = params.target ?? "all";
				if (target === "all") {
					await terminateAll(params.session);
					return { status: "ok", text: `terminated session=${params.session}`, details: {} };
				}
				const sd = subagentDir(orchRoot, params.session, target);
				fs.mkdirSync(sd, { recursive: true });
				fs.writeFileSync(path.join(sd, "status"), "failed:force-terminated\n", "utf8");
				return { status: "ok", text: `marked subagent=${target} as force-terminated`, details: {} };
			}
			case "demo": {
				await ensureSession(orchRoot, params.session);
				managedSessions.add(params.session);
				persistState();
				await runAction({ action: "spawn", session: params.session, subagentId: "worker-a" }, cwd, signal);
				await runAction({ action: "spawn", session: params.session, subagentId: "worker-b" }, cwd, signal);
				await runAction(
					{
						action: "assign",
						session: params.session,
						target: "worker-a",
						taskId: "task-001",
						promptText: "Research 3 ways to make shell orchestration robust. Return concise bullet points.",
					},
					cwd,
					signal,
				);
				await runAction(
					{
						action: "assign",
						session: params.session,
						target: "worker-b",
						taskId: "task-002",
						promptText: "Summarize why a handoff.json file is useful for multi-agent workflows.",
					},
					cwd,
					signal,
				);
				await runAction({ action: "wait", session: params.session, target: "all", timeoutSec: 25, graceSec: 3 }, cwd, signal);
				return runAction({ action: "collect", session: params.session, json: true }, cwd, signal);
			}
		}
	};

	const executeAndNotify = async (params: Params, cwd: string, notify: (msg: string, level: "info" | "warning" | "error") => void) => {
		const out = await runAction(params, cwd);
		notify(truncate(out.text, 1200), out.status === "ok" ? "info" : "error");
		return out;
	};

	const parsePromptSource = (raw: string): { promptFile?: string; promptText?: string } => {
		const candidate = normalizePath(raw);
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return { promptFile: candidate };
		return { promptText: raw };
	};

	pi.registerTool({
		name: "zellij_orchestrate",
		label: "Zellij Orchestrate",
		description:
			"Control Zellij-based Pi subagents: init/spawn/assign/wait/collect/terminate. Extension-native control plane.",
		parameters: ParamsSchema,
		async execute(_toolCallId, params: Params, signal, _onUpdate, ctx) {
			const out = await runAction(params, ctx.cwd, signal);
			ctx.ui.setStatus("zellij-orch", `last: ${params.action} (${out.status})`);
			return {
				content: [{ type: "text", text: `[zellij_orchestrate:${out.status}] ${out.text}` }],
				details: out.details,
				isError: out.status !== "ok",
			};
		},
	});

	pi.registerCommand("zj-help", {
		description: "Show friendly zellij-orchestrator command examples",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				"/zj-start demo worker-a worker-b\n/zj-task demo worker-a t1 @/abs/path/task.md\n/zj-task demo worker-b t2 \"Investigate auth flow\"\n/zj-wait demo all 120\n/zj-results demo\n/zj-stop demo",
				"info",
			);
		},
	});

	pi.registerCommand("zj-start", {
		description: "Initialize session and optionally spawn workers: /zj-start <session> [worker1 worker2 ...]",
		handler: async (args, ctx) => {
			const t = splitArgs((args || "").trim());
			const session = t[0];
			const workers = t.slice(1);
			if (!session) {
				ctx.ui.notify("Usage: /zj-start <session> [worker1 worker2 ...]", "error");
				return;
			}
			try {
				await executeAndNotify({ action: "init", session }, ctx.cwd, (m, l) => ctx.ui.notify(m, l));
				for (const worker of workers) {
					await executeAndNotify({ action: "spawn", session, subagentId: worker }, ctx.cwd, (m, l) => ctx.ui.notify(m, l));
				}
			} catch (e: any) {
				ctx.ui.notify(truncate(String(e?.message || e), 1200), "error");
			}
		},
	});

	pi.registerCommand("zj-task", {
		description: "Assign a task: /zj-task <session> <worker|all> <taskId> <promptFile|promptText>",
		handler: async (args, ctx) => {
			const t = splitArgs((args || "").trim());
			const [session, target, taskId, ...rest] = t;
			if (!session || !target || !taskId || rest.length === 0) {
				ctx.ui.notify("Usage: /zj-task <session> <worker|all> <taskId> <promptFile|promptText>", "error");
				return;
			}
			const promptRaw = rest.join(" ");
			const prompt = parsePromptSource(promptRaw);
			try {
				await executeAndNotify({ action: "assign", session, target, taskId, ...prompt }, ctx.cwd, (m, l) => ctx.ui.notify(m, l));
			} catch (e: any) {
				ctx.ui.notify(truncate(String(e?.message || e), 1200), "error");
			}
		},
	});

	pi.registerCommand("zj-run", {
		description: "One-shot run: spawn worker, assign task, wait, collect",
		handler: async (args, ctx) => {
			const t = splitArgs((args || "").trim());
			const [session, worker, ...rest] = t;
			if (!session || !worker || rest.length === 0) {
				ctx.ui.notify("Usage: /zj-run <session> <worker> <promptFile|promptText>", "error");
				return;
			}
			const taskId = `task-${Date.now()}`;
			const prompt = parsePromptSource(rest.join(" "));
			try {
				await executeAndNotify({ action: "init", session }, ctx.cwd, (m, l) => ctx.ui.notify(m, l));
				await executeAndNotify({ action: "spawn", session, subagentId: worker }, ctx.cwd, (m, l) => ctx.ui.notify(m, l));
				await executeAndNotify({ action: "assign", session, target: worker, taskId, ...prompt }, ctx.cwd, (m, l) => ctx.ui.notify(m, l));
				await executeAndNotify({ action: "wait", session, target: worker, timeoutSec: 120 }, ctx.cwd, (m, l) => ctx.ui.notify(m, l));
				await executeAndNotify({ action: "collect", session, json: true }, ctx.cwd, (m, l) => ctx.ui.notify(m, l));
			} catch (e: any) {
				ctx.ui.notify(truncate(String(e?.message || e), 1200), "error");
			}
		},
	});

	pi.registerCommand("zj-wait", {
		description: "Wait for completion: /zj-wait <session> [worker|all] [timeoutSec] [--grace N]",
		handler: async (args, ctx) => {
			const t = splitArgs((args || "").trim());
			const session = t[0];
			if (!session) {
				ctx.ui.notify("Usage: /zj-wait <session> [worker|all] [timeoutSec] [--grace N]", "error");
				return;
			}
			const target = t[1] ?? "all";
			const timeoutSec = Number(t[2] ?? 120);
			let graceSec: number | undefined;
			for (let i = 3; i < t.length; i++) if (t[i] === "--grace") graceSec = Number(t[++i] ?? 10);
			try {
				await executeAndNotify({ action: "wait", session, target, timeoutSec, graceSec }, ctx.cwd, (m, l) => ctx.ui.notify(m, l));
			} catch (e: any) {
				ctx.ui.notify(truncate(String(e?.message || e), 1200), "error");
			}
		},
	});

	pi.registerCommand("zj-results", {
		description: "Collect results: /zj-results <session>",
		handler: async (args, ctx) => {
			const session = splitArgs((args || "").trim())[0];
			if (!session) {
				ctx.ui.notify("Usage: /zj-results <session>", "error");
				return;
			}
			try {
				await executeAndNotify({ action: "collect", session, json: true }, ctx.cwd, (m, l) => ctx.ui.notify(m, l));
			} catch (e: any) {
				ctx.ui.notify(truncate(String(e?.message || e), 1200), "error");
			}
		},
	});

	pi.registerCommand("zj-stop", {
		description: "Terminate orchestrator session: /zj-stop <session>",
		handler: async (args, ctx) => {
			const session = splitArgs((args || "").trim())[0];
			if (!session) {
				ctx.ui.notify("Usage: /zj-stop <session>", "error");
				return;
			}
			try {
				await executeAndNotify({ action: "terminate", session, target: "all" }, ctx.cwd, (m, l) => ctx.ui.notify(m, l));
			} catch (e: any) {
				ctx.ui.notify(truncate(String(e?.message || e), 1200), "error");
			}
		},
	});
}

