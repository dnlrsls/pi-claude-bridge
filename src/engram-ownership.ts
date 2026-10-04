import { createHash, randomUUID } from "node:crypto";

export const REGISTER_MARKER = "PI_ENGRAM_BRIDGE_SESSION_REGISTER";
export const CAPTURE_MARKER = "PI_ENGRAM_BRIDGE_PROMPT_CAPTURE";
const CLAIM = "engram:bridge:claim:v1";
const DECISION = "engram:bridge:decision:v1";
// Native prompt capture has a 1000ms acknowledgement budget. Leave headroom.
export const OWNERSHIP_WAIT_MS = 1250;

type Status = "owned" | "unknown";
interface Bus {
	on(channel: string, handler: (data: unknown) => void): () => void;
	emit(channel: string, data: unknown): void;
}
interface Claim {
	runtimeSessionId: string;
	nonce: string;
	operation: "session-register" | "prompt-capture";
	promptDigest?: string;
}
interface Ownership {
	registration: boolean;
	capture: boolean;
	cancelled: boolean;
	promptDigest: string;
}
export function promptDigest(prompt: string): string {
	return createHash("sha256").update(prompt.trim(), "utf8").digest("hex");
}

/** No readiness cache: every child asks about its own session and current turn. */
export function claimOwnership(bus: Bus, claim: Claim, signals: readonly AbortSignal[] = [], timeoutMs = OWNERSHIP_WAIT_MS): Promise<Status> {
	if (signals.some((signal) => signal.aborted)) return Promise.resolve("unknown");
	return new Promise((resolve) => {
		let settled = false;
		let unsubscribe = () => {};
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (status: Status) => {
			if (settled) return;
			settled = true;
			unsubscribe();
			clearTimeout(timer);
			for (const signal of signals) signal.removeEventListener("abort", abort);
			resolve(status);
		};
		const abort = () => finish("unknown");
		try {
			unsubscribe = bus.on(DECISION, (data) => {
				if (!data || typeof data !== "object") return;
				const reply = data as Record<string, unknown>;
				if (reply.runtimeSessionId !== claim.runtimeSessionId || reply.nonce !== claim.nonce
					|| reply.operation !== claim.operation || reply.promptDigest !== claim.promptDigest) return;
				if (reply.status === "owned" || reply.status === "unknown") finish(reply.status);
			});
			for (const signal of signals) signal.addEventListener("abort", abort, { once: true });
			timer = setTimeout(() => finish("unknown"), timeoutMs);
			bus.emit(CLAIM, claim);
		} catch {
			finish("unknown"); // An unavailable extension must not disable CC hooks.
		}
	});
}

interface Route {
	bus: Bus;
	controller: AbortController;
	notify: (message: string) => void;
}
/** One route per opaque runtime session ID; stores no ExtensionContext. */
export class OwnershipRoutes {
	private routes = new Map<string, Route>();
	private warned = new Set<string>();

	bind(sessionId: string, bus: Bus, notify: (message: string) => void): () => void {
		this.routes.get(sessionId)?.controller.abort();
		const route = { bus, notify, controller: new AbortController() };
		this.routes.set(sessionId, route);
		return () => {
			route.controller.abort();
			if (this.routes.get(sessionId) !== route) return;
			this.routes.delete(sessionId);
			this.warned.delete(sessionId);
		};
	}

	async forQuery(sessionId: string | null | undefined, prompt: string, signal?: AbortSignal): Promise<Ownership> {
		const digest = promptDigest(prompt);
		const route = sessionId ? this.routes.get(sessionId) : undefined;
		let registration = false, capture = false;
		if (route && sessionId) {
			const signals = signal ? [signal, route.controller.signal] : [route.controller.signal];
			const ask = (operation: Claim["operation"]) => claimOwnership(route.bus, {
				runtimeSessionId: sessionId, nonce: randomUUID(), operation,
				...(operation === "prompt-capture" ? { promptDigest: digest } : {}),
			}, signals);
			const [registered, captured] = await Promise.all([ask("session-register"), ask("prompt-capture")]);
			registration = registered === "owned";
			// Native skips these; even an erroneous owned reply cannot suppress them.
			capture = captured === "owned" && prompt.trim().length > 10;
		}
		const cancelled = Boolean(signal?.aborted || route?.controller.signal.aborted);
		if (!cancelled && (!registration || !capture)) {
			const key = sessionId ?? "(unattributed)";
			if (!this.warned.has(key)) {
				this.warned.add(key);
				const message = "Claude bridge: native Engram ownership is unknown; keeping Claude hooks enabled. Enable/update the native Engram extension and reload this session to avoid duplicate registration or prompt capture.";
				if (route) route.notify(message);
				else console.warn(message);
			}
		}
		return { registration, capture, cancelled, promptDigest: digest };
	}
}

// A reused provider can live in another module evaluation (worktree subagents).
// Share only the session-to-bus routing table, never a process-wide ready flag.
const ROUTES_KEY = Symbol.for("claude-bridge:engramOwnershipRoutes:v1");
const globalRoutes = globalThis as Record<symbol, unknown>;
export const ownershipRoutes = (globalRoutes[ROUTES_KEY] ??= new OwnershipRoutes()) as OwnershipRoutes;

/** Explicit undefined overrides also clear markers when SDK merges process.env. */
export function ownershipEnv(base: NodeJS.ProcessEnv, runtimeSessionId?: string | null, claudeSessionId?: string, ownership?: Ownership): NodeJS.ProcessEnv {
	const env = { ...base, [REGISTER_MARKER]: undefined as string | undefined, [CAPTURE_MARKER]: undefined as string | undefined };
	if (!runtimeSessionId || !claudeSessionId || !ownership || ownership.cancelled) return env;
	const identity = { version: 1, runtimeSessionId, claudeSessionId };
	if (ownership.registration) env[REGISTER_MARKER] = JSON.stringify(identity);
	if (ownership.capture) env[CAPTURE_MARKER] = JSON.stringify({ ...identity, promptDigest: ownership.promptDigest });
	return env;
}
