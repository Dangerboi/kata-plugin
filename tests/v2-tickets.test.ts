import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { v2Fixture } from "./v2-fixture";

// The omp adapter against a real Kata: plan items that name tickets, and init with or without replace.
const { scratch, outside, run, kata, show, issue, unique, host, down, evidence, message, total, commentsOf } = v2Fixture();

const ofSession = async (sid: string) => (await kata(["list", "--status", "all", "--meta", `omp.session_id=${sid}`, "--json"])).issues;
const closesOf = async (short: string) => (await kata(["audit", "closes", "--json"])).rows.filter((r: any) => r.issue === short);
const namingPlan = (a: string, b: string) => [
  { phase: "Smoke test", items: [`v2test#${a}: write the script`, `v2test#${a}: bump the version`] },
  { phase: "Inbox", items: [`v2test#${b}: fetch the inbox`] },
];

test("a plan whose items name tickets creates no issue and no automatic parent", async () => {
  const app = host(); await app.event("session_start");
  const [a, b] = [await issue("Ticket A"), await issue("Ticket B")];
  const before = await total();
  const result = await app.call({ op: "init", list: namingPlan(a, b) });
  expect(result.isError).toBeUndefined();
  expect(await total()).toBe(before);
  expect(await ofSession(app.sid)).toHaveLength(0);
  expect(result.details.kata.parent).toBeUndefined();
  const text = result.content[0].text;
  expect(text).toContain(`[/] v2test#${a}: write the script (v2test#${a})`);
  expect(text).toContain(`[ ] v2test#${b}: fetch the inbox (v2test#${b})`);
  const started = (await show(a)).issue;
  expect(started.owner).toBe("v2-builder");
  expect(started.metadata["todo.status"]).toBe("in_progress");
  expect(started.metadata["todo.phase"]).toBeUndefined();
  expect((await show(b)).issue.owner).toBeUndefined();
  expect(app.widgets.at(-1)![1]![0]).toContain(`v2test#${a}: write the script`);
});

test("an item without a ref in a plan of tickets creates exactly that issue and the automatic parent", async () => {
  const app = host(); await app.event("session_start");
  const [a, b] = [await issue("Ticket A"), await issue("Ticket B")];
  await app.call({ op: "init", list: namingPlan(a, b) });
  const before = await total();
  const appended = await app.call({ op: "append", items: ["update CHANGELOG"], phase: "Inbox" });
  expect(appended.isError).toBeUndefined();
  expect(await total()).toBe(before + 2);
  const [parent, ...rest] = [await ofSession(app.sid)].flatMap(list => list.sort((x: any, y: any) => x.id - y.id));
  expect(rest).toHaveLength(0);
  const ref = appended.details.kata.parent;
  expect((await show(ref)).children.map((c: any) => c.title)).toEqual(["update CHANGELOG"]);
  expect(parent.metadata["omp.auto_parent"]).toBe(true);
  expect((await show(a)).issue.metadata["omp.session_id"]).toBeUndefined();
  expect(appended.content[0].text).toContain("update CHANGELOG");
});

test("with an init ref, items without a ref become children of it and named items stay on their tickets", async () => {
  const [parent, a] = [await issue("Umbrella"), await issue("Ticket A")];
  const app = host(); await app.event("session_start");
  const before = await total();
  const result = await app.call({ op: "init", ref: parent, items: [`v2test#${a}: write the script`, "update the docs"] });
  expect(result.isError).toBeUndefined();
  expect(await total()).toBe(before + 1);
  expect((await show(`v2test#${parent}`)).children.map((c: any) => c.title)).toEqual(["update the docs"]);
  expect((await show(a)).issue.metadata["todo.phase"]).toBeUndefined();
});

