import { expect, test } from "bun:test";
import { claudeKata, pausedClock, PROJECT, type ClaudeHost } from "./claude-fixture";
import { EVIDENCE, eventually, holdKata, MESSAGE, until } from "./kata-fixture";

// The Claude mod's plan band, todo cards, `#` ticket completion and /todo, against a real Kata. A todo call writes `$.state`,
// the render hooks read it back: the cards and the band are checked through `ui.render`, as the transcript would draw them.
// How each surface lays them out is drawn in plugins/claude-code/tests/ui.test.tsx.
const { host, issue, deleteIssue, sessionParents, binary, author } = claudeKata("claude-ui");

// The engine's JSX factory, which the render hooks call: an element is its type, props and children.
(globalThis as any).h = (type: string, props: Record<string, unknown> | null, ...children: unknown[]) => ({ type, props, children });

/** The engine's `$.state`, `$.ui` and `$.command.register` for a host the hand-made `$` lacks them. `engine.latencyMs` is what each state call takes, as a round trip to the engine does. */
function engineUi(h: ClaudeHost) {
	const held = new Map<string, unknown>();
	const toasts: string[] = [];
	const commands: any[] = [];
	const engine = { latencyMs: 0 };
	const key = (ref: any) => (ref.id === undefined ? ref.key : `${ref.key}#${ref.id}`);
	// A real delay: writes overlap only when a state call takes longer than the Kata call of the next todo call, which no
	// ordering of promises reproduces.
	const roundTrip = () => (engine.latencyMs ? Bun.sleep(engine.latencyMs) : undefined);
	h.$.state = {
		get: async (ref: any) => {
			await roundTrip();
			return { value: held.get(key(ref)), version: 1 };
		},
		set: async (ref: any, value: unknown) => {
			await roundTrip();
			held.set(key(ref), structuredClone(value));
			return { isSet: true, version: 2 };
		}
	};
	h.$.ui = {
		toast: (text: string) => {
			toasts.push(text);
		},
		resolve: () => ({ Box: "Box", Text: "Text", Progress: "Progress" })
	};
	h.$.command = {
		register: async (spec: any) => {
			commands.push(spec);
		}
	};
	return { toasts, commands, engine };
}

const ENGINE_ROW = { engineRow: true };
const render = (h: ClaudeHost, component: string, props: Record<string, unknown>) => h.fire("ui.render", { component, surface: "terminal", props }, () => ENGINE_ROW);
const flat = (node: any): string =>
	node === null || node === undefined || typeof node === "boolean"
		? ""
		: typeof node !== "object"
			? String(node)
			: Array.isArray(node)
				? node.map(flat).join(" ")
				: [node.props?.label ?? "", ...(node.children ?? []).map(flat)].join(" ");
const shown = (node: unknown) => flat(node).replace(/\s+/g, " ").trim();
const band = (h: ClaudeHost) => render(h, "AbovePrompt", { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 8, bodyColumns: 100 });
const card = (h: ClaudeHost, id: string) => render(h, "ToolResult", { tool_use_id: id, tool: "todo", output: "x", isErrored: false });
const cardText = async (h: ClaudeHost, id: string) => shown(await card(h, id));

// `count` todo views one after another, each leaving a card named `<prefix><n>`.
async function viewsOf(h: ClaudeHost, prefix: string, count: number) {
	for (let n = 0; n < count; n++) await h.todo({ op: "view" }, undefined, `${prefix}${n}`);
}
// Well past the number of cards the mod keeps.
const MANY = 60;
const LOCAL = { kataExecutable: "/nonexistent/kata" };

const autocomplete = (h: ClaudeHost, text: string) =>
	h.fire("prompt.autocomplete", { text, cursor: text.length, token: text.split(/\s/).pop(), start: text.lastIndexOf(text.split(/\s/).pop()!) }, () => ({
		suggestions: []
	}));
const rows = async (h: ClaudeHost, text: string) => (await autocomplete(h, text)).suggestions as { text: string; label: string; description?: string }[];
/** A project's first list loads in the background when the typeahead's wait passes, so a cold first ask may return no rows. */
const warmRows = async (h: ClaudeHost, text: string) => {
	await eventually(async () => (await rows(h, text)).length > 0, true);
	return rows(h, text);
};

