import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertIsolated } from "./isolation";
import { isolatedKata, later, settle, until } from "./kata-fixture";
import { siblingThrottle } from "./kata-errors";
import { openCodeHost, type OpenCodeInstance } from "./opencode-host";
import opencode from "../plugins/opencode/kata";
import { TRANSCRIPT_ENV } from "../core/kata-cli";
assertIsolated();
const binary = process.env.KATA_TEST_EXECUTABLE!;
if (!binary || !path.isAbsolute(binary)) throw new Error("Set KATA_TEST_EXECUTABLE to the guarded Kata binary.");
const scratch = mkdtempSync(path.join(process.env.KATA_TEST_ROOT!, "opencode-"));
const cwd = path.join(scratch, "workspace");
mkdirSync(cwd);
const home = path.join(scratch, "home");
const env = { ...process.env, KATA_HOME: home, KATA_AUTHOR: "opencode-builder" };
for (const key of ["KATA_SERVER", "KATA_DAEMON", "KATA_AUTH_TOKEN", "KATA_REF", "KATA_TEAMMATE", "KATA_INBOX_USER", ...TRANSCRIPT_ENV]) delete env[key];
const run = isolatedKata(binary, env, cwd);
async function kata(args: string[]): Promise<any> {
	const out = await run(args, cwd);
	if (out.code) throw new Error(out.stderr);
	return JSON.parse(out.stdout);
}
const show = (ref: string) => kata(["show", ref, "--json"]);

// The adapter runs this wrapper as "kata": it records every call and can make `kata close` fail with the sibling throttle,
// as Kata does after a burst of closes. Everything else goes to the real binary.
const wrapper = path.join(scratch, "kata-wrapper.sh");
const calls = path.join(scratch, "calls.log"), throttle = path.join(scratch, "throttle"), slow = path.join(scratch, "slow");
writeFileSync(wrapper, `#!/bin/sh
echo "$@" >> "${calls}"
if [ -e "${slow}" ]; then sleep 0.5; fi
if [ "$1" = close ] && [ -e "${throttle}" ]; then
	printf '%s\\n' '${siblingThrottle().stderr.trim()}' >&2
	exit 1
fi
exec "${binary}" "$@"
`);
chmodSync(wrapper, 0o755);
const kataCalls = () => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean) : []);

const message = "Implemented the item and verified it with the isolated OpenCode adapter suite.";
const evidence = ["test:bun test opencode fixture"];
let sequence = 0;
const open: OpenCodeInstance[] = [];

async function start(options: Record<string, unknown> = {}) {
	const host = await openCodeHost({ plugin: opencode, directory: cwd, options: { executable: wrapper, author: "opencode-builder", ...options } });
	open.push(host);
	return host;
}
// A lead session in a fresh host.
async function lead(options: Record<string, unknown> = {}) {
	const host = await start(options);
	const session = host.createSession({ id: `oc-${++sequence}-${Date.now().toString(36)}` });
	return { host, id: session.id, session };
}
const todos = (...items: ([string, string] | Record<string, unknown>)[]) => ({
	todos: items.map(item => (Array.isArray(item) ? { content: item[0], status: item[1] } : item)),
});
const write = (host: OpenCodeInstance, id: string, input: unknown) => host.callTool(id, "todowrite", input);
const statusOf = (child: any) => (child.status === "closed" ? `closed:${child.closed_reason}` : child.metadata?.["todo.status"]);
async function parentOf(id: string): Promise<any> {
	const list = (await kata(["list", "--status", "all", "--meta", `opencode.session_id=${id}`, "--label", "opencode-session", "--json"])).issues;
	expect(list).toHaveLength(1);
	return list[0];
}
async function childrenOf(ref: string): Promise<any[]> {
	return [...(await show(ref)).children ?? []].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}
