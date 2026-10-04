import { it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueryContext } from "../src/query-state.js";
import { ownershipRoutes, promptDigest, REGISTER_MARKER, CAPTURE_MARKER } from "../src/engram-ownership.js";

const temp = mkdtempSync(join(tmpdir(), "bridge-ownership-"));
process.on("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = temp;
process.env.CLAUDE_CONFIG_DIR = temp;
writeFileSync(join(temp, "claude-bridge.json"), JSON.stringify({ startupNoticeShown: "test", askClaude: { enabled: true } }));
const { default: activate, __test } = await import("../src/index.js");
const handlers = new Map(), warnings = [], calls = [];
const listeners = new Map();
const events = {
	on(channel, fn) { const set = listeners.get(channel) ?? new Set(); listeners.set(channel, set); set.add(fn); return () => set.delete(fn); },
	emit(channel, data) { for (const fn of [...(listeners.get(channel) ?? [])]) fn(data); },
};
let provider;
activate({
	events,
	on(name, fn) { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); },
	registerProvider(name, config) { provider = config; },
	registerTool() {},
});
const contextFor = (id) => ({ sessionManager: { getSessionId: () => id }, ui: { notify: (message) => warnings.push(message) }, modelRegistry: { getProvider: () => ({}) } });
const emit = (name, event, id) => { for (const fn of handlers.get(name) ?? []) fn(event, contextFor(id)); };
let statuses = { "session-register": "owned", "prompt-capture": "owned" };
let transformReply = (reply) => reply;
let claims = [];
events.on("engram:bridge:claim:v1", (request) => {
	claims.push(request);
	if (statuses) events.emit("engram:bridge:decision:v1", transformReply({ ...request, status: statuses[request.operation] }));
});
const model = { id: "claude-sonnet-4-6", provider: "claude-bridge", api: "anthropic-messages", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const context = (text) => ({ messages: [{ role: "user", content: text, timestamp: 1 }], tools: [] });
function fakeQuery(args) {
	calls.push(args.options);
	const q = (async function* () {
		yield { type: "system", subtype: "init", session_id: args.options.resume ?? args.options.sessionId };
		yield { type: "result", subtype: "success", session_id: args.options.resume ?? args.options.sessionId, usage: {}, modelUsage: {} };
	})();
	q.interrupt = async () => {};
	q.close = () => {};
	return q;
}
__test.setQuery(fakeQuery);
__test.setSideQuery(fakeQuery);
after(() => {
	emit("session_shutdown", {}, "s");
	__test.setQuery(null); __test.setSideQuery(null);
});
async function run(id, text, options = {}) {
	const stream = provider.streamSimple(model, context(text), { sessionId: id, ...options });
	await stream.result();
	await new Promise((resolve) => setImmediate(resolve));
	return calls.at(-1);
}

it("first child identity is explicit before hooks, resume keeps it, claims use exact runtime ID", async () => {
	emit("session_start", { reason: "startup" }, " opaque / id ");
	const first = await run(" opaque / id ", "original prompt");
	assert.match(first.sessionId, /^[a-f0-9-]{36}$/);
	assert.equal(first.resume, undefined);
	assert.deepEqual(JSON.parse(first.env[REGISTER_MARKER]), { version: 1, runtimeSessionId: " opaque / id ", claudeSessionId: first.sessionId });
	assert.equal(JSON.parse(first.env[CAPTURE_MARKER]).promptDigest, promptDigest("original prompt"));
	assert.ok(claims.every((request) => request.runtimeSessionId === " opaque / id "));
	assert.ok(claims.every((request) => request.nonce.trim() && request.nonce.length <= 256));
	assert.equal(new Set(claims.map((request) => request.nonce)).size, 2);
	assert.equal(claims[0].promptDigest, undefined);
	const resumeId = first.sessionId;
	__test.setSharedSession(" opaque / id ", { sessionId: resumeId, cursor: 0, cwd: process.cwd() });
	const resumed = await run(" opaque / id ", "different prompt");
	assert.equal(resumed.resume, resumeId);
	assert.equal(resumed.sessionId, undefined);
	assert.equal(JSON.parse(resumed.env[CAPTURE_MARKER]).claudeSessionId, resumeId);
	assert.equal(JSON.parse(resumed.env[CAPTURE_MARKER]).promptDigest, promptDigest("different prompt"));
});
it("unknown capture never inherits proof; warning is once-session and registration remains separate", async () => {
	emit("session_start", { reason: "new" }, "unknown");
	statuses = { "session-register": "owned", "prompt-capture": "unknown" };
	process.env[REGISTER_MARKER] = "inherited"; process.env[CAPTURE_MARKER] = "inherited";
	const before = warnings.length;
	const options = await run("unknown", "uncaptured prompt");
	assert.ok(options.env[REGISTER_MARKER]);
	assert.equal(options.env[CAPTURE_MARKER], undefined);
	await run("unknown", "next uncaptured prompt");
	assert.equal(warnings.length, before + 1);
	statuses = { "session-register": "owned", "prompt-capture": "owned" };
	assert.equal((await run("unknown", "short")).env[CAPTURE_MARKER], undefined);
	const foreign = await run("not-the-route", "foreign prompt");
	assert.equal(foreign.env[REGISTER_MARKER], undefined);
	assert.equal(foreign.env[CAPTURE_MARKER], undefined);
	delete process.env[REGISTER_MARKER]; delete process.env[CAPTURE_MARKER];
});
it("a mismatched capture digest and late ownership retain hooks after the bounded wait", async () => {
	emit("session_start", { reason: "new" }, "mismatch");
	transformReply = (reply) => reply.operation === "prompt-capture" ? { ...reply, promptDigest: "0".repeat(64) } : reply;
	const started = performance.now();
	const options = await run("mismatch", "current original prompt");
	assert.ok(performance.now() - started >= 1000, "wait exceeds native's 1000ms budget");
	assert.ok(options.env[REGISTER_MARKER]);
	assert.equal(options.env[CAPTURE_MARKER], undefined);
	const late = claims.at(-1);
	events.emit("engram:bridge:decision:v1", { ...late, status: "owned" });
	assert.equal(options.env[CAPTURE_MARKER], undefined);
	assert.equal(listeners.get("engram:bridge:decision:v1").size, 0);
	transformReply = (reply) => reply;
	const next = await run("mismatch", "next original prompt");
	assert.equal(JSON.parse(next.env[CAPTURE_MARKER]).promptDigest, promptDigest("next original prompt"));
});
it("abort and reload during handshake prevent child spawn and settle the provider stream", async () => {
	emit("session_start", { reason: "new" }, "abort");
	statuses = null;
	let before = calls.length;
	const controller = new AbortController();
	const pending = provider.streamSimple(model, context("waiting prompt"), { sessionId: "abort", signal: controller.signal });
	controller.abort();
	assert.equal((await pending.result()).stopReason, "aborted");
	assert.equal(calls.length, before);
	const reload = provider.streamSimple(model, context("waiting prompt"), { sessionId: "abort" });
	emit("session_start", { reason: "reload" }, "abort");
	assert.equal((await reload.result()).stopReason, "aborted");
	assert.equal(calls.length, before);
	assert.equal(listeners.get("engram:bridge:decision:v1").size, 0);
	statuses = { "session-register": "owned", "prompt-capture": "owned" };
});
it("tool-result continuation reuses the parked child without any ownership claim", async () => {
	const c = new QueryContext();
	c.activeQuery = { close() {}, interrupt: async () => {} };
	c.piSessionId = "continuation";
	c.turnToolCallIds = ["call"];
	c.pendingToolCalls.set("call", { toolName: "read", resolve() { __test.finalizeCurrentStream(c, "stop"); } });
	__test.activeQueryContexts.add(c);
	const before = claims.length;
	const stream = provider.streamSimple(model, { messages: [{ role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "result" }], timestamp: 1 }], tools: [] }, { sessionId: "continuation" });
	await stream.result();
	assert.equal(claims.length, before);
	__test.activeQueryContexts.delete(c);
});
it("AskClaude preserves its hooks, summary excludes settings, neither inherits ownership markers", async () => {
	process.env[REGISTER_MARKER] = "inherited"; process.env[CAPTURE_MARKER] = "inherited";
	await __test.promptAndWait("delegated", "none", new Map(), undefined, { isolated: true, appendSkills: false });
	const delegated = calls.at(-1);
	assert.deepEqual(delegated.settingSources, ["user", "project"]);
	assert.equal(delegated.env[REGISTER_MARKER], undefined);
	assert.equal(delegated.env[CAPTURE_MARKER], undefined);
	await __test.isolatedStreamFn(model, context("summary"), {}).result();
	const summary = calls.at(-1);
	assert.deepEqual(summary.settingSources, []);
	assert.equal(summary.env[REGISTER_MARKER], undefined);
	assert.equal(summary.env[CAPTURE_MARKER], undefined);
	delete process.env[REGISTER_MARKER]; delete process.env[CAPTURE_MARKER];
});
it("a fresh extension instance routes native claims for the reused provider by its own session bus", async () => {
	const childListeners = new Map(), childHandlers = new Map(), childClaims = [];
	const childBus = {
		on(name, fn) { const set = childListeners.get(name) ?? new Set(); childListeners.set(name, set); set.add(fn); return () => set.delete(fn); },
		emit(name, data) { for (const fn of [...(childListeners.get(name) ?? [])]) fn(data); },
	};
	const { default: childActivate } = await import("../src/index.js?ownership-child");
	childActivate({ events: childBus, on(name, fn) { const list = childHandlers.get(name) ?? []; list.push(fn); childHandlers.set(name, list); }, registerProvider() {}, registerTool() {} });
	childBus.on("engram:bridge:claim:v1", (request) => { childClaims.push(request); childBus.emit("engram:bridge:decision:v1", { ...request, status: "owned" }); });
	for (const fn of childHandlers.get("session_start")) fn({ reason: "startup" }, contextFor("child"));
	const before = claims.length;
	const options = await run("child", "child original prompt");
	assert.equal(JSON.parse(options.env[REGISTER_MARKER]).runtimeSessionId, "child");
	assert.equal(claims.length, before);
	assert.equal(childClaims.length, 2);
	for (const fn of childHandlers.get("session_shutdown")) fn({}, contextFor("child"));
	assert.equal((await ownershipRoutes.forQuery("child", "child original prompt")).registration, false);
});
