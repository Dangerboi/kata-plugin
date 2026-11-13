import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertIsolated } from "./isolation";
import { isolatedKata, until } from "./kata-fixture";
import { openCodeHost, userMessage, type FakeSession, type OpenCodeInstance } from "./opencode-host";
import opencode from "../plugins/opencode/kata";
import { TRANSCRIPT_ENV } from "../core/kata-cli";
assertIsolated();
const binary = process.env.KATA_TEST_EXECUTABLE!;
if (!binary || !path.isAbsolute(binary)) throw new Error("Set KATA_TEST_EXECUTABLE to the guarded Kata binary.");
const scratch = mkdtempSync(path.join(process.env.KATA_TEST_ROOT!, "opencode-delegates-"));
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

// The adapter can run this wrapper as "kata": it records every call and, while `slow` exists, holds each `notify` for a moment,
// so a settle is still running when the next event arrives. Everything goes to the real binary.
const wrapper = path.join(scratch, "kata-wrapper.sh");
const calls = path.join(scratch, "calls.log"), slow = path.join(scratch, "slow");
writeFileSync(wrapper, `#!/bin/sh
echo "$@" >> "${calls}"
if [ "$1" = notify ] && [ -e "${slow}" ]; then sleep 1; fi
exec "${binary}" "$@"
`);
chmodSync(wrapper, 0o755);
const kataCalls = () => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean) : []);

const evidence = ["test:bun test opencode delegates"];
const message = "Implemented the item and verified it with the isolated OpenCode delegate suite.";
const PREAMBLE = "You are a subagent spawned by another session.\n";
let sequence = 0;
const open: OpenCodeInstance[] = [];

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
beforeEach(() => { for (const key of touched.slice(1)) delete process.env[key]; });
afterEach(() => restore(touched.slice(1)));
afterAll(async () => {
	await Promise.all(open.map(host => host.shutdown()));
	await run(["daemon", "stop"]);
	restore(touched);
});

async function lead(executable = binary, options: Record<string, unknown> = {}) {
	const host = await openCodeHost({ plugin: opencode, directory: cwd, options: { executable, author: "opencode-builder", ...options } });
	open.push(host);
	return { host, id: host.createSession({ id: `oc-del-${++sequence}-${Date.now().toString(36)}` }).id };
}
const todos = (...items: ([string, string] | Record<string, unknown>)[]) => ({ todos: items.map(item => (Array.isArray(item) ? { content: item[0], status: item[1] } : item)) });
const write = (host: OpenCodeInstance, id: string, input: unknown) => host.callTool(id, "todowrite", input);
const qref = (issue: any): string => issue.qualified_id ?? `pi-port-opencode#${issue.short_id}`;
const statusOf = (child: any) => (child.status === "closed" ? `closed:${child.closed_reason}` : child.metadata?.["todo.status"]);
// The lead's automatic parent and its items, in creation order.
async function parentOf(id: string): Promise<any> {
	const list = (await kata(["list", "--status", "all", "--meta", `opencode.session_id=${id}`, "--label", "opencode-session", "--json"])).issues;
	expect(list).toHaveLength(1);
	return list[0];
}
async function itemsOf(id: string): Promise<any[]> {
	return [...(await show(qref(await parentOf(id)))).children ?? []].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}
async function item(id: string, title: string): Promise<any> {
	const found = (await itemsOf(id)).find(child => child.title === title);
	expect(found, title).toBeDefined();
	return (await show(qref(found))).issue;
}
// The assignment section a delegate's prompt carries (see delegateContext in the core).
const refIn = (system: string) => /Your Kata issue is (\S+?);/.exec(system)?.[1] ?? "";
const teammateIn = (system: string) => /your teammate is ([a-z0-9._-]+?)\. Keep/.exec(system)?.[1] ?? "";
// What the child's `kata close` does once the shell module routes it: the close runs under the delegate's teammate.
async function closeAs(system: string) {
	const out = await run(["close", refIn(system), "--teammate", teammateIn(system), "--done", "--message", message, "--test", "bun test opencode delegates"], cwd);
	if (out.code) throw new Error(out.stderr);
}

