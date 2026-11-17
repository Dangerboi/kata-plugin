import { expect, test } from "bun:test";
import { claudeKata, PROJECT } from "./claude-fixture";
import { EVIDENCE, MESSAGE } from "./kata-fixture";

// The Claude mod's todo tool and session handling, against a real Kata: a hand-made `$` stands in for the engine.
const { host, kata, show, closesOf, cwd, issue } = claudeKata("claude-todo");

const parentOf = async (id: string) => (await kata(["list", "--status", "all", "--meta", `claude.session_id=${id}`, "--json"])).issues[0];
const childrenOf = async (parent: any) => (await show(parent.short_id)).children as any[];

test("tool.list takes the task tools out, keeps TaskStop and adds todo with the core's schema", async () => {
	const h = host();
	await h.start();
	const { value } = await h.toolList();
	expect(value.map((t: any) => t.name).sort()).toEqual(["Bash", "TaskStop", "todo"]);
	const todo = value.find((t: any) => t.name === "todo");
	expect(todo.mcp).toBe(false);
	expect(todo.inputSchema.properties.op.enum).toContain("init");
	expect(todo.inputSchema.required).toEqual(["op"]);
	expect(todo.description).toContain("Track multi-step work as a todo list stored in Kata.");
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
	// Starting the next task was automatic: the second is in progress.
	expect((await h.todo({ op: "view" })).result).toContain("[/] Test the parser");
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
	expect(sub.result).toContain("no Kata assignment");
	expect((await h.todo({ op: "view" })).result).toContain("[/] Lead task");
});

test("the prompt carries the plan once, again when it changed or after compaction", async () => {
	const h = host();
	await h.start();
	expect((await h.prompt()).context).toBeUndefined();
	await h.todo({ op: "init", items: ["Carry the plan"] });
	const first = await h.prompt();
	expect(first.context).toHaveLength(1);
	expect(first.context[0]).toContain("<kata_todo>");
	expect(first.context[0]).toContain("Carry the plan");
	expect((await h.prompt()).context).toBeUndefined();
	await h.todo({ op: "append", items: ["Second item"] });
	expect((await h.prompt()).context[0]).toContain("Second item");
	await h.fire("session.compact", { trigger: "auto", messages: [] });
	expect((await h.prompt()).context[0]).toContain("Carry the plan");
});

test("the contract section is added only when the plugin option asks for it", async () => {
	const off = host();
	await off.start();
	expect(JSON.stringify((await off.prompt()).context ?? [])).not.toContain("kata_contract");
	const on = host({ options: { kataExecutable: off.state.cwd && process.env.KATA_TEST_EXECUTABLE, contract: true } });
	await on.start();
	expect(JSON.stringify((await on.prompt()).context ?? [])).toContain("<kata_contract>");
});

