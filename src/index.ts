/**
 * Decision-model context pruner for dsh compaction — extractive masking.
 *
 * The shipped `dsh-compaction-basic` condenses history generatively: it asks a
 * chat model to rewrite older turns into a summary. That path can mangle paths,
 * error codes, and line numbers, and it costs a full generation per compaction.
 *
 * This plugin adds a cheaper, lossless first pass in front of it. It splits the
 * current surface at natural boundaries (one chunk per tool result), asks a
 * *decision* model (Cloudflare Clef-Flash over the Jev/SystemOne route) whether
 * each chunk is still needed for the active goal, and replaces the chunks that
 * are not with a fixed-shape marker. Surviving chunks are never rewritten, so
 * retained text keeps exact fidelity and compaction can often skip the summary
 * entirely because the markers already relieved the pressure.
 *
 * Contracts this file depends on (verified against dsh 0.2.0-rc.2):
 * - `BasicCompactionEngine.compactIfNeeded(agent, trigger, signal)` is invoked
 *   through `this`, so an instance-level wrapper is honored at event time.
 * - A tool-result message is read through `session.deriveEventMessage(event)`,
 *   and its `content` is a flat `ContentBlock[]`.
 * - A surface replacement is one `compaction/prune` shadow-price event followed
 *   by a re-appended `tool/result` carrying
 *   `surfaceOp: { op: 'replace', startSeq, endSeq }` and `sourceEventSeqs`,
 *   exactly as `dsh-compaction-tool-result-pruner` does.
 * - Scoring is one forward pass with no generated text; a `noul` question
 *   answers P(true).
 *
 * Every runtime dependency is a Node built-in or a global, so the built output
 * imports nothing: a profile can load it without the harness packages present.
 *
 * @module dsh-compaction-decision-pruner
 */

import type { Context } from "@deepseek-ai/cordis";
import { isVolatile } from "@deepseek-ai/cosmokit";
import { appendFileSync } from "node:fs";
import z from "@deepseek-ai/schemastery";
// Importing the declarations loads the `Context` and `SessionEventMap`
// augmentations for `compaction`, `tokenMeter`, and the `compaction/*` events.
import type { CompactionAgentContext, CompactionTrigger } from "@deepseek-ai/dsh-compaction";
import type { CompactionResult } from "@deepseek-ai/dsh-compaction";
import type { TokenMeter } from "@deepseek-ai/dsh-token-meter";
import type { ContentBlock, Message, ToolResultMessage } from "@deepseek-ai/dsh-llm";
import type { Session, SessionEvent, SessionSeq } from "@deepseek-ai/dsh-session";

/** Plugin row name; must match the id used in a profile patch. */
export const name = "compaction-decision-pruner";
/** Services this plugin needs composed before it arms. */
export const inject = ["compaction", "tokenMeter"];

/** Marker prefix, kept distinctive so a masked chunk cannot read as prose. */
const SENTINEL = "[..";
const SENTINEL_END = "..]";

/** Configuration accepted from the plugin row. */
export interface DecisionPrunerConfig {
	/** Arm the pruner. Defaults to `true`. */
	enabled?: boolean;
	/**
	 * Decision-model server base URL. Falls back to `DECISION_BASE_URL`; one of the
	 * two must be set, because the plugin has no default host to assume.
	 */
	baseUrl?: string;
	/** Decision-model id. Defaults to `clef-flash`. */
	model?: string;
	/** Env var holding the bearer token. Defaults to `OPENAI_COMPAT_API_KEY`. */
	apiKeyEnv?: string;
	/** Literal token; overrides `apiKeyEnv` when set. */
	apiKey?: string;
	/** Mask when P(necessary) is below this. Defaults to `0.35`. */
	keepThreshold?: number;
	/** Do not score chunks smaller than this. Defaults to `480`. */
	minChars?: number;
	/**
	 * `noul` question template; `{k}` is the chunk key. The default is the
	 * counterfactual wording, which separates expendable filler from evidence far
	 * better than a plain necessity question (see the README).
	 */
	question?: string;
	/** Do not score until the surface reaches this size. Defaults to `40000`. */
	minTokensToScore?: number;
	/** Trailing surface nodes that are never touched. Defaults to `6`. */
	protectTail?: number;
	/** Chunks per scoring request. Defaults to `24`. */
	maxChunks?: number;
	/** Scoring requests per compaction pass. Defaults to `2`. */
	maxRequests?: number;
	/** Per-chunk character window sent for scoring. Defaults to `1600`. */
	scoreChars?: number;
	/** Whole-request state budget. Defaults to `48000`. */
	maxStateChars?: number;
	/** Per-request timeout in milliseconds. Defaults to `30000`. */
	timeoutMs?: number;
	/**
	 * Time to stop scoring after a failure, so an unreachable decision server
	 * cannot add the request timeout to every compaction. Defaults to 5 minutes.
	 */
	failureBackoffMs?: number;
	/** Score and log, but do not rewrite the surface. Defaults to `false`. */
	dryRun?: boolean;
	/** Append one NDJSON line per scored chunk. Empty disables it. Defaults to `""`. */
	traceFile?: string;
	/** Marker text with `{tokens}`, `{tool}`, and `{seq}` placeholders. */
	markerTemplate?: string;
}