test("finishing every item of a ticket closes it once with the last item's evidence, earlier items leave comments", async () => {
  const app = host(); await app.event("session_start");
  const a = await issue("Ticket A");
  await app.call({ op: "init", items: [`v2test#${a}: write the script`, `v2test#${a}: bump the version`] });
  const first = await app.call({ op: "done", task: `v2test#${a}: write the script`, message: `${message} (first part)`, evidence: ["test:first item check"] });
  expect(first.isError).toBeUndefined();
  expect((await show(a)).issue.status).toBe("open");
  let comments = await commentsOf(a);
  expect(comments).toHaveLength(1);
  expect(comments[0]).toContain("write the script");
  expect(comments[0]).toContain("(first part)");
  expect(comments[0]).toContain("test:first item check");
  expect(first.content[0].text).toContain(`[/] v2test#${a}: bump the version`);
  const last = await app.call({ op: "done", task: `v2test#${a}: bump the version`, message: `${message} (second part)`, evidence: ["test:second item check"] });
  expect(last.isError).toBeUndefined();
  expect((await show(a)).issue.status).toBe("closed");
  comments = await commentsOf(a);
  expect(comments).toHaveLength(2);
  expect(comments[1]).toContain("test:second item check");
  const rows = await closesOf(a);
  expect(rows).toHaveLength(1);
  const event = (await kata(["events", "--after", String(rows[0].event_id - 1), "--limit", "1", "--json"])).events[0];
  expect(event.payload.evidence).toEqual([{ type: "test", command: "second item check" }]);
  expect(last.content[0].text).toContain("2/2 done");
});

test("appending a ticket item again in a plan of only tickets works without a parent issue", async () => {
  const app = host(); await app.event("session_start");
  const a = await issue("Ticket A");
  const before = await total();
  const init = await app.call({ op: "init", items: [`v2test#${a}: write the script`] });
  expect(init.isError).toBeUndefined();
  const again = await app.call({ op: "append", task: `v2test#${a}: write the script` });
  expect(again.isError).toBeUndefined();
  expect(again.content[0].text).toContain(`v2test#${a}: write the script`);
  const done = await app.call({ op: "done", task: `v2test#${a}: write the script`, message, evidence: ["test:ticket item check"] });
  expect(done.isError).toBeUndefined();
  const reappended = await app.call({ op: "append", task: `v2test#${a}: write the script` });
  expect(reappended.isError).toBe(true);
  expect(reappended.content[0].text).toMatch(/already closed/i);
  expect(await total()).toBe(before);
  expect(await ofSession(app.sid)).toHaveLength(0);
});

test("appending an open ticket item again in a plan with a parent creates no child and no error", async () => {
  const app = host(); await app.event("session_start");
  const a = await issue("Ticket A");
  const init = await app.call({ op: "init", items: ["update the docs", `v2test#${a}: write the script`] });
  expect(init.isError).toBeUndefined();
  const ref = init.details.kata.parent;
  const before = await total();
  const again = await app.call({ op: "append", task: `v2test#${a}: write the script` });
  expect(again.isError).toBeUndefined();
  expect(await total()).toBe(before);
  expect((await show(ref)).children.map((c: any) => c.title)).toEqual(["update the docs"]);
});

test("an unresolvable or closed ref is an error that creates nothing; a bare id names no ticket", async () => {
  const app = host(); await app.event("session_start");
  const before = await total();
  const ghost = await app.call({ op: "init", items: ["Plain item first", "v2test#zzzz: ghost work"] });
  expect(ghost.isError).toBe(true);
  expect(ghost.content[0].text).toContain("v2test#zzzz");
  expect(await total()).toBe(before);
  expect(await ofSession(app.sid)).toHaveLength(0);
  const closed = await issue("Closed work"); await kata(["close", closed, "--done", "--message", message, "--test", "closed-item-fixture", "--json"]);
  const done = await app.call({ op: "init", items: [`v2test#${closed}: more work`] });
  expect(done.isError).toBe(true);
  expect(done.content[0].text).toMatch(/already closed/i);
  expect(await total()).toBe(before + 1); // only the ticket this test closed
  const open = await issue("Open work");
  const bare = await app.call({ op: "init", items: [`${open}: bare id is only text`] });
  expect(bare.isError).toBeUndefined();
  expect((await show(open)).issue.owner).toBeUndefined();
  expect((await ofSession(app.sid))).toHaveLength(1);
});