test("a todo call leaves a card, and the band follows the plan it changed", async () => {
	const h = host();
	engineUi(h);
	await h.start();
	expect(await band(h)).toBe(ENGINE_ROW);
	const init = await h.todo(
		{
			op: "init",
			list: [
				{ phase: "Build", items: ["Write the parser", "Test the parser"] },
				{ phase: "Docs", items: ["Write the guide"] }
			]
		},
		undefined,
		"tu-card"
	);
	expect(init.isError, init.result).toBeUndefined();
	const text = await cardText(h, "tu-card");
	expect(text).toMatch(/Build[\s\S]*▶ Write the parser[\s\S]*☐ Test the parser[\s\S]*Docs[\s\S]*☐ Write the guide/);
	expect(text).toContain(`${PROJECT}#`);
	expect(shown(await band(h))).toMatch(/Kata plan 0\/3 · ▶ Write the parser/);

	await h.todo({ op: "done", task: "Write the parser", message: MESSAGE, evidence: EVIDENCE });
	await h.todo({ op: "block", task: "Test the parser", reason: "waiting for a fixture" }, undefined, "tu-block");
	expect(shown(await band(h))).toMatch(/Kata plan 1\/3 · 1 blocked/);
	expect(await cardText(h, "tu-block")).toMatch(/⏸ Test the parser[\s\S]*waiting for a fixture/);
});

test("a failed todo call keeps the engine's row: no card is drawn for it", async () => {
	const h = host();
	engineUi(h);
	await h.start();
	await h.todo({ op: "init", items: ["Only task"] });
	const refused = await h.todo({ op: "done", task: "Only task", message: "short", evidence: EVIDENCE }, undefined, "bad");
	expect(refused.isError).toBe(true);
	expect(await card(h, "bad")).toBe(ENGINE_ROW);
});

test("only the newest cards are kept", async () => {
	const h = host();
	engineUi(h);
	await h.start();
	await h.todo({ op: "init", items: ["Card item"] }, undefined, "seed");
	await viewsOf(h, "card-", MANY);
	expect(await card(h, "seed")).toBe(ENGINE_ROW);
	expect(await cardText(h, `card-${MANY - 1}`)).toContain("Card item");
	expect(await cardText(h, `card-${MANY - 10}`)).toContain("Card item");
}, 60_000);

test("todo calls that finish while another card is being written each leave a card that is later pruned with the rest", async () => {
	const h = host();
	const ui = engineUi(h);
	await h.start();
	await h.todo({ op: "init", items: ["Card item"] });
	const together = Array.from({ length: 6 }, (_, i) => `par-${i}`);
	ui.engine.latencyMs = 80;
	await Promise.all(together.map(id => h.todo({ op: "view" }, undefined, id)));
	ui.engine.latencyMs = 0;
	for (const id of together) expect(await cardText(h, id), id).toContain("Card item");
	await viewsOf(h, "later-", MANY);
	for (const id of together) expect(await card(h, id), id).toBe(ENGINE_ROW);
}, 60_000);

test("/todo is registered at the session start and answers the omp subcommands for the person", async () => {
	const h = host();
	const ui = engineUi(h);
	await h.start();
	expect(ui.commands.map(c => c.name)).toEqual(["todo", "kata"]);
	const run = (args: string) => h.fire("command.run", { command: "todo", args, origin: { kind: "composer" } });
	expect(await run("")).toMatchObject({ text: expect.stringContaining("No todo plan"), isTextDisplayOnly: true });
	await h.todo({ op: "init", items: ["First item"] });
	const append = await run("append Write the guide");
	expect(append.text).toContain("Write the guide");
	const start = await run("start Write the guide");
	expect(start.text).toContain("[/] Write the guide");
	const block = await run("block waiting for review");
	expect(block.text).toContain("waiting for review");
	expect(shown(await band(h))).toMatch(/Kata plan 0\/2 · 1 blocked/);
	expect((await run("unblock Write the guide")).text).toContain("[ ] Write the guide");
	expect((await run("start Write the guide")).text).toContain("[/] Write the guide");
	const done = await run("done Write the guide");
	expect(done.text).toContain("[x] Write the guide");
	expect(shown(await band(h))).toMatch(/Kata plan 1\/2/);
	expect((await run("drop First item")).text).toContain("First item");
	expect((await run("explode")).text).toContain("/todo explode is not available with Kata");
	const before = (await run("")).text;
	for (const inherited of ["toString", "constructor", "__proto__"]) expect((await run(inherited)).text, inherited).toContain(`/todo ${inherited} is not available with Kata`);
	expect((await run("")).text).toBe(before);
});

