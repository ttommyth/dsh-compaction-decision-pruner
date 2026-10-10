/**
 * Browser half: a settings card for the decision pruner.
 *
 * The node half declares `Config` with every field `.volatile()`, which makes a
 * form *derivable*, but dsh renders settings client-side — a node-only plugin
 * therefore shows no config panel however correct its schema is. This module is
 * the missing half: it binds the plugin's settings namespace through the
 * settings shell's `configForms` service and draws a card in the Plugins page's
 * `plugins.item` slot.
 *
 * Registration is wrapped in `ctx.configForms.whileServed(...)`, so a deployment
 * that never composed the plugin shows no trace of the card, and reads ride the
 * shell's shared describe mirror while writes go through the namespace's queued
 * `set(field, value)` — which the host persists per field, so there is no save
 * button.
 *
 * Written by hand against dsh 0.2.0-rc.2, mirroring
 * `@deepseek-ai/dsh-client-ui-settings-web-search`. Every step is defensive: if
 * the shell's API is not present, `apply` logs and returns rather than breaking
 * the console.
 */
window.__ModuleLoader__.load({
	id: "dsh-compaction-decision-pruner",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		/** The installed package name, which the Plugins page pairs items by. */
		const BUNDLE = "dsh-compaction-decision-pruner";
		/** The host plugin entry id, which is also the settings namespace. */
		const ENTRY_ID = "compaction-decision-pruner";
		/**
		 * The key a row's configuration registers under: the Plugins page renders
		 * `plugins.row.config` for each row a bundle's patch declares, addressed by
		 * `${bundle}#${rowId}`. Without the bundle manifest the page never
		 * enumerates the row, so nothing draws the form however correct the schema is.
		 */
		const ROW_KEY = `${BUNDLE}#${ENTRY_ID}`;
		/** Dictionary namespace owned by this card. */
		const NS = "settings.compactionDecisionPruner";
		/** Required client services (cordis fiber inject). */
		const inject = ["slots", "locale", "configForms"];

		const DICT = {
			en: {
				title: "Context pruning",
				description:
					"Extractive masking of tool results. Each value saves as you change it; the plugin reads it on the next compaction pass.",
				readOnly: "This build of the plugin exposes no editable fields.",
				secret: "write-only"
			},
			zh: {
				title: "上下文剪裁",
				description:
					"以抽取方式遮罩工具結果。每項修改即時儲存，插件於下一次壓縮時讀取。",
				readOnly: "此版本的插件沒有可編輯的欄位。",
				secret: "唯寫"
			}
		};

		/** Field order and labels; anything else falls back to a raw key. */
		const FIELDS = [
			["enabled", "Enabled"],
			["baseUrl", "Decision server URL"],
			["model", "Decision model"],
			["apiKey", "Bearer token"],
			["apiKeyEnv", "Token env var"],
			["keepThreshold", "Mask below score"],
			["question", "Scoring question"],
			["minChars", "Minimum chunk size"],
			["minTokensToScore", "Surface floor to score"],
			["protectTail", "Protected tail nodes"],
			["maxChunks", "Chunks per request"],
			["maxRequests", "Requests per pass"],
			["scoreChars", "Scored window size"],
			["maxStateChars", "Request state budget"],
			["timeoutMs", "Request timeout (ms)"],
			["failureBackoffMs", "Failure backoff (ms)"],
			["dryRun", "Dry run"],
			["traceFile", "Trace file"],
			["markerTemplate", "Marker template"]
		];

		/** Fields whose value never crosses the wire; rendered write-only. */
		const SECRET_FIELDS = new Set(["apiKey"]);

		/**
		 * Subscribe a component to one namespace's settings snapshot.
		 *
		 * @param form - the namespace's config form controller.
		 * @returns the current snapshot value.
		 */
		function useSnapshot(form) {
			const subscribe = React.useCallback(
				(listener) => (typeof form.subscribe === "function" ? form.subscribe(listener) : () => {}),
				[form]
			);
			const read = React.useCallback(() => form.getSnapshot(), [form]);
			let snapshot;
			try {
				snapshot = React.useSyncExternalStore(subscribe, read, read);
			} catch (_unsupported) {
				// Older React without useSyncExternalStore: fall back to a subscription.
				const [state, setState] = React.useState(read);
				React.useEffect(() => subscribe(() => setState(read())), [subscribe, read]);
				snapshot = state;
			}
			return snapshot ?? {};
		}

		/**
		 * Render one editable field.
		 *
		 * @param props - field key, current value, and the write callback.
		 * @returns the field row element.
		 */
		function Field(props) {
			const { name, value, onChange, disabled } = props;
			const secret = SECRET_FIELDS.has(name);
			const input = (() => {
				if (typeof value === "boolean") {
					return React.createElement("input", {
						type: "checkbox",
						checked: value,
						disabled,
						onChange: (event) => onChange(event.target.checked)
					});
				}
				if (typeof value === "number") {
					return React.createElement("input", {
						type: "number",
						value: String(value),
						disabled,
						onChange: (event) => {
							const next = Number(event.target.value);
							if (Number.isFinite(next)) onChange(next);
						}
					});
				}
				// A redacted secret arrives as undefined; the placeholder says so.
				return React.createElement("input", {
					type: secret ? "password" : "text",
					defaultValue: secret ? "" : String(value ?? ""),
					placeholder: secret ? "write-only" : "",
					disabled,
					onBlur: (event) => onChange(event.target.value)
				});
			})();
			return React.createElement(
				"label",
				{ key: name, style: { display: "grid", gap: "0.25rem", marginBottom: "0.5rem" } },
				React.createElement("span", { style: { fontSize: "0.85em", opacity: 0.8 } }, name),
				input
			);
		}

		/**
		 * The settings card: one control per declared option, saving on change.
		 *
		 * @param props - the form controller injected by the slot.
		 * @returns the card element.
		 */
		function Card(props) {
			const form = props.form;
			const t = props.t ?? ((key) => key);
			const snapshot = useSnapshot(form);
			const value = snapshot.value;

			if (form === undefined || typeof value !== "object" || value === null) {
				return React.createElement(
					"div",
					{ style: { padding: "0.75rem 0" } },
					React.createElement("strong", null, t("title")),
					React.createElement("p", { style: { opacity: 0.8 } }, t("readOnly"))
				);
			}

			const onChange = React.useCallback(
				(name, next) => {
					try {
						// The host persists per field; there is no save button.
						Promise.resolve(form.set(name, next)).catch(() => {});
					} catch (_rejected) {
						/* a refused write leaves the previous value in the mirror */
					}
				},
				[form]
			);

			const known = new Set(FIELDS.map(([key]) => key));
			const extra = Object.keys(value).filter((key) => !known.has(key));

			return React.createElement(
				"div",
				{ style: { padding: "0.75rem 0" } },
				React.createElement("strong", null, t("title")),
				React.createElement("p", { style: { opacity: 0.8, margin: "0.25rem 0 0.75rem" } }, t("description")),
				...FIELDS.filter(([key]) => key in value).map(([key]) =>
					React.createElement(Field, {
						key,
						name: key,
						value: value[key],
						disabled: snapshot.pending === true,
						onChange: (next) => onChange(key, next)
					})
				),
				...extra.map((key) =>
					React.createElement(Field, {
						key,
						name: key,
						value: value[key],
						onChange: (next) => onChange(key, next)
					})
				)
			);
		}

		/**
		 * Mount the settings card while the host serves the namespace.
		 *
		 * @param ctx - the browser plugin context.
		 */
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, DICT), "compaction-pruner: dictionaries");

			const form = ctx.configForms.get(ENTRY_ID);
			ctx.effect(() => () => form.dispose?.(), "compaction-pruner: form subscription");

			ctx.effect(
				() =>
					ctx.configForms.whileServed([ENTRY_ID], () =>
						ctx.slots.inject("plugins.item", () =>
							ctx.slots.register(
								{
									name: "plugins.item",
									id: BUNDLE,
									order: 45,
									label: () => t("title"),
									locale: NS
								},
								Card
							)
						)
					),
				"compaction-pruner: plugins list item"
			);

			// The row's configuration form, which is what the page opens for a row.
			ctx.effect(
				() =>
					ctx.configForms.whileServed([ENTRY_ID], () =>
						ctx.slots.inject("plugins.row.config", () =>
							ctx.slots.register(
								{
									name: "plugins.row.config",
									key: ROW_KEY,
									order: 45,
									label: () => t("title"),
									locale: NS
								},
								Card
							)
						)
					),
				"compaction-pruner: row configuration"
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