/** A resolved configuration with every field present. */
export type ResolvedConfig = Required<DecisionPrunerConfig>;

const DEFAULTS: ResolvedConfig = Object.freeze({
	enabled: true,
	baseUrl: process.env.DECISION_BASE_URL ?? "",
	model: "clef-flash",
	apiKeyEnv: "OPENAI_COMPAT_API_KEY",
	apiKey: "",
	// P(necessary). Below this the chunk is masked; at or above it is untouched.
	keepThreshold: 0.35,
	// Chunks smaller than this are cheap to keep and noisy to judge.
	minChars: 480,
	question: "If chunk {k} were removed, would information required for the goal be lost?",
	// Do not pay for a scoring pass until the surface is actually large.
	minTokensToScore: 40000,
	// Recent surface nodes stay byte-identical so the prefix cache survives.
	protectTail: 6,
	maxChunks: 24,
	maxRequests: 2,
	scoreChars: 2000,
	maxStateChars: 48000,
	timeoutMs: 30000,
	failureBackoffMs: 300000,
	dryRun: false,
	traceFile: "",
	markerTemplate: `${SENTINEL} pruned {tokens} tok | {tool} seq {seq} | off-task, full text in session log ${SENTINEL_END}`
});

const CONFIG_KEYS = new Set(Object.keys(DEFAULTS) as (keyof ResolvedConfig)[]);

/**
 * Replace volatile holders with their current values.
 *
 * A field marked `.volatile()` in {@link Config} — which is what makes it
 * editable in a harness's settings form — resolves to an opaque holder whose
 * live value only `.get()` reveals. Reading through the holder on every use is
 * also what makes a client-side edit take effect without a restart.
 *
 * @param config - a raw or cordis-validated configuration.
 * @returns the same fields as plain values.
 */
export function unwrapConfig(config: DecisionPrunerConfig): DecisionPrunerConfig {
	const plain: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(config)) {
		if (value === null || typeof value !== "object") {
			plain[key] = value;
			continue;
		}
		const holder = value as { get?: () => unknown };
		plain[key] = isVolatile(value) || typeof holder.get === "function" ? holder.get?.() : value;
	}
	return plain as DecisionPrunerConfig;
}

/**
 * Row configuration schema.
 *
 * Declaring this gives a row two things. cordis validates its config against it
 * before the plugin starts, so a bad value fails the row with a diagnostic
 * naming the field instead of silently misconfiguring the pruner. And because
 * every field is marked `.volatile()`, a harness's settings surface derives an
 * editable form from it, which is how these options are changed from a client.
 *
 * A field that is not volatile gets no form control: dsh's `volatileForm()`
 * returns nothing for it, so the option would only be editable in the patch
 * file. Roles refine the control — `secret` keeps a value off the wire behind a
 * write-only input, `slider` renders a 0–1 number as a slider.
 *
 * Defaults are duplicated from {@link DEFAULTS} on purpose — the plugin keeps
 * its own validation so it can reject unknown keys with a readable message — and
 * a test asserts the two never drift.
 */