type Work = (child: FakeSession, system: string) => Promise<string>;
interface SpawnInput { prompt: string; description?: string; background?: boolean; sessionID?: string }
// One `subagent` call as OpenCode runs it: the child session exists before its first context hook; a foreground call runs the
// child to its reply inside the call; a background call returns at once and the test drives the child afterwards (`finish`).
async function spawn(host: OpenCodeInstance, leadID: string, input: SpawnInput, work?: Work, hold?: Promise<void>) {
	let child: FakeSession | undefined;
	const result = await host.callTool(leadID, "subagent", { agent: "general", description: "Work item", ...input }, {
		execute: async given => {
			await hold;
			if (given.sessionID) {
				child = host.sessions.get(given.sessionID)!;
				host.addMessage(child.id, userMessage(given.prompt));
			} else child = host.createSession({ parentID: leadID, title: given.description, messages: [userMessage(PREAMBLE + given.prompt)] });
			if (given.background) return { output: { sessionID: child.id, status: "running", output: "The subagent is working in the background." }, content: "The subagent is working in the background.", metadata: { sessionID: child.id, status: "running" } };
			const report = await work!(child, (await host.context(child.id)).system.join("\n"));
			host.addAssistantText(child.id, report);
			return { output: { sessionID: child.id, status: "completed", output: report }, content: `<subagent sessionID="${child.id}" state="completed">\n${report}\n</subagent>`, metadata: { sessionID: child.id, status: "completed" } };
		},
	});
	return { result, child: child! };
}
// A background child's run: its first context hook, its work, its last assistant text, then the end event.
async function finish(host: OpenCodeInstance, child: FakeSession, work: Work, event = "session.execution.succeeded") {
	const report = await work(child, (await host.context(child.id)).system.join("\n"));
	host.addAssistantText(child.id, report);
	await host.emit(event, { sessionID: child.id });
}
// Any tool call of the child: after one, an exit without a close is handed back to the lead instead of rolled back.
const useTool = (host: OpenCodeInstance, child: FakeSession) => host.callTool(child.id, "shell", { command: "ls" }, { execute: () => "ok" });
const turnEnd = (host: OpenCodeInstance, leadID: string) => host.emit("session.execution.succeeded", { sessionID: leadID });
const labelsOf = async (issue: any): Promise<string[]> => ((await show(qref(issue))).labels ?? []).map((label: any) => label.label);
const commentsOf = async (ref: string): Promise<string[]> => ((await show(ref)).comments ?? []).map((comment: any) => comment.body);

test("a foreground spawn is bound to its plan item before the child's first model call, and its own close shows in the lead's next list", async () => {
	const { host, id } = await lead();
	await write(host, id, todos(["Implement parser module", "in_progress"], ["Document the parser output", "pending"]));
	const seen: any = {};
	const { result, child } = await spawn(host, id, { prompt: "Please implement parser module, then verify it.", description: "Parser work" }, async (_child, system) => {
		const ref = refIn(system), teammate = teammateIn(system);
		const issue = (await show(ref)).issue;
		seen.system = system;
		seen.meta = issue.metadata;
		expect(issue.title).toBe("Implement parser module");
		expect(teammate).toMatch(/^[a-z0-9._-]+$/);
		await closeAs(system);
		return "The parser module is implemented and verified.";
	});
	expect(result.status, result.text).toBe("completed");
	expect(seen.system).toContain("You are subagent Parser work.");
	expect(seen.meta["opencode.subagent_id"]).toBe(child.id);
	expect(seen.meta["opencode.session_id"]).toBe(id);
	expect(seen.meta.teammate).toBe(teammateIn(seen.system));
	expect(seen.meta["todo.status"]).toBe("in_progress");
	// The child closed its own issue: Kata has it closed and the delegate keys are gone, no report comment was needed.
	const closed = await item(id, "Implement parser module");
	expect(statusOf(closed)).toBe("closed:done");
	expect(closed.metadata["opencode.subagent_id"]).toBeUndefined();
	// The lead's list shows it completed and the other item untouched.
	const list = await write(host, id, todos(["Implement parser module", "completed"], ["Document the parser output", "pending"]));
	expect(list.status, list.text).toBe("completed");
	expect((await item(id, "Document the parser output")).metadata["todo.status"]).toBe("pending");
});

