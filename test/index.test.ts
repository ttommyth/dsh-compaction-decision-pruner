/**
 * Behavioural tests for the decision-model context pruner.
 *
 * Everything is driven through the public surface — `resolveConfig()` and the
 * `compactIfNeeded` wrapper that `apply()` installs — against fake cordis,
 * session, and fetch objects, so no model, server, or harness is needed. The
 * fake session mirrors the shapes dsh 0.2.0-rc.2 writes, which is what lets
 * these tests catch contract drift: the `startSeq`/`endSeq` rename, the
 * `slice(-0)` protect-tail bug, injected user messages, and a lost
 * missing-backend guard were all found this way.
 *
 * Test sessions are deliberately tiny, so every pass opts out of the protected
 * tail through {@link pruneConfig}; the tail rule itself is covered on its own.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply, Config, inject, name, resolveConfig, type DecisionPrunerConfig } from "../src/index.js";

/**
 * A decision-server URL for tests. The plugin has no default host, so every
 * configuration names one; the runner's environment must not leak one in.
 */
const DECISION_URL = "http://decision.invalid";
delete process.env.DECISION_BASE_URL;

/* ------------------------------------------------------------------ */
/*  Fakes                                                              */
/* ------------------------------------------------------------------ */

interface FakeEvent {
	type: string;
	seq: number;
	data: unknown;
	sourceEventSeqs?: number[];
	surfaceOp?: unknown;
}

interface AppendRecord {
	type: string;
	data: Record<string, unknown>;
	opts?: Record<string, unknown>;
}

/**
 * Configuration for a test pass that always scores and never protects the tail.
 *
 * @param overrides - fields to replace.
 * @returns a pruner configuration for tests.
 */
function pruneConfig(overrides: DecisionPrunerConfig = {}): DecisionPrunerConfig {
	return { baseUrl: DECISION_URL, minTokensToScore: 1, minChars: 1, protectTail: 0, ...overrides };
}

/** Minimal stand-in for a dsh `Message`. */
function toolMessage(text: string, callId: string): Record<string, unknown> {
	return {
		role: "tool",
		content: [{ type: "text", text }],
		source: { kind: "tool", callId },
		toolCallId: callId,
		isError: false,
		id: `msg-${callId}`
	};
}

/**
 * Build a session whose events are supplied in surface order.
 *
 * @param events - fully-formed events, seqs assigned by the caller.
 * @returns a fake session plus the appends it received.
 */
function fakeSession(events: FakeEvent[]): {
	session: Record<string, unknown>;
	appends: AppendRecord[];
} {
	const appends: AppendRecord[] = [];
	let nextSeq = Math.max(...events.map((event) => event.seq), 0) + 1;
	const bySeq = new Map(events.map((event) => [event.seq, event]));
	const session = {
		surface: { nodes: events.map((event) => event.seq) },
		eventAt: (seq: number) => bySeq.get(seq),
		deriveEventMessage: (event: FakeEvent) => {
			if (event.type === "tool/result") return (event.data as { message: unknown }).message;
			if (event.type === "user/message") return { role: "user", content: (event.data as { content: unknown }).content };
			return null;
		},
		append: (type: string, data: Record<string, unknown>, opts?: Record<string, unknown>) => {
			appends.push({ type, data, opts });
			const seq = nextSeq;
			nextSeq += 1;
			bySeq.set(seq, { type, seq, data });
			return { seq };
		}
	};
	return { session, appends };
}

/** A `user/message` event; real input by default. */
function userMessage(seq: number, text: string, sourceKind = "user"): FakeEvent {
	return { type: "user/message", seq, data: { role: "user", content: [{ type: "text", text }], source: { kind: sourceKind } } };
}

/** A `tool/call` event, so a result can name its tool. */
function toolCall(seq: number, toolName: string): FakeEvent {
	return { type: "tool/call", seq, data: { turn: 1, step: 1, callId: `call-${seq}`, name: toolName, arguments: "{}" } };
}

