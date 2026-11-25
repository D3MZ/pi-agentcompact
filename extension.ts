import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	CONFIG_DIR_NAME,
	estimateTokens,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
	type SessionManager,
} from "@earendil-works/pi-coding-agent";

interface AgentCompactSettings {
	enabled: boolean;
	idleCompactionMinutes: number;
}

type PiSettings = { piAgentCompact?: Partial<AgentCompactSettings> };

function readSettings(path: string): PiSettings {
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

function saveSettings(ctx: ExtensionContext, changes: Partial<AgentCompactSettings>): void {
	const projectPath = join(ctx.cwd, CONFIG_DIR_NAME, "settings.json");
	const project = ctx.isProjectTrusted() ? readSettings(projectPath) : {};
	const path = project.piAgentCompact ? projectPath : join(getAgentDir(), "settings.json");
	const settings = project.piAgentCompact ? project : readSettings(path);
	settings.piAgentCompact = { ...settings.piAgentCompact, ...changes };
	writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

function summarize(branch: SessionEntry[], logFile: string): string {
	const userMessages: string[] = [];
	let lastResponse = "";

	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const { message } = entry;
		if (message.role !== "user" && message.role !== "assistant") continue;
		const content = typeof message.content === "string"
			? message.content
			: message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
		if (message.role === "user") userMessages.push(content);
		else lastResponse = content;
	}

	return `See pi logs uri for more details: ${pathToFileURL(logFile).href}. user messages: ${userMessages.join("\n")}, your last response: ${lastResponse}.`;
}

export default function (pi: ExtensionAPI): void {
	let settings: AgentCompactSettings = { enabled: false, idleCompactionMinutes: 5 };
	let timer: ReturnType<typeof setTimeout> | undefined;

	const clearTimer = () => clearTimeout(timer);

	function armTimer(ctx: ExtensionContext): void {
		clearTimer();
		if (!settings.enabled) return;
		const manager = ctx.sessionManager;
		const logFile = manager.getSessionFile();
		if (!logFile || !manager.buildSessionProjection().messages.some((message) => message.role === "user")) return;

		timer = setTimeout(() => {
			if (!ctx.isIdle()) return;
			const summary = summarize(manager.getBranch(), logFile);
			const tokensBefore = manager.buildSessionProjection().messages.reduce((sum, message) => sum + estimateTokens(message), 0);
			// Pi 1.6 exposes the live manager as read-only. Its compaction command skips the
			// hook for short sessions, so append the native retain-none entry directly here.
			(manager as SessionManager).appendCompaction(summary, null, tokensBefore, undefined, true);
		}, settings.idleCompactionMinutes * 60_000).unref();
	}

	pi.registerCommand("agentcompact", {
		description: "Edit AgentCompact settings",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			while (true) {
				const toggle = `Enabled: ${settings.enabled ? "Yes" : "No"}`;
				const idle = `Idle compaction (minutes): ${settings.idleCompactionMinutes}`;
				const choice = await ctx.ui.select("AgentCompact settings", settings.enabled
					? [toggle, idle, "Done"]
					: [toggle, "Done"]);
				let changes: Partial<AgentCompactSettings>;
				if (choice === toggle) {
					changes = { enabled: !settings.enabled };
				} else if (settings.enabled && choice === idle) {
					const input = await ctx.ui.input("Idle compaction in minutes", String(settings.idleCompactionMinutes));
					if (input === undefined) continue;
					const minutes = Number(input);
					// Node timers overflow beyond approximately 35,791 minutes.
					if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 35_791) {
						ctx.ui.notify("Enter a positive number of minutes up to 35,791.", "warning");
						continue;
					}
					changes = { idleCompactionMinutes: minutes };
				} else {
					return;
				}
				saveSettings(ctx, changes);
				settings = { ...settings, ...changes };
				armTimer(ctx);
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		const { piAgentCompact } = pi.getSettings() as PiSettings;
		settings = { enabled: piAgentCompact?.enabled ?? true, idleCompactionMinutes: piAgentCompact?.idleCompactionMinutes ?? 5 };
		armTimer(ctx);
	});

	pi.on("agent_start", clearTimer);
	pi.on("agent_settled", (_event, ctx) => armTimer(ctx));
	pi.on("session_tree", (_event, ctx) => armTimer(ctx));
	pi.on("session_compact", clearTimer);
	pi.on("session_shutdown", clearTimer);

	pi.on("session_before_compact", (event, ctx) => {
		if (!settings.enabled) return;
		const logFile = ctx.sessionManager.getSessionFile();
		if (!logFile) return;
		return {
			compaction: {
				summary: summarize(event.branchEntries, logFile),
				// The hook's type omits null, but Pi passes it to appendCompaction unchanged.
				firstKeptEntryId: null!,
				tokensBefore: event.preparation.tokensBefore,
			},
		};
	});
}