test("a background spawn binds at the child's first context hook, and its last assistant text is its report when it exits without closing", async () => {
	const { host, id } = await lead();
	await write(host, id, todos(["Implement parser module", "pending"]));
	const { result, child } = await spawn(host, id, { prompt: "Implement parser module in the background.", background: true });
	expect(result.status, result.text).toBe("completed");
	// The call has returned, the child has not run: nothing is assigned yet.
	expect((await item(id, "Implement parser module")).metadata["opencode.subagent_id"]).toBeUndefined();
	let system = "";
	await finish(host, child, async (_child, text) => {
		system = text;
		await useTool(host, child);
		expect((await show(refIn(text))).issue.metadata["opencode.subagent_id"]).toBe(child.id);
		return "Half done: the parser module compiles, the tests are not written.";
	});
	// The exit settles at once: the open issue goes back to the lead, and the lead's turn end finds nothing left to do.
	await turnEnd(host, id);
	const handed = await item(id, "Implement parser module");
	expect(handed.status).toBe("open");
	expect(handed.metadata["opencode.subagent_id"]).toBeUndefined();
	expect(handed.metadata.teammate).toBeUndefined();
	expect(handed.metadata["todo.status"]).toBe("pending");
	expect(await labelsOf(handed)).toContain("needs-review");
	const comments = (await commentsOf(refIn(system))).join("\n");
	expect(comments).toContain("Half done: the parser module compiles");
	expect(comments).toContain("completed without closing its Kata issue");
});

test("two parallel spawns work distinct items", async () => {
	const { host, id } = await lead();
	await write(host, id, todos(["Implement parser module", "pending"], ["Write the changelog entry", "pending"]));
	let release!: () => void;
	const hold = new Promise<void>(resolve => (release = resolve));
	const systems: string[] = [];
	const work: Work = async (_child, system) => { systems.push(system); await closeAs(system); return "Done and verified."; };
	const first = spawn(host, id, { prompt: "Implement parser module and verify it.", description: "Parser" }, work, hold);
	const second = spawn(host, id, { prompt: "Write the changelog entry for the release.", description: "Changelog" }, work, hold);
	// Both calls passed execute.before (and the plan check) before either child exists.
	await until(() => host.calls.filter(call => call.tool === "subagent").length === 2);
	release();
	const results = await Promise.all([first, second]);
	for (const { result } of results) expect(result.status, result.text).toBe("completed");
	expect(new Set(systems.map(refIn)).size).toBe(2);
	expect(new Set(systems.map(teammateIn)).size).toBe(2);
	expect(statusOf(await item(id, "Implement parser module"))).toBe("closed:done");
	expect(statusOf(await item(id, "Write the changelog entry"))).toBe("closed:done");
});

test("a second spawn naming an item that another spawn holds is refused, before and after the first child started", async () => {
	const { host, id } = await lead();
	await write(host, id, todos(["Implement parser module", "pending"], ["Write the changelog entry", "pending"]));
	let release!: () => void;
	const hold = new Promise<void>(resolve => (release = resolve));
	const first = spawn(host, id, { prompt: "Implement parser module please." }, async (_child, system) => { await closeAs(system); return "Done."; }, hold);
	await until(() => host.calls.some(call => call.tool === "subagent"));
	// The first call is still pending (no child yet): its item is reserved.
	const pending = await spawn(host, id, { prompt: "Also implement parser module, quickly." }, async () => "never");
	expect(pending.result.status).toBe("error");
	expect(pending.result.executed).toBe(false);
	expect(pending.result.text).toContain("already delegated");
	expect(pending.child).toBeUndefined();
	release();
	expect((await first).result.status).toBe("completed");

	// A running delegate holds its item too.
	await write(host, id, todos(["Implement parser module", "completed"], ["Write the changelog entry", "pending"]));
	const background = await spawn(host, id, { prompt: "Write the changelog entry for the release.", background: true });
	await host.context(background.child.id);
	const again = await spawn(host, id, { prompt: "Write the changelog entry once more." }, async () => "never");
	expect(again.result.status).toBe("error");
	expect(again.result.text).toContain("already delegated");
	await finish(host, background.child, async () => "Nothing done.", "session.execution.interrupted");
	await turnEnd(host, id);
});

