# Changelog

All notable changes are documented here, in [Conventional
Commits](https://www.conventionalcommits.org) order (see `CONTRIBUTING.md`).

## 0.4.0 — 2026-10-10

- Declares `dsh.bundle.patch`, so installing the package as a profile bundle
  composes its row. Without it the Plugins page never enumerated the row, and the
  settings card could not appear however correct the schema and browser half were.
- The browser half registers the row's configuration in the `plugins.row.config`
  slot, keyed `${bundle}#${rowId}`, alongside the list item in `plugins.item`.
- `baseUrl` is no longer fatal. An unset value arms the plugin inert — nothing is
  scored and no row fails — so it can be installed first and pointed at a server
  afterwards, from the client or via `DECISION_BASE_URL`, with no restart.
- The bundle patch ships no host to assume.

## 0.3.0 — 2026-10-10

- Adds the browser half (`lib/client.js`): a settings card bound to the plugin's
  namespace, saving each field on change.

## 0.2.0 — 2026-10-10

- Every option is now marked `.volatile()`, which is what makes it an editable
  control in a DSH client. Without it dsh's `volatileForm()` derives no form, so
  the settings surface offered nothing even though the schema was declared.
- Configuration is read through the volatile holders on each compaction pass, so
  a client-side edit takes effect without a restart. A value the plugin rejects
  leaves the last good configuration in place.
- Field roles: `apiKey` is `role('secret')` (kept off the wire behind a
  write-only input), `keepThreshold` is `role('slider')`, and the integer
  counters use `z.natural()`.
- Adds a peer dependency on `@deepseek-ai/cosmokit` for `isVolatile`.

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
