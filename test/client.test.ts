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

/** A client context stub, recording what the module registers. */
function fakeContext(options: { served?: boolean } = {}) {
	const slots: Array<{ spec: Record<string, any>; component: (props: any) => Element }> = [];
	const dictionaries: Array<[string, unknown]> = [];
	const effects: string[] = [];
	let watched: string[] = [];
	const value = { enabled: true, keepThreshold: 0.35, minChars: 480, question: "If {k} …" };
	const form = {
		getSnapshot: () => ({ value }),
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
			get: () => form,
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

test("the browser half registers and declares the services it needs", () => {
	const { id, exports } = loadClient();
	assert.equal(id, "dsh-compaction-decision-pruner");
	assert.deepEqual([...exports.inject], ["slots", "locale", "configForms"]);
	assert.equal(typeof exports.apply, "function");
});

test("it registers a card in the Plugins page for its own namespace", () => {
	const { exports } = loadClient();
	const { ctx, slots, dictionaries, watched } = fakeContext();

	exports.apply(ctx);

	assert.deepEqual([...watched()], ["compaction-decision-pruner"], "the card must follow the plugin's namespace");
	assert.equal(slots.length, 2, "the list item and the row configuration");
	const slotNames = slots.map((slot) => slot.spec.name).sort();
	assert.deepEqual([...slotNames], ["plugins.item", "plugins.row.config"]);
	const rowSlot = slots.find((slot) => slot.spec.name === "plugins.row.config");
	assert.equal(
		rowSlot?.spec.key,
		"dsh-compaction-decision-pruner#compaction-decision-pruner",
		"the page addresses a row's form as ${bundle}#${rowId}"
	);
	assert.ok(dictionaries.some(([ns]) => ns === "settings.compactionDecisionPruner"), "the card needs its dictionary");
});

test("a host that does not serve the namespace exposes no card", () => {
	const { exports } = loadClient();
	const { ctx, slots } = fakeContext({ served: false });

	exports.apply(ctx);

	assert.deepEqual(slots, [], "a deployment without the plugin must show no trace of it");
});

test("the card renders one control per served field", () => {
	const { exports } = loadClient();
	const { ctx, slots } = fakeContext();
	exports.apply(ctx);

	const element = slots[0].component({ form: ctx.configForms.get(), t: (key: string) => key });
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

	const empty = { getSnapshot: () => ({}), subscribe: () => () => {}, set: async () => true };
	const rendered = slots[0].component({ form: empty, t: (key: string) => key });
	assert.match(JSON.stringify(rendered), /readOnly/, "an unavailable value degrades to a note, not a crash");
});
