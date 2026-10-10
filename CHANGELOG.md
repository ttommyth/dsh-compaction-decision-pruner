# Changelog

## 0.1.0 — unreleased

Initial release.

- Extractive masking of `tool/result` chunks, scored against the session's active
  goal by a joint-schema decision model over the Jev/SystemOne API.
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
- Zero runtime dependencies: every `@deepseek-ai/*` import is type-only.
