import { pathToFileURL } from "node:url";
import {
	estimateTokens,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
	type SessionManager,
} from "@earendil-works/pi-coding-agent";

interface AfkSettings {
	enabled?: boolean;
	idleCompactionMinutes?: number;
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
	let enabled = false;
	let idleCompactionMinutes = 5;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const clearTimer = () => clearTimeout(timer);

	function armTimer(ctx: ExtensionContext): void {
		clearTimer();
		if (!enabled) return;
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
		}, idleCompactionMinutes * 60_000).unref();
	}

	pi.on("session_start", (_event, ctx) => {
		const { piAfk } = pi.getSettings() as { piAfk?: AfkSettings };
		enabled = piAfk?.enabled ?? true;
		if (enabled) idleCompactionMinutes = piAfk?.idleCompactionMinutes ?? 5;
		armTimer(ctx);
	});

	pi.on("agent_start", clearTimer);
	pi.on("agent_settled", (_event, ctx) => armTimer(ctx));
	pi.on("session_tree", (_event, ctx) => armTimer(ctx));
	pi.on("session_compact", clearTimer);
	pi.on("session_shutdown", clearTimer);

	pi.on("session_before_compact", (event, ctx) => {
		if (!enabled) return;
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