test("a spawn the rules refuse never runs and leaves Kata unchanged", async () => {
	const { host, id } = await lead();
	await write(host, id, todos(["Implement parser module", "pending"], ["Write the changelog entry", "pending"]));
	const before = JSON.stringify((await itemsOf(id)).map(child => [child.title, child.revision]));
	const { result, child } = await spawn(host, id, { prompt: "Implement parser module and Write the changelog entry together." }, async () => "never");
	expect(result.status).toBe("error");
	expect(result.executed).toBe(false);
	expect(result.text).toContain("names more than one ticket or plan item");
	expect(child).toBeUndefined();
	expect(JSON.stringify((await itemsOf(id)).map(c => [c.title, c.revision]))).toBe(before);
});

test("a spawn naming an item another lead session holds is refused in todowrite's words", async () => {
	const created = await kata(["create", "Ticket two leads delegate under", "--body", "Shared by two sessions.", "--project", "pi-port-opencode", "--force-new", "--json"]);
	const ticket = `pi-port-opencode#${created.issue.short_id}`;
	const a = await lead(binary, { ref: ticket });
	await write(a.host, a.id, todos(["Shared parser item", "in_progress"]));
	const b = await lead(binary, { ref: ticket });
	const { result, child } = await spawn(b.host, b.id, { prompt: "Work on Shared parser item." }, async () => "never");
	expect(result.status).toBe("error");
	expect(result.executed).toBe(false);
	expect(child).toBeUndefined();
	expect(result.text).toContain("take it over first (send the list with takeover: true)");
	expect(result.text).not.toMatch(/todo op=|todo start|repeat the call/);
});

test("a follow-up to a delegate whose issue is open resumes tracking on the same issue", async () => {
	const { host, id } = await lead();
	await write(host, id, todos(["Implement parser module", "pending"]));
	const first = await spawn(host, id, { prompt: "Implement parser module first part.", description: "Parser" }, async child => {
		await useTool(host, child);
		return "Only the first part is done.";
	});
	expect(first.result.status, first.result.text).toBe("completed");
	// Exited without closing: handed back to the lead at once (a foreground call settles with its result).
	let issue = await item(id, "Implement parser module");
	expect(issue.metadata["opencode.subagent_id"]).toBeUndefined();
	expect(await labelsOf(issue)).toContain("needs-review");
	const ref = qref(issue);
	const before = (await itemsOf(id)).length;

	let teammate = "";
	const second = await spawn(host, id, { prompt: "Now finish the rest.", sessionID: first.child.id }, async (_child, system) => {
		teammate = teammateIn(system);
		expect(refIn(system)).toBe(ref);
		const resumed = (await show(ref)).issue;
		expect(resumed.metadata["opencode.subagent_id"]).toBe(first.child.id);
		expect(resumed.metadata.teammate).toBe(teammate);
		await closeAs(system);
		return "The rest is done and verified.";
	});
	expect(second.result.status, second.result.text).toBe("completed");
	expect(second.child.id).toBe(first.child.id);
	issue = await item(id, "Implement parser module");
	expect(statusOf(issue)).toBe("closed:done");
	expect(issue.metadata["opencode.subagent_id"]).toBeUndefined();
	expect((await itemsOf(id)).length).toBe(before);
	expect(teammate).not.toBe("");
});