export const Config = z.object({
	enabled: z.boolean().default(DEFAULTS.enabled).description("Arm the pruner.").volatile(),
	baseUrl: z
		.string()
		.default(DEFAULTS.baseUrl)
		.description("Decision-model server base URL. Required: there is no default host.")
		.volatile(),
	model: z.string().default(DEFAULTS.model).description("Decision model id.").volatile(),
	apiKeyEnv: z
		.string()
		.default(DEFAULTS.apiKeyEnv)
		.description("Environment variable holding the bearer token.")
		.volatile(),
	apiKey: z
		.string()
		.default(DEFAULTS.apiKey)
		.description("Literal bearer token; overrides apiKeyEnv when non-empty.")
		.role("secret")
		.volatile(),
	keepThreshold: z
		.number()
		.step(0.01)
		.min(0)
		.max(1)
		.default(DEFAULTS.keepThreshold)
		.description("Mask a chunk when P(its information would be lost) is below this.")
		.role("slider")
		.volatile(),
	question: z
		.string()
		.pattern(/\{k\}/u)
		.default(DEFAULTS.question)
		.description("`noul` question template. Must contain the {k} chunk placeholder.")
		.volatile(),
	minChars: z
		.natural()
		.default(DEFAULTS.minChars)
		.description("Never score chunks smaller than this many characters.")
		.volatile(),
	minTokensToScore: z
		.natural()
		.default(DEFAULTS.minTokensToScore)
		.description("Never score until the measured surface reaches this size.")
		.volatile(),
	protectTail: z
		.natural()
		.default(DEFAULTS.protectTail)
		.description("Trailing surface nodes that are never candidates.")
		.volatile(),
	maxChunks: z
		.natural()
		.min(1)
		.default(DEFAULTS.maxChunks)
		.description("Chunks per scoring request.")
		.volatile(),
	maxRequests: z
		.natural()
		.min(1)
		.default(DEFAULTS.maxRequests)
		.description("Scoring requests allowed per compaction pass.")
		.volatile(),
	scoreChars: z
		.natural()
		.default(DEFAULTS.scoreChars)
		.description("Per-chunk character window sent for scoring.")
		.volatile(),
	maxStateChars: z
		.natural()
		.default(DEFAULTS.maxStateChars)
		.description("Whole-request state budget.")
		.volatile(),
	timeoutMs: z
		.natural()
		.min(1)
		.default(DEFAULTS.timeoutMs)
		.description("Per-request timeout in milliseconds.")
		.volatile(),
	failureBackoffMs: z
		.natural()
		.default(DEFAULTS.failureBackoffMs)
		.description("Pause scoring for this long after a failure.")
		.volatile(),
	dryRun: z
		.boolean()
		.default(DEFAULTS.dryRun)
		.description("Score and log without rewriting the surface.")
		.volatile(),
	traceFile: z
		.string()
		.default(DEFAULTS.traceFile)
		.description("Append one NDJSON line per scored chunk. Empty disables tracing.")
		.volatile(),
	markerTemplate: z
		.string()
		.default(DEFAULTS.markerTemplate)
		.description("Marker text with {tokens}, {tool}, and {seq} placeholders.")
		.volatile()
});

/** A `tool/result` event, narrowed from the session event union. */
type ToolResultEvent = Extract<SessionEvent, { type: "tool/result" }>;

/** One prunable chunk. */
interface Candidate {
	readonly seq: SessionSeq;
	readonly event: ToolResultEvent;
	readonly message: ToolResultMessage;
	readonly text: string;
	readonly chars: number;
	readonly tool: string;
	readonly tokens: number;
}

/** Outcome of one pruning pass. */
interface PassResult {
	pruned: number;
	scored: number;
	tokensFreed: number;
	dryRun: boolean;
	skipped: string | undefined;
}

/** Minimal logger surface; dsh contexts may or may not expose one. */
interface LoggerLike {
	info?: (message: string) => void;
	warn?: (message: string) => void;
	debug?: (message: string) => void;
}

/** SystemOne answer for one question. */
interface SystemOneAnswer {
	noul?: number;
	probabilities?: Record<string, number>;
}

/** SystemOne response body. */
interface SystemOneResponse {
	answers?: Record<string, SystemOneAnswer>;
}

/**
 * Resolve and validate plugin configuration.
 *
 * An unknown key fails the row instead of being silently ignored, matching the
 * shipped compaction plugins.
 *
 * @param config - raw row configuration.
 * @returns a frozen, fully defaulted configuration.
 * @throws when a key is unknown or a value is out of range.
 */