test("drop and rm of an item that names a ticket only comment and leave it open", async () => {
  const app = host(); await app.event("session_start");
  const a = await issue("Ticket A");
  await app.call({ op: "init", items: [`v2test#${a}: first step`, `v2test#${a}: second step`] });
  const dropped = await app.call({ op: "drop", task: `v2test#${a}: first step`, message: "The first step is no longer needed here." });
  expect(dropped.isError).toBeUndefined();
  expect(dropped.content[0].text).toContain(`[~] v2test#${a}: first step`);
  const removed = await app.call({ op: "rm", task: `v2test#${a}: second step`, message: "The second step moved elsewhere." });
  expect(removed.isError).toBeUndefined();
  const shown = (await show(a)).issue;
  expect(shown.status).toBe("open");
  expect(shown.closed_reason).toBeFalsy();
  const comments = await commentsOf(a);
  expect(comments).toHaveLength(2);
  expect(comments[0]).toContain("no longer needed");
  expect(comments[1]).toContain("moved elsewhere");
  expect(await closesOf(a)).toHaveLength(0);
});

test("an item that stops working a ticket resets its work state", async () => {
  const app = host(); await app.event("session_start");
  const a = await issue("Ticket A");
  await app.call({ op: "init", items: [`v2test#${a}: only step`] });
  expect((await show(a)).issue.metadata["todo.status"]).toBe("in_progress");
  await app.call({ op: "drop", task: `v2test#${a}: only step`, message: "No longer needed for this ticket." });
  const dropped = (await show(a)).issue;
  expect(dropped.status).toBe("open");
  expect(dropped.metadata["todo.status"]).toBe("pending");
  expect(dropped.metadata["work.attention"]).toBe("ok");
  expect(dropped.metadata["work.attention_msg"]).toBeUndefined();

  const b = await issue("Ticket B");
  await app.call({ op: "init", items: [`v2test#${b}: first step`, `v2test#${b}: second step`] });
  await app.call({ op: "block", task: `v2test#${b}: first step`, reason: "Waiting on a vendor reply" });
  const done = await app.call({ op: "done", task: `v2test#${b}: first step`, message, evidence });
  expect(done.isError).toBeUndefined();
  const after = (await show(b)).issue;
  expect(after.status).toBe("open");
  expect(after.metadata["work.attention"]).toBe("ok");
  expect(after.metadata["work.attention_msg"]).toBeUndefined();
});

test("an item finished, appended again and finished again comments and closes a second time", async () => {
  const app = host(); await app.event("session_start");
  const a = await issue("Ticket A");
  const item = `v2test#${a}: repeat step`;
  await app.call({ op: "init", items: [item] });
  await app.call({ op: "done", task: item, message, evidence });
  expect((await show(a)).issue.status).toBe("closed");
  await kata(["reopen", a, "--json"]);
  const again = await app.call({ op: "append", items: [item] });
  expect(again.isError).toBeUndefined();
  const second = await app.call({ op: "done", task: item, message, evidence });
  if (second.isError) throw new Error(second.content[0].text);
  expect(second.isError).toBeUndefined();
  expect((await show(a)).issue.status).toBe("closed");
  expect(await commentsOf(a)).toHaveLength(2);
  expect(await closesOf(a)).toHaveLength(2);
});

test("a ticket another writer owns or that closed meanwhile is an error, never a fallback or a reopen", async () => {
  const app = host(); await app.event("session_start");
  const foreign = await issue("Foreign work"); await kata(["claim", foreign, "--as", "someone-else", "--json"]);
  const before = await total();
  const refused = await app.call({ op: "init", items: [`v2test#${foreign}: take it over`] });
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toMatch(/someone-else|not owned/);
  expect(await total()).toBe(before);
  expect((await show(foreign)).issue.owner).toBe("someone-else");
  const a = await issue("Ticket A");
  await app.call({ op: "init", items: [`v2test#${a}: first step`, `v2test#${a}: second step`] });
  await kata(["close", a, "--done", "--message", message, "--test", "closed-meanwhile", "--json"]);
  const restart = await app.call({ op: "start", task: `v2test#${a}: second step` });
  expect(restart.isError).toBe(true);
  expect(restart.content[0].text).toMatch(/already closed/i);
  expect((await app.call({ op: "done", task: `v2test#${a}: first step`, message, evidence })).isError).toBeUndefined();
  expect((await show(a)).issue.status).toBe("closed");
  expect(app.calls.some(c => c[0] === "reopen")).toBe(false);
  expect(await commentsOf(a)).toHaveLength(0);
});