test("a follow-up to a delegate whose issue is closed comments its report and never reopens it, also after a restart", async () => {
	const { host, id } = await lead();
	await write(host, id, todos(["Implement parser module", "pending"]));
	const first = await spawn(host, id, { prompt: "Implement parser module fully." }, async (_child, system) => { await closeAs(system); return "Done and closed."; });
	expect(first.result.status, first.result.text).toBe("completed");
	const ref = qref(await item(id, "Implement parser module"));
	const before = (await itemsOf(id)).length;

	const second = await spawn(host, id, { prompt: "Add one more note.", sessionID: first.child.id }, async (_child, system) => {
		// The issue is closed: the delegate is not told to work it, and a close of it would fail.
		expect(refIn(system)).toBe(ref);
		return "The extra note: the parser also handles empty input.";
	});
	expect(second.result.status, second.result.text).toBe("completed");
	let issue = (await show(ref)).issue;
	expect(statusOf(issue)).toBe("closed:done");
	expect((await commentsOf(ref)).join("\n")).toContain("The extra note: the parser also handles empty input.");
	expect((await itemsOf(id)).length).toBe(before);

	// The record of a settled delegate survives a restart.
	const restarted = await host.restart();
	open.push(restarted);
	const third = await spawn(restarted, id, { prompt: "One last remark.", sessionID: first.child.id }, async () => "Last remark: nothing else to add.");
	expect(third.result.status, third.result.text).toBe("completed");
	issue = (await show(ref)).issue;
	expect(statusOf(issue)).toBe("closed:done");
	expect((await commentsOf(ref)).join("\n")).toContain("Last remark: nothing else to add.");
	expect((await itemsOf(id)).length).toBe(before);
});

test("a restart hands back an unfinished delegate that ran tools and rolls back one that did nothing", async () => {
	const { host, id } = await lead();
	await write(host, id, todos(["Implement parser module", "pending"], ["Write the changelog entry", "pending"]));
	const worked = await spawn(host, id, { prompt: "Implement parser module in the background.", background: true });
	const idle = await spawn(host, id, { prompt: "Write the changelog entry in the background.", background: true });
	const systems = new Map<string, string>();
	for (const { child } of [worked, idle]) systems.set(child.id, (await host.context(child.id)).system.join("\n"));
	// One delegate ran a tool, the other none; the server restarts before either ended.
	expect((await useTool(host, worked.child)).status).toBe("completed");
	const workedRef = refIn(systems.get(worked.child.id)!), idleRef = refIn(systems.get(idle.child.id)!);
	expect((await show(workedRef)).issue.metadata["opencode.subagent_id"]).toBe(worked.child.id);
	expect((await show(idleRef)).issue.metadata["opencode.subagent_id"]).toBe(idle.child.id);
	const entries = await host.ctx.storage.get(`session/${id}/entries`);
	expect(JSON.stringify(entries)).toContain(worked.child.id);

	const restarted = await host.restart();
	open.push(restarted);
	// The restored delegates settle in the background; the lead's turn end waits for them.
	await turnEnd(restarted, id);
	const handed = (await show(workedRef)).issue, rolled = (await show(idleRef)).issue;
	expect(handed.status).toBe("open");
	expect(handed.metadata["opencode.subagent_id"]).toBeUndefined();
	expect(await labelsOf(handed)).toContain("needs-review");
	expect(handed.metadata["todo.status"]).toBe("pending");
	expect(rolled.status).toBe("open");
	expect(rolled.metadata["opencode.subagent_id"]).toBeUndefined();
	expect(rolled.metadata.teammate).toBeUndefined();
	expect(rolled.metadata["todo.status"]).toBe("pending");
	expect(await labelsOf(rolled)).not.toContain("needs-review");
	// The lead resumed and can still plan.
	const list = await write(restarted, id, todos(["Implement parser module", "pending"], ["Write the changelog entry", "pending"]));
	expect(list.status, list.text).toBe("completed");
});

