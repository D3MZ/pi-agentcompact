import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { createAssistantMessageEventStream, contentText } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import afk from "../extension.ts";

async function start(t: TestContext, settings: object = {}, inputTokens = 0, projectSettings?: object) {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const cwd = mkdtempSync(join(tmpdir(), "pi afk "));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	writeFileSync(join(cwd, "settings.json"), JSON.stringify(settings));
	if (projectSettings) {
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(projectSettings));
	}
	const settingsManager = SettingsManager.create(cwd, cwd);
	const manager = SessionManager.create(cwd, cwd);
	const requests: string[][] = [];
	const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const resourceLoader = new DefaultResourceLoader({
		cwd, agentDir: cwd, settingsManager,
		extensionFactories: [afk, (pi) => {
			pi.registerProvider("afk-test", {
				api: "afk-test", apiKey: "mock", baseUrl: "http://127.0.0.1",
				models: [{
					id: "test", name: "Test", input: ["text"], cost, reasoning: false,
					contextWindow: 128_000, maxTokens: 1024,
				}],
				streamSimple(model, context) {
					requests.push(context.messages.filter((m) => m.role !== "system").map((m) => contentText(m.content)));
					const stream = createAssistantMessageEventStream();
					stream.push({
						type: "done", reason: "stop", message: {
							role: "assistant", api: model.api, provider: model.provider, model: model.id,
							content: [{ type: "text", text: `Reply ${requests.length}` }],
							usage: { ...cost, input: inputTokens, totalTokens: inputTokens, cost: { ...cost, total: 0 } },
							stopReason: "stop", timestamp: Date.now(),
						},
					});
					return stream;
				},
			});
		}],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd, agentDir: cwd, settingsManager, sessionManager: manager, resourceLoader, noTools: "all",
	});
	t.after(() => session.dispose());
	await session.bindExtensions({ mode: "rpc" });
	await session.setModel(session.modelRuntime.getModel("afk-test", "test")!);
	return { session, manager, requests, cwd };
}

test("idle compaction resets on each turn, persists, and replaces the next request's history", async (t) => {
	const { session, manager, requests } = await start(t);
	await session.prompt("First question");
	t.mock.timers.tick(299_999);
	assert.notEqual(manager.getLeafEntry()?.type, "compaction");

	await session.prompt("Second question");
	t.mock.timers.tick(299_999);
	assert.notEqual(manager.getLeafEntry()?.type, "compaction");
	t.mock.timers.tick(1);

	const logFile = manager.getSessionFile()!;
	const prefix = `See pi logs uri for more details: ${pathToFileURL(logFile).href}.`;
	const expected = `${prefix} user messages: First question\nSecond question, your last response: Reply 2.`;
	const compacted = SessionManager.open(logFile).getLeafEntry();
	assert.equal(compacted?.type, "compaction");
	assert.equal(compacted.firstKeptEntryId, compacted.id);
	assert.equal(compacted.summary, expected);

	await session.prompt("Third question");
	assert.equal(requests[2].length, 2);
	assert.ok(requests[2][0].includes(expected));
	assert.equal(requests[2][1], "Third question");
	t.mock.timers.tick(300_000);
	const repeated = manager.getLeafEntry();
	assert.equal(repeated?.type, "compaction");
	assert.equal(repeated.summary, `${prefix} user messages: First question\nSecond question\nThird question, your last response: Reply 3.`);
});

test("manual compaction replaces the whole history without a model call", async (t) => {
	const { session, manager, requests } = await start(t, { compaction: { keepRecentTokens: 0 } });
	await session.prompt("Hello");
	await session.compact();
	const compacted = manager.getLeafEntry();
	assert.equal(compacted?.type, "compaction");
	assert.equal(compacted.firstKeptEntryId, compacted.id);
	assert.ok(compacted.summary.endsWith("user messages: Hello, your last response: Reply 1."));
	assert.equal(requests.length, 1);

	t.mock.timers.tick(300_000);
	assert.equal(manager.getLeafEntry()?.id, compacted.id);
});

