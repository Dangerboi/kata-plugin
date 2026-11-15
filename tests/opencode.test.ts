import { expect, test } from "bun:test";
import { eventually, finishes, later, settle, until } from "./kata-fixture";
import { currentList, evidence, message, openCodeKata, PROJECT, qref, statusOf, todos, write } from "./opencode-fixture";
import { type OpenCodeInstance } from "./opencode-host";
import opencode from "../plugins/opencode/kata";

const {
	kata, show, startHost, startLead, newSession, restart, parentOf, childrenOf, closeEvents, savedOf, forgotten,
	kataCalls, forgetCalls, throttleCloses, holdCalls, releaseCalls,
} = openCodeKata("opencode");

test("setup registers todowrite once, with the list schema, and registers no other tool", async () => {
	const host = await startHost();
	expect(host.registrationErrors).toEqual([]);
	const tool = host.tool("todowrite");
	expect(tool.options).toEqual({ codemode: false });
	expect(tool.input.properties.todos.items.required).toEqual(["content", "status"]);
	expect(tool.description).toContain("WHOLE list");
	expect([...host.tools().keys()]).toEqual(["todowrite"]);
});

test("the first todowrite creates the automatic parent and one pending task per item, and starts nothing", async () => {
	const { host, id } = await startLead();
	const result = await write(host, id, todos(["Write the parser", "pending"], ["Test the parser", "pending"]));
	expect(result.status, result.text).toBe("completed");
	expect((result.metadata as any).todos).toEqual([{ content: "Write the parser", status: "pending" }, { content: "Test the parser", status: "pending" }]);
	const parent = await parentOf(id);
	expect(parent.metadata["opencode.auto_parent"]).toBe(true);
	expect(parent.metadata["opencode.session_id"]).toBe(id);
	expect(parent.owner).toBe("opencode-builder");
	const children = await childrenOf(qref(parent));
	expect(children.map(c => [c.title, statusOf(c)])).toEqual([["Write the parser", "pending"], ["Test the parser", "pending"]]);
});

test("the context hook shows the plan in the system prompt once there is one", async () => {
	const { host, id } = await startLead();
	expect((await host.context(id)).system).toEqual([]);
	await write(host, id, todos(["Show the plan", "pending"]));
	const { system } = await host.context(id);
	expect(system).toHaveLength(1);
	expect(system[0]).toContain("The todowrite tool is backed by Kata");
	expect(system[0]).toContain("Show the plan");
	expect(system[0]).toContain(qref(await parentOf(id)));
});

