import { expect, test } from "bun:test";
import { eventually } from "./kata-fixture";
import { v2Fixture } from "./v2-fixture";
import { kataViews } from "./omp-host";
import { isRead } from "../core/kata-cli";

// The omp adapter against a real Kata, driven through omp's native todo: plan items that name tickets (their guard, mirror and
// comments), delegates working a ticket an item names, and the guard's check of an init against the plan's open tasks.
// Behaviour that only the other hosts' todo tool still has (done with evidence, block, replace, held ticket closes) is in pi-tickets.test.ts.
const { scratch, kata, show, issue, host, message, total, commentsOf, sessionParents, closesOf } = v2Fixture();
const namingPlan = (a: string, b: string) => [
  { phase: "Smoke test", items: [`v2test#${a}: write the script`, `v2test#${a}: bump the version`] },
  { phase: "Inbox", items: [`v2test#${b}: fetch the inbox`] },
];
const closeRef = (ref: string, proof: string) => kata(["close", ref, "--done", "--message", message, "--test", proof, "--json"]);
const { labelsOf } = kataViews(show);
const titles = (view: any) => view.children.map((c: any) => c.title);
const notified = (app: { notices: any[][] }, pattern: RegExp) => app.notices.some(args => pattern.test(String(args[0])));
const begin = async () => { const app = host(); await app.event("session_start"); return app; };
const adopt = (app: { event: (name: string, data?: unknown) => Promise<unknown> }, ref: string) => app.event("input", { text: `/todo ref ${ref}`, source: "interactive" });
const kataWrites = (calls: string[][]) => calls.filter(args => !isRead(args));

test("a plan whose items name tickets creates no issue and no automatic parent", async () => {
  const app = await begin();
  const [a, b] = [await issue("Ticket A"), await issue("Ticket B")];
  const before = await total();
  const result = await app.call({ op: "init", list: namingPlan(a, b) });
  expect(result.isError).toBeUndefined();
  expect(await total()).toBe(before);
  expect(await sessionParents(app.sid)).toHaveLength(0);
  expect(app.list().map(phase => phase.name)).toEqual(["Smoke test", "Inbox"]);
  expect(app.list()[0].tasks[0]).toEqual({ content: `v2test#${a}: write the script`, status: "in_progress" });
  const started = (await show(a)).issue;
  expect(started.owner).toBe("v2-builder");
  expect(started.metadata["todo.status"]).toBe("in_progress");
  expect(started.metadata["todo.phase"]).toBeUndefined();
  expect((await show(b)).issue.owner).toBeUndefined();
});

test("an item without a ref in a plan of tickets creates exactly that issue and the automatic parent", async () => {
  const app = await begin();
  const [a, b] = [await issue("Ticket A"), await issue("Ticket B")];
  await app.call({ op: "init", list: namingPlan(a, b) });
  const before = await total();
  const appended = await app.call({ op: "append", items: ["update CHANGELOG"], phase: "Inbox" });
  expect(appended.isError).toBeUndefined();
  expect(await total()).toBe(before + 2);
  const parents = await sessionParents(app.sid);
  expect(parents).toHaveLength(1);
  expect(titles(await show(parents[0].qualified_id))).toEqual(["update CHANGELOG"]);
  expect(parents[0].metadata["omp.auto_parent"]).toBe(true);
  expect((await show(a)).issue.metadata["omp.session_id"]).toBeUndefined();
  expect(app.list().find(phase => phase.name === "Inbox")!.tasks.map(task => task.content)).toContain("update CHANGELOG");
});

test("a plan mixing a plain item and a ticket item creates a child for the plain item only", async () => {
  const app = await begin();
  const a = await issue("Ticket A");
  const before = await total();
  const init = await app.call({ op: "init", items: ["update the docs", `v2test#${a}: write the script`] });
  expect(init.isError).toBeUndefined();
  expect(await total()).toBe(before + 2); // the automatic parent and the plain item's child
  const parents = await sessionParents(app.sid);
  expect(parents).toHaveLength(1);
  expect(titles(await show(parents[0].qualified_id))).toEqual(["update the docs"]);
  expect((await show(a)).issue.metadata["omp.session_id"]).toBeUndefined();
});