export function resolveConfig(config: DecisionPrunerConfig = {}): ResolvedConfig {
	for (const key of Object.keys(config) as (keyof ResolvedConfig)[]) {
		if (!CONFIG_KEYS.has(key)) {
			throw new Error(
				`DecisionPrunerConfig: unknown key "${String(key)}" (allowed: ${[...CONFIG_KEYS].join(", ")})`
			);
		}
	}
	const resolved = { ...DEFAULTS, ...config };
	const ratio = resolved.keepThreshold;
	if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
		throw new Error(`DecisionPrunerConfig: keepThreshold (${String(ratio)}) must be a number in [0, 1]`);
	}
	const counters: (keyof ResolvedConfig)[] = [
		"minChars",
		"minTokensToScore",
		"protectTail",
		"maxChunks",
		"maxRequests",
		"scoreChars",
		"maxStateChars",
		"timeoutMs",
		"failureBackoffMs"
	];
	for (const key of counters) {
		const value = resolved[key];
		if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
			throw new Error(`DecisionPrunerConfig: ${key} (${String(value)}) must be a non-negative integer`);
		}
	}
	if (resolved.maxChunks < 1) throw new Error("DecisionPrunerConfig: maxChunks must be at least 1");
	if (resolved.model === "") throw new Error("DecisionPrunerConfig: model must not be empty");
	if (resolved.model === "") throw new Error("DecisionPrunerConfig: model must not be empty");
	for (const key of ["baseUrl", "model", "apiKeyEnv", "apiKey", "traceFile", "markerTemplate", "question"] as const) {
		if (typeof resolved[key] !== "string") {
			throw new Error(`DecisionPrunerConfig: ${key} must be a string`);
		}
	}
	if (!resolved.question.includes("{k}")) {
		throw new Error('DecisionPrunerConfig: question must contain the "{k}" chunk placeholder');
	}
	return Object.freeze(resolved);
}

/**
 * Arm the pruner by wrapping the composed compaction backend.
 *
 * `compactIfNeeded` stays dynamically dispatched by the backend, so this
 * own-property wrapper is what the automatic pressure and overflow paths call.
 * Masking runs first: a successful mask can drop the surface below the
 * threshold and let the backend return `null` without summarizing.
 *
 * @param ctx - cordis context with `compaction` and `tokenMeter` injected.
 * @param config - raw row configuration.
 * @throws when the configuration is rejected by {@link resolveConfig}.
 */
export function apply(ctx: Context, config: DecisionPrunerConfig = {}): void {
	const raw = config;
	let armed: ResolvedConfig;
	try {
		// cordis validates this row against `Config` first, so volatile fields
		// arrive as holders rather than values.
		armed = resolveConfig(unwrapConfig(raw));
	} catch (error) {
		throw new Error(`${name}: ${message(error)}`);
	}
	if (!armed.enabled) {
		logAt(ctx, "info", "disabled by config");
		return;
	}

	// Reading through the volatile holders on every pass is what lets a settings
	// form change take effect without a restart. A value the plugin refuses keeps
	// the last good configuration rather than breaking compaction.
	let last = armed;
	const live = (): ResolvedConfig => {
		try {
			last = resolveConfig(unwrapConfig(raw));
		} catch (error) {
			logAt(ctx, "warn", `ignoring invalid live configuration: ${message(error)}`);
		}
		return last;
	};

	const engine = ctx.compaction;
	// `inject` guarantees this in a real composition; the guard keeps a
	// mis-ordered or hand-written patch from failing the whole boot.
	if (typeof engine?.compactIfNeeded !== "function") {
		logAt(ctx, "warn", "no compaction backend composed; nothing to wrap");
		return;
	}
	const original = engine.compactIfNeeded.bind(engine);
	let running = false;
	let disabledUntil = 0;

	engine.compactIfNeeded = async (
		agent: CompactionAgentContext,
		trigger: CompactionTrigger,
		signal: AbortSignal
	): Promise<CompactionResult | null> => {
		const session = agent.session;
		if (!running) {
			const current = live();
			// No decision server means nothing to ask: stay armed but inert, so the
			// row activates and its settings can be filled in from a client, and so
			// setting baseUrl later starts pruning without a restart.
			if (current.enabled && current.baseUrl !== "" && Date.now() >= disabledUntil) {
				running = true;
				try {
					const result = await pruneSurface(ctx, current, session, signal);
					if (result.pruned > 0 || result.dryRun) {
						logAt(
							ctx,
							"info",
							`decision prune (${trigger}): ${result.pruned}/${result.scored} masked, ` +
								`~${result.tokensFreed} tok freed`
						);
					} else if (result.skipped !== undefined) {
						logAt(ctx, "debug", `decision prune skipped: ${result.skipped}`);
					}
				} catch (error) {
					// Never let scoring break compaction: fall through unmasked, and stop
					// paying the timeout on every subsequent pass.
					disabledUntil = Date.now() + current.failureBackoffMs;
					logAt(
						ctx,
						"warn",
						`decision prune failed, continuing unmasked for ` +
							`${Math.round(current.failureBackoffMs / 1000)}s: ${message(error)}`
					);
				} finally {
					running = false;
				}
			} else if (current.enabled && current.baseUrl === "") {
				logAt(
					ctx,
					"debug",
					"decision prune inactive: no baseUrl (set it in your client or DECISION_BASE_URL)"
				);
			}
		}
		return await original(agent, trigger, signal);
	};

	logAt(
		ctx,
		"info",
		`armed (model=${armed.model} keep<${armed.keepThreshold} ` +
			`floor=${armed.minTokensToScore}tok tail=${armed.protectTail}` +
			`${armed.baseUrl === "" ? " baseUrl=unset (inert)" : ""})`
	);
	traceArmed(armed);
}