test("a later list starts, completes and cancels items; the closes carry the evidence and the opencode transcript pair", async () => {
	const { host, id } = await startLead();
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

test("a blocker pauses an item and its removal resumes it; the list shows the blocked item as in_progress with its blocker", async () => {
	const { host, id } = await startLead();
	await write(host, id, todos(["Wait for the review", "in_progress"]));
	const ref = qref(await parentOf(id));
	let result = await write(host, id, todos({ content: "Wait for the review", status: "in_progress", blocker: "Waiting for the reviewer's answer" }));
	expect(result.status, result.text).toBe("completed");
	expect((await childrenOf(ref)).map(statusOf)).toEqual(["blocked"]);
	expect((result.metadata as any).todos).toEqual([{ content: "Wait for the review", status: "in_progress", blocker: "Waiting for the reviewer's answer" }]);
	result = await write(host, id, todos(["Wait for the review", "in_progress"]));
	expect(result.status, result.text).toBe("completed");
	expect((await childrenOf(ref)).map(statusOf)).toEqual(["in_progress"]);
	expect((result.metadata as any).todos).toEqual([{ content: "Wait for the review", status: "in_progress" }]);
});

test("a refused list leaves Kata unchanged and ends with the current list", async () => {
	const { host, id } = await startLead();
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
	await write(host, id, todos(["Alpha item", "completed"], ["Beta item", "in_progress"], ["Gamma item", "pending"]));
	const back = await write(host, id, todos(["Alpha item", "completed"], ["Beta item", "pending"], ["Gamma item", "pending"]));
	expect(back.status).toBe("error");
	expect(back.text).toContain('"Beta item" is in progress and cannot go back to pending');
	const malformed = await write(host, id, { todos: [{ content: "Only content" }] });
	expect(malformed.status).toBe("error");
	expect(malformed.text).toContain("status must be one of");
});

test("an item added to the plan outside the session must be sent back unchanged", async () => {
	const { host, id } = await startLead();
	await write(host, id, todos(["Own item", "pending"]));
	const ref = qref(await parentOf(id));
	const created = await kata(["create", "--parent", ref, "--project", PROJECT, "--meta", "todo.phase=Tasks", "--meta", "todo.status=pending", "--force-new", "--json", "--", "Added by a teammate"]);
	expect(created.issue.short_id).toBeString();
	const refused = await write(host, id, todos(["Own item", "pending"]));
	expect(refused.status).toBe("error");
	expect(refused.text).toContain('"Added by a teammate" was added to the Kata plan outside this session and is requested work: send it back unchanged');
	const accepted = await write(host, id, { todos: currentList(refused.text) });
	expect(accepted.status, accepted.text).toBe("completed");
});

test("an op that fails after another succeeded ends with the current Kata list, and the item it appended is still the session's own", async () => {
	const { host, id } = await startLead();
	await write(host, id, todos(["Held item", "pending"]));
	const ref = qref(await parentOf(id));
	const [held] = await childrenOf(ref);
	// Another teammate holds the task: starting it is refused by the core, after the new item was appended.
	await kata(["meta", "set", qref(held), "teammate", "someone-else", "--json"]);
	const result = await write(host, id, todos(["Held item", "in_progress"], ["Appended item", "pending"]));
	expect(result.status).toBe("error");
	expect(result.text).toContain("belongs to teammate someone-else");
	expect(currentList(result.text)).toEqual([{ content: "Held item", status: "pending" }, { content: "Appended item", status: "pending" }]);
	expect((await childrenOf(ref)).map(c => c.title)).toEqual(["Held item", "Appended item"]);
	// Leaving the appended item out offers cancelling it: it is not taken for an item added outside the session.
	const refused = await write(host, id, todos(["Held item", "pending"]));
	expect(refused.status).toBe("error");
	expect(refused.text).toContain(`"Appended item" is missing from the list: keep it, or mark it cancelled with a reason`);
	expect(refused.text).not.toContain("outside this session");
});

for (const type of ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]) {
	test(`${type} settles the lead's pending closes and leaves the automatic parent open`, async () => {
		const { host, id } = await startLead();
		await write(host, id, todos(["Throttled item", "in_progress"]));
		const ref = qref(await parentOf(id));
		throttleCloses();
		const deferred = await write(host, id, todos({ content: "Throttled item", status: "completed", message, evidence }));
		expect(deferred.status, deferred.text).toBe("completed");
		expect(deferred.text).toContain("deferred");
		expect((await childrenOf(ref)).map(statusOf)).toEqual(["in_progress"]);
		throttleCloses(false);
		// A turn that ends before the retry is due changes nothing.
		await host.emit(type, { sessionID: id });
		expect((await childrenOf(ref)).map(statusOf)).toEqual(["in_progress"]);
		// The retry may finish after the emit returned: keep the clock advanced while waiting for it.
		await later(async () => {
			await host.emit(type, { sessionID: id });
			await eventually(async () => (await childrenOf(ref)).map(statusOf), ["closed:done"]);
		});
		// Every child is closed with evidence, yet only the session's end closes the parent.
		expect((await show(ref)).issue.status).toBe("open");
	});
}

for (const type of ["session.deleted", "session.archived"]) {
	test(`${type} closes the automatic parent from its children's evidence and forgets the session`, async () => {
		const { host, id } = await startLead();
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
		expect(forgotten(host, id)).toBe(true);
	});
}

test("session.deleted while a close is refused keeps the saved state, and the next setup finishes it and then forgets the session", async () => {
	const { host, id } = await startLead();
	await write(host, id, todos(["Throttled item", "in_progress"]));
	const ref = qref(await parentOf(id));
	throttleCloses();
	const deferred = await write(host, id, todos({ content: "Throttled item", status: "completed", message, evidence }));
	expect(deferred.text).toContain("deferred");
	host.sessions.delete(id);
	await host.emit("session.deleted", { sessionID: id });
	// Nothing could be closed: the pending close and the session's end stay saved.
	expect((await childrenOf(ref)).map(statusOf)).toEqual(["in_progress"]);
	expect((await show(ref)).issue.status).toBe("open");
	expect(savedOf(host, id).entries).toBe(true);
	throttleCloses(false);
	// The retry is due when the next setup runs: it finishes the close, closes the parent, and forgets the session, in the background.
	await later(async () => {
		const restarted = await restart(host);
		expect(await until(() => forgotten(restarted, id))).toBe(true);
	});
	expect((await childrenOf(ref)).map(statusOf)).toEqual(["closed:done"]);
	expect((await show(ref)).issue.status).toBe("closed");
});

test("session.deleted while a close is refused ends in one pass: that item keeps its hold for the retry, the session's other started item is released", async () => {
	const { host, id } = await startLead();
	await write(host, id, todos(["Throttled item", "in_progress"], ["Running item", "in_progress"]));
	const ref = qref(await parentOf(id));
	throttleCloses();
	const deferred = await write(host, id, todos({ content: "Throttled item", status: "completed", message, evidence }, ["Running item", "in_progress"]));
	expect(deferred.text).toContain("deferred");
	const revision = (await childrenOf(ref))[0].revision;
	host.sessions.delete(id);
	await host.emit("session.deleted", { sessionID: id });
	const [refused, running] = await childrenOf(ref);
	// A release would change the refused item's revision, which voids its pending close.
	expect([refused.metadata["todo.session"], refused.revision, statusOf(refused)]).toEqual([id, revision, "in_progress"]);
	expect([running.metadata["todo.session"], statusOf(running)]).toEqual([undefined, "in_progress"]);
	expect(savedOf(host, id).ended).toBe(true);
	throttleCloses(false);
	await later(async () => {
		const restarted = await restart(host);
		expect(await until(() => forgotten(restarted, id))).toBe(true);
	});
	expect((await childrenOf(ref)).map(statusOf)).toEqual(["closed:done", "in_progress"]);
	expect((await show(ref)).issue.status).toBe("open");
});

test("a lead that dropped every item leaves its automatic parent open on purpose, and its end forgets the session", async () => {
	const { host, id } = await startLead();
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
	expect(forgotten(host, id)).toBe(true);
});

test("setup returns before a saved ended session's Kata work is done, and the work finishes in the background", async () => {
	const { host, id } = await startLead();
	await write(host, id, todos(["Throttled item", "in_progress"]));
	const ref = qref(await parentOf(id));
	throttleCloses();
	await write(host, id, todos({ content: "Throttled item", status: "completed", message, evidence }));
	host.sessions.delete(id);
	await host.emit("session.deleted", { sessionID: id });
	expect((await show(ref)).issue.status).toBe("open");
	throttleCloses(false);
	// The old instance's own cleanup is not what is measured.
	await host.shutdown();
	holdCalls();
	await later(async () => {
		// With every Kata call held, a setup that waited on Kata would never return.
		const restarting = restart(host);
		expect(await finishes(restarting)).toBe(true);
		const restarted = await restarting;
		releaseCalls();
		expect(await until(() => forgotten(restarted, id))).toBe(true);
	});
	expect((await childrenOf(ref)).map(statusOf)).toEqual(["closed:done"]);
	expect((await show(ref)).issue.status).toBe("closed");
});

// An archive whose close Kata refused leaves an ended session; the user then keeps working in it. The first two ways of
// coming back clear the saved ended flag at once; the third is only seen by the next setup, which asks OpenCode.
for (const [how, resumed, clearedAtOnce] of [
	["`session.unarchived`", async (host: OpenCodeInstance, id: string) => { host.sessions.get(id)!.archived = undefined; await host.emit("session.unarchived", { sessionID: id }); }, true],
	["a context hook", async (host: OpenCodeInstance, id: string) => { await host.context(id); }, true],
	["nothing the plugin saw, but OpenCode no longer reports it archived", async (host: OpenCodeInstance, id: string) => { host.sessions.get(id)!.archived = undefined; }, false],
] as const) {
	test(`an archived session that is back (${how}) is not finished by the next setup`, async () => {
		const { host, id, session } = await startLead();
		await write(host, id, todos(["Throttled item", "in_progress"], ["Running item", "pending"]));
		const ref = qref(await parentOf(id));
		throttleCloses();
		await write(host, id, todos({ content: "Throttled item", status: "completed", message, evidence }, ["Running item", "in_progress"]));
		session.archived = Date.now();
		await host.emit("session.archived", { sessionID: id });
		expect(savedOf(host, id).ended).toBe(true);
		await resumed(host, id);
		if (clearedAtOnce) expect(savedOf(host, id).ended).toBe(false);
		throttleCloses(false);
		let restarted!: OpenCodeInstance;
		await later(async () => {
			restarted = await restart(host);
			expect(await until(() => !savedOf(restarted, id).ended)).toBe(true);
			// The resumed lead finishes its refused close, and ends nothing: a short wait for what a wrong ending would do.
			for (let wait = 0; wait < 100 && statusOf((await childrenOf(ref))[0]) !== "closed:done"; wait++) await settle(100);
			await settle(1500);
		});
		const [first, second] = await childrenOf(ref);
		expect([first, second].map(statusOf)).toEqual(["closed:done", "in_progress"]);
		// The archive ended the session: it released the item it had started and kept only the hold of the refused close.
		expect(second.metadata["todo.session"]).toBeUndefined();
		expect(savedOf(restarted, id).entries).toBe(true);
		expect((await restarted.context(id)).system[0]).toContain("Running item");
	});
}

// A delegate's tool call says nothing of its lead: it must not clear the ended session a lead was saved as.
for (const [type, end] of [
	["session.archived", (host: OpenCodeInstance, id: string) => { host.sessions.get(id)!.archived = Date.now(); }],
	["session.deleted", (host: OpenCodeInstance, id: string) => { host.sessions.delete(id); }],
] as const) {
	test(`${type} while a delegate still runs stays an ended session through the delegate's tool calls, and the next setup finishes the session`, async () => {
		const { host, id } = await startLead();
		await write(host, id, todos(["Throttled item", "in_progress"]));
		const ref = qref(await parentOf(id));
		const child = host.createSession({ parentID: id });
		throttleCloses();
		await write(host, id, todos({ content: "Throttled item", status: "completed", message, evidence }));
		end(host, id);
		await host.emit(type, { sessionID: id });
		expect(savedOf(host, id).ended).toBe(true);
		await host.callTool(child.id, "shell", { command: "ls" }, { execute: () => "ok" });
		expect(savedOf(host, id).ended).toBe(true);
		throttleCloses(false);
		await later(async () => {
			const restarted = await restart(host);
			expect(await until(() => forgotten(restarted, id))).toBe(true);
		});
		expect((await childrenOf(ref)).map(statusOf)).toEqual(["closed:done"]);
		expect((await show(ref)).issue.status).toBe("closed");
	});
}

test("cleanup drains a close that is due but never closes the parent, though every item is closed", async () => {
	const { host, id } = await startLead();
	await write(host, id, todos(["First item", "in_progress"], ["Second item", "in_progress"]));
	const ref = qref(await parentOf(id));
	await write(host, id, todos(["First item", "in_progress"], { content: "Second item", status: "completed", message, evidence }));
	throttleCloses();
	const deferred = await write(host, id, todos({ content: "First item", status: "completed", message, evidence }, ["Second item", "completed"]));
	expect(deferred.text).toContain("deferred");
	expect((await childrenOf(ref)).map(statusOf)).toEqual(["in_progress", "closed:done"]);
	throttleCloses(false);
	await later(() => host.shutdown());
	expect((await childrenOf(ref)).map(statusOf)).toEqual(["closed:done", "closed:done"]);
	expect((await show(ref)).issue.status).toBe("open");
});

test("cleanup keeps the lead's started item held and a close it could not make saved", async () => {
	const { host, id } = await startLead();
	await write(host, id, todos(["Finished item", "in_progress"], ["Running item", "in_progress"]));
	const ref = qref(await parentOf(id));
	throttleCloses();
	const deferred = await write(host, id, todos({ content: "Finished item", status: "completed", message, evidence }, ["Running item", "in_progress"]));
	expect(deferred.text).toContain("deferred");
	let [finished, running] = await childrenOf(ref);
	expect([finished.metadata["todo.session"], running.metadata["todo.session"]]).toEqual([id, id]);
	await host.shutdown();
	[finished, running] = await childrenOf(ref);
	expect([finished, running].map(statusOf)).toEqual(["in_progress", "in_progress"]);
	expect([finished.metadata["todo.session"], running.metadata["todo.session"]]).toEqual([id, id]);
	expect(savedOf(host, id).entries).toBe(true);
	expect((await show(ref)).issue.status).toBe("open");
});

test("a restart resumes the session's plan and its saved pending closes", async () => {
	const { host, id } = await startLead();
	await write(host, id, todos(["Resumed item", "in_progress"], ["Later item", "pending"]));
	const ref = qref(await parentOf(id));
	throttleCloses();
	await write(host, id, todos({ content: "Resumed item", status: "completed", message, evidence }, ["Later item", "pending"]));
	expect((await childrenOf(ref)).map(statusOf)).toEqual(["in_progress", "pending"]);
	const restarted = await restart(host);
	throttleCloses(false);
	// The saved close is due and the lead's turn ends: the new instance finishes it.
	await later(() => restarted.emit("session.execution.succeeded", { sessionID: id }));
	expect((await childrenOf(ref)).map(statusOf)).toEqual(["closed:done", "pending"]);
	// The accepted contents survived, so a missing item is the model's omission.
	const refused = await write(restarted, id, todos(["Resumed item", "completed"]));
	expect(refused.status).toBe("error");
	expect(refused.text).toContain('"Later item" is missing from the list: keep it, or mark it cancelled with a reason');
	const accepted = await write(restarted, id, todos(["Resumed item", "completed"], ["Later item", "in_progress"]));
	expect(accepted.status, accepted.text).toBe("completed");
	expect((await childrenOf(ref)).map(statusOf)).toEqual(["closed:done", "in_progress"]);
	expect((await restarted.context(id)).system[0]).toContain("Later item");
});

test("sessions of one location keep separate plans, and a delegate's child session is left alone", async () => {
	const { host, id } = await startLead();
	const other = newSession(host);
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
		const created = await kata(["create", title, "--body", "A ticket a session plans under.", "--project", PROJECT, "--force-new", "--json"]);
		return `${PROJECT}#${created.issue.short_id}`;
	};
	// plugin option
	const optionRef = await ticket("Ticket named by an option");
	const withOption = await startLead({ ref: optionRef });
	let result = await write(withOption.host, withOption.id, todos(["Planned under the option ref", "pending"]));
	expect(result.status, result.text).toBe("completed");
	expect((await childrenOf(optionRef)).map(c => c.title)).toEqual(["Planned under the option ref"]);
	// environment of the server
	const envRef = await ticket("Ticket named by the environment");
	process.env.KATA_REF = envRef;
	const withEnv = await startLead();
	result = await write(withEnv.host, withEnv.id, todos(["Planned under the env ref", "pending"]));
	expect(result.status, result.text).toBe("completed");
	expect((await childrenOf(envRef)).map(c => c.title)).toEqual(["Planned under the env ref"]);
	// the option wins over the environment
	const winnerRef = await ticket("Ticket named by an option next to an environment ref");
	const winner = await startLead({ ref: winnerRef });
	result = await write(winner.host, winner.id, todos(["Planned under the option ref, not the env one", "pending"]));
	expect(result.status, result.text).toBe("completed");
	expect((await childrenOf(winnerRef)).map(c => c.title)).toEqual(["Planned under the option ref, not the env one"]);
	expect((await childrenOf(envRef)).map(c => c.title)).toEqual(["Planned under the env ref"]);
	delete process.env.KATA_REF;
	// the first todowrite names the ticket itself
	const listRef = await ticket("Ticket named by the first list");
	const named = await startLead();
	result = await write(named.host, named.id, { ...todos(["Planned under the list ref", "pending"]), ref: listRef });
	expect(result.status, result.text).toBe("completed");
	expect((await childrenOf(listRef)).map(c => c.title)).toEqual(["Planned under the list ref"]);
});