/** A `tool/result` event citing its `tool/call`. */
function toolResult(seq: number, text: string, callSeq: number): FakeEvent {
	return {
		type: "tool/result",
		seq,
		data: { turn: 1, step: 1, message: toolMessage(text, `call-${callSeq}`) },
		sourceEventSeqs: [callSeq],
		surfaceOp: "append"
	};
}

/** A logger that records instead of printing. */
function fakeLogger(): { lines: string[]; info: (m: string) => void; warn: (m: string) => void; debug: (m: string) => void } {
	const lines: string[] = [];
	return {
		lines,
		info: (text: string) => lines.push(`info:${text}`),
		warn: (text: string) => lines.push(`warn:${text}`),
		debug: (text: string) => lines.push(`debug:${text}`)
	};
}

/** A cordis-like context with a fake compaction engine. */
function fakeContext(
	session: unknown,
	totalTokens = 50000
): {
	ctx: Record<string, unknown>;
	engine: { compactIfNeeded: (agent: unknown, trigger: unknown, signal: unknown) => Promise<unknown> };
	logger: ReturnType<typeof fakeLogger>;
	originalCalls: Array<{ trigger: unknown }>;
} {
	const logger = fakeLogger();
	const originalCalls: Array<{ trigger: unknown }> = [];
	const engine = {
		compactIfNeeded: async (_agent: unknown, trigger: unknown, _signal: unknown) => {
			originalCalls.push({ trigger });
			return { compacted: true };
		}
	};
	const ctx = {
		compaction: engine,
		tokenMeter: {
			measure: () => ({ totalTokens }),
			estimateMessage: (message: unknown) => Math.ceil(JSON.stringify(message).length / 4)
		},
		logger
	};
	return { ctx, engine, logger, originalCalls };
}

/** Replace `fetch` with a stub answering each question in the order sent. */
function stubFetch(scores: number[]): Array<Record<string, any>> {
	const bodies: Array<Record<string, any>> = [];
	(globalThis as { fetch: unknown }).fetch = async (_url: string, init: { body: string }) => {
		const body = JSON.parse(init.body);
		bodies.push(body);
		const answers: Record<string, unknown> = {};
		Object.keys(body.questions).forEach((key, index) => {
			answers[key] = { type: "noul", noul: scores[index] ?? 1 };
		});
		return { ok: true, status: 200, json: async () => ({ model: body.model, answers }) };
	};
	return bodies;
}

/** Replace `fetch` with a stub that always fails. */
function stubFetchFailure(): () => number {
	let calls = 0;
	(globalThis as { fetch: unknown }).fetch = async () => {
		calls += 1;
		throw new Error("connect ECONNREFUSED 127.0.0.1:9");
	};
	return () => calls;
}

/** Drive one compaction pass through the wrapper `apply()` installed. */
async function runPass(ctx: Record<string, unknown>, session: unknown): Promise<unknown> {
	const engine = ctx.compaction as { compactIfNeeded: (a: unknown, t: unknown, s: AbortSignal) => Promise<unknown> };
	return engine.compactIfNeeded({ session }, "pressure", new AbortController().signal);
}

/** A session with one user goal and `count` tool results, each `size` chars. */
function sessionWithTools(count: number, size = 900): { session: Record<string, unknown>; appends: AppendRecord[] } {
	const events: FakeEvent[] = [userMessage(1, "Count the ERROR lines in needed.txt")];
	for (let index = 0; index < count; index += 1) {
		const callSeq = 2 + index * 2;
		events.push(toolCall(callSeq, `tool${index}`), toolResult(callSeq + 1, "x".repeat(size), callSeq));
	}
	return fakeSession(events);
}

/* ------------------------------------------------------------------ */
/*  Configuration                                                      */
/* ------------------------------------------------------------------ */

