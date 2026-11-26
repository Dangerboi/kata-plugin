import { expect, test } from "bun:test";
import { assignmentOf, EVIDENCE as evidence, MESSAGE as message, until } from "./kata-fixture";
import { userMessage, type FakeSession, type OpenCodeInstance } from "./opencode-host";
import { openCodeKata, qref, statusOf, todos, write } from "./opencode-fixture";
import opencode from "../plugins/opencode/kata";
import { SUBAGENT_PREFIX } from "../plugins/opencode/subagents";

const {
	show, startLead, restart, parentOf, ticketRef, itemsOf, labelsOf, commentsOf, closeAs, savedOf, forgotten,
	kataCalls, holdCalls, releaseCalls, kataDown,
} = openCodeKata("opencode-delegates");

async function item(id: string, title: string): Promise<any> {
	const found = (await itemsOf(id)).find(child => child.title === title);
	expect(found, title).toBeDefined();
	return (await show(qref(found))).issue;
}

type Work = (child: FakeSession, system: string) => Promise<string>;
interface SpawnInput { prompt: string; description?: string; background?: boolean; sessionID?: string }
// One `subagent` call as OpenCode runs it: the child session exists before its first context hook; a foreground call runs the
// child to its reply inside the call; a background call returns at once and the test drives the child afterwards (`finish`).
// `entered` settles once the call reached its execute, after `execute.before` and the plan check; `hold` keeps it there.
// What `work` throws fails the test: the host would turn it into an error result a caller may not look at.
function spawn(host: OpenCodeInstance, leadID: string, input: SpawnInput, work?: Work, hold?: Promise<void>) {
	let child: FakeSession | undefined;
	const entered = Promise.withResolvers<void>();
	const failures: unknown[] = [];
	const done = (async () => {
		const result = await host.callTool(leadID, "subagent", { agent: "general", description: "Work item", ...input }, {
			execute: async given => {
				entered.resolve();
				await hold;
				if (given.sessionID) {
					child = host.sessions.get(given.sessionID)!;
					host.addMessage(child.id, userMessage(given.prompt));
				} else child = host.createSession({ parentID: leadID, title: given.description, messages: [userMessage(SUBAGENT_PREFIX + given.prompt)] });
				if (given.background) return { output: { sessionID: child.id, status: "running", output: "The subagent is working in the background." }, content: "The subagent is working in the background.", metadata: { sessionID: child.id, status: "running" } };
				let report: string;
				try { report = await work!(child, (await host.context(child.id)).system.join("\n")); }
				catch (error) { failures.push(error); throw error; }
				host.addAssistantText(child.id, report);
				return { output: { sessionID: child.id, status: "completed", output: report }, content: `<subagent sessionID="${child.id}" state="completed">\n${report}\n</subagent>`, metadata: { sessionID: child.id, status: "completed" } };
			},
		});
		if (failures.length) throw failures[0];
		return { result, child: child! };
	})();
	return Object.assign(done, { entered: entered.promise });
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
const notifiesAbout = (ref: string) => kataCalls().filter(call => call.startsWith("notify") && call.includes(ref.split("#")[1]));

test("a foreground spawn is bound to its plan item before the child's first model call, and its own close shows in the lead's next list", async () => {
	const { host, id } = await startLead();
	await write(host, id, todos(["Implement parser module", "in_progress"], ["Document the parser output", "pending"]));
	const seen: any = {};
	const { result, child } = await spawn(host, id, { prompt: "Please implement parser module, then verify it.", description: "Parser work" }, async (_child, system) => {
		const { ref, teammate } = assignmentOf(system);
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
	expect(seen.meta.teammate).toBe(assignmentOf(seen.system).teammate);
	expect(seen.meta["todo.status"]).toBe("in_progress");
	const closed = await item(id, "Implement parser module");
	expect(statusOf(closed)).toBe("closed:done");
	expect(closed.metadata["opencode.subagent_id"]).toBeUndefined();
	const list = await write(host, id, todos(["Implement parser module", "completed"], ["Document the parser output", "pending"]));
	expect(list.status, list.text).toBe("completed");
	expect((await item(id, "Document the parser output")).metadata["todo.status"]).toBe("pending");
});

test("a background spawn binds at the child's first context hook, and its last assistant text is its report when it exits without closing", async () => {
	const { host, id } = await startLead();
	await write(host, id, todos(["Implement parser module", "pending"]));
	const { result, child } = await spawn(host, id, { prompt: "Implement parser module in the background.", background: true });
	expect(result.status, result.text).toBe("completed");
	// The call has returned, the child has not run: nothing is assigned yet.
	expect((await item(id, "Implement parser module")).metadata["opencode.subagent_id"]).toBeUndefined();
	let system = "";
	await finish(host, child, async (_child, text) => {
		system = text;
		await useTool(host, child);
		expect((await show(assignmentOf(text).ref)).issue.metadata["opencode.subagent_id"]).toBe(child.id);
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
	const comments = (await commentsOf(assignmentOf(system).ref)).join("\n");
	expect(comments).toContain("Half done: the parser module compiles");
	expect(comments).toContain("completed without closing its Kata issue");
});

test("two parallel spawns work distinct items", async () => {
	const { host, id } = await startLead();
	await write(host, id, todos(["Implement parser module", "pending"], ["Write the changelog entry", "pending"]));
	const { promise: hold, resolve: release } = Promise.withResolvers<void>();
	const systems: string[] = [];
	const work: Work = async (_child, system) => { systems.push(system); await closeAs(system); return "Done and verified."; };
	const first = spawn(host, id, { prompt: "Implement parser module and verify it.", description: "Parser" }, work, hold);
	const second = spawn(host, id, { prompt: "Write the changelog entry for the release.", description: "Changelog" }, work, hold);
	// Both calls are past the plan check and neither child exists yet: the two reservations overlap.
	await Promise.all([first.entered, second.entered]);
	release();
	for (const { result } of await Promise.all([first, second])) expect(result.status, result.text).toBe("completed");
	expect(new Set(systems.map(system => assignmentOf(system).ref)).size).toBe(2);
	expect(new Set(systems.map(system => assignmentOf(system).teammate)).size).toBe(2);
	expect(statusOf(await item(id, "Implement parser module"))).toBe("closed:done");
	expect(statusOf(await item(id, "Write the changelog entry"))).toBe("closed:done");
});

test("a second spawn naming an item that another spawn holds is refused, before and after the first child started", async () => {
	const { host, id } = await startLead();
	await write(host, id, todos(["Implement parser module", "pending"], ["Write the changelog entry", "pending"]));
	const { promise: hold, resolve: release } = Promise.withResolvers<void>();
	const first = spawn(host, id, { prompt: "Implement parser module please." }, async (_child, system) => { await closeAs(system); return "Done."; }, hold);
	// The first call has reserved its item and has no child yet.
	await first.entered;
	const pending = await spawn(host, id, { prompt: "Also implement parser module, quickly." }, async () => "never");
	expect(pending.result.status).toBe("error");
	expect(pending.result.executed).toBe(false);
	expect(pending.result.text).toContain("already delegated");
	expect(pending.child).toBeUndefined();
	release();
	expect((await first).result.status).toBe("completed");

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
	const { host, id } = await startLead();
	await write(host, id, todos(["Implement parser module", "pending"], ["Write the changelog entry", "pending"]));
	const before = JSON.stringify((await itemsOf(id)).map(child => [child.title, child.revision]));
	const { result, child } = await spawn(host, id, { prompt: "Implement parser module and Write the changelog entry together." }, async () => "never");
	expect(result.status).toBe("error");
	expect(result.executed).toBe(false);
	expect(result.text).toContain("names more than one ticket or plan item");
	expect(child).toBeUndefined();
	expect(JSON.stringify((await itemsOf(id)).map(c => [c.title, c.revision]))).toBe(before);
});

test("a spawn that names a ticket while Kata is unusable is not refused", async () => {
	const ticket = await ticketRef("Ticket named while Kata is down", "Named by a spawn.");
	const { host, id } = await startLead();
	await write(host, id, todos(["Implement parser module", "pending"]));
	kataDown();
	try {
		const { result, child } = await spawn(host, id, { prompt: `Work on ${ticket}.` }, async () => "Done.");
		expect(result.executed).not.toBe(false);
		expect(child).toBeDefined();
	} finally { kataDown(false); }
});

test("a spawn naming an item another lead session holds is refused in todowrite's words", async () => {
	const ticket = await ticketRef("Ticket two leads delegate under", "Shared by two sessions.");
	const a = await startLead({ ref: ticket });
	await write(a.host, a.id, todos(["Shared parser item", "in_progress"]));
	const b = await startLead({ ref: ticket });
	const { result, child } = await spawn(b.host, b.id, { prompt: "Work on Shared parser item." }, async () => "never");
	expect(result.status).toBe("error");
	expect(result.executed).toBe(false);
	expect(child).toBeUndefined();
	expect(result.text).toContain("take it over first (send the list with takeover: true)");
	expect(result.text).not.toMatch(/todo op=|todo start|repeat the call/);
});

test("a follow-up to a delegate whose issue is open resumes tracking on the same issue", async () => {
	const { host, id } = await startLead();
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
		teammate = assignmentOf(system).teammate;
		expect(assignmentOf(system).ref).toBe(ref);
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
	const { host, id } = await startLead();
	await write(host, id, todos(["Implement parser module", "pending"]));
	const first = await spawn(host, id, { prompt: "Implement parser module fully." }, async (_child, system) => { await closeAs(system); return "Done and closed."; });
	expect(first.result.status, first.result.text).toBe("completed");
	const ref = qref(await item(id, "Implement parser module"));
	const before = (await itemsOf(id)).length;

	const second = await spawn(host, id, { prompt: "Add one more note.", sessionID: first.child.id }, async (_child, system) => {
		// The issue is closed: the delegate is not told to work it, and a close of it would fail.
		expect(assignmentOf(system).ref).toBe(ref);
		return "The extra note: the parser also handles empty input.";
	});
	expect(second.result.status, second.result.text).toBe("completed");
	let issue = (await show(ref)).issue;
	expect(statusOf(issue)).toBe("closed:done");
	expect((await commentsOf(ref)).join("\n")).toContain("The extra note: the parser also handles empty input.");
	expect((await itemsOf(id)).length).toBe(before);

	// The record of a settled delegate survives a restart.
	const restarted = await restart(host);
	const third = await spawn(restarted, id, { prompt: "One last remark.", sessionID: first.child.id }, async () => "Last remark: nothing else to add.");
	expect(third.result.status, third.result.text).toBe("completed");
	issue = (await show(ref)).issue;
	expect(statusOf(issue)).toBe("closed:done");
	expect((await commentsOf(ref)).join("\n")).toContain("Last remark: nothing else to add.");
	expect((await itemsOf(id)).length).toBe(before);
});

test("a restart hands back an unfinished delegate that ran tools and rolls back one that did nothing", async () => {
	const { host, id } = await startLead();
	await write(host, id, todos(["Implement parser module", "pending"], ["Write the changelog entry", "pending"]));
	const worked = await spawn(host, id, { prompt: "Implement parser module in the background.", background: true });
	const idle = await spawn(host, id, { prompt: "Write the changelog entry in the background.", background: true });
	const systems = new Map<string, string>();
	for (const { child } of [worked, idle]) systems.set(child.id, (await host.context(child.id)).system.join("\n"));
	// One delegate ran a tool, the other none; the server restarts before either ended.
	expect((await useTool(host, worked.child)).status).toBe("completed");
	const workedRef = assignmentOf(systems.get(worked.child.id)!).ref, idleRef = assignmentOf(systems.get(idle.child.id)!).ref;
	expect((await show(workedRef)).issue.metadata["opencode.subagent_id"]).toBe(worked.child.id);
	expect((await show(idleRef)).issue.metadata["opencode.subagent_id"]).toBe(idle.child.id);

	const restarted = await restart(host);
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
	const { host, id } = await startLead();
	await write(host, id, todos(["Implement parser module", "pending"]));
	let planText = "";
	const bound = await spawn(host, id, { prompt: "Implement parser module step by step." }, async (child, system) => {
		const steps = todos(["Parse the header", "pending"], ["Parse the body", "pending"]);
		const written = await write(host, child.id, steps);
		expect(written.status, written.text).toBe("completed");
		planText = written.text;
		const subtasks = ((await show(assignmentOf(system).ref)).children ?? []).map((c: any) => c.title).sort();
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
	expect((await itemsOf(id)).filter(c => c.metadata?.["opencode.mission"] !== "true").map(c => c.title)).toEqual(["Implement parser module"]);
});

test("an untracked subagent's run is recorded as a closed mission with its agent and report, and a follow-up after a restart reports on it", async () => {
	const { host, id } = await startLead();
	await write(host, id, todos(["Implement parser module", "pending"]));
	const first = await spawn(host, id, { prompt: "Summarize the weather forecast for tomorrow.", description: "Weather" }, async () => "Sunny, with a light breeze.");
	expect(first.result.status, first.result.text).toBe("completed");
	const missions = async () => (await itemsOf(id)).filter(child => child.metadata?.["opencode.mission"] === "true");
	const [mission] = await missions();
	expect(mission).toMatchObject({ status: "closed", closed_reason: "audit-no-change", metadata: { "opencode.mission_agent": "general" } });
	expect(await commentsOf(qref(mission))).toEqual(["Report from subagent Weather:\n\nSunny, with a light breeze."]);

	const restarted = await restart(host);
	const later = await spawn(restarted, id, { prompt: "And the day after?", sessionID: first.child.id }, async () => "Rain all day.");
	expect(later.result.status, later.result.text).toBe("completed");
	expect((await missions()).map(child => child.short_id)).toEqual([mission.short_id]);
	expect(await commentsOf(qref(mission))).toEqual(["Report from subagent Weather:\n\nSunny, with a light breeze.", "Report from subagent Weather (after a follow-up):\n\nRain all day."]);
});

async function running(host: OpenCodeInstance, leadID: string, prompt: string) {
	const { child } = await spawn(host, leadID, { prompt, background: true });
	const system = (await host.context(child.id)).system.join("\n");
	await useTool(host, child);
	host.addAssistantText(child.id, "Stopped before closing.");
	return { child, system, ref: assignmentOf(system).ref };
}

test("a delegate's todowrite while another delegate exits hands the other's issue back once, under the lead's teammate", async () => {
	const { host, id } = await startLead();
	await write(host, id, todos(["Implement parser module", "pending"], ["Write the changelog entry", "pending"]));
	const a = await running(host, id, "Implement parser module in the background.");
	const b = await running(host, id, "Write the changelog entry in the background.");
	// A's exit settle is held in its notify until B has planned through its own core: B's plan must not wait for A's settle.
	holdCalls("notify");
	const exit = host.emit("session.execution.succeeded", { sessionID: a.child.id });
	expect(await until(() => notifiesAbout(a.ref).length > 0)).toBe(true);
	const planned = await write(host, b.child.id, todos(["Write the header", "pending"]));
	releaseCalls();
	await exit;
	await turnEnd(host, id);
	expect(planned.status, planned.text).toBe("completed");
	expect(notifiesAbout(a.ref)).toHaveLength(1);
	const bTeammate = assignmentOf(b.system).teammate;
	expect(kataCalls().filter(call => call.includes(bTeammate) && call.includes(a.ref.split("#")[1]))).toEqual([]);
	const handed = (await show(a.ref)).issue;
	expect(handed.status).toBe("open");
	expect(handed.metadata["opencode.subagent_id"]).toBeUndefined();
	expect(handed.metadata.teammate).toBeUndefined();
	expect(await labelsOf(handed)).toContain("needs-review");
	expect((await commentsOf(a.ref)).filter(body => body.includes("completed without closing"))).toHaveLength(1);
	// B is untouched by A's settle.
	const other = (await show(b.ref)).issue;
	expect(other.metadata["opencode.subagent_id"]).toBe(b.child.id);
	expect(other.metadata.teammate).toBe(bTeammate);
});

test("a follow-up woken while the first exit settles stays tracked on its issue, and its exit settles", async () => {
	const { host, id } = await startLead();
	await write(host, id, todos(["Implement parser module", "pending"]));
	const first = await running(host, id, "Implement parser module in the background.");
	holdCalls("notify");
	const exit = host.emit("session.execution.succeeded", { sessionID: first.child.id });
	// The follow-up wakes the delegate while the settle of its first exit is held in its notify.
	expect(await until(() => notifiesAbout(first.ref).length > 0)).toBe(true);
	const { child } = await spawn(host, id, { prompt: "Now finish the rest.", sessionID: first.child.id, background: true });
	const context = host.context(child.id);
	releaseCalls();
	await exit;
	const system = (await context).system.join("\n");
	expect(assignmentOf(system).ref).toBe(first.ref);
	const resumed = (await show(first.ref)).issue;
	expect(resumed.metadata["opencode.subagent_id"]).toBe(first.child.id);
	expect(resumed.metadata.teammate).toBe(assignmentOf(system).teammate);
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
	const { host, id } = await startLead();
	await write(host, id, todos(["Implement parser module", "pending"]));
	const prompt = "Implement parser module again.";
	const stranger = host.createSession({ parentID: id, messages: [userMessage(SUBAGENT_PREFIX + prompt)] });
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
	const { host, id } = await startLead();
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

test("a call another plugin's hook refuses after the plan check frees its item at the lead's turn end", async () => {
	let refuse = true;
	// Registered after Kata's hooks, so it refuses the call once the plan check has reserved the item: OpenCode then runs
	// neither the tool nor `execute.after`.
	const withRefusal: typeof opencode = { id: opencode.id, async setup(ctx: any) {
		const cleanup = await opencode.setup(ctx);
		await ctx.tool.hook("execute.before", (event: any) => { if (event.tool === "subagent" && refuse) throw new Error("Refused by another plugin."); });
		return cleanup;
	} };
	const { host, id } = await startLead({ plugin: withRefusal });
	await write(host, id, todos(["Implement parser module", "pending"]));
	const refused = await spawn(host, id, { prompt: "Implement parser module please." }, async () => "never");
	expect(refused.result.executed).toBe(false);
	expect(refused.result.text).toContain("Refused by another plugin.");
	await turnEnd(host, id);
	refuse = false;
	const next = await spawn(host, id, { prompt: "Implement parser module please." }, async (_child, system) => { await closeAs(system); return "Done."; });
	expect(next.result.status, next.result.text).toBe("completed");
	expect(statusOf(await item(id, "Implement parser module"))).toBe("closed:done");
});

test("a background call whose child never reaches a context hook frees its item at the lead's turn end", async () => {
	const { host, id } = await startLead();
	await write(host, id, todos(["Implement parser module", "pending"]));
	const lost = await spawn(host, id, { prompt: "Implement parser module in the background.", background: true });
	expect(lost.result.status, lost.result.text).toBe("completed");
	// The child fails before its first model call, so no context hook ever binds it; then the lead's turn ends.
	await host.emit("session.execution.failed", { sessionID: lost.child.id });
	await turnEnd(host, id);
	const next = await spawn(host, id, { prompt: "Implement parser module in the background." }, async (_child, system) => { await closeAs(system); return "Done."; });
	expect(next.result.status, next.result.text).toBe("completed");
	expect(statusOf(await item(id, "Implement parser module"))).toBe("closed:done");
});

test("a lead archived with a call still pending and work owed gets its reservations back when it is unarchived", async () => {
	const { host, id } = await startLead();
	const session = host.sessions.get(id)!;
	await write(host, id, todos(["Implement parser module", "pending"], ["Write the changelog entry", "pending"]));
	// A running delegate is work owed, so the archived lead stays in memory as an ended session.
	const running = await spawn(host, id, { prompt: "Implement parser module in the background.", background: true });
	await host.context(running.child.id);
	const { promise: hold, resolve: release } = Promise.withResolvers<void>();
	const pending = spawn(host, id, { prompt: "Write the changelog entry for the release." }, async (_child, system) => { await closeAs(system); return "Done."; }, hold);
	await pending.entered;
	const refused = await spawn(host, id, { prompt: "Also write the changelog entry, quickly." }, async () => "never");
	expect(refused.result.text).toContain("already delegated");
	session.archived = Date.now();
	await host.emit("session.archived", { sessionID: id });
	session.archived = undefined;
	await host.emit("session.unarchived", { sessionID: id });
	// The call that was pending when the lead was archived is gone: its item can be delegated again.
	const again = await spawn(host, id, { prompt: "Write the changelog entry once more." }, async (_child, system) => { await closeAs(system); return "Done."; });
	expect(again.result.text).not.toContain("already delegated");
	expect(again.result.status, again.result.text).toBe("completed");
	release();
	await pending.catch(() => {});
	await finish(host, running.child, async () => "Nothing done.", "session.execution.interrupted");
});

test("a spawn that would delegate a ticket other open items name is told the way out in todowrite's words", async () => {
	const ticket = await ticketRef("Ticket two items work", "Worked by two plan items.");
	const { host, id } = await startLead();
	await write(host, id, todos([`${ticket}: write the parser`, "pending"], [`${ticket}: test the parser`, "pending"]));
	const { result, child } = await spawn(host, id, { prompt: `Work on ${ticket}.` }, async () => "never");
	expect(result.status).toBe("error");
	expect(child).toBeUndefined();
	expect(result.text).toContain(`or plan the work as child issues (start a session whose first todowrite passes ref ${ticket}) and delegate one of those.`);
	expect(result.text).not.toContain("todo init");
});

test("a child is bound to the call whose prompt is its whole first message, not to an earlier call whose prompt that message ends with", async () => {
	const { host, id } = await startLead();
	await write(host, id, todos(["Implement parser module", "pending"]));
	// Two background calls wait for their children, and the first one's prompt is the end of the second's.
	const short = await spawn(host, id, { prompt: "Finish it.", background: true });
	const long = await spawn(host, id, { prompt: 'Work on "Implement parser module". Finish it.', background: true });
	// The second call's child reaches its first prompt first.
	const system = (await host.context(long.child.id)).system.join("\n");
	expect(assignmentOf(system).ref).toBe(qref(await item(id, "Implement parser module")));
	expect((await item(id, "Implement parser module")).metadata["opencode.subagent_id"]).toBe(long.child.id);
	// The first call is still its own child's: that one named nothing, so it is untracked.
	expect((await host.context(short.child.id)).system.join("\n")).toContain("you have no Kata issue");
	for (const { child } of [long, short]) await host.emit("session.execution.interrupted", { sessionID: child.id });
	await turnEnd(host, id);
});

test("the late end event of a run that its call's result already ended does not end the follow-up run that began since", async () => {
	const { host, id } = await startLead();
	await write(host, id, todos(["Implement parser module", "pending"]));
	const first = await spawn(host, id, { prompt: "Implement parser module first part." }, async child => {
		await useTool(host, child);
		return "Only the first part is done.";
	});
	// OpenCode made the first run's end event by now; the plugin gets to it only later.
	const firstEnded = Date.now();
	const ref = qref(await item(id, "Implement parser module"));
	const { child } = await spawn(host, id, { prompt: "Now finish the rest.", sessionID: first.child.id, background: true });
	const system = (await host.context(child.id)).system.join("\n");
	expect(assignmentOf(system).ref).toBe(ref);
	await useTool(host, child);
	await host.emit("session.execution.succeeded", { sessionID: child.id }, firstEnded);
	// The follow-up still runs and still holds its issue.
	const held = (await show(ref)).issue;
	expect(held.metadata["opencode.subagent_id"]).toBe(child.id);
	expect(held.metadata.teammate).toBe(assignmentOf(system).teammate);
	expect((await host.context(child.id)).system.join("\n")).toContain(`Your Kata issue is ${ref};`);
	// Its own end event ends it.
	await closeAs(system);
	host.addAssistantText(child.id, "The rest is done.");
	await host.emit("session.execution.succeeded", { sessionID: child.id });
	await turnEnd(host, id);
	const closed = (await show(ref)).issue;
	expect(statusOf(closed)).toBe("closed:done");
	expect(closed.metadata["opencode.subagent_id"]).toBeUndefined();
});

test("a follow-up that joins a child still running is one run on the same issue: its end hands the issue back once with the report", async () => {
	const { host, id } = await startLead();
	await write(host, id, todos(["Implement parser module", "pending"]));
	const first = await spawn(host, id, { prompt: "Implement parser module first part.", description: "Parser", background: true });
	const ref = qref(await item(id, "Implement parser module"));
	const system = (await host.context(first.child.id)).system.join("\n");
	expect(assignmentOf(system).ref).toBe(ref);
	await useTool(host, first.child);
	// The child has not ended: the follow-up joins its run, and the child's next model call is the follow-up's first context hook.
	const second = await spawn(host, id, { prompt: "Also cover the edge cases.", sessionID: first.child.id, background: true });
	expect(second.child.id).toBe(first.child.id);
	expect((await host.context(first.child.id)).system.join("\n")).toContain(`Your Kata issue is ${ref};`);
	expect((await show(ref)).issue.metadata["opencode.subagent_id"]).toBe(first.child.id);
	host.addAssistantText(first.child.id, "Both parts are done except the edge cases.");
	await host.emit("session.execution.succeeded", { sessionID: first.child.id });
	await turnEnd(host, id);
	const handed = (await show(ref)).issue;
	expect(handed.status).toBe("open");
	expect(handed.metadata["opencode.subagent_id"]).toBeUndefined();
	expect(await labelsOf(handed)).toContain("needs-review");
	const reports = (await commentsOf(ref)).filter(body => body.includes("Both parts are done except the edge cases."));
	expect(reports.length).toBe(1);
});

test("a background delegate whose session is gone when its end event is handled still exits, and its issue goes back to the lead", async () => {
	const { host, id } = await startLead();
	await write(host, id, todos(["Implement parser module", "pending"]));
	const gone = await running(host, id, "Implement parser module in the background.");
	host.sessions.delete(gone.child.id);
	await host.emit("session.execution.failed", { sessionID: gone.child.id });
	await turnEnd(host, id);
	const handed = (await show(gone.ref)).issue;
	expect(handed.status).toBe("open");
	expect(handed.metadata["opencode.subagent_id"]).toBeUndefined();
	expect(await labelsOf(handed)).toContain("needs-review");
	expect((await commentsOf(gone.ref)).join("\n")).toContain("failed without closing its Kata issue");
	// Nothing holds the item: it can be delegated again.
	const next = await spawn(host, id, { prompt: "Implement parser module again." }, async (_child, system) => { await closeAs(system); return "Done."; });
	expect(next.result.status, next.result.text).toBe("completed");
});

for (const [type, end] of [
	["session.deleted", (host: OpenCodeInstance, id: string) => { host.sessions.delete(id); }],
	["session.archived", (host: OpenCodeInstance, id: string) => { host.sessions.get(id)!.archived = Date.now(); }],
] as const) {
	test(`a running delegate whose own session ends (${type}) exits as aborted, and its issue goes back to the lead`, async () => {
		const { host, id } = await startLead();
		await write(host, id, todos(["Implement parser module", "pending"]));
		const ended = await running(host, id, "Implement parser module in the background.");
		end(host, ended.child.id);
		await host.emit(type, { sessionID: ended.child.id });
		await turnEnd(host, id);
		const handed = (await show(ended.ref)).issue;
		expect(handed.status).toBe("open");
		expect(handed.metadata["opencode.subagent_id"]).toBeUndefined();
		expect(await labelsOf(handed)).toContain("needs-review");
		expect((await commentsOf(ended.ref)).join("\n")).toContain("aborted without closing its Kata issue");
	});

	test(`a lead that ended (${type}) while its delegate still ran is finished once the delegate ends, without a restart`, async () => {
		const { host, id } = await startLead();
		await write(host, id, todos(["Implement parser module", "pending"]));
		const parent = qref(await parentOf(id));
		const delegate = await running(host, id, "Implement parser module in the background.");
		end(host, id);
		await host.emit(type, { sessionID: id });
		expect(savedOf(host, id).ended).toBe(true);
		// The delegate closes its issue and ends: nothing is owed any more, so the ended lead closes its parent and is forgotten.
		await closeAs(delegate.system);
		await host.emit("session.execution.succeeded", { sessionID: delegate.child.id });
		expect(await until(() => forgotten(host, id))).toBe(true);
		expect((await show(parent)).issue).toMatchObject({ status: "closed", closed_reason: "done" });
	});
}

test("one session's events do not wait for another session whose handler is still in Kata", async () => {
	const { host, id } = await startLead();
	await write(host, id, todos(["Implement parser module", "pending"]));
	const slowed = await running(host, id, "Implement parser module in the background.");
	const other = host.createSession({ id: `${id}-other` }).id;
	await write(host, other, todos(["Unrelated item", "in_progress"]));
	const parent = qref(await parentOf(other));
	await write(host, other, todos({ content: "Unrelated item", status: "completed", message, evidence }));
	// The delegate's exit is held in its hand back while the other lead's session is deleted.
	holdCalls("notify");
	const exit = host.emit("session.execution.succeeded", { sessionID: slowed.child.id });
	expect(await until(() => notifiesAbout(slowed.ref).length > 0)).toBe(true);
	host.sessions.delete(other);
	const deleted = host.emit("session.deleted", { sessionID: other });
	expect(await until(() => forgotten(host, other))).toBe(true);
	expect((await show(parent)).issue.status).toBe("closed");
	releaseCalls();
	await Promise.all([exit, deleted]);
});