test("a rejected storage read never fails a child session's tool calls", async () => {
	const host = await startHost();
	const child = host.createSession({ parentID: newSession(host).id });
	host.ctx.storage.get = async () => { throw new Error("storage unavailable"); };
	const result = await host.callTool(child.id, "shell", { command: "ls" }, { execute: () => "ok" });
	expect(result.status, result.text).toBe("completed");
});

test("todowrite in a session OpenCode cannot read says so, and does not call the session a delegate", async () => {
	const { host, id } = await startLead();
	host.ctx.session.get = async () => { throw new Error("session read failed"); };
	const result = await write(host, id, todos(["Any item", "pending"]));
	expect(result.status).toBe("error");
	expect(result.text).toContain("could not read this session");
	expect(result.text).not.toContain("delegate");
});

test("a first list under a ticket that leaves out the ticket's open items is refused in todowrite's words, and the list with them is accepted", async () => {
	const created = await kata(["create", "Ticket with an open item", "--body", "An earlier session planned under it.", "--project", PROJECT, "--force-new", "--json"]);
	const ticket = `${PROJECT}#${created.issue.short_id}`;
	const earlier = await startLead({ ref: ticket });
	await write(earlier.host, earlier.id, todos(["Left by an earlier session", "pending"]));
	const { host, id } = await startLead();
	const refused = await write(host, id, { ...todos(["A different plan", "pending"]), ref: ticket });
	expect(refused.status).toBe("error");
	expect(refused.text).toContain("- [ ] Left by an earlier session");
	expect(refused.text).toContain("Send the list again with these items in it");
	expect(refused.text).not.toMatch(/replace: true|call init/);
	const accepted = await write(host, id, { ...todos(["Left by an earlier session", "pending"], ["A different plan", "pending"]), ref: ticket });
	expect(accepted.status, accepted.text).toBe("completed");
	expect((await childrenOf(ticket)).map(c => c.title)).toEqual(["Left by an earlier session", "A different plan"]);
});