// The saved keys of a session in the fake host's storage.
const keysOf = (shared: OpenCodeInstance["shared"], id: string) => [...shared.kv.keys()].filter(key => key.includes(`/${id}/`));
const endedSession = (shared: OpenCodeInstance["shared"], id: string) => keysOf(shared, id).some(key => key.endsWith("/ended"));
async function closeEvents(): Promise<any[]> {
	const events: any[] = [];
	for (let after = 0; ;) {
		const page = await kata(["events", "--after", String(after), "--limit", "500", "--json"]);
		if (!page.events.length) return events.filter(e => e.type === "issue.closed");
		events.push(...page.events);
		after = page.next_after_id;
	}
}
const qref = (issue: any): string => issue.qualified_id ?? `pi-port-opencode#${issue.short_id}`;
const currentList = (text: string) => JSON.parse(text.slice(text.lastIndexOf('{"todos"'))).todos;

// The full suite runs every file in one process: put back exactly what this file changes in the environment.
const touched = ["KATA_HOME", "KATA_REF", "KATA_TEAMMATE", "KATA_INBOX_USER", "KATA_DEFAULT_PROJECT", ...TRANSCRIPT_ENV];
const previous = new Map(touched.map(key => [key, process.env[key]]));
const restore = (keys: readonly string[]) => {
	for (const key of keys) {
		const value = previous.get(key);
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
};
beforeAll(async () => {
	process.env.KATA_HOME = home;
	const out = await run(["init", "--project", "pi-port-opencode"]);
	if (out.code) throw new Error(out.stderr);
});
beforeEach(() => {
	rmSync(calls, { force: true });
	rmSync(throttle, { force: true });
	rmSync(slow, { force: true });
	for (const key of touched.slice(1)) delete process.env[key];
});
afterEach(() => restore(touched.slice(1)));
afterAll(async () => {
	await Promise.all(open.map(host => host.shutdown()));
	await run(["daemon", "stop"]);
	restore(touched);
});

test("setup registers todowrite once, with the list schema, and registers no other tool", async () => {
	const host = await start();
	expect(host.registrationErrors).toEqual([]);
	const tool = host.tool("todowrite");
	expect(tool.options).toEqual({ codemode: false });
	expect(tool.input.properties.todos.items.required).toEqual(["content", "status"]);
	expect(tool.description).toContain("WHOLE list");
	expect([...host.tools().keys()]).toEqual(["todowrite"]);
	// OpenCode replays the transform on every rebuild: the registry stays the same.
	await host.reload();
	expect([...host.tools().keys()]).toEqual(["todowrite"]);
});

test("the first todowrite creates the automatic parent and one pending task per item, and starts nothing", async () => {
	const { host, id } = await lead();
	const result = await write(host, id, todos(["Write the parser", "pending"], ["Test the parser", "pending"]));
	expect(result.status, result.text).toBe("completed");
	const parent = await parentOf(id);
	expect(parent.metadata["opencode.auto_parent"]).toBe(true);
	expect(parent.metadata["opencode.session_id"]).toBe(id);
	expect(parent.owner).toBe("opencode-builder");
	const children = await childrenOf(qref(parent));
	expect(children.map(c => [c.title, statusOf(c)])).toEqual([["Write the parser", "pending"], ["Test the parser", "pending"]]);
});

test("the context hook shows the plan in the system prompt once there is one", async () => {
	const { host, id } = await lead();
	expect((await host.context(id)).system).toEqual([]);
	await write(host, id, todos(["Show the plan", "pending"]));
	const { system } = await host.context(id);
	expect(system).toHaveLength(1);
	expect(system[0]).toContain("The todowrite tool is backed by Kata");
	expect(system[0]).toContain("Show the plan");
	expect(system[0]).toContain(qref(await parentOf(id)));
});

test("a later list starts, completes and cancels items; the closes carry the evidence and the opencode transcript pair", async () => {
	const { host, id } = await lead();
	await write(host, id, todos(["Build it", "pending"], ["Check it", "pending"], ["Skip it", "pending"]));
	const ref = qref(await parentOf(id));
	let result = await write(host, id, todos(["Build it", "in_progress"], ["Check it", "pending"], ["Skip it", "pending"]));
	expect(result.status, result.text).toBe("completed");
	expect((await childrenOf(ref)).map(statusOf)).toEqual(["in_progress", "pending", "pending"]);
	// Nothing starts on its own, and the list may have several items in progress.
	result = await write(host, id, todos(["Build it", "in_progress"], ["Check it", "in_progress"], ["Skip it", "pending"]));
	expect(result.status, result.text).toBe("completed");
	expect((await childrenOf(ref)).map(statusOf)).toEqual(["in_progress", "in_progress", "pending"]);
	result = await write(host, id, todos(
		{ content: "Build it", status: "completed", message, evidence },
		["Check it", "in_progress"],
		{ content: "Skip it", status: "cancelled", reason: "The parser already covers it, so this item is no longer needed." }));
	expect(result.status, result.text).toBe("completed");
	const [built, checked, skipped] = await childrenOf(ref);
	expect([built, checked, skipped].map(statusOf)).toEqual(["closed:done", "in_progress", "closed:wontfix"]);
	const closes = await closeEvents();
	const builtClose = closes.find(e => e.issue_uid === built.uid), skippedClose = closes.find(e => e.issue_uid === skipped.uid);
	expect(builtClose.payload.evidence).toEqual([{ type: "test", command: "bun test opencode fixture" }]);
	expect(builtClose.payload.transcript).toMatchObject({ agent: "opencode", session_id: id });
	expect(skippedClose.payload.reason).toBe("wontfix");
	// The closed items go back as they are (the model may drop the proof it sent): accepted.
	result = await write(host, id, todos(["Build it", "completed"], ["Check it", "in_progress"], ["Skip it", "cancelled"]));
	expect(result.status, result.text).toBe("completed");
	expect(process.env.KATA_TRANSCRIPT_SESSION_ID).toBeUndefined();
});

test("a blocker pauses an item and its removal resumes it; the list shows the blocked item as in_progress", async () => {
	const { host, id } = await lead();
	await write(host, id, todos(["Wait for the review", "in_progress"]));
	const ref = qref(await parentOf(id));
	let result = await write(host, id, todos({ content: "Wait for the review", status: "in_progress", blocker: "Waiting for the reviewer's answer" }));
	expect(result.status, result.text).toBe("completed");
	expect((await childrenOf(ref)).map(statusOf)).toEqual(["blocked"]);
	expect(result.output ?? result.text).toContain("blocked");
	result = await write(host, id, todos(["Wait for the review", "in_progress"]));
	expect(result.status, result.text).toBe("completed");
	expect((await childrenOf(ref)).map(statusOf)).toEqual(["in_progress"]);
});

test("a refused list leaves Kata unchanged and ends with the current list", async () => {
	const { host, id } = await lead();
	await write(host, id, todos(["Alpha item", "in_progress"], ["Beta item", "pending"], ["Gamma item", "pending"]));
	const parent = await parentOf(id), ref = qref(parent);
	await write(host, id, todos({ content: "Alpha item", status: "completed", message, evidence }, ["Beta item", "pending"], ["Gamma item", "pending"]));
	const snapshot = async () => JSON.stringify([(await show(ref)).issue.revision, (await childrenOf(ref)).map(c => [c.title, c.revision, statusOf(c)])]);
	const before = await snapshot();
	const current = [{ content: "Alpha item", status: "completed" }, { content: "Beta item", status: "pending" }, { content: "Gamma item", status: "pending" }];
	const cases: [string, unknown, string][] = [
		["an open item missing from the list", todos(["Alpha item", "completed"], ["Beta item", "pending"]), '"Gamma item" is missing from the list'],
		["a closed item sent with another status", todos(["Alpha item", "pending"], ["Beta item", "pending"], ["Gamma item", "pending"]), '"Alpha item" is already completed in Kata and cannot be sent as pending'],
		["a completion without evidence", todos(["Alpha item", "completed"], { content: "Beta item", status: "completed", message }, ["Gamma item", "pending"]), '"Beta item" cannot be completed without evidence'],
		["a completion without a message", todos(["Alpha item", "completed"], { content: "Beta item", status: "completed", evidence }, ["Gamma item", "pending"]), '"Beta item" cannot be completed without a message of 40+ characters'],
		["a cancellation without a reason", todos(["Alpha item", "completed"], ["Beta item", "cancelled"], ["Gamma item", "pending"]), '"Beta item" cannot be cancelled without a reason'],
		["a new item sent as cancelled", todos(["Alpha item", "completed"], ["Beta item", "pending"], ["Gamma item", "pending"], ["Delta item", "cancelled"]), '"Delta item" is new and cannot be cancelled'],
	];
	for (const [name, input, expected] of cases) {
		const result = await write(host, id, input);
		expect(result.status, name).toBe("error");
		expect(result.text, name).toContain("Refused: this list disagrees with the Kata plan. Nothing was changed.");
		expect(result.text, name).toContain(expected);
		expect(currentList(result.text), name).toEqual(current);
		expect(await snapshot(), name).toBe(before);
	}
	// A started item cannot go back to pending.
	await write(host, id, todos(["Alpha item", "completed"], ["Beta item", "in_progress"], ["Gamma item", "pending"]));
	const back = await write(host, id, todos(["Alpha item", "completed"], ["Beta item", "pending"], ["Gamma item", "pending"]));
	expect(back.status).toBe("error");
	expect(back.text).toContain('"Beta item" is in progress and cannot go back to pending');
	// A malformed list is an error too, not a crash.
	const malformed = await write(host, id, { todos: [{ content: "Only content" }] });
	expect(malformed.status).toBe("error");
	expect(malformed.text).toContain("status must be one of");
});

test("an item added to the plan outside the session must be sent back unchanged", async () => {
	const { host, id } = await lead();
	await write(host, id, todos(["Own item", "pending"]));
	const ref = qref(await parentOf(id));
	const created = await kata(["create", "--parent", ref, "--project", "pi-port-opencode", "--meta", "todo.phase=Tasks", "--meta", "todo.status=pending", "--force-new", "--json", "--", "Added by a teammate"]);
	expect(created.issue.short_id).toBeString();
	const refused = await write(host, id, todos(["Own item", "pending"]));
	expect(refused.status).toBe("error");
	expect(refused.text).toContain('"Added by a teammate" was added to the Kata plan outside this session and is requested work: send it back unchanged');
	const accepted = await write(host, id, { todos: currentList(refused.text) });
	expect(accepted.status, accepted.text).toBe("completed");
});

test("an op that fails after another succeeded ends with the current Kata list", async () => {
	const { host, id } = await lead();
	await write(host, id, todos(["Held item", "pending"]));
	const ref = qref(await parentOf(id));
	const [held] = await childrenOf(ref);
	// Another teammate holds the task: starting it is refused by the core, after the new item was appended.
	await kata(["meta", "set", qref(held), "teammate", "someone-else", "--json"]);
	const result = await write(host, id, todos(["Held item", "in_progress"], ["Fresh item", "pending"]));
	expect(result.status).toBe("error");
	expect(result.text).toContain("belongs to teammate someone-else");
	expect(currentList(result.text)).toEqual([{ content: "Held item", status: "pending" }, { content: "Fresh item", status: "pending" }]);
	expect((await childrenOf(ref)).map(c => c.title)).toEqual(["Held item", "Fresh item"]);
});

for (const type of ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]) {
	test(`${type} settles the lead's pending closes and leaves the automatic parent open`, async () => {
		const { host, id } = await lead();
		await write(host, id, todos(["Throttled item", "in_progress"]));
		const ref = qref(await parentOf(id));
		writeFileSync(throttle, "");
		const deferred = await write(host, id, todos({ content: "Throttled item", status: "completed", message, evidence }));
		expect(deferred.status, deferred.text).toBe("completed");
		expect(deferred.text).toContain("deferred");
		expect((await childrenOf(ref)).map(statusOf)).toEqual(["in_progress"]);
		rmSync(throttle);
		// A turn that ends before the retry is due changes nothing.
		await host.emit(type, { sessionID: id });
		expect((await childrenOf(ref)).map(statusOf)).toEqual(["in_progress"]);
		await later(() => host.emit(type, { sessionID: id }));
		expect((await childrenOf(ref)).map(statusOf)).toEqual(["closed:done"]);
		// Every child is closed with evidence, yet only the session's end closes the parent.
		expect((await show(ref)).issue.status).toBe("open");
	});
}

