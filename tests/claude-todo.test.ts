import { expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { savedSnapshot } from "../core/kata-core";
import { claudeKata, entering, PROJECT, type ClaudeHost } from "./claude-fixture";
import { EVIDENCE, eventually, holdKata, holdNext, MESSAGE, quote } from "./kata-fixture";

// The Claude mod's todo tool and session handling, against a real Kata: a hand-made `$` stands in for the engine.
const { host, show, closesOf, cwd, issue, binary, sessionParents, sh } = claudeKata("claude-todo");

const parentOf = async (id: string) => (await sessionParents("claude", id, true))[0];
const childrenOf = async (parent: any) => (await show(parent.short_id)).children as any[];
const entriesOf = (store: Map<string, unknown>, id: string) => ((store.get(`session/${id}`) as any)?.entries ?? []) as any[];
const snapshotOf = (store: Map<string, unknown>, id: string) => savedSnapshot(entriesOf(store, id), "claude") as any;

// A started session whose first Kata close fails, so it owes the close, with the core's queue held on the next call a test arms.
async function owingSession(store: Map<string, unknown>) {
	const failing = holdKata(
		argv => argv.includes("close"),
		() => {
			throw new Error("Kata went away");
		}
	);
	failing.release();
	const gate = holdNext();
	const h = host({
		store,
		before: async (argv, init) => {
			await gate.before(argv, init);
			return failing.before(argv, init);
		}
	});
	await h.start();
	await h.todo({ op: "init", items: ["Plan of the old session"] });
	await h.todo({ op: "done", task: "Plan of the old session", message: MESSAGE, evidence: EVIDENCE });
	return { h, gate };
}

test("tool.list takes the task tools out, keeps TaskStop and adds todo with the core's schema", async () => {
	const h = host();
	await h.start();
	const { value } = await h.toolList();
	expect(value.map((t: any) => t.name).sort()).toEqual(["Bash", "TaskStop", "todo"]);
	const todo = value.find((t: any) => t.name === "todo");
	expect(todo.mcp).toBe(false);
	expect(todo.inputSchema.properties.op.enum).toContain("init");
	expect(todo.inputSchema.required).toEqual(["op"]);
});

test("todo init, start, done and view run against Kata; done closes from evidence recorded for the Claude session", async () => {
	const h = host();
	await h.start();
	const init = await h.todo({ op: "init", items: ["Write the parser", "Test the parser"] });
	expect(init.isError, init.result).toBeUndefined();
	expect(init.result).toContain("Write the parser");
	const parent = await parentOf(h.state.session);
	expect(parent.title).toBeTruthy();
	const children = await childrenOf(parent);
	expect(children.map(c => c.title).sort()).toEqual(["Test the parser", "Write the parser"]);

	const view = await h.todo({ op: "view" });
	expect(view.result).toContain("[/] Write the parser");
	const done = await h.todo({ op: "done", task: "Write the parser", message: MESSAGE, evidence: EVIDENCE });
	expect(done.isError, done.result).toBeUndefined();
	expect(done.result).toContain("[x] Write the parser");
	const closed = children.find(c => c.title === "Write the parser");
	expect((await show(closed.short_id)).issue.status).toBe("closed");
	const close = (await closesOf(closed.short_id))[0];
	expect(close.payload.transcript).toMatchObject({ agent: "claude", session_id: h.state.session });
	expect((await h.todo({ op: "view" })).result).toContain("[/] Test the parser");
});

test("a Bash kata close of the lead records its session, also through the auto-mode refusal; the switch still turns it off", async () => {
	const closeCommand = (ref: string) => `kata close ${ref} --done --message ${quote(MESSAGE)} --evidence ${quote(EVIDENCE[0])} && ls`;
	const bash = (h: ClaudeHost, command: string, engine: (e: any) => any = e => e) => h.fire("tool.call", { tool: "Bash", tool_use_id: `b-${crypto.randomUUID()}`, command }, engine);
	const h = host();
	await h.start();
	const ref = await issue("Closed from the lead's shell");
	expect((await bash(h, `kata show ${ref}`)).command).toBe(`kata show ${ref}`);
	const refused = await bash(h, closeCommand(ref), () => ({ deny: "a hook changed this call's input after auto mode reviewed it" }));
	const exact = refused.deny.split("exactly like this: ")[1];
	expect(exact.endsWith("&& ls")).toBe(true);
	expect((await bash(h, exact)).command).toBe(exact);
	const ran = await sh(exact);
	expect(ran.code, ran.stderr).toBe(0);
	expect((await closesOf(ref))[0].payload.transcript).toMatchObject({ agent: "claude", session_id: h.state.session });

	const off = host({ env: { KATA_CLOSE_TRANSCRIPT_ENABLED: "false" } });
	await off.start();
	const quiet = await issue("Closed with recording off");
	const ranQuiet = await sh((await bash(off, closeCommand(quiet))).command);
	expect(ranQuiet.code, ranQuiet.stderr).toBe(0);
	expect((await closesOf(quiet))[0].payload.transcript).toBeUndefined();
});

test("a failed call is an error result carrying the plan, and a bad op is refused before Kata", async () => {
	const h = host();
	await h.start();
	await h.todo({ op: "init", items: ["Only task"] });
	const refused = await h.todo({ op: "done", task: "Only task", message: "short", evidence: EVIDENCE });
	expect(refused.isError).toBe(true);
	expect(refused.result).toContain("Only task");
	const before = h.calls.length;
	const unknown = await h.todo({ op: "explode" });
	expect(unknown.isError).toBe(true);
	expect(h.calls.length).toBe(before);
});

test("a call of a subagent the lead does not track is refused and never reaches the lead's plan", async () => {
	const h = host();
	await h.start();
	await h.todo({ op: "init", items: ["Lead task"] });
	const sub = await h.todo({ op: "done", task: "Lead task", message: MESSAGE, evidence: EVIDENCE }, "agent-7");
	expect(sub.isError).toBe(true);
	expect((await h.todo({ op: "view" })).result).toContain("[/] Lead task");
});

test("the prompt carries the plan once, again when it changed or after compaction", async () => {
	const h = host();
	await h.start();
	expect((await h.prompt()).context).toBeUndefined();
	await h.todo({ op: "init", items: ["Carry the plan"] });
	const first = await h.prompt();
	expect(first.context).toHaveLength(1);
	expect(first.context[0]).toContain("Carry the plan");
	expect((await h.prompt()).context).toBeUndefined();
	await h.todo({ op: "append", items: ["Second item"] });
	expect((await h.prompt()).context[0]).toContain("Second item");
	await h.fire("session.compact", { trigger: "auto", messages: [] });
	expect((await h.prompt()).context[0]).toContain("Carry the plan");
});

test("a prompt the engine drops leaves the plan to be sent with the next prompt", async () => {
	const h = host();
	await h.start();
	await h.todo({ op: "init", items: ["Carry the plan"] });
	let offered: string[] | undefined;
	const dropped = await h.fire("prompt.submit", { text: "go", wait: true, origin: { kind: "composer" } }, e => {
		offered = e.context;
		return { drop: "not now" };
	});
	expect(dropped).toEqual({ drop: "not now" });
	expect(offered?.join("\n")).toContain("Carry the plan");
	expect((await h.prompt()).context[0]).toContain("Carry the plan");
	expect((await h.prompt()).context).toBeUndefined();
});

test("the contract section is added only when the plugin option asks for it", async () => {
	const off = host();
	await off.start();
	expect((await off.prompt()).context).toBeUndefined();
	const on = host({ options: { kataExecutable: binary, contract: true } });
	await on.start();
	expect((await on.prompt()).context).toHaveLength(1);
	expect((await on.prompt()).context).toBeUndefined();
});

test("contractSource option overrides the environment when contract is enabled", async () => {
	const option = path.join(cwd, "option-contract.md"), fallback = path.join(cwd, "env-contract.md");
	writeFileSync(option, "Option contract fixture");
	writeFileSync(fallback, "Environment contract fixture");
	const h = host({ options: { kataExecutable: binary, contract: true, contractSource: " option-contract.md " }, env: { KATA_CONTRACT_SOURCE: fallback } });
	await h.start();
	expect((await h.prompt()).context?.join("\n")).toContain("Option contract fixture");
	expect(h.calls.find((call: any) => call.argv.includes("agent-contract-hook"))?.argv).toContain(realpathSync(option));
});

test("stop reminds of open tasks three times at most, only after progress and not after a question", async () => {
	const h = host();
	await h.start();
	await h.todo({ op: "init", items: ["Reminded task"] });
	await h.prompt("go");
	const progress = () => h.fire("tool.call", { tool: "Bash", tool_use_id: `b-${crypto.randomUUID()}`, command: "true" }, () => ({ result: "ok", text: "ok" }));
	expect((await h.stop()).block).toContain("Reminded task");
	expect((await h.stop()).block).toBeUndefined();
	await progress();
	expect((await h.stop("Which file did you mean?")).block).toBeUndefined();
	expect((await h.stop()).block).toContain("Reminded task");
	await progress();
	expect((await h.stop()).block).toContain("Reminded task");
	await progress();
	expect((await h.stop()).block).toBeUndefined();
	expect((await h.fire("classic.Stop", { stop_hook_active: false, agent_id: "a1" })).block).toBeUndefined();
});

test("session state is saved per session id and a resumed session picks its plan back up", async () => {
	const store = new Map<string, unknown>();
	const first = host({ store });
	await first.start();
	await first.todo({ op: "init", items: ["Survives a restart"] });
	const key = `session/${first.state.session}`;
	expect(store.has(key)).toBe(true);
	expect([...store.keys()].filter(k => k.startsWith("session/"))).toEqual([key]);
	await first.end("clear");
	expect(store.has(key)).toBe(true);

	const resumed = host({ store, session: first.state.session });
	await resumed.start();
	expect((await resumed.todo({ op: "view" })).result).toContain("Survives a restart");
	expect((await resumed.prompt()).context[0]).toContain("Survives a restart");
});

test("a session id that changes without a start (resume, clear) rebinds the core and leaves the plan behind", async () => {
	const h = host();
	await h.start();
	await h.todo({ op: "init", items: ["Old session task"] });
	const old = h.state.session;
	h.state.session = crypto.randomUUID();
	const view = await h.todo({ op: "view" });
	expect(view.result).not.toContain("Old session task");
	expect(h.store.has(`session/${old}`)).toBe(true);
	h.state.session = old;
	expect((await h.todo({ op: "view" })).result).toContain("Old session task");
});

test("the end of the process closes the finished plan's parent and forgets the session", async () => {
	const h = host();
	await h.start();
	await h.todo({ op: "init", items: ["Last task"] });
	await h.todo({ op: "done", task: "Last task", message: MESSAGE, evidence: EVIDENCE });
	const parent = await parentOf(h.state.session);
	await h.end("prompt_input_exit");
	expect((await show(parent.short_id)).issue.status).toBe("closed");
	expect(h.store.has(`session/${h.state.session}`)).toBe(false);
});

test("start prunes ended sessions past their keep time and keeps recent ones, running ones and one that still owes work", async () => {
	const store = new Map<string, unknown>();
	const day = 86_400_000,
		now = Date.now();
	const record = (updatedAt: number, endedAt?: number) => ({ directory: cwd, entries: [], updatedAt, ...(endedAt ? { endedAt } : {}) });
	const owing = host({ store });
	await owing.start();
	await owing.todo({ op: "init", items: ["Still open at the end"] });
	await owing.end("prompt_input_exit");
	const owingKey = `session/${owing.state.session}`;
	store.set(owingKey, { ...(store.get(owingKey) as object), updatedAt: now - 10 * day, endedAt: now - 10 * day });
	store.set("session/old-ended", record(now - 20 * day, now - 10 * day));
	store.set("session/recent-ended", record(now - day, now - day));
	store.set("session/stale-running", record(now - 40 * day));
	store.set("session/other-running", record(now - day));
	const h = host({ store });
	await h.start();
	await eventually(async () => ["session/old-ended", "session/stale-running"].filter(key => store.has(key)), []);
	expect(["session/recent-ended", "session/other-running", owingKey].filter(key => !store.has(key))).toEqual([]);
});

test("over the store budget, start evicts ended sessions that owe nothing before older ones that owe work, counting bytes", async () => {
	const store = new Map<string, unknown>();
	const day = 86_400_000,
		now = Date.now();
	// 700,000 bytes of UTF-8 in 350,000 characters: three of them pass the 2 MiB budget only when bytes are counted.
	const pad = { type: "custom", customType: "padding", data: "é".repeat(350_000) };
	const owing = host({ store });
	await owing.start();
	await owing.todo({ op: "init", items: ["Owed after the end"] });
	await owing.end("prompt_input_exit");
	const owingKey = `session/${owing.state.session}`;
	const owed = store.get(owingKey) as { entries: unknown[] };
	store.set(owingKey, { ...owed, entries: [...owed.entries, pad], updatedAt: now - 3 * day, endedAt: now - 3 * day });
	store.set("session/older-done", { entries: [pad], updatedAt: now - 2 * day, endedAt: now - 2 * day });
	store.set("session/newer-done", { entries: [pad], updatedAt: now - day, endedAt: now - day });
	store.set("session/running", { entries: [pad], updatedAt: now - day });
	const h = host({ store });
	await h.start();
	await eventually(async () => ["session/older-done", "session/newer-done"].filter(key => store.has(key)), []);
	expect([owingKey, "session/running"].filter(key => !store.has(key))).toEqual([]);
});

test("an unknown op is refused with the ops there are and changes nothing", async () => {
	const h = host();
	await h.start();
	await h.todo({ op: "init", items: ["Only task"] });
	const before = (await h.todo({ op: "view" })).result;
	const bad = await h.todo({ op: "bogus" });
	expect(bad.isError).toBe(true);
	expect(bad.result).toContain("todo needs op: one of init");
	expect((await h.todo({ op: "view" })).result).toBe(before);
});

test("a switch whose saved record fails to load is retried at the next hook instead of staying on the previous session", async () => {
	let failing: string | undefined;
	const store = new (class extends Map<string, unknown> {
		has(key: string) {
			if (key !== failing) return super.has(key);
			failing = undefined;
			throw new Error("store unreadable");
		}
	})();
	const h = host({ store });
	await h.start();
	await h.todo({ op: "init", items: ["Old session's task"] });
	const old = h.state.session;
	h.state.session = crypto.randomUUID();
	failing = `session/${h.state.session}`;
	expect((await h.todo({ op: "view" })).isError).toBe(true);
	await h.todo({ op: "init", items: ["New session's task"] });
	await eventually(async () => JSON.stringify(entriesOf(store, h.state.session)).includes("New session's task"), true);
	expect(JSON.stringify(entriesOf(store, old))).not.toContain("New session's task");
});

test("with no Kata the plan stays session-local and the call is not an error", async () => {
	const h = host({ options: { kataExecutable: "/nonexistent/kata" } });
	await h.start();
	const init = await h.todo({ op: "init", items: ["Offline task"] });
	expect(init.isError, init.result).toBeUndefined();
	expect(init.result).toContain("Session-local plan");
});

test("a fork starts with its source's plan and leaves the source resumable", async () => {
	const store = new Map<string, unknown>();
	const source = host({ store });
	await source.start();
	await source.todo({ op: "init", items: ["Shared by the fork"] });
	const origin = source.state.session;
	// /branch: the process goes on under a new id and a SessionStart of source `fork` says so.
	source.state.session = crypto.randomUUID();
	await source.fire("classic.SessionStart", { source: "fork" });
	expect((await source.todo({ op: "view" })).result).toContain("Shared by the fork");
	expect(store.has(`session/${origin}`)).toBe(true);
	expect(store.has(`session/${source.state.session}`)).toBe(true);
});

test.each([
	["with an explicit parent", undefined, async () => ({ ref: `${PROJECT}#${await issue("Explicit parent")}` })],
	["that is session-local", { kataExecutable: "/nonexistent/kata" }, async () => ({})]
] as const)("a plan %s survives the end of the process and a resume", async (_name, options, extra) => {
	const store = new Map<string, unknown>();
	const first = host({ store, options });
	await first.start();
	expect((await first.todo({ op: "init", items: ["Keep through the exit"], ...(await extra()) })).isError).toBeUndefined();
	await first.end("prompt_input_exit");
	expect(store.has(`session/${first.state.session}`)).toBe(true);
	const resumed = host({ store, session: first.state.session, options });
	await resumed.start();
	expect((await resumed.todo({ op: "view" })).result).toContain("Keep through the exit");
});

test("a job of the old session still queued at a resume runs for that session and leaves the resumed one's snapshot alone", async () => {
	const store = new Map<string, unknown>();
	const first = host({ store });
	await first.start();
	await first.todo({ op: "init", items: ["Plan of the resumed session"] });
	// X has a delegate still running when its process ends: a resume of X settles it, which sends its issue back for review.
	const spawned = await first.spawn({ prompt: "Plan of the resumed session", description: "Planner" }, "agent-of-x");
	const issueRef = /Your Kata issue is (\S+?);/.exec(spawned.prompt)?.[1] ?? "";
	expect(issueRef).not.toBe("");
	await first.agentCall("agent-of-x", "Read");
	const x = first.state.session;
	await first.end();

	const gate = holdNext();
	const h = host({ store, before: gate.before });
	await h.start();
	const a = h.state.session;
	gate.arm();
	const writing = h.todo({ op: "init", items: ["Plan of the old session"] });
	await gate.entered;
	const { result: queued } = await entering(() => h.todo({ op: "view" }));
	// /resume X while both still run.
	h.state.session = x;
	const { result: resumed } = await entering(() => h.todo({ op: "view" }));
	gate.release();
	await writing;
	await queued;
	const view = await resumed;
	await eventually(async () => snapshotOf(store, a)?.sessionId === a && snapshotOf(store, x)?.sessionId === x, true);
	expect(view.result).toContain("Plan of the resumed session");
	expect(snapshotOf(store, x).plan.tasks.map((t: any) => t.content)).toEqual(["Plan of the resumed session"]);
	await eventually(async () => ((await show(issueRef)).labels ?? []).some((label: any) => label.label === "needs-review"), true);
}, 30_000);

test("a write that lands after its session ended keeps the record ended", async () => {
	const store = new Map<string, unknown>();
	const gate = holdNext();
	const h = host({ store, before: gate.before });
	await h.start();
	const a = h.state.session;
	gate.arm();
	const writing = h.todo({ op: "init", items: ["Plan the late write touches"] });
	await gate.entered;
	const { result: queued } = await entering(() => h.todo({ op: "view" }));
	// A new session replaces A while A's plan write still runs.
	h.state.session = crypto.randomUUID();
	const { result: switching } = await entering(() => h.todo({ op: "view" }));
	gate.release();
	await Promise.all([writing, queued, switching]);
	await eventually(async () => {
		const record = store.get(`session/${a}`) as any;
		return JSON.stringify(record?.entries ?? []).includes("Plan the late write touches") && (record?.endedAt ?? 0) > 0;
	}, true);
});

test("a process that exits before a queued switch has run ends the record of the session it switched to", async () => {
	const store = new Map<string, unknown>();
	const recordOf = (id: string) => store.get(`session/${id}`) as any;
	// X has an open plan and a record that was never ended (its process was killed).
	const first = host({ store });
	await first.start();
	await first.todo({ op: "init", items: ["Plan of the resumed session"] });
	const x = first.state.session;
	await eventually(async () => recordOf(x) !== undefined, true);
	expect(recordOf(x).endedAt).toBeUndefined();

	const gate = holdNext();
	const h = host({ store, before: gate.before });
	await h.start();
	gate.arm();
	const writing = h.todo({ op: "init", items: ["Plan of the old session"] });
	await gate.entered;
	// /resume X while A's plan write holds the core's queue: the switch job is queued behind it.
	h.state.session = x;
	const { result: switching } = await entering(() => h.todo({ op: "view" }));
	await h.end("prompt_input_exit");
	expect(recordOf(x).endedAt).toBeGreaterThan(0);
	gate.release();
	await Promise.all([writing, switching]);
});

test("a process that exits before a queued switch has run deletes the switched-to record that has no work, whatever the old session owes", async () => {
	const store = new Map<string, unknown>();
	const x = crypto.randomUUID();
	// X was resumed from a record with nothing left to do.
	store.set(`session/${x}`, { directory: cwd, entries: [], updatedAt: Date.now() });
	const { h, gate } = await owingSession(store);
	gate.arm();
	const writing = h.todo({ op: "view" });
	await gate.entered;
	// /resume X while A's call holds the core's queue: the switch job is queued behind it.
	h.state.session = x;
	const { result: switching } = await entering(() => h.todo({ op: "view" }));
	await h.end("prompt_input_exit");
	expect(store.has(`session/${x}`)).toBe(false);
	gate.release();
	await Promise.all([writing, switching]);
});

test("a switch ends the session it leaves with that session's own debts, also when two switches wait on a slow call", async () => {
	const store = new Map<string, unknown>();
	const b = crypto.randomUUID(),
		c = crypto.randomUUID();
	store.set(`session/${b}`, { directory: cwd, entries: [], updatedAt: Date.now() });
	const { h, gate } = await owingSession(store);
	const a = h.state.session;
	gate.arm();
	const writing = h.todo({ op: "view" });
	await gate.entered;
	h.state.session = b;
	const { result: toB } = await entering(() => h.todo({ op: "view" }));
	h.state.session = c;
	const { result: toC } = await entering(() => h.todo({ op: "view" }));
	gate.release();
	await Promise.all([writing, toB, toC]);
	await eventually(async () => store.has(`session/${b}`), false);
	await eventually(async () => ((store.get(`session/${a}`) as any)?.endedAt ?? 0) > 0, true);
});

test("Write, Edit and a git commit that name a ref of the plan are denied until the refGuard option is off", async () => {
	for (const off of [false, true]) {
		const h = host(off ? { options: { kataExecutable: binary, refGuard: false } } : {});
		await h.start();
		await h.todo({ op: "init", items: ["Guarded plan item"] });
		const ref = `${PROJECT}#${(await parentOf(h.state.session)).short_id}`;
		const file = `${cwd}/notes.ts`;
		const fire = (call: Record<string, unknown>) => h.fire("tool.call", { tool_use_id: `g-${crypto.randomUUID()}`, ...call }, () => ({ result: "ok", text: "ok" }));
		const attempts = [
			{ tool: "Write", file_path: file, content: `// tracked as ${ref}` },
			{ tool: "Edit", file_path: file, old_string: "x", new_string: `// ${ref}` },
			{ tool: "Bash", command: `git commit -m "fix ${ref}"` },
		];
		for (const attempt of attempts) {
			const result = await fire(attempt);
			if (off) { expect(result.deny).toBeUndefined(); continue; }
			expect(result.deny).toContain(ref);
			expect(result.deny).toContain("KATA_REF_GUARD=off");
		}
		for (const attempt of [{ tool: "Write", file_path: file, content: "// README.md#tasks" }, { tool: "Write", file_path: "/tmp/outside-notes.ts", content: ref }, { tool: "Bash", command: `kata comment ${ref} -m "note ${ref}"` }]) {
			expect((await fire(attempt)).deny).toBeUndefined();
		}
	}
});

test("a delegate's note names no inbox: the Claude path shows a delegate none", async () => {
	process.env.KATA_INBOX_USER = "claude-builder/lead";
	const h = host({ options: { kataExecutable: binary, contract: true } });
	await h.start();
	await h.todo({ op: "init", items: ["Note without inbox"] });
	const spawned = await h.spawn({ prompt: "Note without inbox", description: "Noter" }, "agent-noter");
	expect(spawned.prompt).toContain("Your Kata issue is");
	expect(spawned.prompt).not.toContain("Your Kata inbox");
});