test("a saved session that was deleted while no instance ran is ended by the next setup", async () => {
	const { host, id } = await startLead();
	await write(host, id, todos(["Only item", "in_progress"]));
	const ref = qref(await parentOf(id));
	await write(host, id, todos({ content: "Only item", status: "completed", message, evidence }));
	await host.shutdown();
	expect(savedOf(host, id).entries).toBe(true);
	// No event reaches a location that has no instance: the next setup learns it from OpenCode.
	host.sessions.delete(id);
	const restarted = await restart(host);
	expect(await until(() => forgotten(restarted, id))).toBe(true);
	expect((await show(ref)).issue).toMatchObject({ status: "closed", closed_reason: "done" });
});

test("a saved session whose resume is still reading storage when the instance stops is not bound after the stop", async () => {
	let gate: Promise<void> | undefined;
	// Holds the resume at its read of the session's `ended` part.
	const gated: typeof opencode = { id: opencode.id, async setup(ctx: any) {
		const get = ctx.storage.get;
		ctx.storage.get = async (key: string) => { if (key.endsWith("/ended")) await gate; return get(key); };
		return opencode.setup(ctx);
	} };
	const host = await startHost({ plugin: gated });
	const id = newSession(host).id;
	// A deferred close is saved work: the next setup resumes the session for it.
	await write(host, id, todos(["Throttled item", "in_progress"]));
	throttleCloses();
	const deferred = await write(host, id, todos({ content: "Throttled item", status: "completed", message, evidence }));
	expect(deferred.text).toContain("deferred");
	await host.shutdown();
	forgetCalls();
	const release = Promise.withResolvers<void>();
	gate = release.promise;
	const restarted = await restart(host);
	const stopping = restarted.shutdown();
	// The cleanup has stopped the instance and waits for the resume.
	await settle(100);
	release.resolve();
	await stopping;
	await settle(300);
	expect(kataCalls()).toEqual([]);
});

