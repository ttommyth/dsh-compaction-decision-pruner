/**
 * Tests for the browser half (`lib/client.js`).
 *
 * The client module cannot be exercised without a browser, so it is loaded in a
 * sandbox with stubs for the client loader and the services it injects. That
 * catches the failure modes that would break the console UI — a module that does
 * not register, a slot registered when the host does not serve the namespace, or
 * a render that throws.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { resolveConfig } from "../src/index.js";

/** Any base URL: the plugin needs one to resolve, and this test only reads defaults. */
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
		useState: (initial: unknown) => [typeof initial === "function" ? (initial as () => unknown)() : initial, () => {}],
		useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read()
	};
}

/** Load `lib/client.js` in a sandbox and call its factory. */
function loadClient(): { id: string; exports: Record<string, any> } {
	const file = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js");
	const source = readFileSync(file, "utf8");
	let registered: { id: string; factory: (require: (name: string) => unknown) => Record<string, any> } | undefined;
	const context = vm.createContext({
		window: { __ModuleLoader__: { load: (spec: typeof registered) => (registered = spec) } },
		console
	});
	vm.runInContext(source, context, { filename: file });
	assert.ok(registered, "the module must register itself with the client loader");
	const exports = registered.factory((name: string) => {
		if (name === "react") return fakeReact();
		throw new Error(`unexpected require: ${name}`);
	});
	return { id: registered.id, exports };
}

/** Render an element tree by invoking function components, as React would. */
function render(node: unknown, depth = 0): unknown {
	if (depth > 8 || node === null || typeof node !== "object") return node;
	const el = node as { type: unknown; props: Record<string, unknown>; children?: unknown[] };
	if (typeof el.type === "function") return render((el.type as (props: unknown) => unknown)(el.props), depth + 1);
	return { ...el, children: (el.children ?? []).map((child) => render(child, depth + 1)) };
}

/** A client context stub, recording what the module registers. */
function fakeContext(options: { served?: boolean; empty?: boolean; noForm?: boolean } = {}) {
	const slots: Array<{ spec: Record<string, any>; component: (props: any) => Element }> = [];
	const dictionaries: Array<[string, unknown]> = [];
	const effects: string[] = [];
	let watched: string[] = [];
	const value = { enabled: true, keepThreshold: 0.35, minChars: 480, question: "If {k} …" };
	const form = {
		getSnapshot: () => (options.empty === true ? {} : { value }),
		subscribe: () => () => {},
		set: async () => true,
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
		configForms: {
			get: () => (options.noForm === true ? undefined : form),
			whileServed: (namespaces: string[], register: () => unknown) => {
				watched = namespaces;
				return options.served === false ? () => {} : register();
			}
		},
		effect: (callback: (() => unknown) | undefined, label?: string) => {
			effects.push(label ?? "");
			return callback?.();
		}
	};
	return { ctx, slots, dictionaries, effects, form, watched: () => watched };
}

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

test("the browser half registers and declares the services it needs", () => {
	const { id, exports } = loadClient();
	assert.equal(id, "dsh-compaction-decision-pruner");
	assert.deepEqual([...exports.inject], ["slots", "locale", "configForms"]);
	assert.equal(typeof exports.apply, "function");
});

test("it registers the row's configuration without a namespace gate", () => {
	const { exports } = loadClient();
	const { ctx, slots, dictionaries } = fakeContext();

	exports.apply(ctx);

	// Registering unconditionally is the contract the harness's own bundle fixture
	// follows: gating on a namespace lookup silently registers nothing when the
	// lookup does not match, which is a form that never appears.
	const keys = slots.map((slot) => slot.spec.key).sort();
	assert.deepEqual([...keys], ["dsh-compaction-decision-pruner#compaction-decision-pruner"], "the page keys a row as `${bundle}#${rowId}`");
	for (const slot of slots) {
		assert.equal(slot.spec.name, "plugins.row.config");
		assert.equal(typeof slot.spec.label, "function");
		assert.equal(typeof slot.component, "function");
	}
	assert.ok(dictionaries.some(([ns]) => ns === "settings.compactionDecisionPruner"), "the card needs its dictionary");
});

test("the registered component reads the namespace through its own controller", () => {
	const { exports } = loadClient();
	const { ctx, slots } = fakeContext();
	exports.apply(ctx);

	// The page passes its own `form` binding; the component must ignore it and use
	// the controller this half was built against, or it renders an empty note.
	const rendered = render(slots[0].component({ view: "page", t: (key: string) => key, form: undefined }));
	const text = JSON.stringify(rendered);
	assert.ok(text.includes("keepThreshold"), "the fields must render from the controller");
	assert.ok(!text.includes("readOnly"), "the fallback note must not render while values exist");
});

test("the summary view is a one-liner the row can show", () => {
	const { exports } = loadClient();
	const { ctx, slots } = fakeContext();
	exports.apply(ctx);

	const summary = render(slots[0].component({ t: (key: string) => key, view: "summary" }));
	assert.equal(typeof summary, "string");
	assert.equal(summary, "summary");
});

test("the card renders one control per served field", () => {
	const { exports } = loadClient();
	const { ctx, slots } = fakeContext();
	exports.apply(ctx);

	const element = render(slots[0].component({ view: "page", t: (key: string) => key }));
	const text = JSON.stringify(element);
	assert.match(text, /Context pruning|title/);
	for (const field of ["enabled", "keepThreshold", "minChars", "question"]) {
		assert.ok(text.includes(field), `the card should render a control for ${field}`);
	}
});

test("the card still renders when no value is available yet", () => {
	const { exports } = loadClient();
	const { ctx, slots } = fakeContext();
	exports.apply(ctx);

	const { ctx: bare, slots: bareSlots } = fakeContext({ empty: true });
	exports.apply(bare);
	const rendered = render(bareSlots[0].component({ view: "page", t: (key: string) => key }));
	const text = JSON.stringify(rendered);
	assert.match(text, /loading/, "an unloaded namespace says so rather than looking empty");
	assert.match(text, /keepThreshold/, "its controls still come from the declared option list");

	const { ctx: none, slots: noneSlots } = fakeContext({ noForm: true });
	exports.apply(none);
	const bare2 = render(noneSlots[0].component({ view: "page", t: (key: string) => key }));
	assert.match(JSON.stringify(bare2), /readOnly/, "no controller at all degrades to a note, not a crash");
});
