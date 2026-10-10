/**
 * Browser half: the decision pruner's settings card.
 *
 * The node half declares `Config` with every field `.volatile()`, which makes a
 * form derivable, but dsh renders plugin configuration client-side — a node-only
 * plugin shows no panel however correct its schema is. This module is the missing
 * half.
 *
 * It is built on the harness's own staged-edit model rather than on bookkeeping of
 * its own. `SettingsFormModel` holds the drafts, `SettingsForm` draws the frame and
 * owns the Save control, and **only a save writes**: a settings scope's `set`
 * stages an edit and `mutate` is what commits it, so a card that writes per
 * keystroke loses every edit when the page is left. The model also supplies the
 * overridden badge and the reset-to-default control.
 *
 * Written against dsh 0.2.0-rc.2, mirroring
 * `@deepseek-ai/dsh-client-ui-settings-web-search`.
 */
window.__ModuleLoader__.load({
	id: "dsh-compaction-decision-pruner",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const {
			SettingsForm,
			SettingsSecretField,
			SettingsValueField,
			SettingsFormModel,
			settingsNumberField,
			settingsTextField
		} = require("@deepseek-ai/dsh-client-ui-primitives");

		/** The installed package name, which the Plugins page pairs items by. */
		const BUNDLE = "dsh-compaction-decision-pruner";
		/** The host plugin entry id, which is also the settings namespace. */
		const ENTRY_ID = "compaction-decision-pruner";
		/** The key a row's configuration registers under: `${bundle}#${rowId}`. */
		const ROW_KEY = `${BUNDLE}#${ENTRY_ID}`;
		/** Dictionary namespace owned by this card. */
		const NS = "settings.compactionDecisionPruner";
		/** Required client services (cordis fiber inject). */
		const inject = ["slots", "locale", "remote", "configForms"];

		const DICT = {
			en: {
				title: "Context pruning",
				summary: "Extractive masking of tool results, scored against the active goal.",
				optional: "optional",
				required: "required",
				overridden: "overridden",
				reset: "Reset to default",
				invalidNumber: "Enter a number; an empty one means the default.",
				defaultLabel: "default",
				on: "on",
				off: "off",
				readOnly: "This deployment's settings are read-only.",
				unavailable:
					"The Host does not serve this plugin's settings, so there is nothing to configure. A row that is not active — one still waiting for a service — has no settings to show.",
				loading: "Reading the Host's settings document…",
				remote:
					"The Host serves plugin settings only to a page on its own loopback address, so this page cannot configure the plugin. Open the console at http://127.0.0.1:3080 on the Host, or forward that port and browse http://localhost:3080 (e.g. ssh -L 3080:127.0.0.1:3080 <host>). Over any other address the Host keeps settings process-local, so nothing typed here could be saved.",
				save: "Save",
				saving: "Saving…",
				saveFailed: "The Host did not accept these values; they are kept for you to change.",
				secretSet: "A token is stored.",
				secretUnset: "No token of its own; the plugin reads the environment variable."
			},
			zh: {
				title: "上下文剪裁",
				summary: "以抽取方式遮罩工具結果，依當前目標評分。",
				optional: "選填",
				required: "必填",
				overridden: "已覆寫",
				reset: "重設為預設值",
				invalidNumber: "請填數字；留空表示使用預設值。",
				defaultLabel: "預設",
				on: "開",
				off: "關",
				readOnly: "本部署的設定為唯讀。",
				unavailable: "主機未提供此外掛的設定，無可設定項目。未啟用的列（仍在等待服務）不會有設定。",
				loading: "正在讀取主機的設定文件…",
				remote: "主機只向其 loopback 位址上的頁面提供外掛設定，因此本頁無法設定此外掛。請在主機上以 http://127.0.0.1:3080 開啟主控台，或轉發該埠後瀏覽 http://localhost:3080（例：ssh -L 3080:127.0.0.1:3080 <host>）。經其他位址時，主機的設定只保留在行程內，此處輸入的內容無法儲存。",
				save: "儲存",
				saving: "儲存中…",
				saveFailed: "主機未接受這些值，已保留供你修改。",
				secretSet: "已存有權杖。",
				secretUnset: "未自存權杖；插件改讀環境變數。"
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
			{ key: "enabled", section: "general", label: "Enabled", type: "boolean", default: true, help: "Arm the pruner." },
			{ key: "dryRun", section: "general", label: "Dry run", type: "boolean", default: false, help: "Score and log without rewriting the surface." },
			{ key: "baseUrl", section: "server", label: "Decision server URL", type: "text", default: "", required: true, help: "No host is assumed; the plugin stays inert until this is set." },
			{ key: "model", section: "server", label: "Decision model", type: "text", default: "clef-flash", help: "Model id that host serves." },
			{ key: "apiKey", section: "server", label: "Bearer token", type: "secret", default: "", help: "Write-only: stored, never sent back. Leave it blank to keep the current token." },
			{ key: "apiKeyEnv", section: "server", label: "Token environment variable", type: "text", default: "OPENAI_COMPAT_API_KEY", help: "Read when no literal token is set." },
			{ key: "timeoutMs", section: "server", label: "Request timeout", type: "number", unit: "ms", default: 30000, help: "Per scoring request." },
			{ key: "failureBackoffMs", section: "server", label: "Failure backoff", type: "number", unit: "ms", default: 300000, help: "How long scoring pauses after a failure." },
			{ key: "keepThreshold", section: "scoring", label: "Mask below score", type: "number", step: 0.01, min: 0, max: 1, default: 0.35, help: "A chunk is masked when the model puts the chance of losing needed information below this." },
			{ key: "question", section: "scoring", label: "Scoring question", type: "text", default: "If chunk {k} were removed, would information required for the goal be lost?", help: "Must contain {k}. Counterfactual wording is what separates evidence from filler." },
			{ key: "scoreChars", section: "scoring", label: "Scored window", type: "number", unit: "chars", default: 2000, help: "Per-chunk excerpt sent for scoring." },
			{ key: "maxStateChars", section: "scoring", label: "Request budget", type: "number", unit: "chars", default: 48000, help: "Whole-request state budget." },
			{ key: "maxChunks", section: "scoring", label: "Chunks per request", type: "number", min: 1, default: 24 },
			{ key: "maxRequests", section: "scoring", label: "Requests per pass", type: "number", min: 1, default: 2 },
			{ key: "minTokensToScore", section: "trigger", label: "Surface floor", type: "number", unit: "tokens", default: 40000, help: "Do nothing until the measured surface reaches this size." },
			{ key: "minChars", section: "trigger", label: "Smallest chunk", type: "number", unit: "chars", default: 480, help: "Smaller chunks are never scored." },
			{ key: "protectTail", section: "trigger", label: "Protected tail nodes", type: "number", default: 6, help: "Trailing surface nodes that are never candidates." },
			{ key: "markerTemplate", section: "marker", label: "Marker text", type: "text", default: "[.. pruned {tokens} tok | {tool} seq {seq} | off-task, full text in session log ..]", help: "Placeholders: {tokens}, {tool}, {seq}." },
			{ key: "traceFile", section: "marker", label: "Trace file", type: "text", default: "", help: "Append one NDJSON line per scored chunk. Empty disables tracing." }
		];

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

		/**
		 * A toggle, staged as text the way every other field is: the model takes
		 * draft text in and writes JSON-shaped values out, so a checkbox edits
		 * `on`/`off`. The primitives ship no toggle, which is why this control and
		 * its spec are local to this package.
		 */
		function toggleSpec(field) {
			return {
				field,
				format: (value) => (value === undefined || value === null ? "" : value === true ? "on" : "off"),
				parse: (text) => (text === "" ? { kind: "clear" } : { kind: "set", value: text === "on" })
			};
		}

		/** The staged-edit spec one option needs. */
		function specFor(field) {
			if (field.type === "boolean") return toggleSpec(field.key);
			if (field.type === "number") return settingsNumberField(field.key);
			return settingsTextField(field.key);
		}

		/**
		 * Whether the stored user layer carries a value for a write-only control.
		 *
		 * A credential literal never rides a response, so its presence is all the page
		 * can learn: the layer is checked for the key rather than for a value, and an
		 * explicit empty string counts as absent because clearing a field writes one.
		 *
		 * @param scope - the form's settings scope.
		 * @param field - the option to look for.
		 * @returns whether a value is stored for it.
		 */
		function stored(scope, field) {
			const layer = scope.getSnapshot()?.user;
			const section = layer?.[ENTRY_ID] ?? layer;
			const value = section?.[field];
			return value !== undefined && value !== null && value !== "";
		}

		/** One toggle row, shaped like a value field with a checkbox for a control. */
		function ToggleRow(props) {
			const { field, state, t, onEdit, onReset } = props;
			const on = state.text !== "off" && state.text !== "";
			return React.createElement(
				"div",
				{ "data-field": field.key, style: { padding: "0.55rem 0", borderTop: "1px solid rgba(127,127,127,0.25)" } },
				React.createElement(
					"div",
					{ style: { display: "flex", alignItems: "baseline", gap: "0.5rem", flexWrap: "wrap" } },
					React.createElement("span", { style: { fontWeight: 600 } }, field.label),
					React.createElement("span", { style: BADGE }, field.required === true ? t("required") : t("optional")),
					state.overridden === true ? React.createElement("button", { type: "button", onClick: onReset, style: RESET }, t("reset")) : null
				),
				React.createElement(
					"label",
					{ style: { display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.35rem" } },
					React.createElement("input", { type: "checkbox", checked: on, onChange: (event) => onEdit(event.target.checked ? "on" : "off") }),
					React.createElement("span", { style: MUTED }, on ? t("on") : t("off")),
					React.createElement("span", { style: { ...MUTED, whiteSpace: "nowrap" } }, t("defaultLabel") + ": " + (field.default === true ? t("on") : t("off")))
				),
				field.help === undefined ? null : React.createElement("p", { style: { ...MUTED, margin: "0.25rem 0 0" } }, field.help)
			);
		}

		const NOTE = { ...MUTED, maxWidth: "44rem" };

		/**
		 * The line the card shows instead of its controls, per reason.
		 *
		 * The three reasons are not interchangeable, and saying "not loaded" for all
		 * of them sends a reader looking for a problem that is not there: a page
		 * reached over anything but loopback is never served a settings document at
		 * all, however healthy the plugin is.
		 */
		const NOTE_KEY = { ready: undefined, loading: "loading", remote: "remote", unserved: "unavailable" };

		/**
		 * The card: a one-line summary where the page asks for one, and the staged
		 * form on the row's own page. The frame draws the Save and Discard controls.
		 */
		function Card(props) {
			const t = props.t ?? ((key) => key);
			if (props.view === "summary") return t("summary");

			const state = typeof props.useCompactionPruner === "function" ? props.useCompactionPruner((snapshot) => snapshot) : undefined;
			const noteKey = state === undefined ? "unavailable" : NOTE_KEY[state.phase ?? "ready"];
			if (noteKey !== undefined) return React.createElement("p", { style: NOTE }, t(noteKey));

			const labels = {
				unavailable: t("unavailable"),
				readOnly: t("readOnly"),
				saveFailed: t("saveFailed"),
				save: t("save"),
				saving: t("saving")
			};

			const rows = SECTIONS.map((section) =>
				React.createElement(
					"section",
					{ key: section.id, style: { marginTop: "1.1rem" } },
					React.createElement("h4", { style: { margin: "0 0 0.1rem" } }, section.title),
					...FIELDS.filter((field) => field.section === section.id).map((field) => {
						const fieldState = state[field.key] ?? { text: "", overridden: false, invalid: false };
						if (field.type === "boolean") {
							return React.createElement(ToggleRow, {
								key: field.key,
								field,
								state: fieldState,
								t,
								onEdit: (text) => props.edit(field.key, text),
								onReset: () => props.resetField(field.key)
							});
						}
						if (field.type === "secret") {
							const configured = state[`${field.key}Configured`] === true;
							return React.createElement(SettingsSecretField, {
								key: field.key,
								id: `plugin-config-compaction-pruner-${field.key}`,
								label: field.label,
								hint: field.help,
								text: fieldState.text,
								configured,
								stateLabel: configured ? t("secretSet") : t("secretUnset"),
								disabled: !state.writable,
								onEdit: (text) => props.edit(field.key, text)
							});
						}
						return React.createElement(SettingsValueField, {
							key: field.key,
							id: `plugin-config-compaction-pruner-${field.key}`,
							// The shared control has no unit slot, so a derived unit rides the label.
							label: field.unit === undefined ? field.label : `${field.label} (${field.unit})`,
							hint: field.help,
							overriddenLabel: t("overridden"),
							resetLabel: t("reset"),
							invalidLabel: t("invalidNumber"),
							numeric: field.type === "number",
							disabled: !state.writable,
							...fieldState,
							onEdit: (text) => props.edit(field.key, text),
							onReset: () => props.resetField(field.key)
						});
					})
				)
			);

			return React.createElement(
				"div",
				{ style: { padding: "0.75rem 0", maxWidth: "44rem" } },
				// The page draws the plugin's title, icon, crumb, and description
				// itself — a heading here would print them twice.
				React.createElement(SettingsForm, { labels, state, onSave: props.save, onDiscard: props.discard }, ...rows)
			);
		}

		/**
		 * Mount the row's configuration page.
		 *
		 * Registers unconditionally, like the harness's own bundle fixture: the page
		 * derives what to draw from the row ledger, and a row's page exists only
		 * while an entry here names it. Gating this behind a namespace check
		 * silently registers nothing when the lookup does not match, which is a form
		 * that never appears.
		 *
		 * @param ctx - the browser plugin context.
		 */
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, DICT), "compaction-pruner: dictionaries");

			const served = ctx.configForms.get(ENTRY_ID);
			// Without a scope there is nothing to read, but the card still registers so
			// the row keeps its page and can say why it is inactive.
			const scope = served ?? {
				getSnapshot: () => ({ value: {} }),
				subscribe: () => () => {},
				mutate: async () => false,
				set: async () => false,
				unset: async () => false
			};
			const plain = FIELDS.filter((field) => field.type !== "secret");
			const secrets = FIELDS.filter((field) => field.type === "secret");
			const model = new SettingsFormModel(
				scope,
				plain.map(specFor),
				// A redacted value never comes back, so the token is blank until typed and
				// a blank draft writes nothing, which keeps whatever is stored.
				secrets.map((field) => ({
					field: field.key,
					write: (text) => scope.mutate([{ op: "set", path: [field.key], value: text }])
				}))
			);
			const store = model.bind(() => {
				const shell = model.shell();
				// A scope is only "ready" while the Host serves the namespace; a
				// non-loopback page is deliberately never served one, which is a
				// different story from a namespace that has not arrived yet.
				const hostLoopback = ctx.remote?.$host?.isLoopback !== false;
				const status = scope.getSnapshot?.()?.status;
				const snapshot = {
					...shell,
					available: served !== undefined && shell.available !== false,
					phase: shell.available ? "ready" : !hostLoopback ? "remote" : status === "loading" ? "loading" : "unserved"
				};
				for (const field of FIELDS) {
					snapshot[field.key] = model.field(field.key);
				if (field.type === "secret") snapshot[`${field.key}Configured`] = stored(scope, field.key);
				}
				return snapshot;
			});
			ctx.effect(() => () => model.dispose?.(), "compaction-pruner: form subscription");

			ctx.slots.inject("plugins.row.config", () =>
				ctx.slots.register(
					{
						name: "plugins.row.config",
						key: ROW_KEY,
						order: 45,
						label: () => t("title"),
						locale: NS,
						inject: () => ({ hooks: { compactionPruner: store }, ...model.actions() })
					},
					Card
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