test("a second lead on the same ticket is refused an item the first started, and takeover: true takes it over", async () => {
	const created = await kata(["create", "Ticket two leads plan under", "--body", "Shared by two sessions.", "--project", PROJECT, "--force-new", "--json"]);
	const ticket = `${PROJECT}#${created.issue.short_id}`;
	const a = await startLead({ ref: ticket });
	await write(a.host, a.id, todos(["Shared item", "in_progress"]));
	const b = await startLead({ ref: ticket });
	const done = todos({ content: "Shared item", status: "completed", message, evidence });
	const refused = await write(b.host, b.id, done);
	expect(refused.status).toBe("error");
	expect(refused.text).toContain("takeover: true");
	// The text speaks todowrite's interface, not the omp todo tool's.
	expect(refused.text).not.toMatch(/todo op=|todo start|repeat the call/);
	expect(refused.text).toContain("send the list again with takeover: true");
	expect(currentList(refused.text)).toEqual([{ content: "Shared item", status: "in_progress" }]);
	const [before] = await childrenOf(ticket);
	expect(statusOf(before)).toBe("in_progress");

	const taken = await write(b.host, b.id, { ...done, takeover: true });
	expect(taken.status, taken.text).toBe("completed");
	const [after] = await childrenOf(ticket);
	expect(after.status).toBe("closed");
	const comments = (await show(qref(after))).comments ?? [];
	expect(comments.some((c: any) => /Taken over by session .* from session .*, which started it/.test(c.body))).toBe(true);

	// A flag that is not a boolean is an error, not a silent no-takeover.
	const bad = await write(b.host, b.id, { ...done, takeover: "yes" });
	expect(bad.status).toBe("error");
	expect(bad.text).toContain("takeover must be a boolean");
});