for (const type of ["session.deleted", "session.archived"]) {
	test(`${type} closes the automatic parent from its children's evidence and forgets the session`, async () => {
		const { host, id } = await lead();
		await write(host, id, todos(["Only item", "in_progress"]));
		const ref = qref(await parentOf(id));
		await write(host, id, todos({ content: "Only item", status: "completed", message, evidence }));
		await host.emit("session.execution.succeeded", { sessionID: id });
		expect((await show(ref)).issue.status).toBe("open");
		await host.emit(type, { sessionID: id });
		const parent = (await show(ref)).issue;
		expect(parent.status).toBe("closed");
		expect(parent.closed_reason).toBe("done");
		const close = (await closeEvents()).find(e => e.issue_uid === parent.uid);
		expect(close.payload.transcript).toMatchObject({ agent: "opencode", session_id: id });
		expect(keysOf(host.shared, id)).toEqual([]);
	});
}

test("session.deleted while a close is refused keeps the saved state, and the next setup finishes it and then forgets the session", async () => {
	const { host, id } = await lead();
	await write(host, id, todos(["Throttled item", "in_progress"]));
	const ref = qref(await parentOf(id));
	writeFileSync(throttle, "");
	const deferred = await write(host, id, todos({ content: "Throttled item", status: "completed", message, evidence }));
	expect(deferred.text).toContain("deferred");
	host.sessions.delete(id);
	await host.emit("session.deleted", { sessionID: id });
	// Nothing could be closed: the pending close and the session's end stay saved.
	expect((await childrenOf(ref)).map(statusOf)).toEqual(["in_progress"]);
	expect((await show(ref)).issue.status).toBe("open");
	const saved = () => keysOf(host.shared, id);
	expect(saved().some(key => key.endsWith("/entries"))).toBe(true);
	rmSync(throttle);
	// The retry is due when the next setup runs: it finishes the close, closes the parent, and forgets the session, in the background.
	let restarted!: OpenCodeInstance;
	await later(async () => {
		restarted = await host.restart();
		open.push(restarted);
		expect(await until(() => keysOf(restarted.shared, id).length === 0)).toBe(true);
	});
	expect((await childrenOf(ref)).map(statusOf)).toEqual(["closed:done"]);
	expect((await show(ref)).issue.status).toBe("closed");
});

