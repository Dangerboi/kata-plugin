import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { claudeKata, PROJECT } from "./claude-fixture";
import { EVIDENCE, eventually, MESSAGE } from "./kata-fixture";
import { rememberCard } from "../plugins/claude-code/hooks/plan";

// The Claude mod's plan band, todo cards, `#` ticket completion and /todo, against a real Kata. The render hooks themselves
// are drawn in plugins/claude-code/tests/ui.test.tsx; here the state they draw from and the rows the typeahead gets.
const { host, issue, scratch, binary, kata } = claudeKata("claude-ui");

/** The engine's `$.state`, `$.ui.toast` and `$.command.register` for a host the hand-made `$` lacks them. */
function engineUi(h: ReturnType<typeof host>) {
	const held = new Map<string, any>();
	const toasts: string[] = [];
	const commands: any[] = [];
	const key = (ref: any) => (ref.id === undefined ? ref.key : `${ref.key}#${ref.id}`);
	h.$.state = {
		get: async (ref: any) => ({ value: held.get(key(ref)), version: 1 }),
		set: async (ref: any, value: unknown) => {
			held.set(key(ref), structuredClone(value));
			return { isSet: true, version: 2 };
		}
	};
	h.$.ui = {
		toast: (text: string) => {
			toasts.push(text);
		}
	};
	h.$.command = {
		register: async (spec: any) => {
			commands.push(spec);
		}
	};
	return { held, toasts, commands };
}

const autocomplete = (h: ReturnType<typeof host>, text: string) =>
	h.fire("prompt.autocomplete", { text, cursor: text.length, token: text.split(/\s/).pop(), start: text.lastIndexOf(text.split(/\s/).pop()!) }, () => ({
		suggestions: []
	}));
const rows = async (h: ReturnType<typeof host>, text: string) =>
	(await autocomplete(h, text)).suggestions as { text: string; label: string; description?: string }[];
/** A project's first list loads in the background when the typeahead's 400 ms bound passes, so a cold first ask may return no rows. */
const warmRows = async (h: ReturnType<typeof host>, text: string) => {
	await eventually(async () => (await rows(h, text)).length > 0, true);
	return rows(h, text);
};

test("the plan the core pushes is what the band draws from, and a todo call leaves its card", async () => {
	const h = host();
	const ui = engineUi(h);
	await h.start();
	expect(ui.held.get("plan")).toBeNull();
	const id = "tu-card";
	const init = await h.fire(
		"tool.call",
		{ tool: "todo", tool_use_id: id, op: "init", list: [{ phase: "Build", items: ["Write the parser", "Test the parser"] }] },
		() => {
			throw new Error("the engine ran todo");
		}
	);
	expect(init.isError, init.result).toBeUndefined();
	const plan = ui.held.get("plan");
	expect(plan.phases.map((p: any) => [p.name, p.tasks.map((t: any) => [t.content, t.status])])).toEqual([
		[
			"Build",
			[
				["Write the parser", "in_progress"],
				["Test the parser", "pending"]
			]
		]
	]);
	expect(plan.phases[0].tasks[0].ref).toContain(`${PROJECT}#`);
	const card = ui.held.get(`cards#${id}`);
	expect(card.text).toContain("Write the parser");
	expect(card.view.phases[0].tasks).toHaveLength(2);
	expect(ui.held.get("cardIds")).toEqual([id]);

	// Closing a task moves the band; blocking one carries its reason.
	await h.todo({ op: "done", task: "Write the parser", message: MESSAGE, evidence: EVIDENCE });
	await h.todo({ op: "block", task: "Test the parser", reason: "waiting for a fixture" });
	const later = ui.held.get("plan").phases[0].tasks;
	expect(later[0].status).toBe("completed");
	expect(later[1]).toMatchObject({ status: "blocked", blocker: "waiting for a fixture" });
});

test("a failed todo call keeps the engine's row: no card is stored for it", async () => {
	const h = host();
	const ui = engineUi(h);
	await h.start();
	await h.fire("tool.call", { tool: "todo", tool_use_id: "ok", op: "init", items: ["Only task"] }, () => {
		throw new Error("no");
	});
	const refused = await h.fire("tool.call", { tool: "todo", tool_use_id: "bad", op: "done", task: "Only task", message: "short", evidence: EVIDENCE }, () => {
		throw new Error("no");
	});
	expect(refused.isError).toBe(true);
	expect(ui.held.has("cards#bad")).toBe(false);
});

