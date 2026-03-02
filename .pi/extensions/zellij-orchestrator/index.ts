import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
	command: Type.Optional(Type.String({ description: "PI_SUBAGENT_CMD for worker spawn" })),
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

function truncate(text: string, max = 12000): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`;
}

function normalizePath(p: string): string {
	return p.startsWith("@") ? p.slice(1) : p;
}

function resolveScriptPath(cwd: string): string {
	const candidates = [
		process.env.PI_ZELLIJ_ORCH_SCRIPT,
		path.join(cwd, "bin", "orchestrator.sh"),
		path.join(cwd, "zellij-pi-orchestrator", "bin", "orchestrator.sh"),
		"/private/tmp/zellij-pi-orchestrator/bin/orchestrator.sh",
	].filter(Boolean) as string[];

	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) return candidate;
	}

	throw new Error(
		`Could not locate orchestrator.sh. Set PI_ZELLIJ_ORCH_SCRIPT or place it at <cwd>/bin/orchestrator.sh. Tried: ${candidates.join(", ")}`,
	);
}

function splitArgs(raw: string): string[] {
	const tokens = raw.match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\S+/g) ?? [];
	return tokens.map((t) => {
		if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
			return t.slice(1, -1);
		}
		return t;
	});
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
				if (Array.isArray(sessions)) {
					for (const s of sessions) if (typeof s === "string") managedSessions.add(s);
				}
			}
		}
		if (managedSessions.size > 0) {
			ctx.ui.setStatus("zellij-orch", `Managed sessions: ${Array.from(managedSessions).join(", ")}`);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		for (const session of managedSessions) {
			try {
				const script = resolveScriptPath(ctx.cwd);
				await pi.exec(script, ["terminate", session, "all"]);
			} catch {
				// best-effort cleanup
			}
		}
		ctx.ui.setStatus("zellij-orch", undefined);
	});

	const run = async (params: Params, cwd: string, signal?: AbortSignal) => {
		const script = resolveScriptPath(cwd);
		const args: string[] = [];
		let tempPromptFile: string | undefined;

		switch (params.action) {
			case "init":
				args.push("init", params.session);
				managedSessions.add(params.session);
				persistState();
				break;
			case "spawn": {
				if (!params.subagentId) throw new Error("subagentId is required for spawn");
				args.push("spawn", params.session, params.subagentId);
				if (params.cwd) args.push("--cwd", normalizePath(params.cwd));
				if (params.command) args.push("--cmd", params.command);
				managedSessions.add(params.session);
				persistState();
				break;
			}
			case "assign": {
				const target = params.target ?? "all";
				if (!params.taskId) throw new Error("taskId is required for assign");
				let promptFile = params.promptFile;
				if (!promptFile && params.promptText) {
					tempPromptFile = path.join(os.tmpdir(), `pi-zellij-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
					fs.writeFileSync(tempPromptFile, params.promptText, "utf8");
					promptFile = tempPromptFile;
				}
				if (!promptFile) throw new Error("promptFile or promptText is required for assign");
				args.push("assign", params.session, target, params.taskId, normalizePath(promptFile));
				break;
			}
			case "wait":
				args.push("wait", params.session, params.target ?? "all", String(params.timeoutSec ?? 120));
				if (params.graceSec !== undefined) args.push("--grace", String(params.graceSec));
				break;
			case "collect":
				args.push("collect", params.session);
				if (params.json !== false) args.push("--json");
				break;
			case "status":
				args.push("status", params.session);
				break;
			case "terminate":
				args.push("terminate", params.session, params.target ?? "all");
				if ((params.target ?? "all") === "all") {
					managedSessions.delete(params.session);
					persistState();
				}
				break;
			case "demo":
				args.push("demo", params.session);
				managedSessions.add(params.session);
				persistState();
				break;
		}

		try {
			const result = await pi.exec(script, args, { signal, timeout: 300000 });
			const stdout = result.stdout ?? "";
			const stderr = result.stderr ?? "";
			let parsed: unknown;
			if (params.action === "collect" && (params.json ?? true)) {
				try {
					parsed = JSON.parse(stdout);
				} catch {
					parsed = undefined;
				}
			}
			return { script, args, code: result.code, stdout, stderr, parsed };
		} finally {
			if (tempPromptFile) {
				try {
					fs.unlinkSync(tempPromptFile);
				} catch {
					// ignore temp cleanup errors
				}
			}
		}
	};

	pi.registerTool({
		name: "zellij_orchestrate",
		label: "Zellij Orchestrate",
		description:
			"Control Zellij-based Pi subagents: init/spawn/assign/wait/collect/terminate. Use collect(json=true) after wait.",
		parameters: ParamsSchema,
		async execute(_toolCallId, params: Params, signal, _onUpdate, ctx) {
			const out = await run(params, ctx.cwd, signal);
			const cmd = `${out.script} ${out.args.join(" ")}`;
			const status = out.code === 0 ? "ok" : "error";
			let text = `[zellij_orchestrate:${status}] ${params.action} session=${params.session}`;
			if (out.stdout.trim()) text += `\n\nstdout:\n${truncate(out.stdout)}`;
			if (out.stderr.trim()) text += `\n\nstderr:\n${truncate(out.stderr)}`;

			ctx.ui.setStatus("zellij-orch", `last: ${params.action} (${status})`);
			return {
				content: [{ type: "text", text }],
				details: {
					command: cmd,
					exitCode: out.code,
					stdout: truncate(out.stdout),
					stderr: truncate(out.stderr),
					parsed: out.parsed,
				},
				isError: out.code !== 0,
			};
		},
	});

	pi.registerCommand("zj", {
		description: "Run orchestrator command directly, eg: /zj status my-session",
		handler: async (args, ctx) => {
			const raw = (args || "").trim();
			if (!raw) {
				ctx.ui.notify("Usage: /zj <init|spawn|assign|wait|collect|status|terminate|demo> ...", "info");
				return;
			}
			const script = resolveScriptPath(ctx.cwd);
			const tokens = splitArgs(raw);
			const result = await pi.exec(script, tokens, { timeout: 300000 });
			if (result.stdout?.trim()) ctx.ui.notify(truncate(result.stdout, 1200), result.code === 0 ? "info" : "error");
			if (result.stderr?.trim()) ctx.ui.notify(truncate(result.stderr, 1200), "warning");
		},
	});
}