test("/kata is registered beside /todo and answers for the person only", async () => {
	const h = host();
	const ui = engineUi(h);
	await h.start();
	expect(ui.commands.find(c => c.name === "kata")).toMatchObject({ argumentHint: "[status|inbox|refresh]" });
	const run = (args: string) => h.fire("command.run", { command: "kata", args, origin: { kind: "composer" } });
	const status = await run("");
	expect(status).toMatchObject({ isTextDisplayOnly: true });
	expect(status.text).toMatch(/^workspace  /);
	expect(status.text).toContain("contract   off — kata agent-hook supplies it");
	expect(await run("refresh")).toEqual({ text: "Kata contract and actor cleared; the next prompt reads both again.", isTextDisplayOnly: true });
	expect(await run("explode")).toEqual({ text: "Usage: /kata [status|inbox|refresh]", isTextDisplayOnly: true });
});

test("an unknown /kata subcommand answers with the usage before any session work", async () => {
	const h = host();
	engineUi(h);
	const reply = await h.fire("command.run", { command: "kata", args: "explode", origin: { kind: "composer" } });
	expect(reply).toEqual({ text: "Usage: /kata [status|inbox|refresh]", isTextDisplayOnly: true });
	expect(h.calls).toEqual([]);
});

test("/kata says Kata supplies the inbox only with the mod's contract and live inbox both off", async () => {
	const address = `${author}/kata-owner`;
	const rows = async (contract: boolean, liveInbox: boolean) => {
		const h = host({ env: { KATA_INBOX_USER: address }, options: { kataExecutable: binary, contract, liveInbox } });
		engineUi(h);
		await h.start();
		const { text } = await h.fire("command.run", { command: "kata", args: "", origin: { kind: "composer" } });
		await h.end();
		const row = (label: string) => text.split("\n").find((line: string) => line.startsWith(label.padEnd(11)))?.slice(11);
		return { inbox: row("inbox"), requests: row("requests") };
	};
	expect(await rows(false, false)).toEqual({ inbox: `${address} · kata supplies it`, requests: "Kata supplies the inbox, without this plugin's actor filter" });
	expect((await rows(true, false)).inbox).toBe(`${address} · per prompt`);
	expect((await rows(false, true)).inbox).toBe(`${address} · live`);
});

test("/todo takeover starts a ticket item of the plan", async () => {
	const ticket = `${PROJECT}#${await issue("Held ticket")}`;
	const first = host();
	engineUi(first);
	await first.start();
	expect((await first.todo({ op: "init", items: [`${ticket}: work the held ticket`] })).isError).toBeUndefined();
	expect((await first.todo({ op: "start", task: ticket })).isError).toBeUndefined();
	const second = host();
	engineUi(second);
	await second.start();
	await second.todo({ op: "init", items: [`${ticket}: work the held ticket`] });
	const run = (args: string) => second.fire("command.run", { command: "todo", args, origin: { kind: "composer" } });
	const taken = await run(`takeover ${ticket}`);
	expect(taken.text).toContain("[/]");
	expect(taken.text).not.toContain("not available");
});

test("# offers open tickets from the bound project, in a project named after a second #, and leaves digits to GitHub", async () => {
	// A prefix of digits only is GitHub's, so the lookup by id needs a short id with a letter in it.
	let sampleId = await issue("Tidy the sample board");
	while (/^\d+$/.test(sampleId)) {
		await deleteIssue(`${PROJECT}#${sampleId}`);
		sampleId = await issue("Tidy the sample board");
	}
	await issue("Rework the ticket cache");
	const h = host();
	engineUi(h);
	await h.start();
	await h.todo({ op: "init", items: ["Bind the plan"] });
	const found = await warmRows(h, "see #tid");
	expect(found).toHaveLength(1);
	expect(found[0]).toEqual({ text: `${PROJECT}#${sampleId} `, label: `${PROJECT}#${sampleId}`, description: "Tidy the sample board" });
	// Another project's name needs its own `#`; that project's list is a cache of its own, warmed here.
	expect((await warmRows(h, `#${PROJECT}#cac`)).map(r => r.description)).toEqual(["Rework the ticket cache"]);
	expect((await rows(h, `#${sampleId.match(/^\d*\D/)![0]}`)).map(r => r.label)).toContain(`${PROJECT}#${sampleId}`);
	expect(await rows(h, "build #3164")).toEqual([]);
	expect(await rows(h, "#")).toEqual([]);
	// Rows of plugins beneath stay, ahead of ours.
	const mixed = await h.fire("prompt.autocomplete", { text: "#tid", cursor: 4, token: "#tid", start: 0 }, () => ({ suggestions: [{ text: "mine" }] }));
	expect(mixed.suggestions.map((r: any) => r.text)).toEqual(["mine", `${PROJECT}#${sampleId} `]);
});