test("a ticket with open children stays open when its last item is done, with a comment saying why", async () => {
  const app = host(); await app.event("session_start");
  const umbrella = await issue("Umbrella");
  await kata(["create", "Child work", "--parent", umbrella, "--force-new", "--json"]);
  await app.call({ op: "init", items: [`v2test#${umbrella}: finish the umbrella`] });
  const done = await app.call({ op: "done", message, evidence });
  expect(done.isError).toBeUndefined();
  expect(done.content[0].text).toContain(`[x] v2test#${umbrella}: finish the umbrella`);
  expect((await show(umbrella)).issue.status).toBe("open");
  const comments = await commentsOf(umbrella);
  expect(comments).toHaveLength(2);
  expect(comments[0]).toContain("test:bun test fixture");
  expect(comments[1]).toMatch(/1 open child/);
  expect(await closesOf(umbrella)).toHaveLength(0);
});

const blockingComments = async (ref: string) => (await commentsOf(ref)).filter(c => /open child|open children/.test(c));
const closeCalls = (app: { calls: string[][] }, ref: string) => app.calls.filter(c => c[0] === "close" && c[1].endsWith(`#${ref}`));

test("a claimed ticket named by an item closes once its plan children close, with the ticket item's evidence", async () => {
  const app = host(); await app.event("session_start");
  const ticket = await issue("Claimed ticket"); await kata(["claim", ticket, "--json"]);
  await app.event("tool_result", { toolName: "bash", input: { command: `kata claim v2test#${ticket}` }, isError: false, details: { exitCode: 0 } });
  const init = await app.call({ op: "init", items: [`v2test#${ticket}: write the greeting`, "Add the ignore file"] });
  expect(init.isError, init.content[0].text).toBeUndefined();
  expect(init.details.kata.parent).toBe(`v2test#${ticket}`);
  await app.call({ op: "done", task: `v2test#${ticket}: write the greeting`, message, evidence: ["test:ticket item evidence"] });
  expect((await show(ticket)).issue.status).toBe("open");
  expect(await blockingComments(ticket)).toHaveLength(1);
  expect((await blockingComments(ticket))[0]).toMatch(/closes once that child is closed/);
  const last = await app.call({ op: "done", task: "Add the ignore file", message, evidence });
  expect(last.isError, last.content[0].text).toBeUndefined();
  const closed = await show(ticket);
  expect(closed.issue.status).toBe("closed");
  expect(await closesOf(ticket)).toHaveLength(1);
  expect(JSON.stringify(closed)).toContain("test:ticket item evidence");
  expect(await blockingComments(ticket)).toHaveLength(1);
});

test("an umbrella ticket stays open after its outside children close, even across resume", async () => {
  const app = host(); await app.event("session_start");
  const umbrella = await issue("Umbrella with outside child"), other = await issue("Other ticket");
  const outside = (await kata(["create", "Outside child", "--parent", umbrella, "--force-new", "--json"])).issue.short_id;
  await app.call({ op: "init", items: [`v2test#${umbrella}: finish the umbrella`, `v2test#${other}: unrelated step`] });
  await app.call({ op: "done", task: `v2test#${umbrella}: finish the umbrella`, message, evidence });
  expect(await blockingComments(umbrella)).toHaveLength(1);
  expect((await blockingComments(umbrella))[0]).toMatch(/outside this todo plan, so close the ticket yourself/);
  await kata(["close", outside, "--done", "--message", message, "--test", "closed outside", "--json"]);
  await app.call({ op: "done", task: `v2test#${other}: unrelated step`, message, evidence });
  const resumed = host({ sid: app.sid, entries: app.entries }); await resumed.event("session_start");
  await resumed.call({ op: "view" }); await resumed.event("session_shutdown");
  expect((await show(umbrella)).issue.status).toBe("open");
  expect(closeCalls(app, umbrella)).toHaveLength(1);
  expect(closeCalls(resumed, umbrella)).toHaveLength(0);
});