/**
 * Score and mask the current surface.
 *
 * @param ctx - cordis context.
 * @param config - resolved configuration.
 * @param session - session whose surface is rewritten.
 * @param signal - cancellation signal.
 * @returns a summary of the pass.
 */
async function pruneSurface(
	ctx: Context,
	config: ResolvedConfig,
	session: Session,
	signal: AbortSignal
): Promise<PassResult> {
	const total = measureTotal(ctx, session);
	if (total < config.minTokensToScore) {
		return { pruned: 0, scored: 0, tokensFreed: 0, dryRun: false, skipped: `below-floor(${total})` };
	}
	const goal = sessionGoal(session);
	if (goal === "") {
		return { pruned: 0, scored: 0, tokensFreed: 0, dryRun: false, skipped: "no-goal" };
	}
	const candidates = collectCandidates(ctx, config, session);
	if (candidates.length === 0) {
		return { pruned: 0, scored: 0, tokensFreed: 0, dryRun: false, skipped: "no-candidates" };
	}

	let pruned = 0;
	let scored = 0;
	let tokensFreed = 0;
	let requests = 0;
	for (let index = 0; index < candidates.length; index += config.maxChunks) {
		if (requests >= config.maxRequests) break;
		if (signal.aborted) break;
		const batch = candidates.slice(index, index + config.maxChunks);
		requests += 1;
		const scores = await scoreBatch(config, goal, batch, signal);
		scored += scores.size;
		traceScores(config, batch, scores, total);
		const applied = applyVerdicts(ctx, config, session, batch, scores);
		pruned += applied.pruned;
		tokensFreed += applied.tokensFreed;
	}
	return { pruned, scored, tokensFreed, dryRun: config.dryRun, skipped: undefined };
}

/**
 * Collect prunable chunks: tool results outside the protected tail, large
 * enough to matter, and not already masked.
 *
 * @param ctx - cordis context.
 * @param config - resolved configuration.
 * @param session - session to inspect.
 * @returns candidate chunks in surface order.
 */
function collectCandidates(ctx: Context, config: ResolvedConfig, session: Session): Candidate[] {
	const seqs = [...session.surface.nodes];
	// `slice(-0)` is `slice(0)`, so zero must not be passed through.
	const protectedSeqs = new Set<SessionSeq>(
		config.protectTail > 0 ? seqs.slice(-config.protectTail) : []
	);
	const candidates: Candidate[] = [];
	for (const seq of seqs) {
		if (protectedSeqs.has(seq)) continue;
		const event = session.eventAt(seq);
		if (event?.type !== "tool/result") continue;
		const message = session.deriveEventMessage(event);
		if (message === null || message.role !== "tool") continue;
		const text = textOf(message.content);
		if (text.length < config.minChars) continue;
		if (text.includes(SENTINEL)) continue;
		candidates.push({
			seq,
			event,
			message,
			text,
			chars: text.length,
			tool: toolNameOf(session, event),
			tokens: estimateMessageTokens(ctx, message)
		});
	}
	return candidates;
}