test("a lead that dropped every item leaves its automatic parent open on purpose, and its end forgets the session", async () => {
	const { host, id } = await lead();
	await write(host, id, todos(["Only item", "in_progress"]));
	const ref = qref(await parentOf(id));
	const reason = "The parser already covers it, so this item is no longer needed.";
	const dropped = await write(host, id, todos({ content: "Only item", status: "cancelled", reason }));
	expect(dropped.status, dropped.text).toBe("completed");
	host.sessions.delete(id);
	await host.emit("session.deleted", { sessionID: id });
	// Every child is wontfix: the core flags the parent for a person instead of closing it, which is not work left.
	const parent = (await show(ref)).issue;
	expect(parent.status).toBe("open");
	expect(parent.labels).toContain("needs-review");
	expect(keysOf(host.shared, id)).toEqual([]);
	// Nothing is left to end at the next setup.
	rmSync(calls, { force: true });
	const restarted = await host.restart();
	open.push(restarted);
	await settle(300);
	expect(kataCalls()).toEqual([]);
});

test("setup returns before a saved ended session's Kata work is done, and the work finishes in the background", async () => {
	const { host, id } = await lead();
	await write(host, id, todos(["Throttled item", "in_progress"]));
	const ref = qref(await parentOf(id));
	writeFileSync(throttle, "");
	await write(host, id, todos({ content: "Throttled item", status: "completed", message, evidence }));
	host.sessions.delete(id);
	await host.emit("session.deleted", { sessionID: id });
	expect((await show(ref)).issue.status).toBe("open");
	rmSync(throttle);
	// The old instance's own cleanup is not what is measured.
	await host.shutdown();
	writeFileSync(slow, "");
	let restarted!: OpenCodeInstance;
	try {
		await later(async () => {
			const started = performance.now();
			restarted = await host.restart();
			open.push(restarted);
			// Every Kata call takes half a second: ending the session takes many of them.
			expect(performance.now() - started).toBeLessThan(2000);
			expect((await show(ref)).issue.status).toBe("open");
			expect(await until(() => keysOf(restarted.shared, id).length === 0, 60_000)).toBe(true);
		});
	} finally { rmSync(slow, { force: true }); }
	expect((await childrenOf(ref)).map(statusOf)).toEqual(["closed:done"]);
	expect((await show(ref)).issue.status).toBe("closed");
}, 90_000);