test("a ticket whose open child is named by another plan item closes after that child closes", async () => {
  const app = host(); await app.event("session_start");
  const parent = await issue("Parent ticket");
  const child = (await kata(["create", "Named child", "--parent", parent, "--force-new", "--json"])).issue.short_id;
  await app.call({ op: "init", items: [`v2test#${parent}: finish the parent`, `v2test#${child}: finish the child`] });
  await app.call({ op: "done", task: `v2test#${parent}: finish the parent`, message, evidence: ["test:parent item evidence"] });
  expect(await blockingComments(parent)).toHaveLength(1);
  expect((await blockingComments(parent))[0]).toMatch(/closes once that child is closed/);
  const last = await app.call({ op: "done", task: `v2test#${child}: finish the child`, message, evidence });
  expect(last.isError, last.content[0].text).toBeUndefined();
  expect((await show(child)).issue.status).toBe("closed");
  const closed = await show(parent);
  expect(closed.issue.status).toBe("closed");
  expect(JSON.stringify(closed)).toContain("test:parent item evidence");
  expect(await blockingComments(parent)).toHaveLength(1);
});

test("an umbrella ticket whose open child is outside the plan stays open without repeated close attempts or comments", async () => {
  const app = host(); await app.event("session_start");
  const umbrella = await issue("Umbrella"), other = await issue("Other ticket");
  await kata(["create", "Outside child", "--parent", umbrella, "--force-new", "--json"]);
  await app.call({ op: "init", items: [`v2test#${umbrella}: finish the umbrella`, `v2test#${other}: unrelated step`] });
  await app.call({ op: "done", task: `v2test#${umbrella}: finish the umbrella`, message, evidence });
  await app.call({ op: "done", task: `v2test#${other}: unrelated step`, message, evidence });
  await app.call({ op: "view" });
  await app.event("session_shutdown");
  expect((await show(umbrella)).issue.status).toBe("open");
  expect((await show(other)).issue.status).toBe("closed");
  expect(await blockingComments(umbrella)).toHaveLength(1);
  expect(closeCalls(app, umbrella)).toHaveLength(1);
});

test("a pending ticket close survives resume and closes once the children close", async () => {
  const first = host(); await first.event("session_start");
  const ticket = await issue("Resumed ticket"); await kata(["claim", ticket, "--json"]);
  await first.event("tool_result", { toolName: "bash", input: { command: `kata claim v2test#${ticket}` }, isError: false, details: { exitCode: 0 } });
  await first.call({ op: "init", items: [`v2test#${ticket}: ship it`, "Plain step"] });
  await first.call({ op: "done", task: `v2test#${ticket}: ship it`, message, evidence: ["test:survives resume"] });
  const resumed = host({ sid: first.sid, entries: first.entries }); await resumed.event("session_start");
  const child = (await show(ticket)).children[0].short_id;
  await kata(["close", child, "--done", "--message", message, "--test", "closed outside", "--json"]);
  await resumed.event("session_shutdown");
  const closed = await show(ticket);
  expect(closed.issue.status).toBe("closed");
  expect(JSON.stringify(closed)).toContain("test:survives resume");
  expect(await blockingComments(ticket)).toHaveLength(1);
});

test("a done replayed after the close failed leaves one comment and closes once", async () => {
  let outage = true;
  const app = host({ before: (args: string[]) => args[0] === "close" && outage ? down() : undefined }); await app.event("session_start");
  const a = await issue("Ticket A");
  await app.call({ op: "init", items: [`v2test#${a}: only step`] });
  const failed = await app.call({ op: "done", message, evidence });
  expect(failed.isError).toBe(true);
  expect(await commentsOf(a)).toHaveLength(1);
  outage = false;
  const replayed = await app.call({ op: "done", task: `v2test#${a}: only step`, message, evidence });
  expect(replayed.isError).toBeUndefined();
  expect(await commentsOf(a)).toHaveLength(1);
  expect((await show(a)).issue.status).toBe("closed");
  expect(await closesOf(a)).toHaveLength(1);
});

