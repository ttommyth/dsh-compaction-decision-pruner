/**
 * Tests for the browser half (`lib/client.js`).
 *
 * The client module cannot be exercised without a browser, so it is loaded in a
 * sandbox with stubs for the client loader and the services and primitives it
 * imports. That catches the failure modes that would break a console — a module
 * that does not register, a slot registered under the wrong key, or a render that
 * throws. It cannot prove a save reaches the Host: that needs the real
 * `SettingsFormModel`, and is verified by driving a real console.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { resolveConfig } from "../src/index.js";

/** Any base URL: the plugin needs one to resolve, and these tests read defaults. */
const DECISION_URL = "http://127.0.0.1:8888";

interface Element {
	type: unknown;
	props: Record<string, unknown>;
	children: unknown[];
}

/** A minimal React stand-in: enough for the module's hooks and elements. */
function fakeReact() {
	return {
		createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Element => ({
			type,
			props: props ?? {},
			children
		}),
		useCallback: (fn: unknown) => fn,
		useEffect: () => {},
		useMemo: (fn: () => unknown) => fn(),
		useRef: (initial: unknown) => ({ current: initial }),
		useState: (initial: unknown) => [typeof initial === "function" ? (initial as () => unknown)() : initial, () => {}],
		useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read()
	};
}

/** The staged-edit model and field specs, faked: the module's wiring is what is under test. */
function fakePrimitives() {
	const models: Array<{ scope: unknown; specs: Array<{ field: string }>; secrets: Array<{ field: string }>; staged: Map<string, string>; saved: number }> = [];
	class SettingsFormModel {
		readonly scope: unknown;
		readonly specs: Array<{ field: string }>;
		readonly secrets: Array<{ field: string }>;
		readonly staged = new Map<string, string>();
		saved = 0;
		constructor(scope: unknown, specs: Array<{ field: string }>, secrets: Array<{ field: string }> = []) {
			this.scope = scope;
			this.specs = specs;
			this.secrets = secrets;
			models.push(this as never);
		}
		shell() {
			// The real model reports availability as `scope.status === "ready"`, which is
			// how a namespace the Host does not serve stays unrenderable.
			const status = (this.scope as { getSnapshot: () => { status?: string } }).getSnapshot().status;
			return { available: status === "ready", writable: true, dirty: this.staged.size > 0, invalid: false, saving: false, failed: false };
		}
		field(name: string) {
			const staged = this.staged.get(name);
			const seed = (this.scope as { getSnapshot: () => { value?: Record<string, unknown> } }).getSnapshot().value?.[name];
			const spec = this.specs.find((candidate) => candidate.field === name);
			const formatted = spec === undefined ? "" : String(seed ?? "");
			return { text: staged ?? formatted, overridden: this.staged.has(name), invalid: false };
		}
		edit(name: string, text: string) {
			if (text === "") this.staged.delete(name);
			else this.staged.set(name, text);
		}
		resetField(name: string) {
			this.staged.set(name, "");
		}
		actions() {
			return {
				edit: (field: string, text: string) => this.edit(field, text),
				resetField: (field: string) => this.resetField(field),
				save: () => {
					this.saved += 1;
				},
				discard: () => this.staged.clear()
			};
		}
		bind(project: () => unknown) {
			return (selector: (snapshot: unknown) => unknown) => selector(project());
		}
		dispose() {}
	}
	return {
		SettingsForm: "SettingsForm",
		SettingsValueField: "SettingsValueField",
		SettingsSecretField: "SettingsSecretField",
		SettingsFormModel,
		settingsNumberField: (field: string) => ({ field, kind: "number" }),
		settingsTextField: (field: string) => ({ field, kind: "text" }),
		__models: models
	};
}