test("resolveConfig applies defaults and freezes the result", () => {
	const config = resolveConfig({ baseUrl: DECISION_URL });
	assert.equal(config.enabled, true);
	assert.equal(config.baseUrl, DECISION_URL);
	assert.equal(config.model, "clef-flash");
	assert.equal(config.keepThreshold, 0.35);
	assert.equal(config.minChars, 480);
	assert.equal(config.minTokensToScore, 40000);
	assert.equal(config.protectTail, 6);
	assert.equal(config.maxChunks, 24);
	assert.equal(config.maxRequests, 2);
	assert.equal(config.scoreChars, 2000);
	assert.equal(config.timeoutMs, 30000);
	assert.equal(config.failureBackoffMs, 300000);
	assert.equal(config.dryRun, false);
	assert.equal(config.traceFile, "");
	assert.ok(Object.isFrozen(config));
});

test("resolveConfig defaults the question to the counterfactual wording", () => {
	const { question } = resolveConfig({ baseUrl: DECISION_URL });
	assert.ok(question.includes("{k}"));
	assert.match(question, /removed/);
	assert.match(question, /lost/);
});

test("resolveConfig rejects an unknown key instead of ignoring it", () => {
	assert.throws(() => resolveConfig({ baseUrl: DECISION_URL, nonsense: true } as never), /unknown key "nonsense"/);
});

test("resolveConfig rejects a keepThreshold outside [0, 1]", () => {
	assert.throws(() => resolveConfig({ keepThreshold: 1.5 }), /keepThreshold/);
	assert.throws(() => resolveConfig({ keepThreshold: -0.1 }), /keepThreshold/);
});

test("resolveConfig rejects non-integer counters", () => {
	assert.throws(() => resolveConfig({ protectTail: 1.5 }), /protectTail/);
	assert.throws(() => resolveConfig({ minChars: -1 }), /minChars/);
});

test("resolveConfig rejects maxChunks below one", () => {
	assert.throws(() => resolveConfig({ maxChunks: 0 }), /maxChunks/);
});

test("resolveConfig requires a decision server URL, since there is no default host", () => {
	assert.throws(() => resolveConfig(), /baseUrl is required/);
	assert.throws(() => resolveConfig({ baseUrl: "" }), /baseUrl is required/);
});

test("resolveConfig rejects an empty model", () => {
	assert.throws(() => resolveConfig({ baseUrl: DECISION_URL, model: "" }), /model/);
});

test("resolveConfig rejects a question without the {k} placeholder", () => {
	assert.throws(() => resolveConfig({ baseUrl: DECISION_URL, question: "Is this needed?" }), /\{k\}/);
});

test("the plugin advertises its name and the services it needs", () => {
	assert.equal(name, "compaction-decision-pruner");
	assert.deepEqual(inject, ["compaction", "tokenMeter"]);
});

/* ------------------------------------------------------------------ */
/*  Declared config schema                                             */
/* ------------------------------------------------------------------ */

/**
 * Run the exported schema over a candidate config.
 *
 * schemastery reports failures either as a standard-schema issues result or by
 * throwing, so both are treated as "rejected".
 */
function schemaRejects(input: unknown): boolean {
	try {
		const result = Config["~standard"].validate(input) as { issues?: unknown };
		return result.issues !== undefined;
	} catch {
		return true;
	}
}

test("the schema accepts a config the plugin also accepts", () => {
	assert.equal(schemaRejects({ baseUrl: DECISION_URL }), false);
	assert.equal(schemaRejects(pruneConfig({ keepThreshold: 0.9 })), false);
});

test("the schema carries a default for every option, matching the plugin's own", () => {
	const result = Config["~standard"].validate({}) as { value: Record<string, unknown>; issues?: unknown };
	assert.equal(result.issues, undefined);
	const schemaDefaults = result.value;
	const pluginDefaults = resolveConfig({ baseUrl: DECISION_URL }) as unknown as Record<string, unknown>;

	// A drift guard: the schema is what a DSH client renders, so its defaults must
	// track the plugin's. `baseUrl` is compared separately because the plugin test
	// supplies one.
	assert.deepEqual(Object.keys(schemaDefaults).sort(), Object.keys(pluginDefaults).sort());
	for (const key of Object.keys(pluginDefaults)) {
		if (key === "baseUrl") continue;
		assert.deepEqual(schemaDefaults[key], pluginDefaults[key], `schema default for ${key}`);
	}
	assert.equal(schemaDefaults.baseUrl, process.env.DECISION_BASE_URL ?? "");
});