test("the item-to-ticket record survives a resumed session", async () => {
  const first = host(); await first.event("session_start");
  const a = await issue("Ticket A");
  await first.call({ op: "init", items: [`v2test#${a}: first step`, `v2test#${a}: second step`] });
  await first.call({ op: "done", task: `v2test#${a}: first step`, message, evidence });
  const resumed = host({ sid: first.sid, entries: first.entries }); await resumed.event("session_start");
  const view = (await resumed.call({ op: "view" })).content[0].text;
  expect(view).toContain(`[x] v2test#${a}: first step (v2test#${a})`);
  expect(view).toContain(`v2test#${a}: second step (v2test#${a})`);
  expect((await resumed.call({ op: "done", task: `v2test#${a}: second step`, message, evidence })).isError).toBeUndefined();
  expect((await show(a)).issue.status).toBe("closed");
  expect(await commentsOf(a)).toHaveLength(2);
});

test("a task delegated to an item that names a ticket works that ticket and creates no issue", async () => {
  const app = host(); await app.event("session_start");
  const a = await issue("Ticket A");
  await app.call({ op: "init", items: [`v2test#${a}: write the widget parser`] });
  const before = await total();
  await app.event("tool_call", { toolName: "task", toolCallId: "named-item", input: { name: "Parser", task: "Write the widget parser and report back." } });
  app.emit("task:subagent:lifecycle", { id: "named-item", status: "started", sessionFile: `${scratch}/named-item.jsonl`, parentToolCallId: "named-item", index: 0 });
  await app.call({ op: "view" });
  expect((await show(a)).issue.metadata["omp.subagent_id"]).toBe("named-item");
  expect(await total()).toBe(before);
  expect(await ofSession(app.sid)).toHaveLength(1); // the delegated ticket itself
  const refused = await app.call({ op: "done", task: `v2test#${a}: write the widget parser`, message, evidence });
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toMatch(/delegated/i);
});

test("an item follows its ticket when a delegate closes it: shown completed, no reminder, done is no error", async () => {
  const app = host(); await app.event("session_start");
  const a = await issue("Ticket A");
  await app.call({ op: "init", items: [`v2test#${a}: write the gadget parser`, `v2test#${a}: document the gadget parser`] });
  await app.event("tool_call", { toolName: "task", toolCallId: "follow", input: { name: "Parser", task: `Finish v2test#${a} and close it.` } });
  app.emit("task:subagent:lifecycle", { id: "follow", status: "started", sessionFile: `${scratch}/follow.jsonl`, parentToolCallId: "follow", index: 0 });
  await app.call({ op: "view" });
  await kata(["close", a, "--done", "--message", message, "--test", "delegate-closed-it", "--json"]);
  const view = (await app.call({ op: "view" })).content[0].text;
  expect(view).toContain(`[x] v2test#${a}: write the gadget parser`);
  expect(view).toContain(`[x] v2test#${a}: document the gadget parser`);
  expect(await app.event("session_stop", { messages: [] })).toBeUndefined();
  const again = await app.call({ op: "done", task: `v2test#${a}: write the gadget parser`, message, evidence });
  expect(again.isError).toBeUndefined();
  expect(await commentsOf(a)).toHaveLength(0);
});

test("an item follows a wontfix close of its ticket as abandoned", async () => {
  const app = host(); await app.event("session_start");
  const a = await issue("Ticket A");
  await app.call({ op: "init", items: [`v2test#${a}: only step`] });
  await kata(["close", a, "--wontfix", "--message", "Closed by someone else because this work is no longer wanted by anyone here.", "--json"]);
  expect((await app.call({ op: "view" })).content[0].text).toContain(`[~] v2test#${a}: only step`);
});

const kataWrites = (calls: string[][]) => calls.filter(a => !["show", "list", "search", "whoami"].includes(a[0]));

test("init without replace refuses a plan with open tasks and writes nothing to Kata", async () => {
  const app = host(); const parent = await app.init(["Started task", "Waiting task", "Pending task"]);
  await app.call({ op: "start", task: "Started task" });
  await app.call({ op: "block", task: "Waiting task", reason: "needs a decision" });
  const before = await show(parent);
  const mark = app.calls.length;
  const result = await app.call({ op: "init", items: ["Brand new task"] });
  expect(result.isError).toBe(true);
  const text = result.content[0].text;
  for (const title of ["Started task", "Waiting task", "Pending task"]) expect(text).toContain(title);
  expect(text).toContain("replace: true");
  expect(kataWrites(app.calls.slice(mark))).toEqual([]);
  expect(await show(parent)).toEqual(before);
});