// An archive whose close Kata refused leaves an ended session; the user then keeps working in it.
for (const [how, resumed] of [
	["`session.unarchived`", async (host: OpenCodeInstance, id: string) => { host.sessions.get(id)!.archived = undefined; await host.emit("session.unarchived", { sessionID: id }); }],
	["a context hook", async (host: OpenCodeInstance, id: string) => { await host.context(id); }],
	["nothing the plugin saw, but OpenCode no longer reports it archived", async (host: OpenCodeInstance, id: string) => { host.sessions.get(id)!.archived = undefined; }],
] as const) {
	test(`an archived session that is back (${how}) is not ended by the next setup`, async () => {
		const { host, id, session } = await lead();
		await write(host, id, todos(["Throttled item", "in_progress"], ["Running item", "pending"]));
		const ref = qref(await parentOf(id));
		writeFileSync(throttle, "");
		await write(host, id, todos({ content: "Throttled item", status: "completed", message, evidence }, ["Running item", "in_progress"]));
		session.archived = Date.now();
		await host.emit("session.archived", { sessionID: id });
		expect(endedSession(host.shared, id)).toBe(true);
		await resumed(host, id);
		rmSync(throttle);
		let restarted!: OpenCodeInstance;
		await later(async () => {
			restarted = await host.restart();
			open.push(restarted);
			expect(await until(() => !endedSession(restarted.shared, id))).toBe(true);
			// The resumed lead finishes its refused close, and ends nothing: a short wait for what a wrong ending would do.
			for (let wait = 0; wait < 100 && statusOf((await childrenOf(ref))[0]) !== "closed:done"; wait++) await settle(100);
			await settle(1500);
			expect((await show(ref)).issue.status).toBe("open");
		});
		expect((await show(ref)).issue.status).toBe("open");
		const [first, second] = await childrenOf(ref);
		expect([first, second].map(statusOf)).toEqual(["closed:done", "in_progress"]);
		expect(second.metadata["todo.session"]).toBe(id);
		expect(keysOf(restarted.shared, id).some(key => key.endsWith("/entries"))).toBe(true);
		expect((await restarted.context(id)).system[0]).toContain("Running item");
	});
}

