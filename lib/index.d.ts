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
import z from "@deepseek-ai/schemastery";
/** Plugin row name; must match the id used in a profile patch. */
export declare const name = "compaction-decision-pruner";
/** Services this plugin needs composed before it arms. */
export declare const inject: string[];
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
export declare function unwrapConfig(config: DecisionPrunerConfig): DecisionPrunerConfig;
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
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    enabled: z<boolean, boolean, "volatile-defined">;
    baseUrl: z<string, string, "volatile-defined">;
    model: z<string, string, "volatile-defined">;
    apiKeyEnv: z<string, string, "volatile-defined">;
    apiKey: z<string, string, "volatile-defined">;
    keepThreshold: z<number, number, "volatile-defined">;
    question: z<string, string, "volatile-defined">;
    minChars: z<number, number, "volatile-defined">;
    minTokensToScore: z<number, number, "volatile-defined">;
    protectTail: z<number, number, "volatile-defined">;
    maxChunks: z<number, number, "volatile-defined">;
    maxRequests: z<number, number, "volatile-defined">;
    scoreChars: z<number, number, "volatile-defined">;
    maxStateChars: z<number, number, "volatile-defined">;
    timeoutMs: z<number, number, "volatile-defined">;
    failureBackoffMs: z<number, number, "volatile-defined">;
    dryRun: z<boolean, boolean, "volatile-defined">;
    traceFile: z<string, string, "volatile-defined">;
    markerTemplate: z<string, string, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    enabled: z<boolean, boolean, "volatile-defined">;
    baseUrl: z<string, string, "volatile-defined">;
    model: z<string, string, "volatile-defined">;
    apiKeyEnv: z<string, string, "volatile-defined">;
    apiKey: z<string, string, "volatile-defined">;
    keepThreshold: z<number, number, "volatile-defined">;
    question: z<string, string, "volatile-defined">;
    minChars: z<number, number, "volatile-defined">;
    minTokensToScore: z<number, number, "volatile-defined">;
    protectTail: z<number, number, "volatile-defined">;
    maxChunks: z<number, number, "volatile-defined">;
    maxRequests: z<number, number, "volatile-defined">;
    scoreChars: z<number, number, "volatile-defined">;
    maxStateChars: z<number, number, "volatile-defined">;
    timeoutMs: z<number, number, "volatile-defined">;
    failureBackoffMs: z<number, number, "volatile-defined">;
    dryRun: z<boolean, boolean, "volatile-defined">;
    traceFile: z<string, string, "volatile-defined">;
    markerTemplate: z<string, string, "volatile-defined">;
}>>, "plain">;
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
export declare function resolveConfig(config?: DecisionPrunerConfig): ResolvedConfig;
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
export declare function apply(ctx: Context, config?: DecisionPrunerConfig): void;