test("contents with surrounding spaces, an inner newline and 600 characters resend as the same list with no ops", async () => {
	const { host, id } = await startLead();
	const contents = ["  padded on both sides  ", "first line\nsecond line", `long ${"x".repeat(600)}`, "tab\tand  double  spaces"];
	const first = await write(host, id, { todos: contents.map(content => ({ content, status: "pending" })) });
	expect(first.status, first.text).toBe("completed");
	const ref = qref(await parentOf(id));
	expect((await childrenOf(ref)).map(c => c.title)).toEqual(contents);
	forgetCalls();
	const again = await write(host, id, { todos: contents.map(content => ({ content, status: "pending" })) });
	expect(again.status, again.text).toBe("completed");
	expect(kataCalls().filter(line => /^(create|claim|meta|close|comment)\b/.test(line))).toEqual([]);
	// The list a refusal carries is the same text and is accepted too.
	const refused = await write(host, id, { todos: contents.slice(1).map(content => ({ content, status: "pending" })) });
	expect(refused.status).toBe("error");
	expect(currentList(refused.text).map((item: any) => item.content)).toEqual(contents);
	const accepted = await write(host, id, { todos: currentList(refused.text) });
	expect(accepted.status, accepted.text).toBe("completed");
});

test("a plan made elsewhere with one title in two phases shows it once, and a change applies to both copies", async () => {
	const { host, id } = await startLead();
	await write(host, id, todos(["Plan opener", "pending"]));
	const ref = qref(await parentOf(id));
	for (const phase of ["Design", "Build"]) {
		await kata(["create", "--parent", ref, "--project", PROJECT, "--meta", `todo.phase=${phase}`, "--meta", "todo.status=pending", "--force-new", "--json", "--", "Review the API"]);
	}
	const refused = await write(host, id, todos(["Plan opener", "pending"]));
	expect(refused.status).toBe("error");
	expect(currentList(refused.text)).toEqual([{ content: "Plan opener", status: "pending" }, { content: "Review the API", status: "pending" }]);
	const sent = await write(host, id, { todos: currentList(refused.text) });
	expect(sent.status, sent.text).toBe("completed");
	const started = await write(host, id, todos(["Plan opener", "pending"], ["Review the API", "in_progress"]));
	expect(started.status, started.text).toBe("completed");
	expect((await childrenOf(ref)).map(c => [c.title, statusOf(c)])).toEqual([["Plan opener", "pending"], ["Review the API", "in_progress"], ["Review the API", "in_progress"]]);
	const finished = await write(host, id, todos(["Plan opener", "pending"], { content: "Review the API", status: "completed", message, evidence }));
	expect(finished.status, finished.text).toBe("completed");
	expect((await childrenOf(ref)).map(c => [c.title, statusOf(c)])).toEqual([["Plan opener", "pending"], ["Review the API", "closed:done"], ["Review the API", "closed:done"]]);
});