test("every option is described, so a client can label it", () => {
	const dict = (Config as unknown as { dict?: Record<string, unknown> }).dict ?? {};
	assert.ok(Object.keys(dict).length > 0, "the schema should expose its fields");
	for (const [key, schema] of Object.entries(dict)) {
		const meta = (schema as { meta?: { description?: unknown } }).meta;
		assert.equal(typeof meta?.description, "string", `${key} needs a description`);
	}
});

test("the schema rejects values the plugin would refuse", () => {
	assert.equal(schemaRejects({ baseUrl: DECISION_URL, keepThreshold: 2 }), true);
	assert.equal(schemaRejects({ baseUrl: DECISION_URL, protectTail: -1 }), true);
	assert.equal(schemaRejects({ baseUrl: DECISION_URL, question: "no placeholder" }), true);
	assert.equal(schemaRejects({ baseUrl: DECISION_URL, maxChunks: 0 }), true);
});

/* ------------------------------------------------------------------ */
/*  Arming                                                             */
/* ------------------------------------------------------------------ */

test("a disabled pruner leaves the compaction engine untouched", async () => {
	const { session } = sessionWithTools(1);
	const { ctx, engine } = fakeContext(session);
	const before = engine.compactIfNeeded;
	const bodies = stubFetch([0.01]);

	apply(ctx as never, { enabled: false, baseUrl: DECISION_URL });
	assert.equal((ctx.compaction as typeof engine).compactIfNeeded, before);
	await runPass(ctx, session);
	assert.deepEqual(bodies, []);
});

test("a configuration error surfaces as a named plugin error", () => {
	const { session } = sessionWithTools(1);
	const { ctx } = fakeContext(session);
	assert.throws(() => apply(ctx as never, { baseUrl: DECISION_URL, keepThreshold: 9 }), /compaction-decision-pruner/);
});

test("a context without a compaction backend arms nothing and does not throw", () => {
	const logger = fakeLogger();
	assert.doesNotThrow(() => apply({ tokenMeter: {}, logger } as never, { baseUrl: DECISION_URL }));
	assert.ok(logger.lines.some((line) => line.includes("no compaction backend")));
});

test("the wrapper delegates to the original and forwards its result", async () => {
	const { session } = sessionWithTools(1);
	const { ctx, originalCalls } = fakeContext(session);
	apply(ctx as never, pruneConfig());

	const result = await runPass(ctx, session);
	assert.deepEqual(result, { compacted: true });
	assert.equal(originalCalls.length, 1);
	assert.equal(originalCalls[0].trigger, "pressure");
});

/* ------------------------------------------------------------------ */
/*  Scoring and masking                                                */
/* ------------------------------------------------------------------ */

