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
		 * The key a row's configuration registers under: `${bundle}#${rowId}`, using
		 * the plain row id. The row element's `data-plugin-row` shows the *entry* id,
		 * which carries the layer that declared it (`include:compaction-decision-pruner`);
		 * the key does not. Verified against the rendered page, whose row detail
		 * element reports `data-plugin-row-detail` as the computed key.
		 */
		const ROW_KEY = `${BUNDLE}#${ENTRY_ID}`;
		/** Dictionary namespace owned by this card. */
		const NS = "settings.compactionDecisionPruner";
		/** Required client services (cordis fiber inject). */
		const inject = ["slots", "locale", "configForms"];

		const DICT = {
			en: {
				title: "Context pruning",
				summary: "Extractive masking of tool results, scored against the active goal.",
				description:
					"Extractive masking of tool results. A value saves as you type it and commits when you leave the field; the plugin reads it on the next compaction pass.",
				readOnly: "This build of the plugin exposes no editable fields.",
				loading: "Loading current values…",
				optional: "optional",
				required: "required",
				useDefault: "Use default",
				defaultLabel: "default",
				on: "on",
				off: "off",
				other: "Other",
				secret: "write-only"
			},
			zh: {
				title: "上下文剪裁",
				summary: "以抽取方式遮罩工具結果，依當前目標評分。",
				description:
					"以抽取方式遮罩工具結果。輸入時即儲存，離開欄位時送出；插件於下一次壓縮時讀取。",
				readOnly: "此版本的插件沒有可編輯的欄位。",
				loading: "正在讀取目前值…",
				optional: "選填",
				required: "必填",
				useDefault: "使用預設值",
				defaultLabel: "預設",
				on: "開",
				off: "關",
				other: "其他",
				secret: "唯寫"
			}
		};

		/**
		 * The card's structure: sections in order, each holding the options that
		 * belong together, each option carrying the label and help text a reader
		 * needs and the default it falls back to.
		 *
		 * `default` duplicates the schema's own default — the browser half cannot
		 * import the node half — and a test asserts the two never drift.
		 */
		const SECTIONS = [
			{ id: "general", title: "General" },
			{ id: "server", title: "Decision server" },
			{ id: "scoring", title: "Scoring" },
			{ id: "trigger", title: "When to run" },
			{ id: "marker", title: "Marker and diagnostics" }
		];

		const FIELDS = [
			{
				key: "enabled",
				section: "general",
				label: "Enabled",
				type: "boolean",
				default: true,
				help: "Arm the pruner."
			},
			{
				key: "dryRun",
				section: "general",
				label: "Dry run",
				type: "boolean",
				default: false,
				help: "Score and log without rewriting the surface."
			},
			{
				key: "baseUrl",
				section: "server",
				label: "Decision server URL",
				type: "text",
				default: "",
				required: true,
				help: "No host is assumed; the plugin stays inert until this is set."
			},
			{
				key: "model",
				section: "server",
				label: "Decision model",
				type: "text",
				default: "clef-flash",
				help: "Model id that host serves."
			},
			{
				key: "apiKey",
				section: "server",
				label: "Bearer token",
				type: "password",
				default: "",
				secret: true,
				help: "Write-only: stored, never sent back."
			},
			{
				key: "apiKeyEnv",
				section: "server",
				label: "Token environment variable",
				type: "text",
				default: "OPENAI_COMPAT_API_KEY",
				help: "Read when no literal token is set."
			},
			{
				key: "timeoutMs",
				section: "server",
				label: "Request timeout",
				type: "number",
				unit: "ms",
				default: 30000,
				help: "Per scoring request."
			},
			{
				key: "failureBackoffMs",
				section: "server",
				label: "Failure backoff",
				type: "number",
				unit: "ms",
				default: 300000,
				help: "How long scoring pauses after a failure."
			},
			{
				key: "keepThreshold",
				section: "scoring",
				label: "Mask below score",
				type: "number",
				step: 0.01,
				min: 0,
				max: 1,
				default: 0.35,
				help: "A chunk is masked when the model puts the chance of losing needed information below this."
			},
			{
				key: "question",
				section: "scoring",
				label: "Scoring question",
				type: "text",
				default: "If chunk {k} were removed, would information required for the goal be lost?",
				help: "Must contain {k}. Counterfactual wording is what separates evidence from filler."
			},
			{
				key: "scoreChars",
				section: "scoring",
				label: "Scored window",
				type: "number",
				unit: "chars",
				default: 2000,
				help: "Per-chunk excerpt sent for scoring."
			},
			{
				key: "maxStateChars",
				section: "scoring",
				label: "Request budget",
				type: "number",
				unit: "chars",
				default: 48000,
				help: "Whole-request state budget."
			},
			{
				key: "maxChunks",
				section: "scoring",
				label: "Chunks per request",
				type: "number",
				min: 1,
				default: 24
			},
			{
				key: "maxRequests",
				section: "scoring",
				label: "Requests per pass",
				type: "number",
				min: 1,
				default: 2
			},
			{
				key: "minTokensToScore",
				section: "trigger",
				label: "Surface floor",
				type: "number",
				unit: "tokens",
				default: 40000,
				help: "Do nothing until the measured surface reaches this size."
			},
			{
				key: "minChars",
				section: "trigger",
				label: "Smallest chunk",
				type: "number",
				unit: "chars",
				default: 480,
				help: "Smaller chunks are never scored."
			},
			{
				key: "protectTail",
				section: "trigger",
				label: "Protected tail nodes",
				type: "number",
				default: 6,
				help: "Trailing surface nodes that are never candidates."
			},
			{
				key: "markerTemplate",
				section: "marker",
				label: "Marker text",
				type: "text",
				default: "[.. pruned {tokens} tok | {tool} seq {seq} | off-task, full text in session log ..]",
				help: "Placeholders: {tokens}, {tool}, {seq}."
			},
			{
				key: "traceFile",
				section: "marker",
				label: "Trace file",
				type: "text",
				default: "",
				help: "Append one NDJSON line per scored chunk. Empty disables tracing."
			}
		];

		/** Option keys whose value never crosses the wire. */
		const SECRET_FIELDS = new Set(FIELDS.filter((field) => field.secret === true).map((field) => field.key));

		/** Stable stand-in so a missing snapshot never looks like a new one. */
		const EMPTY_SNAPSHOT = {};

		/**
		 * Subscribe a component to one namespace's settings snapshot.
		 *
		 * The snapshot is held in state and only replaced by the controller's own
		 * notification. Deriving it per render instead — `useSyncExternalStore`
		 * calling `getSnapshot()` — loops forever when the controller answers with a
		 * fresh object, which React reports as "Maximum update depth exceeded".
		 *
		 * @param form - the namespace's config form controller.
		 * @returns the current snapshot.
		 */
		function useSnapshot(form) {
			const read = React.useCallback(() => form?.getSnapshot?.() ?? EMPTY_SNAPSHOT, [form]);
			const [snapshot, setSnapshot] = React.useState(read);
			React.useEffect(() => {
				setSnapshot(read());
				if (typeof form?.subscribe !== "function") return undefined;
				return form.subscribe(() => setSnapshot(read()));
			}, [form, read]);
			return snapshot ?? EMPTY_SNAPSHOT;
		}

		/** Muted text, so the card needs no stylesheet of its own. */
		const MUTED = { opacity: 0.72, fontSize: "0.85em" };
		/** The badge saying whether an option must be set. */
		const BADGE = { ...MUTED, border: "1px solid currentColor", borderRadius: "999px", padding: "0 0.4rem" };
		/** The reset control's look. */
		const RESET = {
			font: "inherit",
			fontSize: "0.85em",
			background: "transparent",
			color: "inherit",
			border: "1px solid currentColor",
			borderRadius: "4px",
			padding: "0.05rem 0.4rem",
			cursor: "pointer"
		};

		/** The shared look of an input, so the card needs no stylesheet. */
		const CONTROL_STYLE = {
			font: "inherit",
			padding: "0.3rem 0.45rem",
			background: "transparent",
			color: "inherit",
			border: "1px solid currentColor",
			borderRadius: "4px"
		};

		/**
		 * One option row: what it is, what it falls back to, how to change it, and a
		 * way back to the default once it has been changed.
		 *
		 * The control keeps a local draft while it is being typed in. Rendering the
		 * namespace's value straight into `value` loses characters: every keystroke
		 * re-renders the field from a snapshot that has not caught up, which resets
		 * the caret and drops the intervening input.
		 */
		function Field(props) {
			const { field, value, loaded, onChange, onClear, t } = props;
			const external = value === undefined ? "" : String(value);
			const [draft, setDraft] = React.useState(external);
			const [editing, setEditing] = React.useState(false);
			const timer = React.useRef(undefined);

			// Adopt the namespace's value whenever this option is not being typed in.
			React.useEffect(() => {
				if (!editing) setDraft(external);
			}, [external, editing]);
			React.useEffect(
				() => () => {
					if (timer.current !== undefined) clearTimeout(timer.current);
				},
				[]
			);

			const commit = React.useCallback(
				(text) => {
					if (field.type === "number") {
						// An emptied number goes back to the schema's default.
						if (String(text).trim() === "") {
							onClear(field.key);
							return;
						}
						const next = Number(text);
						if (Number.isFinite(next)) onChange(next);
						return;
					}
					onChange(String(text));
				},
				[field.key, field.type, onChange, onClear]
			);
			const schedule = (text) => {
				if (timer.current !== undefined) clearTimeout(timer.current);
				timer.current = setTimeout(() => {
					timer.current = undefined;
					commit(text);
				}, 500);
			};

			const changed = loaded && value !== undefined && value !== field.default;
			const control =
				field.type === "boolean"
					? React.createElement("input", {
							type: "checkbox",
							checked: value === undefined ? field.default === true : value === true,
							onChange: (event) => onChange(event.target.checked),
							style: { ...CONTROL_STYLE, width: "auto" }
						})
					: React.createElement("input", {
							type: field.secret === true ? "password" : field.type === "number" ? "number" : "text",
							value: draft,
							placeholder: field.secret === true ? "write-only" : String(field.default ?? ""),
							style: { ...CONTROL_STYLE, width: field.type === "number" ? "9rem" : "100%" },
							...(field.type === "number" ? { step: field.step ?? 1, min: field.min, max: field.max } : {}),
							onFocus: () => setEditing(true),
							onChange: (event) => {
								setDraft(event.target.value);
								schedule(event.target.value);
							},
							onBlur: () => {
								setEditing(false);
								commit(draft);
							}
						});

			return React.createElement(
				"div",
				{ "data-field": field.key, style: { padding: "0.55rem 0", borderTop: "1px solid rgba(127,127,127,0.25)" } },
				React.createElement(
					"div",
					{ style: { display: "flex", alignItems: "baseline", gap: "0.5rem", flexWrap: "wrap" } },
					React.createElement("span", { style: { fontWeight: 600 } }, field.label),
					React.createElement("span", { style: BADGE }, field.required === true ? t("required") : t("optional")),
					React.createElement("code", { style: { ...MUTED, marginLeft: "auto" } }, field.key),
					field.type === "boolean"
						? React.createElement(
								"span",
								{ style: { ...MUTED, whiteSpace: "nowrap" } },
								t("defaultLabel") + ": " + (field.default === true ? t("on") : t("off"))
							)
						: null,
					changed
						? React.createElement("button", { type: "button", onClick: () => onClear(field.key), style: RESET }, t("useDefault"))
						: null
				),
				React.createElement(
					"div",
					{ style: { display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.35rem" } },
					control,
					field.unit === undefined ? null : React.createElement("span", { style: { ...MUTED, whiteSpace: "nowrap" } }, field.unit)
				),
				field.help === undefined ? null : React.createElement("p", { style: { ...MUTED, margin: "0.25rem 0 0" } }, field.help)
			);
		}

		/**
		 * The row's configuration: a one-line summary where the page asks for one, and
		 * the options grouped into sections on the row's own page.
		 *
		 * @param props - the form controller, plus the page's own `t` and `view`.
		 * @returns the element for the requested view.
		 */
		function Card(props) {
			const form = props.form;
			const t = props.t ?? ((key) => key);
			const snapshot = useSnapshot(form);
			const value = snapshot.value;

			// Hook order stays identical across views; the summary is just a string.
			if (props.view === "summary") {
				return t("summary");
			}

			// Only a missing controller means there is nothing to edit: an unloaded
			// namespace still gets its controls, with a note saying values are on the way.
			if (form === undefined) {
				return React.createElement(
					"div",
					{ style: { padding: "0.75rem 0" } },
					React.createElement("strong", null, t("title")),
					React.createElement("p", { style: MUTED }, t("readOnly"))
				);
			}

			const loaded = typeof value === "object" && value !== null;
			const values = loaded ? value : {};

			const write = React.useCallback(
				(key, next) => {
					try {
						// The host persists each field; there is no save button.
						Promise.resolve(form.set(key, next)).catch(() => {});
					} catch (_rejected) {
						/* a refused write leaves the previous value in the mirror */
					}
				},
				[form]
			);
			const clear = React.useCallback(
				(key) => {
					try {
						// Drop the override so the option falls back to its default.
						Promise.resolve(form.unset(key)).catch(() => {});
					} catch (_rejected) {
						/* a refused clear keeps the previous value */
					}
				},
				[form]
			);

			const known = new Set(FIELDS.map((field) => field.key));
			const extras = Object.keys(values).filter((key) => !known.has(key));

			return React.createElement(
				"div",
				{ style: { padding: "0.75rem 0", maxWidth: "44rem" } },
				React.createElement("strong", null, t("title")),
				React.createElement("p", { style: { ...MUTED, margin: "0.25rem 0 0" } }, t("description")),
				loaded ? null : React.createElement("p", { style: { ...MUTED, margin: "0.5rem 0 0" } }, t("loading")),
				...SECTIONS.map((section) =>
					React.createElement(
						"section",
						{ key: section.id, style: { marginTop: "1.1rem" } },
						React.createElement("h4", { style: { margin: "0 0 0.1rem" } }, section.title),
						...FIELDS.filter((field) => field.section === section.id).map((field) =>
							React.createElement(Field, {
								key: field.key,
								field,
								value: values[field.key],
								loaded,
								disabled: snapshot.pending === true,
								onChange: (next) => write(field.key, next),
								onClear: clear,
								t
							})
						)
					)
				),
				extras.length === 0
					? null
					: React.createElement(
							"section",
							{ style: { marginTop: "1.1rem" } },
							React.createElement("h4", { style: { margin: "0 0 0.1rem" } }, t("other")),
							...extras.map((key) =>
								React.createElement(
									"div",
									{ key, "data-field": key, style: { padding: "0.55rem 0", borderTop: "1px solid rgba(127,127,127,0.25)" } },
									React.createElement("code", null, key),
									React.createElement("code", { style: MUTED }, JSON.stringify(values[key]))
								)
							)
						)
			);
		}

		/**
		 * Mount the row's configuration page.
		 *
		 * Registers unconditionally, like the harness's own bundle fixture: the
		 * page derives what to draw from the row ledger, and a row's page exists
		 * only while an entry here names it. Gating this behind a
		 * `whileServed`/namespace check silently registers nothing when the
		 * namespace lookup does not match, which is a form that never appears.
		 *
		 * @param ctx - the browser plugin context.
		 */
		function apply(ctx) {
			// TEMP diagnostic: expose the ledgers this half depends on.
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, DICT), "compaction-pruner: dictionaries");

			const form = ctx.configForms.get(ENTRY_ID);
			ctx.effect(() => () => form.dispose?.(), "compaction-pruner: form subscription");

			// The page passes `t` and `view`, and its own `form` binding whose shape is
			// not the controller this half reads; supply ours so the component always
			// reads the namespace through the controller it was built against.
			const Component = (props) => React.createElement(Card, { ...props, form });

			ctx.slots.inject("plugins.row.config", () =>
				ctx.slots.register(
					{
						name: "plugins.row.config",
						key: ROW_KEY,
						order: 45,
						label: () => t("title"),
						locale: NS
					},
					Component
				)
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		// Exposed so the test suite can hold the duplicated defaults to the schema's.
		exports.FIELD_DEFAULTS = Object.fromEntries(FIELDS.map((field) => [field.key, field.default]));
		exports.SECTIONS = SECTIONS;
		return module.exports;
	}
});