test("init without replace goes through when the new list keeps every open task", async () => {
  const app = host(); const parent = await app.init(["One", "Two"]);
  const result = await app.call({ op: "init", items: ["One", "Two", "Three"] });
  expect(result.isError, result.content[0].text).toBeUndefined();
  const children = (await show(parent)).children;
  expect(children.map((c: any) => c.title).sort()).toEqual(["One", "Three", "Two"]);
  expect(children.every((c: any) => c.status === "open")).toBe(true);
});

test("init without replace names only the open tasks the new list leaves out", async () => {
  const app = host(); const parent = await app.init(["One", "Two", "Three"]);
  const before = await show(parent);
  const mark = app.calls.length;
  const result = await app.call({ op: "init", items: ["One", "Four"] });
  expect(result.isError).toBe(true);
  const text = result.content[0].text.split("\n\n")[0];
  expect(text).toContain("Two"); expect(text).toContain("Three");
  expect(text).not.toContain("One"); expect(text).not.toContain("Four");
  expect(kataWrites(app.calls.slice(mark))).toEqual([]);
  expect(await show(parent)).toEqual(before);
});

test("init without replace refuses open ticket-named items and writes nothing to Kata", async () => {
  const ticket = `v2test#${await issue("Named work")}`;
  const app = host();
  await app.call({ op: "init", items: [`${ticket}: do the named work`] });
  const before = await show(ticket);
  const mark = app.calls.length;
  const result = await app.call({ op: "init", items: ["Something else"] });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain(`${ticket}: do the named work`);
  expect(kataWrites(app.calls.slice(mark))).toEqual([]);
  expect(await show(ticket)).toEqual(before);
});

test("init with replace closes the open tasks missing from the new list", async () => {
  const app = host(); const parent = await app.init(["Old task", "Kept task"]);
  const result = await app.call({ op: "init", items: ["Kept task", "New task"], replace: true });
  expect(result.isError).toBeUndefined();
  const children = (await show(parent)).children;
  const old = children.find((c: any) => c.title === "Old task");
  expect(old.status).toBe("closed"); expect(old.closed_reason).toBe("wontfix");
  expect(children.find((c: any) => c.title === "Kept task").status).toBe("open");
  expect(children.find((c: any) => c.title === "New task").status).toBe("open");
});

test("init needs no replace once every task of the plan is closed", async () => {
  const ref = `v2test#${await issue()}`;
  const app = host();
  await app.call({ op: "init", ref, items: ["Only task"] });
  await app.call({ op: "done", task: "Only task", message, evidence });
  const result = await app.call({ op: "init", ref, items: ["Follow-up task"] });
  expect(result.isError).toBeUndefined();
  expect((await show(ref)).children.find((c: any) => c.title === "Follow-up task").status).toBe("open");
});

test("init with a bare short id that resolves in the session project refuses to abandon that ticket's open children", async () => {
  const other = path.join(scratch, `other-${unique()}`); mkdirSync(other);
  await kata(["init", "--project", "v2alpha", "--json"], other);
  const alpha = (await kata(["create", "Alpha parent", "--force-new", "--json"], other)).issue.short_id;
  const beta = await issue("Beta parent");
  await kata(["create", "Beta open child", "--parent", beta, "--meta", "todo.phase=Tasks", "--meta", "todo.status=pending", "--force-new", "--json"]);
  // Short ids are random per project, so route the bare id to the session project's ticket.
  const app = host({ before: (args: string[], opts: any) => args.includes(alpha) ? run(args.map(a => a === alpha ? `v2test#${beta}` : a), opts.cwd, opts.timeout) : undefined });
  await app.call({ op: "init", ref: `v2alpha#${alpha}`, items: ["Alpha child"] });
  const mark = app.calls.length;
  const result = await app.call({ op: "init", ref: alpha, items: ["Alpha child"] });
  expect(result.isError).toBe(true);
  expect(kataWrites(app.calls.slice(mark))).toEqual([]);
  expect((await show(beta)).children.map((c: any) => c.status)).toEqual(["open"]);
});