test("with /todo ref, items without a ref become children of it and named items stay on their tickets", async () => {
  const [parent, a] = [await issue("Umbrella"), await issue("Ticket A")];
  const app = await begin();
  await adopt(app, `v2test#${parent}`);
  const before = await total();
  const result = await app.call({ op: "init", items: [`v2test#${a}: write the script`, "update the docs"] });
  expect(result.isError).toBeUndefined();
  expect(await total()).toBe(before + 1);
  expect(titles(await show(`v2test#${parent}`))).toEqual(["update the docs"]);
  expect((await show(a)).issue.metadata["todo.phase"]).toBeUndefined();
});

test("a non-last item of a ticket is done with a comment on the ticket; the last needs the ticket closed first", async () => {
  const app = await begin();
  const a = await issue("Ticket A");
  const [first, second] = [`v2test#${a}: write the script`, `v2test#${a}: bump the version`];
  await app.call({ op: "init", items: [first, second] });
  const done = await app.call({ op: "done", task: first });
  expect(done.isError).toBeUndefined();
  expect(app.list()[0].tasks.map(task => task.status)).toEqual(["completed", "in_progress"]);
  expect((await show(a)).issue.status).toBe("open");
  expect(await labelsOf(a)).not.toContain("needs-review");
  let comments = await commentsOf(a);
  expect(comments).toHaveLength(1);
  expect(comments[0]).toContain("Todo item done");
  expect(comments[0]).toContain("write the script");
  expect(comments[0]).not.toContain("without a Kata close");
  const refused = await app.call({ op: "done", task: second });
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toContain("Close the ticket first");
  expect(refused.content[0].text).toContain(`v2test#${a}`);
  expect(app.list()[0].tasks[1].status).toBe("in_progress");
  expect((await show(a)).issue.status).toBe("open");
  await closeRef(`v2test#${a}`, "second item check");
  const last = await app.call({ op: "done", task: second });
  expect(last.isError).toBeUndefined();
  expect(app.list()[0].tasks.map(task => task.status)).toEqual(["completed", "completed"]);
  expect((await show(a)).issue.status).toBe("closed");
  comments = await commentsOf(a);
  expect(comments).toHaveLength(1);
  const closes = await closesOf(a);
  expect(closes).toHaveLength(1);
  expect(closes[0].payload.evidence).toEqual([{ type: "test", command: "second item check" }]);
});

test("the only item of a ticket is done after the ticket's close; an item removed and appended again once its ticket is closed is reported, not reopened", async () => {
  const app = await begin();
  const a = await issue("Ticket A");
  const item = `v2test#${a}: write the script`;
  const before = await total();
  const init = await app.call({ op: "init", items: [item] });
  expect(init.isError).toBeUndefined();
  const refused = await app.call({ op: "done", task: item });
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toContain("Close the ticket first");
  await closeRef(`v2test#${a}`, "ticket item check");
  const done = await app.call({ op: "done", task: item });
  expect(done.isError).toBeUndefined();
  expect((await app.call({ op: "rm", task: item })).isError).toBeUndefined();
  const reappended = await app.call({ op: "append", items: [item] });
  expect(reappended.isError).toBeUndefined();
  expect(notified(app, /already closed/i)).toBe(true);
  expect((await show(a)).issue.status).toBe("closed");
  expect(app.calls.some(c => c[0] === "reopen")).toBe(false);
  expect(await total()).toBe(before);
  expect(await sessionParents(app.sid)).toHaveLength(0);
});