/**
 * Resolve the tool name that produced one result, via its `tool/call` source.
 *
 * @param session - session owning the result.
 * @param event - the `tool/result` event.
 * @returns a short display name, or `"tool"`.
 */
function toolNameOf(session: Session, event: ToolResultEvent): string {
	const sourceSeq = event.sourceEventSeqs?.[0];
	if (sourceSeq === undefined) return "tool";
	const call = session.eventAt(sourceSeq);
	const raw = call?.type === "tool/call" ? call.data.name : undefined;
	if (typeof raw !== "string" || raw === "") return "tool";
	// `mcp__brain__ha` reads better as `ha` in a marker.
	return raw.includes("__") ? (raw.split("__").pop() ?? raw) : raw;
}

/**
 * Score one batch of chunks in a single decision-model forward pass.
 *
 * @param config - resolved configuration.
 * @param goal - active goal text.
 * @param batch - candidate chunks.
 * @param signal - cancellation signal.
 * @returns map of surface seq to P(necessary).
 */
async function scoreBatch(
	config: ResolvedConfig,
	goal: string,
	batch: readonly Candidate[],
	signal: AbortSignal
): Promise<Map<SessionSeq, number>> {
	const chunks: Record<string, string> = {};
	const questions: Record<string, { type: "noul"; instructions: string }> = {};
	for (const [index, candidate] of batch.entries()) {
		const key = `c${index}`;
		chunks[key] = window(candidate.text, config.scoreChars);
		questions[key] = {
			type: "noul",
			instructions: config.question.replace("{k}", key)
		};
	}
	const body = {
		model: config.model,
		state: { goal: clamp(goal, 4000), chunks: clampState(chunks, config.maxStateChars) },
		questions
	};
	const apiKey = config.apiKey !== "" ? config.apiKey : (process.env[config.apiKeyEnv] ?? "");
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (apiKey !== "") headers.authorization = `Bearer ${apiKey}`;

	const response = await fetch(`${config.baseUrl.replace(/\/+$/u, "")}/v1/systemone`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: withTimeout(signal, config.timeoutMs)
	});
	if (!response.ok) {
		throw new Error(`systemone ${response.status}: ${clamp(await response.text(), 300)}`);
	}
	const payload = (await response.json()) as SystemOneResponse;
	const answers = payload.answers ?? {};
	const scores = new Map<SessionSeq, number>();
	for (const [index, candidate] of batch.entries()) {
		const answer = answers[`c${index}`];
		const score = answer?.noul ?? answer?.probabilities?.true;
		if (typeof score === "number" && Number.isFinite(score)) scores.set(candidate.seq, score);
	}
	return scores;
}

/**
 * Replace every below-threshold chunk with its marker.
 *
 * Each replacement mirrors `dsh-compaction-tool-result-pruner`: a
 * `compaction/prune` event prices the shadowed node, then a re-appended
 * `tool/result` carries the replacement and cites the original seq, so replay
 * recovers the exact text that produced the marker.
 *
 * @param ctx - cordis context.
 * @param config - resolved configuration.
 * @param session - session whose surface is rewritten.
 * @param batch - scored candidates.
 * @param scores - map of surface seq to P(necessary).
 * @returns counts of applied replacements.
 */
function applyVerdicts(
	ctx: Context,
	config: ResolvedConfig,
	session: Session,
	batch: readonly Candidate[],
	scores: ReadonlyMap<SessionSeq, number>
): { pruned: number; tokensFreed: number } {
	let pruned = 0;
	let tokensFreed = 0;
	for (const candidate of batch) {
		const score = scores.get(candidate.seq);
		if (score === undefined || score >= config.keepThreshold) continue;
		if (config.dryRun) {
			pruned += 1;
			tokensFreed += candidate.tokens;
			continue;
		}
		try {
			const marker = markerText(config, candidate);
			const message = freezeMessage({ ...candidate.message, content: [markerBlock(marker)] });
			const replacementTokens = estimateMessageTokens(ctx, message);
			session.append("compaction/prune", {
				shadowedRange: { start: candidate.seq, end: candidate.seq },
				shadowedSeqs: [candidate.seq],
				shadowedTokenCount: candidate.tokens
			});
			session.append(
				"tool/result",
				{ ...candidate.event.data, message },
				{
					surfaceOp: { op: "replace", startSeq: candidate.seq, endSeq: candidate.seq },
					sourceEventSeqs: [candidate.seq]
				}
			);
			pruned += 1;
			tokensFreed += Math.max(0, candidate.tokens - replacementTokens);
		} catch (error) {
			// A rejected replacement fails that chunk only; earlier ones stay durable.
			logAt(ctx, "warn", `mask rejected for seq ${String(candidate.seq)}: ${message(error)}`);
		}
	}
	return { pruned, tokensFreed };
}