test("a slow Kata adds no rows and holds typing for 400 ms at most; the list shows once it has loaded", async () => {
	await issue("Slow board ticket");
	let slow = false;
	const list = holdKata(argv => slow && argv.includes("list"));
	const h = host({ before: list.before });
	engineUi(h);
	await h.start();
	await h.todo({ op: "init", items: ["Bind the plan"] });
	const clock = pausedClock(h.$);
	slow = true;
	let first: unknown;
	const asking = rows(h, "#slow").then(found => (first = found));
	await eventually(async () => {
		if (first !== undefined) return true;
		clock.fireNext();
		return false;
	}, true);
	await asking;
	expect(first).toEqual([]);
	expect(clock.elapsed()).toBeLessThanOrEqual(400);
	list.release();
	await eventually(async () => (await rows(h, "#slow")).length > 0, true);
	expect((await rows(h, "#slow")).map(r => r.description)).toEqual(["Slow board ticket"]);
});

test("an unreachable Kata adds no rows, fails nothing and shows no error", async () => {
	const h = host({ options: LOCAL });
	const ui = engineUi(h);
	await h.start();
	expect(await rows(h, "#anything")).toEqual([]);
	expect(await rows(h, "#anything")).toEqual([]);
	const init = await h.todo({ op: "init", items: ["Offline task"] });
	expect(init.isError, init.result).toBeUndefined();
	expect(ui.toasts.some(t => /unreachable/i.test(t))).toBe(true);
});

test("a subagent's todo call leaves no card, and the lead's cards stay", async () => {
	const h = host();
	engineUi(h);
	await h.start();
	await h.todo({ op: "init", items: ["Implement parser module", "Document the output"] }, undefined, "lead-card");
	await h.spawn({ prompt: "Implement parser module", description: "Parser" }, "agent-card");
	const sub = await h.todo({ op: "view" }, "agent-card", "sub-card");
	expect(sub.isError, sub.result).toBeUndefined();
	expect(await card(h, "sub-card")).toBe(ENGINE_ROW);
	expect(await cardText(h, "lead-card")).toContain("Document the output");
});

test("a result's notice (a deleted parent) is kept on the card", async () => {
	const h = host();
	engineUi(h);
	await h.start();
	await h.todo({ op: "init", items: ["Notice task"] });
	const [parent] = await sessionParents("claude", h.state.session, true);
	await deleteIssue(`${PROJECT}#${parent.short_id}`);
	const out = await h.todo({ op: "init", items: ["Fresh task"] }, undefined, "note-card");
	expect(out.isError, out.result).toBeUndefined();
	expect(out.result).toMatch(/deleted/);
	expect(await cardText(h, "note-card")).toMatch(/was deleted/);
});

test("the wait for a first list runs beside the plugins beneath, not after them", async () => {
	await issue("Parallel board ticket");
	let hanging = false;
	const list = holdKata(argv => hanging && argv.includes("list"));
	const h = host({ before: list.before });
	engineUi(h);
	await h.start();
	await h.todo({ op: "init", items: ["Bind the plan"] });
	hanging = true;
	const beneath = Promise.withResolvers<{ suggestions: { text: string }[] }>();
	const asking = h.fire("prompt.autocomplete", { text: "#par", cursor: 4, token: "#par", start: 0 }, () => beneath.promise);
	// The first list is asked for while the plugins beneath have not answered.
	expect(await until(() => list.held > 0)).toBe(true);
	beneath.resolve({ suggestions: [{ text: "mine" }] });
	expect((await asking).suggestions.map((r: any) => r.text)).toEqual(["mine"]);
	list.release();
});
