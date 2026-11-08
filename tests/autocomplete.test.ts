import { expect, test } from "bun:test";
import { createTicketCompletion, ticketAutocomplete, type Ticket } from "../core/autocomplete";

// Fixture project and ids; none of these exist in any Kata store.
const issue = (short_id: string, title: string, project = "demo"): Ticket => ({ short_id, title, qualified_id: `${project}#${short_id}` });
const bound = [issue("bc7q", "Tidy the sample board"), issue("x9k2", "Rework the ticket cache"), issue("1234", "Numeric id")];
const other = [issue("zz11", "Elsewhere only", "other")];

const github = { items: [{ value: "pr://3164", label: "PR #3164" }, { value: "issue://3164", label: "Issue #3164" }], prefix: "#3164" };
function wrapped(result: any = null) {
	const calls: string[] = [];
	return {
		calls,
		getSuggestions: async (lines: string[], _l: number, col: number) => { calls.push(lines[0].slice(0, col)); return result; },
		applyCompletion: (lines: string[], line: number, col: number, item: any, prefix: string) => ({ lines: [`wrapped:${item.value}:${prefix}`], cursorLine: line, cursorCol: col }),
	};
}
const source = (byProject: Record<string, Ticket[]>) => async (project?: string) => byProject[project ?? ""] ?? [];
const ask = (provider: any, text: string, signal?: AbortSignal) => provider.getSuggestions([text], 0, text.length, signal);

test("#bc offers the matching ticket and accepting inserts the qualified ref with a trailing space", async () => {
	const provider = ticketAutocomplete(wrapped(), source({ "": bound }));
	const result = await ask(provider, "see #bc");
	expect(result.prefix).toBe("#bc");
	expect(result.items.map((i: any) => i.value)).toEqual(["demo#bc7q"]);
	// The hosts truncate labels past 30 cells, so the title goes in the description column, which gets the rest of the row.
	expect(result.items[0]).toMatchObject({ label: "demo#bc7q", description: "Tidy the sample board" });
	const applied = provider.applyCompletion(["see #bc"], 0, 7, result.items[0], result.prefix);
	expect(applied).toEqual({ lines: ["see demo#bc7q "], cursorLine: 0, cursorCol: 14 });
});

test("kata tickets come first in one list with the wrapped provider's items", async () => {
	const inner = wrapped({ items: [{ value: "#bc-action", label: "bc action" }], prefix: "#bc" });
	const result = await ask(ticketAutocomplete(inner, source({ "": bound })), "#bc");
	// The first item is the one Tab/Enter accepts.
	expect(result.items.map((i: any) => i.value)).toEqual(["demo#bc7q", "#bc-action"]);
	// A wrapped item still applies through the wrapped provider.
	const applied = ticketAutocomplete(inner, source({})).applyCompletion(["#bc"], 0, 3, result.items[1], "#bc");
	expect(applied.lines).toEqual(["wrapped:#bc-action:#bc"]);
});

test("a digits-only token stays GitHub's", async () => {
	const result = await ask(ticketAutocomplete(wrapped(github), source({ "": bound })), "#3164");
	expect(result).toEqual(github);
	// "1234" is a real short id in the fixture, yet #1234 is not offered.
	expect((await ask(ticketAutocomplete(wrapped(), source({ "": bound })), "#1234"))).toBeNull();
});

test("title words match, not only short ids", async () => {
	const provider = ticketAutocomplete(wrapped(), source({ "": bound }));
	expect((await ask(provider, "#tidy")).items.map((i: any) => i.value)).toEqual(["demo#bc7q"]);
	expect((await ask(provider, "#CACHE")).items.map((i: any) => i.value)).toEqual(["demo#x9k2"]);
	expect(await ask(provider, "#nomatch")).toBeNull();
});

test("#project#token searches that project, and an all-digit id is reachable that way", async () => {
	const provider = ticketAutocomplete(wrapped(), source({ "": bound, other, demo: [issue("1234", "Numeric id")] }));
	const scoped = await ask(provider, "#other#zz");
	expect(scoped.prefix).toBe("#other#zz");
	expect(scoped.items.map((i: any) => i.value)).toEqual(["other#zz11"]);
	expect((await ask(provider, "#demo#1234")).items.map((i: any) => i.value)).toEqual(["demo#1234"]);
	expect(await ask(provider, "#other#bc")).toBeNull();
});