// A delegate's tool call says nothing of its lead: it must not clear the ended session a lead was saved as.
for (const [type, end] of [
	["session.archived", (host: OpenCodeInstance, id: string) => { host.sessions.get(id)!.archived = Date.now(); }],
	["session.deleted", (host: OpenCodeInstance, id: string) => { host.sessions.delete(id); }],
] as const) {
	test(`${type} while a delegate still runs stays an ended session through the delegate's tool calls, and the next setup ends the session`, async () => {
		const { host, id } = await lead();
		await write(host, id, todos(["Throttled item", "in_progress"]));
		const ref = qref(await parentOf(id));
		const child = host.createSession({ parentID: id });
		writeFileSync(throttle, "");
		await write(host, id, todos({ content: "Throttled item", status: "completed", message, evidence }));
		end(host, id);
		await host.emit(type, { sessionID: id });
		expect(endedSession(host.shared, id)).toBe(true);
		await host.callTool(child.id, "shell", { command: "ls" }, { execute: () => "ok" });
		expect(endedSession(host.shared, id)).toBe(true);
		rmSync(throttle);
		let restarted!: OpenCodeInstance;
		await later(async () => {
			restarted = await host.restart();
			open.push(restarted);
			expect(await until(() => keysOf(restarted.shared, id).length === 0)).toBe(true);
		});
		expect((await childrenOf(ref)).map(statusOf)).toEqual(["closed:done"]);
		expect((await show(ref)).issue.status).toBe("closed");
	});
}

