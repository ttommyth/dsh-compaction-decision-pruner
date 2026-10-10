# Contributing

## Commit messages

This project follows [Conventional Commits](https://www.conventionalcommits.org).
The published history is the changelog, so the subject line matters.

```
<type>(<optional scope>): <description>

<optional body>

<optional footer>
```

Allowed types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`,
`chore`, `revert`.

Allowed scopes (optional): `config`, `scoring`, `marker`, `session`, `docs`,
`deps`, `ci`, `tests`.

Examples:

```
feat(config): declare a schema so every option is client-configurable
fix(session): keep replace events in surface order
docs: explain the counterfactual question phrasing
test(scoring): cover batching across maxChunks boundaries
```

Subjects are lower-case (or sentence-case) and take no trailing full stop. The
header is limited to 100 characters, body lines to 120.

Rules live in `commitlint.config.cjs` and are enforced in CI. To check a message
locally:

```bash
npx commitlint --edit                 # lint the message being edited
echo "feat: add a thing" | npx commitlint
```

To lint the same way locally that CI does, add a `commit-msg` hook:

```bash
printf '#!/bin/sh\nnpx --no -- commitlint --edit "$1"\n' > .git/hooks/commit-msg
chmod +x .git/hooks/commit-msg
```

## Before opening a pull request

```bash
npm ci
npm run check      # typecheck src and test
npm test           # 38 tests, no model or server needed
npm run build      # lib/ is committed, so rebuild when src/ changes
```

CI also fails if the committed `lib/` does not match `src/`, so run `npm run
build` and include the result.

## Tests

Tests must not require a model, a server, or a network. Drive the plugin through
its public surface (`apply`, `resolveConfig`, `Config`) with fake cordis,
session, and `fetch` objects, in the style of the existing suite.

When you fix a contract or behavioural bug, add the regression test that would
have caught it. Several tests in `test/index.test.ts` exist for exactly that
reason and are labelled as regressions.

## Scope

The plugin deliberately stays small: it masks `tool/result` chunks, and nothing
else. Changes that add unrelated responsibility to this plugin are better as a
separate plugin composed alongside it.