test("the default project is searched after the bound one", async () => {
	const provider = ticketAutocomplete(wrapped(), source({ "": bound, other }), { defaultProject: "other" });
	expect((await ask(provider, "#zz")).items.map((i: any) => i.value)).toEqual(["other#zz11"]);
	expect((await ask(provider, "#bc")).items.map((i: any) => i.value)).toEqual(["demo#bc7q"]);
});

test("a token inside a word or without #-boundary is left to the wrapped provider", async () => {
	const inner = wrapped(github);
	const provider = ticketAutocomplete(inner, source({ "": bound }));
	expect(await ask(provider, "C#bc")).toEqual(github);
	expect(await ask(provider, "#")).toEqual(github);
});

test("an unreachable source returns the wrapped items promptly, without an error", async () => {
	const inner = { items: [{ value: "#bc-action", label: "bc action" }], prefix: "#bc" };
	const down = ticketAutocomplete(wrapped(inner), async () => { throw new Error("connection refused"); });
	expect(await ask(down, "#bc")).toEqual(inner);
	const hung = ticketAutocomplete(wrapped(inner), () => new Promise<Ticket[]>(() => {}), { timeout: 30 });
	const started = Date.now();
	expect(await ask(hung, "#bc")).toEqual(inner);
	expect(Date.now() - started).toBeLessThan(500);
});

test("an aborted request returns the wrapped items without waiting for the source", async () => {
	const inner = { items: [{ value: "#bc-action", label: "bc action" }], prefix: "#bc" };
	const provider = ticketAutocomplete(wrapped(inner), () => new Promise<Ticket[]>(() => {}), { timeout: 60_000 });
	const controller = new AbortController();
	const pending = ask(provider, "#bc", controller.signal);
	controller.abort();
	expect(await pending).toEqual(inner);
});

test("pi-style options object: abort is honoured and '#' becomes a trigger character", async () => {
	const inner = { items: [{ value: "x", label: "x" }], prefix: "#bc" };
	const base = { ...wrapped(inner), triggerCharacters: ["@"] };
	const provider = ticketAutocomplete(base, () => new Promise<Ticket[]>(() => {}), { timeout: 60_000 }) as any;
	expect(provider.triggerCharacters).toEqual(["@", "#"]);
	const controller = new AbortController();
	const pending = provider.getSuggestions(["#bc"], 0, 3, { signal: controller.signal });
	controller.abort();
	expect(await pending).toEqual(inner);
	const live = ticketAutocomplete(wrapped(), source({ "": bound })) as any;
	expect((await live.getSuggestions(["#bc"], 0, 3, { signal: new AbortController().signal })).items.map((i: any) => i.value)).toEqual(["demo#bc7q"]);
});

test("a session switch registers again, yet each ticket is offered once", async () => {
	// omp keeps every factory for the life of the process and stacks them in registration order.
	const factories: ((current: any) => any)[] = [];
	const ui = () => ({ addAutocompleteProvider: (factory: (current: any) => any) => { factories.push(factory); } });
	const kata = { run: async () => JSON.stringify({ issues: bound }) } as any;
	const scope = () => ({ cwd: "/fixture" });
	createTicketCompletion(kata, scope, () => {})(ui());
	// Another extension's provider between the two registrations.
	factories.push(current => ({ getSuggestions: (...args: any[]) => current.getSuggestions(...args), applyCompletion: (...args: any[]) => current.applyCompletion(...args) }));
	// The next session: a new UI context, and a reloaded module.
	createTicketCompletion(kata, scope, () => {})(ui());
	const editor = factories.reduce((provider, factory) => factory(provider), wrapped());
	const result = await ask(editor, "see #bc");
	expect(result.items.map((i: any) => i.value)).toEqual(["demo#bc7q"]);
	expect(editor.applyCompletion(["see #bc"], 0, 7, result.items[0], result.prefix).lines).toEqual(["see demo#bc7q "]);
});
