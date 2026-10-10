# Changelog

All notable changes are documented here, in [Conventional
Commits](https://www.conventionalcommits.org) order (see `CONTRIBUTING.md`).

## 0.1.0 — 2026-10-10

Initial release.

- Extractive masking of `tool/result` chunks, scored against the session's active
  goal by a joint-schema decision model over the Jev/SystemOne API.
- **Every option is a declared config schema**, so a DSH client can present and
  validate it; an out-of-range value fails the row with a diagnostic naming the
  field instead of silently misconfiguring the pruner.
- Batched scoring: every chunk in a window is answered in one forward pass with no
  generated text.
- Replay-safe replacement: a `compaction/prune` shadow-price event followed by a
  `tool/result` carrying `surfaceOp: { op: 'replace', startSeq, endSeq }` and
  `sourceEventSeqs`, so the original text stays recoverable from the session log.
- Goal taken from the newest genuine `user/message` (`source.kind === 'user'`),
  never from injected runtime-context or skill-catalog reminders.
- Fail-open on any scoring or replacement error, with a configurable backoff so an
  unreachable decision server costs one timeout rather than one per turn.
- Protections: `protectTail`, `minChars`, `minTokensToScore`, `maxChunks`,
  `maxRequests`, and idempotence against re-masking.
- Optional `traceFile` recording an `armed` line and one line per scored chunk, for
  threshold tuning.
- `baseUrl` is required: the plugin has no default host to assume.
- Peer dependency on `@deepseek-ai/schemastery` for the config schema; every other
  `@deepseek-ai/*` import is type-only.