test("cleanup drains what fits but never closes the parent or releases the lead's tasks", async () => {
	const { host, id } = await lead();
	await write(host, id, todos(["Finished item", "in_progress"], ["Running item", "pending"]));
	const ref = qref(await parentOf(id));
	await write(host, id, todos({ content: "Finished item", status: "completed", message, evidence }, ["Running item", "in_progress"]));
	let [, running] = await childrenOf(ref);
	expect(running.metadata["todo.session"]).toBe(id);
	await host.shutdown();
	expect((await show(ref)).issue.status).toBe("open");
	[, running] = await childrenOf(ref);
	expect(running.metadata["todo.session"]).toBe(id);
	expect(statusOf(running)).toBe("in_progress");
	expect(keysOf(host.shared, id).some(key => key.endsWith("/entries"))).toBe(true);
});

test("a restart resumes the session's plan and its saved pending closes", async () => {
	const { host, id } = await lead();
	await write(host, id, todos(["Resumed item", "in_progress"], ["Later item", "pending"]));
	const ref = qref(await parentOf(id));
	writeFileSync(throttle, "");
	await write(host, id, todos({ content: "Resumed item", status: "completed", message, evidence }, ["Later item", "pending"]));
	expect((await childrenOf(ref)).map(statusOf)).toEqual(["in_progress", "pending"]);
	const restarted = await host.restart();
	open.push(restarted);
	rmSync(throttle);
	// The saved close is due and the lead's turn ends: the new instance finishes it.
	await later(() => restarted.emit("session.execution.succeeded", { sessionID: id }));
	expect((await childrenOf(ref)).map(statusOf)).toEqual(["closed:done", "pending"]);
	// The plan resumes: the accepted contents survived, so a missing item is the model's omission.
	const refused = await write(restarted, id, todos(["Resumed item", "completed"]));
	expect(refused.status).toBe("error");
	expect(refused.text).toContain('"Later item" is missing from the list: keep it, or mark it cancelled with a reason');
	const accepted = await write(restarted, id, todos(["Resumed item", "completed"], ["Later item", "in_progress"]));
	expect(accepted.status, accepted.text).toBe("completed");
	expect((await childrenOf(ref)).map(statusOf)).toEqual(["closed:done", "in_progress"]);
	expect((await restarted.context(id)).system[0]).toContain("Later item");
});