test("Pi's automatic compaction also uses the replacement summary", async (t) => {
	const { session, manager, requests } = await start(t, {
		compaction: { keepRecentTokens: 0, reserveTokens: 28_000 },
	}, 101_000);
	await session.prompt("Hello");
	const compacted = manager.getLeafEntry();
	assert.equal(compacted?.type, "compaction");
	assert.equal(compacted.firstKeptEntryId, compacted.id);
	assert.ok(compacted.summary.endsWith("user messages: Hello, your last response: Reply 1."));
	assert.equal(requests.length, 1);
});

test("honors a custom idle timeout", async (t) => {
	const { session, manager } = await start(t, { piAfk: { idleCompactionMinutes: 1 } });
	await session.prompt("Hello");
	t.mock.timers.tick(59_999);
	assert.notEqual(manager.getLeafEntry()?.type, "compaction");
	t.mock.timers.tick(1);
	assert.equal(manager.getLeafEntry()?.type, "compaction");
});

test("disabled leaves compaction to Pi and ignores the idle timeout", async (t) => {
	const { session, manager, requests } = await start(t, {
		piAfk: { enabled: false, idleCompactionMinutes: 1 },
		compaction: { keepRecentTokens: 0 },
	});
	await session.prompt("Hello");
	t.mock.timers.tick(300_000);
	assert.notEqual(manager.getLeafEntry()?.type, "compaction");

	await session.compact();
	assert.equal(requests.length, 2);
	const compacted = manager.getLeafEntry();
	assert.equal(compacted?.type, "compaction");
	assert.ok(compacted.summary.includes("Reply 2"));
	assert.equal(compacted.fromHook, false);
	assert.notEqual(compacted.firstKeptEntryId, compacted.id);
});

test("/afk applies and saves both settings, and can re-enable the plugin", async (t) => {
	const { session, manager, cwd } = await start(t, { hideThinkingBlock: true });
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = cwd;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});

	const menus: string[][] = [];
	const choices = [1, 0, 0, 2];
	const runner = session.extensionRunner;
	runner.setUIContext({
		...runner.getUIContext(),
		async select(_title, options) {
			menus.push(options);
			return options[choices.shift()!];
		},
		async input() {
			return "1.5";
		},
	}, "rpc");

	await session.prompt("Hello");
	await session.prompt("/afk");
	assert.deepEqual(menus, [
		["Enabled: Yes", "Idle compaction (minutes): 5", "Done"],
		["Enabled: Yes", "Idle compaction (minutes): 1.5", "Done"],
		["Enabled: No", "Done"],
		["Enabled: Yes", "Idle compaction (minutes): 1.5", "Done"],
	]);
	assert.deepEqual(JSON.parse(readFileSync(join(cwd, "settings.json"), "utf8")), {
		hideThinkingBlock: true,
		piAfk: { enabled: true, idleCompactionMinutes: 1.5 },
	});
	t.mock.timers.tick(89_999);
	assert.notEqual(manager.getLeafEntry()?.type, "compaction");
	t.mock.timers.tick(1);
	assert.equal(manager.getLeafEntry()?.type, "compaction");
});

test("/afk edits an existing project override without changing user settings", async (t) => {
	const global = { piAfk: { idleCompactionMinutes: 5 } };
	const { session, manager, cwd } = await start(t, global, 0, {
		piAfk: { idleCompactionMinutes: 2 },
	});
	const runner = session.extensionRunner;
	const choices = [0, 1];
	runner.setUIContext({
		...runner.getUIContext(),
		async select(_title, options) {
			return options[choices.shift()!];
		},
	}, "rpc");
	await session.prompt("Hello");
	await session.prompt("/afk");
	t.mock.timers.tick(300_000);
	assert.notEqual(manager.getLeafEntry()?.type, "compaction");
	assert.deepEqual(JSON.parse(readFileSync(join(cwd, ".pi", "settings.json"), "utf8")), {
		piAfk: { enabled: false, idleCompactionMinutes: 2 },
	});
	assert.deepEqual(JSON.parse(readFileSync(join(cwd, "settings.json"), "utf8")), global);
});