test("a chunk below the threshold is replaced by the marker", async () => {
	const { session, appends } = fakeSession([
		userMessage(1, "Diagnose the flaky deploy"),
		toolCall(2, "npm"),
		toolResult(3, "npm http fetch GET 200 https://registry.example/pkg-1 12ms", 2)
	]);
	const { ctx } = fakeContext(session);
	stubFetch([0.02]);
	apply(ctx as never, pruneConfig());

	await runPass(ctx, session);

	const prune = appends.find((entry) => entry.type === "compaction/prune");
	assert.ok(prune, "expected a compaction/prune shadow-price event");
	assert.deepEqual(prune?.data.shadowedSeqs, [3]);
	assert.ok((prune?.data.shadowedTokenCount as number) > 0);

	const replace = appends.find((entry) => entry.type === "tool/result");
	assert.ok(replace, "expected a replacement tool/result event");
	assert.deepEqual(replace?.opts?.surfaceOp, { op: "replace", startSeq: 3, endSeq: 3 });
	assert.deepEqual(replace?.opts?.sourceEventSeqs, [3]);

	const content = (replace?.data.message as { content: Array<{ text: string }> }).content;
	assert.equal(content.length, 1);
	assert.match(content[0].text, /^\[\.\. pruned \d+ tok \| npm seq 3 \|/);
	// The marker must be recognisable, never a paraphrase of the removed text.
	assert.ok(!content[0].text.includes("registry.example"));
});

test("a chunk at or above the threshold is left byte-identical", async () => {
	const { session, appends } = fakeSession([
		userMessage(1, "Fix port exhaustion"),
		toolCall(2, "netstat"),
		toolResult(3, "netstat: 28411 sockets in TIME_WAIT on 8080", 2)
	]);
	const { ctx } = fakeContext(session);
	const bodies = stubFetch([0.91]);
	apply(ctx as never, pruneConfig());

	await runPass(ctx, session);
	assert.equal(bodies.length, 1, "the chunk was scored");
	assert.deepEqual(appends, [], "but nothing was rewritten");
});

test("the shadow price cites the token meter's price for the shadowed node", async () => {
	const { session, appends } = fakeSession([userMessage(1, "goal"), toolCall(2, "read"), toolResult(3, "y".repeat(400), 2)]);
	const { ctx } = fakeContext(session);
	stubFetch([0.01]);
	apply(ctx as never, pruneConfig());

	await runPass(ctx, session);
	const prune = appends.find((entry) => entry.type === "compaction/prune");
	const expected = Math.ceil(JSON.stringify(toolMessage("y".repeat(400), "call-2")).length / 4);
	assert.equal(prune?.data.shadowedTokenCount, expected);
});

test("high-value chunks survive next to masked ones in the same pass", async () => {
	const { session, appends } = fakeSession([
		userMessage(1, "Count the ERROR lines in needed.txt"),
		toolCall(2, "read"),
		toolResult(3, "1: ERROR auth failed", 2),
		toolCall(4, "read"),
		toolResult(5, "npm http fetch GET 200 https://registry.example/pkg-1 12ms", 4)
	]);
	const { ctx } = fakeContext(session);
	stubFetch([0.95, 0.04]);
	apply(ctx as never, pruneConfig());

	await runPass(ctx, session);

	const replaced = appends.filter((entry) => entry.type === "tool/result");
	assert.equal(replaced.length, 1, "exactly one chunk should be masked");
	assert.deepEqual(replaced[0].opts?.surfaceOp, { op: "replace", startSeq: 5, endSeq: 5 });
});

test("dryRun reports the mask without rewriting the surface", async () => {
	const { session, appends } = sessionWithTools(1);
	const { ctx, logger } = fakeContext(session);
	stubFetch([0.01]);
	apply(ctx as never, pruneConfig({ dryRun: true }));

	await runPass(ctx, session);
	assert.deepEqual(appends, []);
	assert.ok(logger.lines.some((line) => line.includes("1/1 masked")));
});

/* ------------------------------------------------------------------ */
/*  Candidate selection                                                */
/* ------------------------------------------------------------------ */

test("protectTail keeps the trailing surface nodes untouched", async () => {
	const { session, appends } = fakeSession([
		userMessage(1, "goal"),
		toolCall(2, "a"),
		toolResult(3, "filler ".repeat(100), 2),
		toolCall(4, "b"),
		toolResult(5, "recent ".repeat(100), 4)
	]);
	const { ctx } = fakeContext(session);
	stubFetch([0.01, 0.01]);
	apply(ctx as never, pruneConfig({ protectTail: 2 }));

	await runPass(ctx, session);
	const replaced = appends.filter((entry) => entry.type === "tool/result");
	assert.equal(replaced.length, 1);
	assert.deepEqual(replaced[0].opts?.surfaceOp, { op: "replace", startSeq: 3, endSeq: 3 });
});

test("protectTail of zero protects nothing (regression: slice(-0) selects everything)", async () => {
	const { session, appends } = sessionWithTools(1);
	const { ctx } = fakeContext(session);
	stubFetch([0.01]);
	apply(ctx as never, pruneConfig({ protectTail: 0 }));

	await runPass(ctx, session);
	assert.equal(appends.filter((entry) => entry.type === "tool/result").length, 1);
});

test("a chunk smaller than minChars is never scored", async () => {
	const { session, appends } = fakeSession([userMessage(1, "goal"), toolCall(2, "math"), toolResult(3, "42", 2)]);
	const { ctx } = fakeContext(session);
	const bodies = stubFetch([0.01]);
	apply(ctx as never, pruneConfig({ minChars: 480 }));

	await runPass(ctx, session);
	assert.deepEqual(bodies, []);
	assert.deepEqual(appends, []);
});

test("a chunk already carrying the sentinel is skipped, so markers never nest", async () => {
	const { session, appends } = fakeSession([
		userMessage(1, "goal"),
		toolCall(2, "read"),
		toolResult(3, "[.. pruned 83 tok | read seq 3 | off-task, full text in session log ..]", 2)
	]);
	const { ctx } = fakeContext(session);
	const bodies = stubFetch([0.01]);
	apply(ctx as never, pruneConfig());

	await runPass(ctx, session);
	assert.deepEqual(bodies, []);
	assert.deepEqual(appends, []);
});

test("nothing is scored below the token floor", async () => {
	const { session } = sessionWithTools(1);
	const { ctx, logger } = fakeContext(session, 5000);
	const bodies = stubFetch([0.01]);
	apply(ctx as never, pruneConfig({ minTokensToScore: 40000 }));

	await runPass(ctx, session);
	assert.deepEqual(bodies, []);
	assert.ok(logger.lines.some((line) => line.includes("below-floor(5000)")));
});

test("a session with no user message is skipped rather than scored", async () => {
	const { session } = fakeSession([toolCall(2, "read"), toolResult(3, "x".repeat(900), 2)]);
	const { ctx, logger } = fakeContext(session);
	const bodies = stubFetch([0.01]);
	apply(ctx as never, pruneConfig());

	await runPass(ctx, session);
	assert.deepEqual(bodies, []);
	assert.ok(logger.lines.some((line) => line.includes("no-goal")));
});

test("the goal comes from real user input, not an injected reminder (regression)", async () => {
	const { session } = fakeSession([
		userMessage(1, "Count the ERROR lines in needed.txt"),
		userMessage(2, "<system-reminder>Available skills: find-skills, motion-design</system-reminder>", "skill-catalog"),
		toolCall(3, "read"),
		toolResult(4, "x".repeat(900), 3)
	]);
	const { ctx } = fakeContext(session);
	const bodies = stubFetch([0.9]);
	apply(ctx as never, pruneConfig());

	await runPass(ctx, session);
	assert.equal(bodies.length, 1);
	assert.equal(bodies[0].state.goal, "Count the ERROR lines in needed.txt");
});

/* ------------------------------------------------------------------ */
/*  Batching                                                           */
/* ------------------------------------------------------------------ */

test("chunks are scored in one request per maxChunks batch", async () => {
	const { session } = sessionWithTools(5);
	const { ctx } = fakeContext(session);
	const bodies = stubFetch([0.9, 0.9, 0.9, 0.9, 0.9]);
	apply(ctx as never, pruneConfig({ maxChunks: 2, maxRequests: 5 }));

	await runPass(ctx, session);
	assert.equal(bodies.length, 3, "5 chunks at 2 per request is 3 requests");
	assert.deepEqual(
		bodies.map((body) => Object.keys(body.questions).length),
		[2, 2, 1]
	);
});

test("maxRequests caps how many requests one pass may issue", async () => {
	const { session } = sessionWithTools(5);
	const { ctx } = fakeContext(session);
	const bodies = stubFetch([0.9, 0.9, 0.9, 0.9, 0.9]);
	apply(ctx as never, pruneConfig({ maxChunks: 1, maxRequests: 2 }));

	await runPass(ctx, session);
	assert.equal(bodies.length, 2);
});

test("the request carries the goal, the chunk window, and a noul question per chunk", async () => {
	const { session } = sessionWithTools(1);
	const { ctx } = fakeContext(session);
	const bodies = stubFetch([0.9]);
	apply(ctx as never, pruneConfig());

	await runPass(ctx, session);
	assert.equal(bodies[0].model, "clef-flash");
	assert.equal(bodies[0].state.goal, "Count the ERROR lines in needed.txt");
	assert.deepEqual(Object.keys(bodies[0].state.chunks), ["c0"]);
	assert.equal(bodies[0].questions.c0.type, "noul");
	assert.match(bodies[0].questions.c0.instructions, /If chunk c0 were removed/);
});

/* ------------------------------------------------------------------ */
/*  Failure handling                                                   */
/* ------------------------------------------------------------------ */

test("a scoring failure fails open and still compacts", async () => {
	const { session, appends } = sessionWithTools(1);
	const { ctx, logger, originalCalls } = fakeContext(session);
	stubFetchFailure();
	apply(ctx as never, pruneConfig());

	const result = await runPass(ctx, session);
	assert.deepEqual(result, { compacted: true }, "the backend must still run");
	assert.equal(originalCalls.length, 1);
	assert.deepEqual(appends, [], "nothing is masked when scoring fails");
	assert.ok(logger.lines.some((line) => line.includes("continuing unmasked")));
});

test("after a failure the pruner backs off instead of paying the timeout each turn", async () => {
	const { session } = sessionWithTools(1);
	const { ctx } = fakeContext(session);
	const fetchCalls = stubFetchFailure();
	apply(ctx as never, pruneConfig({ failureBackoffMs: 60000 }));

	await runPass(ctx, session);
	assert.equal(fetchCalls(), 1);
	await runPass(ctx, session);
	assert.equal(fetchCalls(), 1, "the second pass must not retry while backed off");
});

test("a rejected replacement fails that chunk only", async () => {
	const { session } = sessionWithTools(1);
	const { ctx, logger } = fakeContext(session);
	(session as { append: unknown }).append = () => {
		throw new Error("surface rewrite rejected");
	};
	stubFetch([0.01]);
	apply(ctx as never, pruneConfig());

	await assert.doesNotReject(() => runPass(ctx, session));
	assert.ok(logger.lines.some((line) => line.includes("mask rejected for seq 3")));
});

/* ------------------------------------------------------------------ */
/*  Tracing                                                            */
/* ------------------------------------------------------------------ */

test("traceFile records the armed configuration and one line per scored chunk", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dp-test-"));
	const traceFile = join(dir, "trace.ndjson");
	try {
		const { session } = fakeSession([
			userMessage(1, "Count the ERROR lines"),
			toolCall(2, "read"),
			toolResult(3, "1: ERROR auth failed", 2),
			toolCall(4, "read"),
			toolResult(5, "npm http fetch GET 200 https://registry.example/pkg 12ms", 4)
		]);
		const { ctx } = fakeContext(session, 12345);
		stubFetch([0.95, 0.04]);
		apply(ctx as never, pruneConfig({ traceFile }));

		await runPass(ctx, session);

		const lines = readFileSync(traceFile, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.equal(lines.length, 3, "armed line plus two scored chunks");
		assert.equal(lines[0].event, "armed");
		assert.equal(lines[0].model, "clef-flash");
		assert.equal(lines[1].tool, "read");
		assert.equal(lines[1].keep, true);
		assert.equal(lines[2].keep, false);
		assert.equal(lines[2].surfaceTokens, 12345);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an unwritable trace file never breaks a pass", async () => {
	const { session } = sessionWithTools(1);
	const { ctx } = fakeContext(session);
	stubFetch([0.01]);
	apply(ctx as never, pruneConfig({ traceFile: "/nonexistent-dir-xyz/trace.ndjson" }));

	await assert.doesNotReject(() => runPass(ctx, session));
});
