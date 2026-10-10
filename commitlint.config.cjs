/**
 * Conventional Commits configuration.
 *
 * The published history is the changelog, so commit subjects are linted in CI
 * and available locally via `npx commitlint --edit`.
 */
module.exports = {
	extends: ["@commitlint/config-conventional"],
	rules: {
		// Types this project actually uses; anything else is a typo.
		"type-enum": [
			2,
			"always",
			["feat", "fix", "perf", "refactor", "docs", "test", "build", "ci", "chore", "revert"]
		],
		// A scope is optional, but must come from this set when used.
		"scope-enum": [2, "always", ["config", "scoring", "marker", "session", "docs", "deps", "ci", "tests"]],
		"subject-case": [2, "always", ["sentence-case", "lower-case"]],
		"subject-empty": [2, "never"],
		"subject-full-stop": [2, "never", "."],
		"header-max-length": [2, "always", 100],
		"body-max-line-length": [2, "always", 120]
	}
};