/**
 * Record one line confirming the row armed and how it resolved.
 *
 * A plugin row that fails to load leaves no trace anywhere, and a harness's own
 * stderr is not always surfaced, so this is what makes activation observable.
 *
 * @param config - resolved configuration.
 */
function traceArmed(config: ResolvedConfig): void {
	if (config.traceFile === "") return;
	try {
		appendFileSync(
			config.traceFile,
			`${JSON.stringify({
				time: new Date().toISOString(),
				event: "armed",
				model: config.model,
				baseUrl: config.baseUrl,
				keepThreshold: config.keepThreshold,
				minTokensToScore: config.minTokensToScore,
				protectTail: config.protectTail
			})}\n`
		);
	} catch {
		/* tracing must never break the pass */
	}
}

/**
 * Append one NDJSON line per scored chunk, when a trace file is configured.
 *
 * Threshold tuning needs the actual probabilities, which are otherwise only
 * visible as a downstream mask decision.
 *
 * @param config - resolved configuration.
 * @param batch - scored candidates.
 * @param scores - map of surface seq to P(necessary).
 */
function traceScores(
	config: ResolvedConfig,
	batch: readonly Candidate[],
	scores: ReadonlyMap<SessionSeq, number>,
	total: number
): void {
	if (config.traceFile === "") return;
	try {
		const time = new Date().toISOString();
		const lines = batch.map((candidate) => {
			const score = scores.get(candidate.seq);
			return `${JSON.stringify({
				time,
				seq: candidate.seq,
				tool: candidate.tool,
				chars: candidate.chars,
				tokens: candidate.tokens,
				score: score ?? null,
				keep: score === undefined ? null : score >= config.keepThreshold,
				surfaceTokens: total
			})}\n`;
		});
		appendFileSync(config.traceFile, lines.join(""));
	} catch {
		/* tracing must never break the pass */
	}
}

/**
 * Build the one text block that replaces a masked chunk.
 * *
 * @param marker - marker text.
 * @returns the replacement content block.
 */
function markerBlock(marker: string): ContentBlock {
	return { type: "text", text: marker };
}

/**
 * Build the replacement marker for one chunk.
 *
 * @param config - resolved configuration.
 * @param candidate - the chunk being masked.
 * @returns the opaque marker text.
 */
function markerText(config: ResolvedConfig, candidate: Candidate): string {
	// The marker counts the text it replaces, which is what a reader needs to
	// judge what was lost; it is approximate because the marker is not part of it.
	const tokens = Math.max(1, Math.round(candidate.chars / 4));
	return config.markerTemplate
		.replace("{tokens}", String(tokens))
		.replace("{tool}", candidate.tool)
		.replace("{seq}", String(candidate.seq));
}

/**
 * Extract the active goal from the latest genuine user message.
 *
 * dsh also publishes injected `user/message` events in the same surface —
 * runtime-context and skill-catalog reminders, for example — so the newest user
 * message is often not the task. Only `source.kind === "user"` is real input;
 * an injected message is used as a last resort so scoring still has a goal.
 *
 * @param session - session to inspect.
 * @returns goal text, or `""` when none is present.
 */
function sessionGoal(session: Session): string {
	const seqs = [...session.surface.nodes];
	let fallback = "";
	for (let index = seqs.length - 1; index >= 0; index -= 1) {
		const event = session.eventAt(seqs[index]);
		if (event?.type !== "user/message") continue;
		const text = textOf(event.data.content).trim();
		if (text === "") continue;
		const kind = (event.data.source as { kind?: string }).kind;
		if (kind === "user") return text;
		if (fallback === "") fallback = text;
	}
	return fallback;
}

/**
 * Join the text blocks of one content array.
 *
 * @param blocks - content blocks.
 * @returns concatenated text.
 */