test("a ticket item saved in a list edit as completed, without a close, comments on its ticket; the last open one labels the ticket needs-review", async () => {
  const app = await begin();
  const a = await issue("Ticket A");
  await app.call({ op: "init", items: [`v2test#${a}: write the script`, `v2test#${a}: bump the version`] });
  const phases = app.list();
  phases[0].tasks[0].status = "completed";
  await app.edit(phases);
  expect(await labelsOf(a)).not.toContain("needs-review");
  expect(await commentsOf(a)).toHaveLength(1);
  expect((await commentsOf(a))[0]).toContain("Todo item done");
  expect((await commentsOf(a))[0]).toContain("write the script");
  expect((await commentsOf(a))[0]).not.toContain("without a Kata close");
  phases[0].tasks[1].status = "completed";
  await app.edit(phases);
  const comments = await commentsOf(a);
  expect(comments.some(c => c.includes("write the script"))).toBe(true);
  expect(comments.some(c => c.includes("bump the version"))).toBe(true);
  expect(comments).toHaveLength(2);
  expect(comments[0]).toContain("Todo item done");
  expect(comments[0]).not.toContain("without a Kata close");
  expect(comments[1]).toContain("without a Kata close");
  expect(comments[1]).toContain("bump the version");
  expect(await labelsOf(a)).toContain("needs-review");
  expect((await show(a)).issue.status).toBe("open");
  expect(await closesOf(a)).toHaveLength(0);
});

test("completing the one item omp lists does not flag the ticket last while another item of it, never in omp's list, is still open", async () => {
  const app = await begin();
  const a = await issue("Ticket A");
  const [first, second] = [`v2test#${a}: write the script`, `v2test#${a}: bump the version`];
  await app.call({ op: "init", items: [first, second] });
  // A resumed session whose omp list never held the second item: the plan has it, omp's last-seen list does not. No list sequence
  // reaches it (a dropped item leaves the plan too), so the saved snapshot's memory of omp's list is edited.
  const entries = structuredClone(app.entries);
  for (const entry of entries) if (entry.data?.native?.prev) delete entry.data.native.prev[second];
  const resumed = host({ sid: app.sid, entries });
  await resumed.event("session_start");
  await resumed.edit([{ name: "Tasks", tasks: [{ content: first, status: "completed" }] }]);
  expect(await labelsOf(a)).not.toContain("needs-review");
  const comments = await commentsOf(a);
  expect(comments).toHaveLength(1);
  expect(comments[0]).toContain("Todo item done");
  expect(comments[0]).toContain("write the script");
  expect(comments[0]).not.toContain("without a Kata close");
  expect((await show(a)).issue.status).toBe("open");
  expect(await closesOf(a)).toHaveLength(0);
});