test("only the newest cards are kept", async () => {
	const held = new Map<string, any>();
	const $: any = {
		state: {
			get: async (ref: any) => ({ value: held.get(ref.id === undefined ? ref.key : `${ref.key}#${ref.id}`), version: 1 }),
			set: async (ref: any, value: unknown) => {
				held.set(ref.id === undefined ? ref.key : `${ref.key}#${ref.id}`, value);
				return { isSet: true, version: 1 };
			}
		}
	};
	held.set("plan", { phases: [{ name: "P", tasks: [{ content: "t", status: "pending", ref: "x#1" }] }] });
	for (let i = 0; i < 45; i++) await rememberCard($, `id${i}`, { result: `r${i}` });
	expect(held.get("cardIds")).toHaveLength(40);
	expect(held.get("cardIds")[0]).toBe("id5");
	expect(held.get("cards#id4")).toBeNull();
	expect(held.get("cards#id5").text).toBe("r5");
});

test("/todo is registered at the session start and answers the omp subcommands for the person", async () => {
	const h = host();
	const ui = engineUi(h);
	await h.start();
	expect(ui.commands.map(c => c.name)).toEqual(["todo"]);
	const run = (args: string) => h.fire("command.run", { command: "todo", args, origin: { kind: "composer" } });
	expect(await run("")).toMatchObject({ text: expect.stringContaining("No todo plan"), isTextDisplayOnly: true });
	await h.todo({ op: "init", items: ["First item"] });
	const append = await run("append Write the guide");
	expect(append.text).toContain("Write the guide");
	const start = await run("start Write the guide");
	expect(start.text).toContain("[/] Write the guide");
	const block = await run("block waiting for review");
	expect(block.text).toContain("waiting for review");
	expect(ui.held.get("plan").phases[0].tasks.find((t: any) => t.content === "Write the guide")).toMatchObject({
		status: "blocked",
		blocker: "waiting for review"
	});
	expect((await run("unblock Write the guide")).text).toContain("[ ] Write the guide");
	expect((await run("start Write the guide")).text).toContain("[/] Write the guide");
	const done = await run("done Write the guide");
	expect(done.text).toContain("[x] Write the guide");
	expect(ui.held.get("plan").phases[0].tasks.find((t: any) => t.content === "Write the guide").status).toBe("completed");
	expect((await run("drop First item")).text).toContain("First item");
	expect((await run("explode")).text).toContain("/todo explode is not available with Kata");
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
	const sampleId = await issue("Tidy the sample board");
	await issue("Rework the ticket cache");
	const h = host();
	engineUi(h);
	await h.start();
	await h.todo({ op: "init", items: ["Bind the plan"] });
	const found = await warmRows(h, "see #tid");
	expect(found).toHaveLength(1);
	expect(found[0]).toEqual({ text: `${PROJECT}#${sampleId} `, label: `${PROJECT}#${sampleId}`, description: "Tidy the sample board" });
	// A title word or a short id prefix finds it; another project's name needs its own `#`. A prefix of digits only is GitHub's, so it runs up to the id's first letter.
	expect((await rows(h, `#${sampleId.match(/^\d*\D/)?.[0] ?? sampleId}`)).map(r => r.label)).toContain(`${PROJECT}#${sampleId}`);
	expect((await warmRows(h, `#${PROJECT}#cac`)).map(r => r.description)).toEqual(["Rework the ticket cache"]);
	expect(await rows(h, "build #3164")).toEqual([]);
	expect(await rows(h, "#")).toEqual([]);
	// Rows of plugins beneath stay, ahead of ours.
	const mixed = await h.fire("prompt.autocomplete", { text: "#tid", cursor: 4, token: "#tid", start: 0 }, () => ({ suggestions: [{ text: "mine" }] }));
	expect(mixed.suggestions.map((r: any) => r.text)).toEqual(["mine", `${PROJECT}#${sampleId} `]);
});

test("a slow Kata adds no rows and holds typing for 400 ms at most; the list shows once it has loaded", async () => {
	await issue("Slow board ticket");
	const flag = join(scratch, "slow-list");
	const slow = join(scratch, "slow-kata.sh");
	writeFileSync(slow, `#!/bin/sh\nif [ -e "${flag}" ]; then case " $* " in *" --limit 1000 "*) sleep 2;; esac; fi\nexec "${binary}" "$@"\n`);
	chmodSync(slow, 0o755);
	const h = host({ options: { kataExecutable: slow } });
	engineUi(h);
	await h.start();
	await h.todo({ op: "init", items: ["Bind the plan"] });
	writeFileSync(flag, "");
	const begun = Date.now();
	expect(await rows(h, "#slow")).toEqual([]);
	expect(Date.now() - begun).toBeLessThan(1500);
	await eventually(async () => (await rows(h, "#slow")).length > 0, true);
	const warm = Date.now();
	expect((await rows(h, "#slow")).map(r => r.description)).toEqual(["Slow board ticket"]);
	expect(Date.now() - warm).toBeLessThan(400);
});