function textOf(blocks: readonly { type: string; text?: string }[]): string {
	const parts: string[] = [];
	for (const block of blocks) {
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}

/**
 * Keep a head/tail window of one chunk so scoring stays cheap.
 *
 * @param text - full chunk text.
 * @param limit - maximum characters.
 * @returns the original text, or a head/tail window.
 */
function window(text: string, limit: number): string {
	if (limit <= 0 || text.length <= limit) return text;
	const head = Math.floor(limit * 0.7);
	const tail = limit - head;
	return `${text.slice(0, head)}\n\n[…]\n\n${text.slice(text.length - tail)}`;
}

/**
 * Drop the lowest-value chunks until the state fits its budget.
 *
 * @param chunks - keyed chunk texts.
 * @param limit - maximum total characters.
 * @returns keyed chunk texts within budget.
 */
function clampState(chunks: Record<string, string>, limit: number): Record<string, string> {
	if (limit <= 0) return chunks;
	let total = 0;
	const kept: Record<string, string> = {};
	for (const [key, value] of Object.entries(chunks)) {
		if (total + value.length > limit && Object.keys(kept).length > 0) continue;
		kept[key] = value;
		total += value.length;
	}
	return kept;
}

/**
 * Truncate text to a character budget.
 *
 * @param text - text to clamp.
 * @param limit - maximum characters.
 * @returns clamped text.
 */
function clamp(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/**
 * Combine one caller signal with a timeout.
 *
 * Written by hand rather than with `AbortSignal.any`, which older lib targets
 * do not declare.
 *
 * @param signal - caller cancellation signal.
 * @param timeoutMs - timeout in milliseconds.
 * @returns a signal that aborts on either condition.
 */
function withTimeout(signal: AbortSignal, timeoutMs: number): AbortSignal {
	if (timeoutMs <= 0) return signal;
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort(new Error(`decision scoring timed out after ${timeoutMs}ms`));
	}, timeoutMs);
	const forward = (): void => {
		clearTimeout(timer);
		controller.abort(signal.reason);
	};
	if (signal.aborted) forward();
	else signal.addEventListener("abort", forward, { once: true });
	controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
	return controller.signal;
}

/**
 * Freeze a message value without importing `@deepseek-ai/dsh-llm`.
 *
 * The plugin composes from a profile whose `node_modules` does not carry the
 * harness packages, so the one operation it needs is inlined. It matches
 * `freezeMessage`: deep-freeze of a structural clone.
 *
 * @param value - value to clone and freeze.
 * @returns the frozen clone.
 */
function freezeMessage<T>(value: T): T {
	const walk = (item: unknown): void => {
		if (item !== null && typeof item === "object" && !Object.isFrozen(item)) {
			Object.freeze(item);
			for (const key of Object.keys(item)) walk((item as Record<string, unknown>)[key]);
		}
	};
	walk(value);
	const clone = structuredClone(value);
	walk(clone);
	return clone;
}

/**
 * Price one message through the injected token meter.
 *
 * @param ctx - cordis context.
 * @param message - message to price.
 * @returns estimated tokens, or `0` when the meter is unavailable.
 */
function estimateMessageTokens(ctx: Context, message: Message): number {
	try {
		const meter: TokenMeter = ctx.tokenMeter;
		return meter.estimateMessage(message) ?? 0;
	} catch {
		return 0;
	}
}

/**
 * Measure current surface pressure.
 *
 * @param ctx - cordis context.
 * @param session - session to measure.
 * @returns total estimated tokens, or `0` when the meter is unavailable.
 */
function measureTotal(ctx: Context, session: Session): number {
	try {
		const meter: TokenMeter = ctx.tokenMeter;
		return meter.measure(session)?.totalTokens ?? 0;
	} catch {
		return 0;
	}
}

/**
 * Normalize an unknown thrown value to a message.
 *
 * @param error - thrown value.
 * @returns readable text.
 */
function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Emit one log line through whichever logger surface the context provides.
 *
 * @param ctx - cordis context.
 * @param level - log level.
 * @param text - line to log.
 */
function logAt(ctx: Context, level: "info" | "warn" | "debug", text: string): void {
	const line = `[${name}] ${text}`;
	try {
		const logger = (ctx as { logger?: LoggerLike }).logger;
		const write = logger?.[level];
		if (typeof write === "function") {
			write(line);
			return;
		}
		if (level === "debug") return;
		// dsh runs the harness with a live stdout; stderr keeps this off protocol streams.
		process.stderr.write(`${line}\n`);
	} catch {
		/* logging must never break the pass */
	}
}