test("a bound delegate plans under its own issue through its own core; an untracked delegate's todowrite is refused", async () => {
	const { host, id } = await lead();
	await write(host, id, todos(["Implement parser module", "pending"]));
	let planText = "";
	const bound = await spawn(host, id, { prompt: "Implement parser module step by step." }, async (child, system) => {
		const steps = todos(["Parse the header", "pending"], ["Parse the body", "pending"]);
		const written = await write(host, child.id, steps);
		expect(written.status, written.text).toBe("completed");
		planText = written.text;
		const subtasks = ((await show(refIn(system))).children ?? []).map((c: any) => c.title).sort();
		expect(subtasks).toEqual(["Parse the body", "Parse the header"]);
		// Kata refuses to close an issue that has open children: the delegate completes its steps first.
		const done = await write(host, child.id, todos({ content: "Parse the header", status: "completed", message, evidence }, { content: "Parse the body", status: "completed", message, evidence }));
		expect(done.status, done.text).toBe("completed");
		await closeAs(system);
		return "Both steps done.";
	});
	expect(bound.result.status, bound.result.text).toBe("completed");
	expect(planText).toContain("Parse the header");
	// The lead's plan is its own: the delegate's steps are not its items, and it is still the one lead.
	expect((await itemsOf(id)).map(c => c.title)).toEqual(["Implement parser module"]);
	const list = await write(host, id, todos(["Implement parser module", "completed"]));
	expect(list.status, list.text).toBe("completed");

	const untracked = await spawn(host, id, { prompt: "Summarize the weather forecast for tomorrow." }, async (child, system) => {
		expect(system).toContain("you have no Kata issue");
		const refused = await write(host, child.id, todos(["Anything", "pending"]));
		expect(refused.status).toBe("error");
		expect(refused.text).toContain("no Kata issue");
		return "Sunny.";
	});
	expect(untracked.result.status, untracked.result.text).toBe("completed");
	expect((await itemsOf(id)).map(c => c.title)).toEqual(["Implement parser module"]);
});

// A background delegate up to its first tool use, bound to its item and not yet ended.
async function running(host: OpenCodeInstance, leadID: string, prompt: string) {
	const { child } = await spawn(host, leadID, { prompt, background: true });
	const system = (await host.context(child.id)).system.join("\n");
	await useTool(host, child);
	host.addAssistantText(child.id, "Stopped before closing.");
	return { child, system, ref: refIn(system) };
}

test("a delegate's todowrite while another delegate exits hands the other's issue back once, under the lead's teammate", async () => {
	const { host, id } = await lead(wrapper);
	await write(host, id, todos(["Implement parser module", "pending"], ["Write the changelog entry", "pending"]));
	const a = await running(host, id, "Implement parser module in the background.");
	const b = await running(host, id, "Write the changelog entry in the background.");
	// A's exit settle is held in its notify while B plans through its own core.
	writeFileSync(slow, "");
	const exit = host.emit("session.execution.succeeded", { sessionID: a.child.id });
	const planned = await write(host, b.child.id, todos(["Write the header", "pending"]));
	await exit;
	await turnEnd(host, id);
	rmSync(slow);
	expect(planned.status, planned.text).toBe("completed");
	expect(kataCalls().filter(call => call.startsWith("notify") && call.includes(a.ref.split("#")[1]))).toHaveLength(1);
	expect(kataCalls().filter(call => call.includes(teammateIn(b.system)) && call.includes(a.ref.split("#")[1]))).toEqual([]);
	const handed = (await show(a.ref)).issue;
	expect(handed.status).toBe("open");
	expect(handed.metadata["opencode.subagent_id"]).toBeUndefined();
	expect(handed.metadata.teammate).toBeUndefined();
	expect(await labelsOf(handed)).toContain("needs-review");
	expect((await commentsOf(a.ref)).filter(body => body.includes("completed without closing"))).toHaveLength(1);
	// B is untouched by A's settle.
	const other = (await show(b.ref)).issue;
	expect(other.metadata["opencode.subagent_id"]).toBe(b.child.id);
	expect(other.metadata.teammate).toBe(teammateIn(b.system));
});