test("stop reminds of open tasks up to three times, not after a question, and keeps progress in mind", async () => {
	const h = host();
	await h.start();
	await h.todo({ op: "init", items: ["Reminded task"] });
	await h.prompt("go");
	const one = await h.stop();
	expect(one.block).toContain("Reminded task");
	expect(one.block).toContain("reminder 1/3");
	// No progress since: no second reminder until a tool ran.
	expect((await h.stop()).block).toBeUndefined();
	await h.fire("tool.call", { tool: "Bash", tool_use_id: "b1", command: "true" }, () => ({ result: "ok", text: "ok" }));
	expect((await h.stop("Which file did you mean?")).block).toBeUndefined();
	expect((await h.stop()).block).toContain("reminder 2/3");
	// A subagent's stop is not the lead's.
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

test("start prunes ended sessions past their keep time and keeps recent and running ones", async () => {
	const store = new Map<string, unknown>();
	const day = 86_400_000,
		now = Date.now();
	const record = (updatedAt: number, endedAt?: number) => ({ directory: cwd, entries: [], updatedAt, ...(endedAt ? { endedAt } : {}) });
	store.set("session/old-ended", record(now - 20 * day, now - 10 * day));
	store.set("session/recent-ended", record(now - day, now - day));
	store.set("session/stale-running", record(now - 40 * day));
	store.set("session/other-running", record(now - day));
	const h = host({ store });
	await h.start();
	await new Promise(resolve => setTimeout(resolve, 200));
	expect(store.has("session/other-running") && store.has("session/recent-ended")).toBe(true);
	expect(store.has("session/old-ended")).toBe(false);
	expect(store.has("session/stale-running")).toBe(false);
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

test("a plan with an explicit parent survives the end of the process and a resume", async () => {
	const parent = `${PROJECT}#${await issue("Explicit parent")}`;
	const store = new Map<string, unknown>();
	const first = host({ store });
	await first.start();
	expect((await first.todo({ op: "init", ref: parent, items: ["Keep through the exit"] })).isError).toBeUndefined();
	await first.end("prompt_input_exit");
	expect(store.has(`session/${first.state.session}`)).toBe(true);
	const resumed = host({ store, session: first.state.session });
	await resumed.start();
	expect((await resumed.todo({ op: "view" })).result).toContain("Keep through the exit");
});

test("a session-local plan survives the end of the process and a resume", async () => {
	const store = new Map<string, unknown>();
	const first = host({ store, options: { kataExecutable: "/nonexistent/kata" } });
	await first.start();
	await first.todo({ op: "init", items: ["Local and open"] });
	await first.end("prompt_input_exit");
	expect(store.has(`session/${first.state.session}`)).toBe(true);
	const resumed = host({ store, session: first.state.session, options: { kataExecutable: "/nonexistent/kata" } });
	await resumed.start();
	expect((await resumed.todo({ op: "view" })).result).toContain("Local and open");
});

test("a job of the old session still queued at a resume runs for that session and leaves the resumed one's snapshot alone", async () => {
	const store = new Map<string, unknown>();
	const entriesOf = (id: string) => ((store.get(`session/${id}`) as any)?.entries ?? []) as any[];
	const snapshotOf = (id: string) => entriesOf(id).find(entry => entry.customType.endsWith(".state"))?.data;
	const first = host({ store });
	await first.start();
	await first.todo({ op: "init", items: ["Plan of the resumed session"] });
	const x = first.state.session;
	await first.end("clear");

	// Holds the first Kata call after `armed`: the plan write is then running in the core's queue, and a later call of the
	// same session waits behind it.
	let armed = false;
	let reached!: () => void;
	const running = new Promise<void>(resolve => (reached = resolve));
	let release!: () => void;
	const gate = new Promise<void>(resolve => (release = resolve));
	const h = host({
		store,
		hold: () => {
			if (!armed) return undefined;
			armed = false;
			reached();
			return gate;
		}
	});
	await h.start();
	const a = h.state.session;
	armed = true;
	const writing = h.todo({ op: "init", items: ["Plan of the old session"] });
	await running;
	const queued = h.todo({ op: "view" });
	await Bun.sleep(100);
	// /resume X while both still run.
	h.state.session = x;
	const resumed = h.todo({ op: "view" });
	await Bun.sleep(150);
	release();
	await writing;
	await queued;
	const view = await resumed;
	await Bun.sleep(300);
	expect(view.result).toContain("Plan of the resumed session");
	expect(snapshotOf(x).sessionId).toBe(x);
	expect(snapshotOf(x).plan.tasks.map((t: any) => t.content)).toEqual(["Plan of the resumed session"]);
	expect(snapshotOf(a).sessionId).toBe(a);
});

test("a write that lands after its session ended keeps the record ended, so it is pruned with the ended ones", async () => {
	const store = new Map<string, unknown>();
	let armed = false;
	let reached!: () => void;
	const running = new Promise<void>(resolve => (reached = resolve));
	let release!: () => void;
	const gate = new Promise<void>(resolve => (release = resolve));
	const h = host({
		store,
		hold: () => {
			if (!armed) return undefined;
			armed = false;
			reached();
			return gate;
		}
	});
	await h.start();
	const a = h.state.session;
	armed = true;
	const writing = h.todo({ op: "init", items: ["Plan the late write touches"] });
	await running;
	const queued = h.todo({ op: "view" });
	await Bun.sleep(100);
	// A new session replaces A while A's plan write still runs.
	h.state.session = crypto.randomUUID();
	const switching = h.todo({ op: "view" });
	await Bun.sleep(150);
	release();
	await Promise.all([writing, queued, switching]);
	await Bun.sleep(300);
	expect((store.get(`session/${a}`) as any)?.endedAt).toBeGreaterThan(0);
});