test("an unresolvable or closed ticket in the list is reported and creates nothing; a bare id names no ticket", async () => {
  const ghostApp = await begin();
  let before = await total();
  const ghost = await ghostApp.call({ op: "init", items: ["Plain item first", "v2test#zzzz: ghost work"] });
  expect(ghost.isError).toBeUndefined(); // omp's list takes it; the mirror into Kata fails
  expect(notified(ghostApp, /v2test#zzzz/)).toBe(true);
  // The mirror creates what it can: the plain item under an automatic parent, never the ghost's ticket.
  expect(await total()).toBe(before + 2);
  const ghostParents = await sessionParents(ghostApp.sid);
  expect(ghostParents).toHaveLength(1);
  expect(titles(await show(ghostParents[0].qualified_id))).toEqual(["Plain item first"]);

  const closedApp = await begin();
  const closed = await issue("Closed work"); await closeRef(closed, "closed-item-fixture");
  before = await total();
  const done = await closedApp.call({ op: "init", items: [`v2test#${closed}: more work`] });
  expect(done.isError).toBeUndefined();
  expect(notified(closedApp, /already closed/i)).toBe(true);
  expect(await total()).toBe(before);
  expect(await sessionParents(closedApp.sid)).toHaveLength(0);

  const bareApp = await begin();
  const open = await issue("Open work");
  const bare = await bareApp.call({ op: "init", items: [`${open}: bare id is only text`] });
  expect(bare.isError).toBeUndefined();
  expect((await show(open)).issue.owner).toBeUndefined();
  expect(await sessionParents(bareApp.sid)).toHaveLength(1);
});

test("drop and rm of an item that names a ticket only comment and leave it open", async () => {
  const app = await begin();
  const a = await issue("Ticket A");
  await app.call({ op: "init", items: [`v2test#${a}: first step`, `v2test#${a}: second step`] });
  const dropped = await app.call({ op: "drop", task: `v2test#${a}: first step` });
  expect(dropped.isError).toBeUndefined();
  expect(app.list()[0].tasks[0].status).toBe("abandoned");
  const removed = await app.call({ op: "rm", task: `v2test#${a}: second step` });
  expect(removed.isError).toBeUndefined();
  const shown = (await show(a)).issue;
  expect(shown.status).toBe("open");
  expect(shown.closed_reason).toBeFalsy();
  const comments = await commentsOf(a);
  expect(comments).toHaveLength(2);
  expect(comments[0]).toContain("dropped in omp's todo list");
  expect(comments[1]).toContain("removed from omp's todo list");
  expect(await closesOf(a)).toHaveLength(0);
});

test("an item that stops working a ticket resets its work state", async () => {
  const app = await begin();
  const a = await issue("Ticket A");
  await app.call({ op: "init", items: [`v2test#${a}: only step`] });
  expect((await show(a)).issue.metadata["todo.status"]).toBe("in_progress");
  await app.call({ op: "drop", task: `v2test#${a}: only step` });
  const dropped = (await show(a)).issue;
  expect(dropped.status).toBe("open");
  expect(dropped.metadata["todo.status"]).toBe("pending");
  expect(dropped.metadata["work.attention"]).toBe("ok");
  expect(dropped.metadata["work.attention_msg"]).toBeUndefined();
});

test("an item removed and appended again once its ticket is reopened is done after the ticket's second close", async () => {
  const app = await begin();
  const a = await issue("Ticket A");
  const item = `v2test#${a}: repeat step`;
  await app.call({ op: "init", items: [item] });
  await closeRef(`v2test#${a}`, "first close");
  expect((await app.call({ op: "done", task: item })).isError).toBeUndefined();
  expect((await show(a)).issue.status).toBe("closed");
  await kata(["reopen", a, "--json"]);
  expect((await app.call({ op: "rm", task: item })).isError).toBeUndefined();
  const again = await app.call({ op: "append", items: [item] });
  expect(again.isError).toBeUndefined();
  const refused = await app.call({ op: "done", task: item });
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toContain("Close the ticket first");
  await closeRef(`v2test#${a}`, "second close");
  const second = await app.call({ op: "done", task: item });
  if (second.isError) throw new Error(second.content[0].text);
  expect((await show(a)).issue.status).toBe("closed");
  expect(await closesOf(a)).toHaveLength(2);
});

test("a ticket another writer owns or that closed meanwhile is reported, never a fallback or a reopen", async () => {
  const app = await begin();
  const foreign = await issue("Foreign work"); await kata(["claim", foreign, "--as", "someone-else", "--json"]);
  const before = await total();
  expect((await app.call({ op: "init", items: [`v2test#${foreign}: take it over`] })).isError).toBeUndefined();
  expect(notified(app, /someone-else|not owned/)).toBe(true);
  expect(await total()).toBe(before);
  expect((await show(foreign)).issue.owner).toBe("someone-else");

  const late = await begin();
  const a = await issue("Ticket A");
  await late.call({ op: "init", items: [`v2test#${a}: first step`, `v2test#${a}: second step`] });
  await closeRef(`v2test#${a}`, "closed-meanwhile");
  const restart = await late.call({ op: "start", task: `v2test#${a}: second step` });
  expect(restart.isError).toBeUndefined();
  expect(notified(late, /already closed/i)).toBe(true);
  expect((await late.call({ op: "done", task: `v2test#${a}: first step` })).isError).toBeUndefined();
  expect((await show(a)).issue.status).toBe("closed");
  expect(late.calls.some(c => c[0] === "reopen")).toBe(false);
  expect(await commentsOf(a)).toHaveLength(0);
});

test("done on the last item of a ticket with open children is refused until the ticket is closed, and leaves it open", async () => {
  const app = await begin();
  const umbrella = await issue("Umbrella");
  await issue("Child work", { parent: umbrella });
  await app.call({ op: "init", items: [`v2test#${umbrella}: finish the umbrella`] });
  const refused = await app.call({ op: "done", task: `v2test#${umbrella}: finish the umbrella` });
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toContain("Close the ticket first");
  expect(app.list()[0].tasks[0].status).toBe("in_progress");
  expect((await show(umbrella)).issue.status).toBe("open");
  expect(await commentsOf(umbrella)).toHaveLength(0);
  expect(await closesOf(umbrella)).toHaveLength(0);
});

test("a claimed ticket named by an item: its last item waits for the ticket's close, which waits for its plan children", async () => {
  const app = await begin();
  const ticket = await issue("Claimed ticket"); await kata(["claim", ticket, "--json"]);
  await app.event("tool_result", { toolName: "bash", input: { command: `kata claim v2test#${ticket}` }, isError: false, details: { exitCode: 0 } });
  const item = `v2test#${ticket}: write the greeting`;
  const init = await app.call({ op: "init", items: [item, "Add the ignore file"] });
  expect(init.isError, init.content[0].text).toBeUndefined();
  expect(titles(await show(ticket))).toEqual(["Add the ignore file"]);
  const refused = await app.call({ op: "done", task: item });
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toContain("Close the ticket first");
  const child = (await show(ticket)).children[0].short_id;
  await closeRef(`v2test#${child}`, "child evidence");
  expect((await app.call({ op: "done", task: "Add the ignore file" })).isError).toBeUndefined();
  expect((await show(ticket)).issue.status).toBe("open");
  await closeRef(`v2test#${ticket}`, "ticket item evidence");
  const last = await app.call({ op: "done", task: item });
  expect(last.isError, last.content[0].text).toBeUndefined();
  const closed = await show(ticket);
  expect(closed.issue.status).toBe("closed");
  expect(await closesOf(ticket)).toHaveLength(1);
  expect((await closesOf(ticket))[0].payload.evidence).toEqual([{ type: "test", command: "ticket item evidence" }]);
});

test("a task delegated to an item that names a ticket works that ticket and creates no issue", async () => {
  const app = await begin();
  const a = await issue("Ticket A");
  const item = `v2test#${a}: write the widget parser`;
  await app.call({ op: "init", items: [item] });
  const before = await total();
  await app.event("tool_call", { toolName: "task", toolCallId: "named-item", input: { name: "Parser", task: `Work v2test#${a} and report back.` } });
  app.emit("task:subagent:lifecycle", { id: "named-item", status: "started", sessionFile: `${scratch}/named-item.jsonl`, parentToolCallId: "named-item", index: 0 });
  await eventually(async () => (await show(a)).issue.metadata?.["omp.subagent_id"], "named-item");
  expect(await total()).toBe(before);
  expect(await sessionParents(app.sid)).toHaveLength(1); // the delegated ticket itself
  const refused = await app.call({ op: "done", task: item });
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toMatch(/delegated/i);
  expect(app.list()[0].tasks[0].status).toBe("in_progress");
});

test("when a delegate closes the ticket an item names, no reminder is due and done on its item is no error and leaves no comment", async () => {
  const app = await begin();
  const a = await issue("Ticket A");
  const item = `v2test#${a}: write the gadget parser`;
  await app.call({ op: "init", items: [item] });
  await app.event("tool_call", { toolName: "task", toolCallId: "follow", input: { name: "Parser", task: `Finish v2test#${a} and close it.` } });
  app.emit("task:subagent:lifecycle", { id: "follow", status: "started", sessionFile: `${scratch}/follow.jsonl`, parentToolCallId: "follow", index: 0 });
  await eventually(async () => (await show(a)).issue.metadata?.["omp.subagent_id"], "follow");
  await closeRef(`v2test#${a}`, "delegate-closed-it");
  expect(await app.event("session_stop", { messages: [] })).toBeUndefined();
  expect((await app.call({ op: "done", task: item })).isError).toBeUndefined();
  expect(app.list()[0].tasks.map(task => task.status)).toEqual(["completed"]);
  expect(await commentsOf(a)).toHaveLength(0);
});

test("a ticket named by two open items is not delegated: its delegate would close the ticket under the other item", async () => {
  const app = await begin();
  const a = await issue("Ticket A");
  await app.call({ op: "init", items: [`v2test#${a}: write the gadget parser`, `v2test#${a}: document the gadget parser`] });
  const input = { name: "Parser", task: `Finish v2test#${a} and close it.` };
  expect(await app.event("tool_call", { toolName: "task", toolCallId: "shared", input })).toMatchObject({ block: true, reason: expect.stringContaining("other open plan items name it") });
  expect((await show(a)).issue.metadata?.["omp.subagent_id"]).toBeUndefined();
});

test("an item whose ticket was closed wontfix elsewhere is done without a refusal or a comment", async () => {
  const app = await begin();
  const a = await issue("Ticket A");
  const item = `v2test#${a}: only step`;
  await app.call({ op: "init", items: [item] });
  await kata(["close", a, "--wontfix", "--message", "Closed by someone else because this work is no longer wanted by anyone here.", "--json"]);
  const done = await app.call({ op: "done", task: item });
  expect(done.isError).toBeUndefined();
  expect(app.list()[0].tasks[0].status).toBe("completed");
  expect(await commentsOf(a)).toHaveLength(0);
  expect((await show(a)).issue.closed_reason).toBe("wontfix");
});

test("init refuses a plan with open tasks left out, naming them, and writes nothing to Kata", async () => {
  const app = host(); await app.event("session_start"); const parent = await app.init(["Started task", "Waiting task", "Pending task"]);
  await app.call({ op: "start", task: "Waiting task" });
  const before = await show(parent);
  const mark = app.calls.length;
  const result = await app.call({ op: "init", items: ["Brand new task"] });
  expect(result.isError).toBe(true);
  const text = result.content[0].text;
  for (const title of ["Started task", "Waiting task", "Pending task"]) expect(text).toContain(title);
  expect(text).toContain("todo drop");
  expect(kataWrites(app.calls.slice(mark))).toEqual([]);
  expect(await show(parent)).toEqual(before);
  expect(app.list()[0].tasks.map(task => task.content)).toEqual(["Started task", "Waiting task", "Pending task"]);
});

test("init goes through when the new list keeps every open task", async () => {
  const app = host(); await app.event("session_start"); const parent = await app.init(["One", "Two"]);
  const result = await app.call({ op: "init", items: ["One", "Two", "Three"] });
  expect(result.isError, result.content[0].text).toBeUndefined();
  const children = (await show(parent)).children;
  expect(children.map((c: any) => c.title).sort()).toEqual(["One", "Three", "Two"]);
  expect(children.every((c: any) => c.status === "open")).toBe(true);
});

test("init names only the open tasks the new list leaves out", async () => {
  const app = host(); await app.event("session_start"); const parent = await app.init(["One", "Two", "Three"]);
  const before = await show(parent);
  const mark = app.calls.length;
  const result = await app.call({ op: "init", items: ["One", "Four"] });
  expect(result.isError).toBe(true);
  const text = result.content[0].text;
  expect(text).toContain("Two"); expect(text).toContain("Three");
  expect(text).not.toContain("One"); expect(text).not.toContain("Four");
  expect(kataWrites(app.calls.slice(mark))).toEqual([]);
  expect(await show(parent)).toEqual(before);
});

test("init that leaves out an open ticket item is not refused; the ticket stays open and gets one comment", async () => {
  const ticket = `v2test#${await issue("Named work")}`;
  const app = await begin();
  await app.call({ op: "init", items: [`${ticket}: do the named work`] });
  const result = await app.call({ op: "init", items: ["Something else"] });
  expect(result.isError).toBeUndefined();
  expect((await show(ticket)).issue.status).toBe("open");
  expect(await closesOf(ticket)).toHaveLength(0);
  const comments = await commentsOf(ticket);
  expect(comments).toHaveLength(1);
  expect(comments[0]).toContain("removed from omp's todo list");
});

test("init needs no drop once every task of the plan is closed", async () => {
  const ref = `v2test#${await issue()}`;
  const app = await begin();
  await adopt(app, ref);
  await app.call({ op: "init", items: ["Only task"] });
  const child = (await show(ref)).children.find((c: any) => c.title === "Only task");
  await closeRef(`v2test#${child.short_id}`, "only task check");
  expect((await app.call({ op: "done", task: "Only task" })).isError).toBeUndefined();
  const result = await app.call({ op: "init", items: ["Follow-up task"] });
  expect(result.isError, result.content[0].text).toBeUndefined();
  expect((await show(ref)).children.find((c: any) => c.title === "Follow-up task").status).toBe("open");
});
