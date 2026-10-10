# Changelog

All notable changes are documented here, in [Conventional
Commits](https://www.conventionalcommits.org) order (see `CONTRIBUTING.md`).

## 0.6.1 — 2026-10-10

- Text, number, and token fields accept typing. They rendered the namespace's value
  straight into `value`, so every keystroke re-rendered the field from a snapshot
  that had not caught up: typing a 21-character URL left `t78`. Each field now
  keeps a local draft while it is being edited, commits 500ms after the last
  keystroke and on blur, and adopts the namespace's value again once it is not
  being typed in.
- Emptying a number goes back to its default rather than writing zero.
- A value written from the card lands in the profile's own patch as an override,
  which is what **Use default** clears.

## 0.6.0 — 2026-10-10

- The row page groups its options into sections — General, Decision server,
  Scoring, When to run, Marker and diagnostics — instead of one flat list of
  nineteen raw keys.
- Each option now carries a human label, an optional/required badge, its raw key,
  a unit where one applies, and a line of help. Numbers get a narrow control,
  toggles a checkbox, the token a password field.
- Defaults are visible: they appear as the placeholder for a text or number
  option and as an explicit note beside a toggle. A **Use default** control
  appears on any option that has been changed and clears the override, so an
  option returns to the schema's default without being guessed at.
- The browser half carries the defaults it displays and a test holds them to the
  schema, so the two cannot drift.

## 0.5.2 — 2026-10-10

- The row page renders its controls even before the namespace's values arrive,
  with a "Loading current values…" note, instead of showing the "no editable
  fields" note for both an unloaded namespace and a genuinely absent one. The two
  are now distinguishable on sight, and a slow or momentarily empty snapshot no
  longer looks like a broken plugin.
- A client bundle already loaded in a long-lived page keeps running until the page
  reloads: bumping the package is not enough for an open console tab, whose module
  URLs carry a revision. Reload after installing.

## 0.5.1 — 2026-10-10

- The card renders its fields. `useSyncExternalStore` with a `getSnapshot()` that
  answers a fresh object loops forever: React reports "Maximum update depth
  exceeded" and the page logs `slot entry crashed in 'plugins.row.config'`, which
  presents as a row whose Configure control opens an empty panel. The snapshot is
  now held in state and replaced by the controller's own notification.
- The component reads the namespace through the controller this half was built
  against rather than a `form` prop, whose shape on the page is not that
  controller.
- Registers the row key as `${bundle}#${rowId}` with the plain row id, verified
  against `data-plugin-row-detail` on the rendered row page (the row element's
  `data-plugin-row` shows the *entry* id, `include:<rowId>`, which the key does
  not use).
- Verified end to end in a real console: the Configure control opens the row page
  and all 19 fields render with live values, with no client errors.

## 0.5.0 — 2026-10-10

- Registers `plugins.row.config` unconditionally. Gating the registration on a
  `configForms.whileServed(...)` namespace lookup silently registered nothing, so
  the row never gained its Configure control — the failure looked identical to
  having no browser half at all. The harness's own bundle fixture registers
  without a gate, and the page derives what to draw from the row ledger.
- The slot now injects the form controller, so the component actually receives the
  thing it renders from. It previously read `props.form`, which nothing supplied,
  and so would have drawn its "no editable fields" note.
- Renders the two views the page asks for: a one-line summary for the row's
  description and the controls on the row's own page.

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