test("sessions of one location keep separate plans, and a delegate's child session is left alone", async () => {
	const { host, id } = await lead();
	const other = host.createSession({ id: `oc-other-${Date.now().toString(36)}` });
	await write(host, id, todos(["First lead item", "pending"]));
	await write(host, other.id, todos(["Second lead item", "pending"]));
	expect(qref(await parentOf(id))).not.toBe(qref(await parentOf(other.id)));
	expect((await childrenOf(qref(await parentOf(id)))).map(c => c.title)).toEqual(["First lead item"]);

	const child = host.createSession({ parentID: id });
	expect((await host.context(child.id)).system).toEqual([]);
	const refused = await write(host, child.id, todos(["Child item", "pending"]));
	expect(refused.status).toBe("error");
	expect(refused.text).toContain("todowrite is for the lead session");
	await host.emit("session.execution.succeeded", { sessionID: child.id });
	await host.emit("session.deleted", { sessionID: child.id });
	expect((await kata(["list", "--status", "all", "--meta", `opencode.session_id=${child.id}`, "--limit", "5", "--json"])).issues).toEqual([]);
	// The lead is untouched by its child's end.
	expect((await show(qref(await parentOf(id)))).issue.status).toBe("open");
});

test("settings come from plugin options first, then the server's environment", async () => {
	const ticket = async (title: string) => {
		const created = await kata(["create", title, "--body", "A ticket a session plans under.", "--project", "pi-port-opencode", "--force-new", "--json"]);
		return `pi-port-opencode#${created.issue.short_id}`;
	};
	// plugin option
	const optionRef = await ticket("Ticket named by an option");
	const withOption = await lead({ ref: optionRef });
	let result = await write(withOption.host, withOption.id, todos(["Planned under the option ref", "pending"]));
	expect(result.status, result.text).toBe("completed");
	expect((await childrenOf(optionRef)).map(c => c.title)).toEqual(["Planned under the option ref"]);
	// environment of the server
	const envRef = await ticket("Ticket named by the environment");
	process.env.KATA_REF = envRef;
	const withEnv = await lead();
	result = await write(withEnv.host, withEnv.id, todos(["Planned under the env ref", "pending"]));
	expect(result.status, result.text).toBe("completed");
	expect((await childrenOf(envRef)).map(c => c.title)).toEqual(["Planned under the env ref"]);
	// the option wins over the environment
	const winnerRef = await ticket("Ticket named by an option next to an environment ref");
	const winner = await lead({ ref: winnerRef });
	result = await write(winner.host, winner.id, todos(["Planned under the option ref, not the env one", "pending"]));
	expect(result.status, result.text).toBe("completed");
	expect((await childrenOf(winnerRef)).map(c => c.title)).toEqual(["Planned under the option ref, not the env one"]);
	expect((await childrenOf(envRef)).map(c => c.title)).toEqual(["Planned under the env ref"]);
	delete process.env.KATA_REF;
	// the first todowrite names the ticket itself
	const listRef = await ticket("Ticket named by the first list");
	const named = await lead();
	result = await write(named.host, named.id, { ...todos(["Planned under the list ref", "pending"]), ref: listRef });
	expect(result.status, result.text).toBe("completed");
	expect((await childrenOf(listRef)).map(c => c.title)).toEqual(["Planned under the list ref"]);
});

test("an item appended before a later op failed is still the session's own: leaving it out offers cancelling", async () => {
	const { host, id } = await lead();
	await write(host, id, todos(["Held item", "pending"]));
	const ref = qref(await parentOf(id));
	const [held] = await childrenOf(ref);
	await kata(["meta", "set", qref(held), "teammate", "someone-else", "--json"]);
	const failed = await write(host, id, todos(["Held item", "in_progress"], ["Appended item", "pending"]));
	expect(failed.status).toBe("error");
	const refused = await write(host, id, todos(["Held item", "pending"]));
	expect(refused.status).toBe("error");
	expect(refused.text).toContain(`"Appended item" is missing from the list: keep it, or mark it cancelled with a reason`);
	expect(refused.text).not.toContain("outside this session");
});