test("an unreachable Kata adds no rows, fails nothing and shows no error", async () => {
	const h = host({ options: { kataExecutable: "/nonexistent/kata" } });
	const ui = engineUi(h);
	await h.start();
	const begun = Date.now();
	expect(await rows(h, "#anything")).toEqual([]);
	expect(await rows(h, "#anything")).toEqual([]);
	expect(Date.now() - begun).toBeLessThan(1500);
	// The plan is still told of: Kata being down is a toast, and the todo tool keeps a local plan.
	const init = await h.todo({ op: "init", items: ["Offline task"] });
	expect(init.isError, init.result).toBeUndefined();
	expect(ui.toasts.some(t => /unreachable/i.test(t))).toBe(true);
});

test("a subagent's todo call leaves no card, and the lead's cards stay", async () => {
	const h = host();
	const ui = engineUi(h);
	await h.start();
	await h.fire("tool.call", { tool: "todo", tool_use_id: "lead-card", op: "init", items: ["Implement parser module", "Document the output"] }, () => {
		throw new Error("no");
	});
	await h.spawn({ prompt: "Implement parser module", description: "Parser" }, "agent-card");
	const sub = await h.fire("tool.call", { tool: "todo", tool_use_id: "sub-card", agentId: "agent-card", op: "view" }, () => {
		throw new Error("no");
	});
	expect(sub.isError, sub.result).toBeUndefined();
	expect(ui.held.has("cards#sub-card")).toBe(false);
	expect(ui.held.get("cardIds")).toEqual(["lead-card"]);
});

test("todo calls that finish together each leave a card and none is lost from the list", async () => {
	const h = host();
	const ui = engineUi(h);
	await h.start();
	const ids = Array.from({ length: 6 }, (_, i) => `par-${i}`);
	await Promise.all(ids.map(id => rememberCard(h.$, id, { result: `text of ${id}` })));
	expect((ui.held.get("cardIds") as string[]).sort()).toEqual([...ids].sort());
	for (const id of ids) expect(ui.held.get(`cards#${id}`).text).toBe(`text of ${id}`);
});

test("a result's notice (a deleted parent) is kept on the card", async () => {
	const h = host();
	const ui = engineUi(h);
	await h.start();
	await h.todo({ op: "init", items: ["Notice task"] });
	const parent = (await kata(["list", "--status", "all", "--meta", `claude.session_id=${h.state.session}`, "--json"])).issues[0];
	await kata(["delete", `${PROJECT}#${parent.short_id}`, "--force", "--confirm", `DELETE ${PROJECT}#${parent.short_id}`, "--json"]);
	const out = await h.fire("tool.call", { tool: "todo", tool_use_id: "note-card", op: "init", items: ["Fresh task"] }, () => {
		throw new Error("no");
	});
	expect(out.isError, out.result).toBeUndefined();
	expect(out.result).toMatch(/deleted/);
	expect(ui.held.get("cards#note-card").notice).toMatch(/was deleted/);
});

test("the wait for a first list runs beside the plugins beneath, not after them", async () => {
	await issue("Parallel board ticket");
	const flag = join(scratch, "hang-list");
	const hang = join(scratch, "hang-list-kata.sh");
	writeFileSync(hang, `#!/bin/sh\nif [ -e "${flag}" ]; then case " $* " in *" --limit 1000 "*) sleep 30;; esac; fi\nexec "${binary}" "$@"\n`);
	chmodSync(hang, 0o755);
	const h = host({ options: { kataExecutable: hang } });
	engineUi(h);
	await h.start();
	await h.todo({ op: "init", items: ["Bind the plan"] });
	writeFileSync(flag, "");
	// Beneath takes 600 ms and the first fill holds 400 ms: side by side the call lasts about 600 ms, one after the other 1000.
	const slowBeneath = async () => {
		await Bun.sleep(600);
		return { suggestions: [{ text: "mine" }] };
	};
	const begun = Date.now();
	const first = await h.fire("prompt.autocomplete", { text: "#par", cursor: 4, token: "#par", start: 0 }, slowBeneath);
	expect(first.suggestions.map((r: any) => r.text)).toEqual(["mine"]);
	expect(Date.now() - begun).toBeLessThan(900);
});
