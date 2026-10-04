import { it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { claimOwnership, OwnershipRoutes, ownershipEnv, promptDigest, REGISTER_MARKER, CAPTURE_MARKER } from "../src/engram-ownership.js";

export function bus() {
	const listeners = new Map();
	return {
		on(channel, fn) {
			const set = listeners.get(channel) ?? new Set();
			listeners.set(channel, set);
			set.add(fn);
			return () => set.delete(fn);
		},
		emit(channel, data) { for (const fn of [...(listeners.get(channel) ?? [])]) fn(data); },
		count(channel) { return listeners.get(channel)?.size ?? 0; },
	};
}
const CLAIM = "engram:bridge:claim:v1";
const DECISION = "engram:bridge:decision:v1";
const claim = { runtimeSessionId: " opaque / session ", nonce: "nonce", operation: "prompt-capture", promptDigest: promptDigest(" hello world ") };

it("hashes UTF-8 JavaScript-trimmed text without exposing the prompt", () => {
	assert.equal(promptDigest("\uFEFF café 😀 \u00A0"), createHash("sha256").update("café 😀", "utf8").digest("hex"));
});
it("subscribes before emitting and ignores every correlation mismatch", async () => {
	const b = bus();
	b.on(CLAIM, (request) => {
		assert.equal(b.count(DECISION), 1);
		for (const patch of [{ runtimeSessionId: "foreign" }, { nonce: "other" }, { operation: "session-register" }, { promptDigest: "0".repeat(64) }, { status: "ready" }]) {
			b.emit(DECISION, { ...request, status: "owned", ...patch });
		}
		b.emit(DECISION, { ...request, status: "owned" });
	});
	assert.equal(await claimOwnership(b, claim, [], 20), "owned");
	assert.equal(b.count(DECISION), 0);
});
it("timeout, abort and late decisions never produce ownership or leak subscriptions", async () => {
	const b = bus();
	const started = performance.now();
	assert.equal(await claimOwnership(b, claim, [], 10), "unknown");
	assert.ok(performance.now() - started >= 5, "must actually await a decision rather than immediately return unknown");
	b.emit(DECISION, { ...claim, status: "owned" });
	const abort = new AbortController();
	const pending = claimOwnership(b, claim, [abort.signal], 100);
	abort.abort();
	assert.equal(await pending, "unknown");
	assert.equal(b.count(DECISION), 0);
	assert.equal(await claimOwnership(b, claim, [abort.signal], 100), "unknown");
});
it("keeps independent buses and warns once per session, not once per process", async () => {
	const routes = new OwnershipRoutes();
	const a = bus(), b = bus(), warnings = [];
	const removeA = routes.bind("a", a, (text) => warnings.push(["a", text]));
	const removeB = routes.bind("b", b, (text) => warnings.push(["b", text]));
	a.on(CLAIM, (request) => a.emit(DECISION, { ...request, status: "owned" }));
	b.on(CLAIM, (request) => b.emit(DECISION, { ...request, status: "unknown" }));
	const [yes, no] = await Promise.all([routes.forQuery("a", "original prompt"), routes.forQuery("b", "original prompt")]);
	assert.equal(yes.registration, true);
	assert.equal(yes.capture, true);
	assert.equal(no.registration, false);
	await routes.forQuery("b", "another prompt");
	const replacement = routes.bind("b", b, (text) => warnings.push(["b", text]));
	removeB();
	await routes.forQuery("b", "after reload prompt");
	assert.equal(warnings.length, 1);
	replacement();
	assert.match(warnings[0][1], /hooks.*reload/i);
	removeA(); removeB();
});
it("concurrent sessions cannot borrow acknowledgements from another runtime bus", async () => {
	const routes = new OwnershipRoutes();
	const a = bus(), b = bus(), requestsA = [], requestsB = [];
	const removeA = routes.bind("a", a, () => {}), removeB = routes.bind("b", b, () => {});
	a.on(CLAIM, (request) => requestsA.push(request));
	b.on(CLAIM, (request) => requestsB.push(request));
	const pendingA = routes.forQuery("a", "shared prompt text"), pendingB = routes.forQuery("b", "shared prompt text");
	assert.equal(a.count(DECISION), 2);
	assert.equal(b.count(DECISION), 2);
	for (const request of requestsA) b.emit(DECISION, { ...request, status: "owned" });
	for (const request of requestsB) a.emit(DECISION, { ...request, status: "owned" });
	assert.equal(a.count(DECISION), 2);
	assert.equal(b.count(DECISION), 2);
	for (const request of requestsA) a.emit(DECISION, { ...request, status: "owned" });
	for (const request of requestsB) b.emit(DECISION, { ...request, status: "unknown" });
	assert.equal((await pendingA).capture, true);
	assert.equal((await pendingB).capture, false);
	removeA(); removeB();
});
it("reload aborts pending claims and old cleanup cannot remove a replacement route", async () => {
	const routes = new OwnershipRoutes();
	const old = bus(), next = bus();
	const removeOld = routes.bind("s", old, () => {});
	const pending = routes.forQuery("s", "original prompt");
	const removeNext = routes.bind("s", next, () => {});
	removeOld();
	assert.equal((await pending).cancelled, true);
	assert.equal(old.count(DECISION), 0);
	next.on(CLAIM, (request) => next.emit(DECISION, { ...request, status: "owned" }));
	assert.equal((await routes.forQuery("s", "original prompt")).capture, true);
	removeNext();
});
it("registration is not prompt proof; short prompts retain their hook even on an owned reply", async () => {
	const routes = new OwnershipRoutes();
	const b = bus();
	const remove = routes.bind("s", b, () => {});
	b.on(CLAIM, (request) => b.emit(DECISION, { ...request, status: request.operation === "session-register" ? "owned" : "unknown" }));
	const partial = await routes.forQuery("s", "longer prompt");
	assert.equal(partial.registration, true);
	assert.equal(partial.capture, false);
	const allOwned = bus();
	const removeOwned = routes.bind("owned-short", allOwned, () => {});
	allOwned.on(CLAIM, (request) => allOwned.emit(DECISION, { ...request, status: "owned" }));
	const short = await routes.forQuery("owned-short", " 1234567890 ");
	assert.equal(short.registration, true);
	assert.equal(short.capture, false);
	removeOwned();
	remove();
});
it("markers are independent JSON proofs scoped to actual child identity and current digest", () => {
	const inherited = { [REGISTER_MARKER]: "stale", [CAPTURE_MARKER]: "stale", KEEP: "yes" };
	const result = { registration: true, capture: false, promptDigest: claim.promptDigest };
	const env = ownershipEnv(inherited, "opaque", "child-uuid", result);
	assert.deepEqual(JSON.parse(env[REGISTER_MARKER]), { version: 1, runtimeSessionId: "opaque", claudeSessionId: "child-uuid" });
	assert.equal(env[CAPTURE_MARKER], undefined);
	const capture = ownershipEnv(inherited, "opaque", "child-uuid", { ...result, capture: true });
	assert.deepEqual(JSON.parse(capture[CAPTURE_MARKER]), { version: 1, runtimeSessionId: "opaque", claudeSessionId: "child-uuid", promptDigest: claim.promptDigest });
	assert.notEqual(JSON.parse(capture[CAPTURE_MARKER]).promptDigest, promptDigest("later steer"));
	assert.equal(ownershipEnv(inherited)[REGISTER_MARKER], undefined);
	assert.equal(ownershipEnv(inherited)[CAPTURE_MARKER], undefined);
	assert.equal(ownershipEnv(inherited).KEEP, "yes");
});