test("a follow-up woken while the first exit settles stays tracked on its issue, and its exit settles", async () => {
	const { host, id } = await lead(wrapper);
	await write(host, id, todos(["Implement parser module", "pending"]));
	const first = await running(host, id, "Implement parser module in the background.");
	writeFileSync(slow, "");
	const exit = host.emit("session.execution.succeeded", { sessionID: first.child.id });
	// The follow-up wakes the delegate while the settle of its first exit is held in its notify.
	expect(await until(() => kataCalls().some(call => call.startsWith("notify") && call.includes(first.ref.split("#")[1])))).toBe(true);
	const { child } = await spawn(host, id, { prompt: "Now finish the rest.", sessionID: first.child.id, background: true });
	const context = host.context(child.id);
	await exit;
	rmSync(slow);
	const system = (await context).system.join("\n");
	expect(refIn(system)).toBe(first.ref);
	const resumed = (await show(first.ref)).issue;
	expect(resumed.metadata["opencode.subagent_id"]).toBe(first.child.id);
	expect(resumed.metadata.teammate).toBe(teammateIn(system));
	// The first exit's settle never posted "undefined without closing" for the woken delegate.
	expect((await commentsOf(first.ref)).join("\n")).not.toContain("undefined");
	await useTool(host, child);
	await closeAs(system);
	host.addAssistantText(child.id, "The rest is done.");
	await host.emit("session.execution.succeeded", { sessionID: child.id });
	await turnEnd(host, id);
	const closed = (await show(first.ref)).issue;
	expect(statusOf(closed)).toBe("closed:done");
	expect(closed.metadata["opencode.subagent_id"]).toBeUndefined();
});

test("a follow-up to a delegate the lead holds no record of reserves nothing, so a later spawn naming the item is not refused", async () => {
	const { host, id } = await lead();
	await write(host, id, todos(["Implement parser module", "pending"]));
	const prompt = "Implement parser module again.";
	const stranger = host.createSession({ parentID: id, messages: [userMessage(PREAMBLE + prompt)] });
	const followUp = await spawn(host, id, { prompt, sessionID: stranger.id, background: true });
	expect(followUp.result.status, followUp.result.text).toBe("completed");
	// Untracked: the child binds to nothing and its prompt carries no assignment.
	expect((await host.context(stranger.id)).system.join("\n")).not.toContain("Your Kata issue");
	expect((await item(id, "Implement parser module")).metadata["opencode.subagent_id"]).toBeUndefined();
	const next = await spawn(host, id, { prompt }, async (_child, system) => { await closeAs(system); return "Done."; });
	expect(next.result.status, next.result.text).toBe("completed");
	expect(statusOf(await item(id, "Implement parser module"))).toBe("closed:done");
});

test("a follow-up that runs no tool is rolled back, and its report stays on the open issue", async () => {
	const { host, id } = await lead();
	await write(host, id, todos(["Implement parser module", "pending"]));
	const first = await spawn(host, id, { prompt: "Implement parser module first part.", description: "Parser" }, async child => {
		await useTool(host, child);
		return "Only the first part is done.";
	});
	expect(first.result.status, first.result.text).toBe("completed");
	const ref = qref(await item(id, "Implement parser module"));
	const before = (await show(ref)).issue;

	const second = await spawn(host, id, { prompt: "Which part is left?", sessionID: first.child.id }, async () => "Only the error handling is left.");
	expect(second.result.status, second.result.text).toBe("completed");
	const after = (await show(ref)).issue;
	expect(after.metadata["opencode.subagent_id"]).toBeUndefined();
	expect(after.metadata.teammate).toBe(before.metadata.teammate);
	expect(after.status).toBe(before.status);
	expect((await commentsOf(ref)).some(body => body.includes("after a follow-up") && body.includes("Only the error handling is left."))).toBe(true);
});