/** Load `lib/client.js` in a sandbox and call its factory. */
function loadClient() {
	const file = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js");
	const source = readFileSync(file, "utf8");
	let registered: { id: string; factory: (require: (name: string) => unknown) => Record<string, any> } | undefined;
	const context = vm.createContext({
		window: { __ModuleLoader__: { load: (spec: typeof registered) => (registered = spec) } },
		console
	});
	vm.runInContext(source, context, { filename: file });
	assert.ok(registered, "the module must register itself with the client loader");
	const primitives = fakePrimitives();
	const exports = registered.factory((name: string) => {
		if (name === "react") return fakeReact();
		if (name === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
		throw new Error(`unexpected require: ${name}`);
	});
	return { id: registered.id, exports, primitives };
}

/** A client context stub, recording what the module registers. */
function fakeContext(options: { served?: boolean; empty?: boolean; noForm?: boolean; status?: string; loopback?: boolean } = {}) {
	const slots: Array<{ spec: Record<string, any>; component: (props: any) => Element }> = [];
	const dictionaries: Array<[string, unknown]> = [];
	const effects: string[] = [];
	const writes: Array<readonly unknown[]> = [];
	const value = { enabled: true, keepThreshold: 0.35, minChars: 480, question: "If {k} …" };
	const scope = {
		getSnapshot: () => (options.empty === true ? {} : { status: options.status ?? "ready", value }),
		subscribe: () => () => {},
		mutate: async (ops: readonly unknown[]) => {
			writes.push(ops);
			return true;
		},
		set: async () => true,
		unset: async () => true,
		dispose: () => {}
	};
	const ctx = {
		locale: {
			bind: () => (key: string) => key,
			register: (ns: string, dict: unknown) => dictionaries.push([ns, dict])
		},
		slots: {
			inject: (_name: string, register: () => unknown) => register(),
			register: (spec: Record<string, any>, component: (props: any) => Element) => {
				slots.push({ spec, component });
				return () => {};
			}
		},
		remote: { $host: { isLoopback: options.loopback ?? true } },
		configForms: { get: () => (options.noForm === true ? undefined : scope), whileServed: (_ns: string[], register: () => unknown) => register() },
		effect: (callback: (() => unknown) | undefined, label?: string) => {
			effects.push(label ?? "");
			return callback?.();
		}
	};
	return { ctx, slots, dictionaries, effects, scope, writes };
}

/** Render an element tree by invoking function components, as React would. */
function render(node: unknown, depth = 0): unknown {
	if (depth > 8 || node === null || typeof node !== "object") return node;
	const el = node as { type: unknown; props: Record<string, unknown>; children?: unknown[] };
	if (typeof el.type === "function") return render((el.type as (props: unknown) => unknown)(el.props), depth + 1);
	return { ...el, children: (el.children ?? []).map((child) => render(child, depth + 1)) };
}

test("the browser half registers and declares the services it needs", () => {
	const { id, exports } = loadClient();
	assert.equal(id, "dsh-compaction-decision-pruner");
	assert.deepEqual([...exports.inject], ["slots", "locale", "remote", "configForms"]);
	assert.equal(typeof exports.apply, "function");
});

test("the browser half's option defaults match the plugin's own", () => {
	// The browser half cannot import the node half, so it carries the defaults it
	// shows. This is the guard that keeps the two from drifting apart.
	const { exports } = loadClient();
	const plugin = resolveConfig({ baseUrl: DECISION_URL }) as unknown as Record<string, unknown>;
	const shown = exports.FIELD_DEFAULTS as Record<string, unknown>;
	assert.deepEqual([...Object.keys(shown).sort()], [...Object.keys(plugin).sort()], "the same option set");
	for (const [key, value] of Object.entries(shown)) {
		if (key === "baseUrl") continue; // env-derived, and empty by design
		assert.deepEqual(value, plugin[key], `default for ${key}`);
	}
	assert.equal(shown.baseUrl, "", "baseUrl ships empty so the plugin stays inert until set");
});

test("it registers the row's configuration without a namespace gate", () => {
	const { exports } = loadClient();
	const { ctx, slots, dictionaries } = fakeContext();

	exports.apply(ctx);

	// Registering unconditionally is the contract the harness's own bundle fixture
	// follows: gating on a namespace lookup silently registers nothing when the
	// lookup does not match, which is a form that never appears.
	assert.equal(slots.length, 1, "exactly the row's configuration page");
	assert.equal(slots[0].spec.name, "plugins.row.config");
	assert.equal(slots[0].spec.key, "dsh-compaction-decision-pruner#compaction-decision-pruner");
	assert.equal(typeof slots[0].spec.label, "function");
	assert.ok(dictionaries.some(([ns]) => ns === "settings.compactionDecisionPruner"), "the card needs its dictionary");
});

test("the slot injects the form's actions and its snapshot hook", () => {
	const { exports } = loadClient();
	const { ctx, slots } = fakeContext();
	exports.apply(ctx);

	const injected = slots[0].spec.inject();
	// Only a save writes, so the entry must hand the frame the model's own actions.
	for (const action of ["edit", "resetField", "save", "discard"]) {
		assert.equal(typeof injected[action], "function", `the entry needs ${action}`);
	}
	assert.equal(typeof injected.hooks.compactionPruner, "function", "the card reads state through the hook");
});

test("a namespace whose scope is missing says so instead of crashing", () => {
	const { exports } = loadClient();
	const { ctx, slots } = fakeContext({ noForm: true });
	exports.apply(ctx);

	const injected = slots[0].spec.inject();
	const rendered = render(slots[0].component({ view: "page", t: (key: string) => key, useCompactionPruner: injected.hooks.compactionPruner, ...injected }));
	assert.ok(JSON.stringify(rendered).includes("\"unavailable\""), "the note names the state");
});
test("a page the Host never serves settings to says why, and where to go", () => {
	// dsh serves a settings document only to a loopback page
	// (`ctx.remote.$host.isLoopback`); anywhere else the settings stay
	// process-local, so no amount of waiting makes this card configurable. Saying
	// "not loaded" here would send a reader hunting for a fault that is not there.
	const { exports } = loadClient();
	const { ctx, slots, dictionaries } = fakeContext({ loopback: false, status: "unavailable" });
	exports.apply(ctx);

	const injected = slots[0].spec.inject();
	const rendered = render(slots[0].component({ view: "page", t: (key: string) => key, useCompactionPruner: injected.hooks.compactionPruner, ...injected }));
	const text = JSON.stringify(rendered);
	assert.ok(text.includes("\"remote\""), "the note is the loopback one, not the unserved one");
	assert.ok(!text.includes("SettingsValueField"), "no controls are offered that could not be saved");
	const dictionary = dictionaries.find(([ns]) => ns === "settings.compactionDecisionPruner")?.[1] as { en: Record<string, string>; zh: Record<string, string> };
	assert.ok(dictionary.en.remote.includes("127.0.0.1:3080"), "the copy names an address that does work");
	assert.ok(dictionary.zh.remote.includes("127.0.0.1:3080"), "and its translation does too");
});

test("a document that has not arrived yet is not reported as a missing plugin", () => {
	const { exports } = loadClient();
	const { ctx, slots } = fakeContext({ status: "loading" });
	exports.apply(ctx);

	const injected = slots[0].spec.inject();
	const rendered = render(slots[0].component({ view: "page", t: (key: string) => key, useCompactionPruner: injected.hooks.compactionPruner, ...injected }));
	const text = JSON.stringify(rendered);
	assert.ok(text.includes("\"loading\""), "the note is the loading one");
	assert.ok(!text.includes("\"unavailable\""), "and not the unserved one");
});

test("the summary view is a one-liner the row can show", () => {
	const { exports } = loadClient();
	const { ctx, slots } = fakeContext();
	exports.apply(ctx);

	const summary = render(slots[0].component({ view: "summary", t: (key: string) => key }));
	assert.equal(summary, "summary");
});

test("the page view renders one control per declared option", () => {
	const { exports } = loadClient();
	const { ctx, slots } = fakeContext();
	exports.apply(ctx);

	const injected = slots[0].spec.inject();
	const rendered = render(slots[0].component({ view: "page", t: (key: string) => key, useCompactionPruner: injected.hooks.compactionPruner, ...injected }));
	const text = JSON.stringify(rendered);
	for (const field of ["enabled", "keepThreshold", "minChars", "question", "markerTemplate"]) {
		assert.ok(text.includes(field), `the card should render a control for ${field}`);
	}
	assert.ok(text.includes("SettingsForm"), "the card is drawn by the shared form frame");
	assert.ok(text.includes("SettingsValueField"), "steering options render as staged value fields");
	assert.ok(text.includes("SettingsSecretField"), "the token renders as the write-only control");
	assert.ok(text.includes("General") && text.includes("Scoring"), "the options are grouped");
	// The page draws the plugin's title, icon, crumb, and description itself, so
	// anything the card put above the form would print the row's header twice.
	const root = rendered as { children: unknown[] };
	assert.equal(root.children.length, 1, "the card renders the form and nothing above it");
});
