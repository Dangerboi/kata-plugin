import { expect, test } from "bun:test";
import { eventually } from "./kata-fixture";
import { v2Fixture } from "./v2-fixture";
import { kataViews } from "./omp-host";

// The omp adapter against a real Kata, on omp's native `todo`: the backend's `apply` that refuses calls before they commit and the mirror that follows
// the list into Kata (the todo backend's `replace`). Edge cases of both, one behaviour per test.
const { show, issue, host, down, total, commentsOf, sessionParents, closesOf, scratch, kata, message } = v2Fixture();

const { refOf, childRef, issueOf, labelsOf, titles } = kataViews(show);
// A pre-existing plan task (todo.phase set), as an earlier session's mirror leaves it; `issue` suffixes the title.
const planTask = (title: string, parent: string) => issue(title, { parent, meta: ["todo.phase=Tasks", "todo.status=pending"] });

test("done on a task whose Kata child is open is refused with the child's ref and the close command, leaving Kata and omp's list as they were", async () => {
  const app = host(); await app.event("session_start");
  const parent = await app.init(["Write parser", "Write docs"]);
  const child = await childRef(parent, "Write parser");
  const before = app.list();
  const refused = await app.call({ op: "done", task: "Write parser" });
  expect(refused.isError).toBe(true);
  const text = refused.content[0].text;
  expect(text).toContain(`is open in Kata as ${child}`);
  expect(text).toContain(`kata close ${child}`);
  expect((await issueOf(child)).status).toBe("open");
  expect(app.list()).toEqual(before);
});

test("done passes after the child's close, and Kata keeps that close with its evidence", async () => {
  const app = host(); await app.event("session_start");
  const parent = await app.init(["Write parser", "Write docs"]);
  const child = await childRef(parent, "Write parser");
  expect((await app.call({ op: "done", task: "Write parser" })).isError).toBe(true);
  await app.close("Write parser");
  const done = await app.call({ op: "done", task: "Write parser" });
  expect(done.isError, done.content[0].text).toBeUndefined();
  expect(app.list()[0]!.tasks.find(t => t.content === "Write parser")!.status).toBe("completed");
  expect(await issueOf(child)).toMatchObject({ status: "closed", closed_reason: "done" });
  const closes = await closesOf(child);
  expect(closes).toHaveLength(1);
  expect(closes[0].payload.reason).toBe("done");
});

test("an init that leaves out an open task is refused, naming it", async () => {
  const app = host(); await app.event("session_start");
  const parent = await app.init(["Write parser", "Write docs"]);
  const before = app.list();
  const refused = await app.call({ op: "init", items: ["Write parser", "Ship it"] });
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toContain("Write docs");
  expect(refused.content[0].text).toContain("The new list leaves out tasks that are still open in Kata");
  expect(app.list()).toEqual(before);
  expect(await titles(parent)).toEqual(["Write docs", "Write parser"]);
});

test("a dropped task can then be left out of an init, and its child is closed wontfix", async () => {
  const app = host(); await app.event("session_start");
  const parent = await app.init(["Write parser", "Write docs"]);
  const dropped = await childRef(parent, "Write docs");
  expect((await app.call({ op: "drop", task: "Write docs" })).isError).toBeUndefined();
  const init = await app.call({ op: "init", items: ["Write parser"] });
  expect(init.isError, init.content[0]?.text).toBeUndefined();
  expect(await issueOf(dropped)).toMatchObject({ status: "closed", closed_reason: "wontfix" });
  expect((await issueOf(await childRef(parent, "Write parser"))).status).toBe("open");
});

test("a user's /todo edit marking an open task completed labels it needs-review with one comment, once, and leaves it open", async () => {
  const app = host(); await app.event("session_start");
  const parent = await app.init(["Write parser", "Write docs"]);
  const child = await childRef(parent, "Write parser");
  const list = app.list();
  list[0]!.tasks[0]!.status = "completed";
  list[0]!.tasks[1]!.status = "in_progress";
  await app.edit(list);
  expect(await labelsOf(child)).toContain("needs-review");
  expect(await commentsOf(child)).toHaveLength(1);
  expect((await issueOf(child)).status).toBe("open");
  // A second sync that still holds the task completed (another task changed, so omp sends the list again) adds nothing.
  list[0]!.tasks[1]!.status = "pending";
  await app.edit(list);
  expect(await commentsOf(child)).toHaveLength(1);
  expect((await labelsOf(child)).filter(l => l === "needs-review")).toHaveLength(1);
  expect((await issueOf(child)).status).toBe("open");
});

test("native drop closes the task's child wontfix", async () => {
  const app = host(); await app.event("session_start");
  const parent = await app.init(["Write parser", "Write docs", "Write tests"]);
  const child = await childRef(parent, "Write docs");
  expect((await app.call({ op: "drop", task: "Write docs" })).isError).toBeUndefined();
  expect(await issueOf(child)).toMatchObject({ status: "closed", closed_reason: "wontfix" });
  expect((await issueOf(await childRef(parent, "Write tests"))).status).toBe("open");
});

test("native rm of a task omp's list held closes its child wontfix", async () => {
  const app = host(); await app.event("session_start");
  const parent = await app.init(["Write parser", "Write docs", "Write tests"]);
  const child = await childRef(parent, "Write docs");
  expect((await app.call({ op: "rm", task: "Write docs" })).isError).toBeUndefined();
  expect(await issueOf(child)).toMatchObject({ status: "closed", closed_reason: "wontfix" });
  expect((await issueOf(await childRef(parent, "Write tests"))).status).toBe("open");
});

test("a task omp's list never held stays open when the list starts empty under a KATA_REF parent and another task is appended", async () => {
  const parent = refOf(await issue("Explicit parent"));
  const existing = refOf(await planTask("Existing work", parent));
  process.env.KATA_REF = parent;
  const app = host(); await app.event("session_start");
  const appended = await app.call({ op: "append", items: ["Fresh work"] });
  expect(appended.isError, appended.content[0].text).toBeUndefined();
  expect((await issueOf(existing)).status).toBe("open");
  expect(await titles(parent)).toEqual([(await issueOf(existing)).title, "Fresh work"]);
});

test("a task omp's list never held stays open when the list starts empty under a /todo ref parent and another task is appended", async () => {
  const parent = refOf(await issue("Explicit parent"));
  const existing = refOf(await planTask("Existing work", parent));
  const app = host(); await app.event("session_start");
  await app.event("input", { text: `/todo ref ${parent}`, source: "interactive" });
  const appended = await app.call({ op: "append", items: ["Fresh work"] });
  expect(appended.isError, appended.content[0].text).toBeUndefined();
  expect((await issueOf(existing)).status).toBe("open");
  expect(await titles(parent)).toEqual([(await issueOf(existing)).title, "Fresh work"]);
});

test("/todo ref makes the issue the plan parent before the first init, whose tasks become its children", async () => {
  const parent = refOf(await issue("Explicit parent"));
  const app = host(); await app.event("session_start");
  await app.event("input", { text: `/todo ref ${parent}`, source: "interactive" });
  expect(app.notices.at(-1)![0]).toContain(parent);
  const init = await app.call({ op: "init", items: ["Fresh one", "Fresh two"] });
  expect(init.isError, init.content[0].text).toBeUndefined();
  expect(await titles(parent)).toEqual(["Fresh one", "Fresh two"]);
  expect(await sessionParents(app.sid)).toHaveLength(0);
});

test("after /todo ref an init that leaves out the parent's open child is refused", async () => {
  const parent = refOf(await issue("Explicit parent"));
  const existing = refOf(await planTask("Existing work", parent));
  const app = host(); await app.event("session_start");
  await app.event("input", { text: `/todo ref ${parent}`, source: "interactive" });
  const refused = await app.call({ op: "init", items: ["Fresh one"] });
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toContain("Existing work");
  expect(app.list()).toEqual([]);
  expect((await issueOf(existing)).status).toBe("open");
  expect(await titles(parent)).toEqual([(await issueOf(existing)).title]);
});

test("with todo.backend native the plugin neither asks `apply` nor mirrors and says so once; switching back mirrors the current list", async () => {
  const app = host(); await app.event("session_start");
  const parent = await app.init(["Write parser", "Write docs"]);
  const child = await childRef(parent, "Write parser");
  const docs = await childRef(parent, "Write docs");
  await app.backend("native");
  const done = await app.call({ op: "done", task: "Write parser" });
  expect(done.isError, done.content[0].text).toBeUndefined();
  expect((await app.call({ op: "append", items: ["Write tests"] })).isError).toBeUndefined();
  expect((await app.call({ op: "rm", task: "Write docs" })).isError).toBeUndefined();
  expect((await issueOf(child)).status).toBe("open");
  expect(await labelsOf(child)).not.toContain("needs-review");
  expect(await titles(parent)).toEqual(["Write docs", "Write parser"]);
  expect(app.notices.filter(n => /todo backend/i.test(String(n[0])))).toHaveLength(1);

  await app.backend("kata");
  expect(await issueOf(docs)).toMatchObject({ status: "closed", closed_reason: "wontfix" });
  expect((await issueOf(docs)).metadata["todo.removed"]).toBe(true);
  expect((await issueOf(await childRef(parent, "Write tests"))).status).toBe("open");
  expect(await labelsOf(child)).toContain("needs-review");
  expect(app.notices.filter(n => /todo backend/i.test(String(n[0])))).toHaveLength(1);
});

test("of several calls in one message only the done whose child was closed beforehand passes", async () => {
  const app = host(); await app.event("session_start");
  const parent = await app.init(["Write parser", "Write docs"]);
  const closedChild = await childRef(parent, "Write parser"), openChild = await childRef(parent, "Write docs");
  await app.close("Write parser");
  const [first, second] = await app.batch([{ op: "done", task: "Write parser" }, { op: "done", task: "Write docs" }]);
  expect(first!.isError, first!.content[0].text).toBeUndefined();
  expect(second!.isError).toBe(true);
  expect(second!.content[0].text).toContain(`is open in Kata as ${openChild}`);
  const statuses = Object.fromEntries(app.list()[0]!.tasks.map(t => [t.content, t.status]));
  expect(statuses["Write parser"]).toBe("completed");
  expect(statuses["Write docs"]).not.toBe("completed");
  expect((await issueOf(closedChild)).status).toBe("closed");
  expect((await issueOf(openChild)).status).toBe("open");
});

test("a task closed in Kata earlier in the same message is accepted as done: omp asks when the call commits", async () => {
  const app = host(); await app.event("session_start");
  const parent = await app.init(["Write parser", "Write docs"]);
  const parserRef = await childRef(parent, "Write parser");
  const [done] = await app.batch([() => app.close("Write parser"), { op: "done", task: "Write parser" }]);
  expect(done!.isError, done!.content[0].text).toBeUndefined();
  expect((await issueOf(parserRef)).status).toBe("closed");
  expect(app.list()[0]!.tasks.find(t => t.content === "Write parser")!.status).toBe("completed");
  expect(await labelsOf(parserRef)).not.toContain("needs-review");
});

test("a refused call is no extension error, leaves Kata and the list as they were, and says which task to close", async () => {
  const app = host(); await app.event("session_start");
  const parent = await app.init(["Write parser", "Write docs"]);
  const before = app.list();
  const refused = await app.call({ op: "done", task: "Write docs" });
  expect(refused.isError).toBe(true);
  expect(refused.details.refused).toBe(true);
  expect(refused.content[0].text).toMatch(/^Todo backend "kata" did not accept this change: "Write docs" is open in Kata as /);
  expect(app.list()).toEqual(before);
  expect(app.mirrorFailures()).toEqual([]);
  expect((await issueOf(await childRef(parent, "Write docs"))).status).toBe("open");
});

test("an accepted change reaches Kata through the replace omp sends after committing it", async () => {
  const app = host(); await app.event("session_start");
  const parent = await app.init(["Write parser"]);
  const mark = app.calls.length;
  expect((await app.call({ op: "append", items: ["Write docs"] })).isError).toBeUndefined();
  expect(await titles(parent)).toEqual(["Write docs", "Write parser"]);
  const created = app.calls.slice(mark).filter(c => c[0] === "create");
  expect(created).toHaveLength(1);
});

test("an accepted done that omp does not commit leaves the task closed in Kata: the resend of the old list reopens nothing", async () => {
  const app = host(); await app.event("session_start");
  const parent = await app.init(["Write parser", "Write docs"]);
  const child = await childRef(parent, "Write docs");
  await app.close("Write docs");
  const before = app.list(), commentsBefore = (await commentsOf(child)).length;
  // The call is aborted after `apply` accepted it: omp keeps its list and resends it.
  app.beforeCommit = () => true;
  const mark = app.calls.length;
  const result = await app.call({ op: "done", task: "Write docs" });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("did not take this change in time");
  expect(app.list()).toEqual(before);
  expect(app.mirrorFailures()).toEqual([]);
  expect(await issueOf(child)).toMatchObject({ status: "closed", closed_reason: "done" });
  expect(await labelsOf(child)).not.toContain("needs-review");
  expect(await commentsOf(child)).toHaveLength(commentsBefore);
  expect(app.calls.slice(mark).filter(c => c[0] === "reopen")).toEqual([]);
});

test("a lead's done naming two tasks, one still open in Kata, is refused naming the open one", async () => {
  const app = host(); await app.event("session_start");
  const parent = await app.init(["Write parser", "Write docs"]);
  const closedRef = await childRef(parent, "Write parser"), openRef = await childRef(parent, "Write docs");
  await app.close("Write parser");
  const before = app.list();
  const refused = await app.call({ op: "done", task: ["Write parser", "Write docs"] });
  expect(refused.isError).toBe(true);
  expect(refused.details.refused).toBe(true);
  expect(refused.content[0].text).toContain(`"Write docs" is open in Kata as ${openRef}`);
  expect(refused.content[0].text).not.toContain(closedRef);
  expect(app.list()).toEqual(before);
  expect((await issueOf(openRef)).status).toBe("open");
});

test("a delegate's todo with no assignment is neither asked nor mirrored", async () => {
  const lead = host(); await lead.event("session_start");
  const parent = await lead.init(["Lead task"]);
  const delegate = host({ agent: { kind: "sub", id: "unassigned-delegate", parentId: lead.ctx.agent.id } });
  const before = await total();
  expect((await delegate.call({ op: "init", items: ["Own task", "Other task"] })).isError).toBeUndefined();
  expect((await delegate.call({ op: "done", task: "Own task" })).isError).toBeUndefined();
  expect(await total()).toBe(before);
  expect(await sessionParents(delegate.sid)).toHaveLength(0);
  expect(await titles(parent)).toEqual(["Lead task"]);
  expect(delegate.mirrorFailures()).toEqual([]);
});

test("a delegate whose assignment failed and is retried by its first todo call is guarded by it: done on an open task is refused", async () => {
  let failed = false;
  const lead = host({ before: (args: string[]) => {
    if (failed || args[0] !== "meta" || args[3] !== "omp.subagent_id") return;
    failed = true;
    return { code: 1, stdout: "", stderr: "delegation service permission denied" };
  } });
  await lead.event("session_start");
  const parent = await lead.init(["Delegated plan task"]);
  const assigned = await childRef(parent, "Delegated plan task");
  const sessionFile = `${scratch}/retried-assignment.jsonl`;
  lead.emit("task:subagent:lifecycle", { id: "retried-assignment", status: "started", sessionFile, description: "Delegated plan task" });
  await lead.call({ op: "view" });
  await eventually(async () => failed, true);
  // The delegate has no assignment until its next use retries it; its todo call is that next use.
  const open = await planTask("Delegate step", assigned);
  const title = (await issueOf(`v2test#${open}`)).title;
  const worker = host({ sessionFile, agent: { kind: "sub", id: "retried-assignment", parentId: lead.ctx.agent.id } });
  const refused = await worker.call({ op: "done", task: title });
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toContain(`v2test#${open}`);
  expect((await issueOf(`v2test#${open}`)).status).toBe("open");
});

test("a delegate's refusal reads like the lead's for the same case: a done on a task still open in Kata", async () => {
  const lead = host(); await lead.event("session_start");
  const parent = await lead.init(["Delegated plan task", "Own task"]);
  const assigned = await childRef(parent, "Delegated plan task");
  const sessionFile = `${scratch}/same-wording.jsonl`;
  lead.emit("task:subagent:lifecycle", { id: "same-wording", status: "started", sessionFile, description: "Delegated plan task" });
  await lead.call({ op: "view" });
  await eventually(async () => (await show(assigned)).issue.metadata?.["omp.subagent_id"], "same-wording");
  const step = await planTask("Same step", assigned);
  const title = (await issueOf(`v2test#${step}`)).title;
  const worker = host({ sessionFile, agent: { kind: "sub", id: "same-wording", parentId: lead.ctx.agent.id } });
  const delegated = (await worker.call({ op: "done", task: title })).content[0].text as string;
  const own = (await lead.call({ op: "done", task: "Own task" })).content[0].text as string;
  const ownRef = await childRef(parent, "Own task");
  // Refs and titles differ per plan, and omp flattens the lead's reason to one line and adds its own prefix and list: the wording is the same.
  const wording = (text: string, ref: string, name: string) => text.replaceAll(ref, "<ref>").replaceAll(name, "<task>").replace(/\s+/g, " ").trim();
  const reason = wording(own, ownRef, "Own task").replace(/^Todo backend "kata" did not accept this change: /, "").replace(/ Remaining items.*$/, "");
  expect(reason).toBe(wording(delegated, `v2test#${step}`, title));
});

test("a mirror while Kata is unreachable does not throw, and the change lands in Kata on the next change once it answers", async () => {
  let unreachable = false;
  const app = host({ before: (args: string[]) => unreachable && (args[0] === "create" || args[0] === "show") ? down() : undefined });
  await app.event("session_start");
  unreachable = true;
  const before = await total();
  const init = await app.call({ op: "init", items: ["Write parser", "Write docs"] });
  expect(init.isError, init.content[0].text).toBeUndefined();
  // The outage is told once, as an outage; no other warning.
  expect(app.mirrorFailures().map(args => String(args[0]))).toEqual([expect.stringContaining("Kata is unreachable")]);
  expect(await total()).toBe(before);

  unreachable = false;
  const appended = await app.call({ op: "append", items: ["Write tests"] });
  expect(appended.isError, appended.content[0].text).toBeUndefined();
  expect(app.mirrorFailures()).toHaveLength(1);
  const [parent] = await sessionParents(app.sid);
  expect(parent).toBeDefined();
  expect(await titles(parent.qualified_id)).toEqual(["Write docs", "Write parser", "Write tests"]);
});

test("an init with no op that leaves out an open task is refused like op init, and nothing changes", async () => {
  const app = host(); await app.event("session_start");
  const parent = await app.init(["Write parser", "Write docs"]);
  const before = app.list();
  const refused = await app.call({ list: [{ phase: "Tasks", items: ["Write parser"] }] });
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toContain("Write docs");
  expect(refused.content[0].text).toContain("The new list leaves out tasks that are still open in Kata");
  expect(app.list()).toEqual(before);
  expect(await titles(parent)).toEqual(["Write docs", "Write parser"]);
});

test("an init with an empty list is refused while tasks are open, and closes nothing", async () => {
  const app = host(); await app.event("session_start");
  const parent = await app.init(["Write parser", "Write docs"]);
  const before = app.list();
  const refused = await app.call({ op: "init", list: [] });
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toContain("Write parser");
  expect(refused.content[0].text).toContain("Write docs");
  expect(app.list()).toEqual(before);
  for (const title of ["Write parser", "Write docs"]) expect((await issueOf(await childRef(parent, title))).status).toBe("open");
});

test("after /todo ref the init refusal for a child omp never listed advises append then drop, and following it works end to end", async () => {
  const parent = refOf(await issue("Explicit parent"));
  const existing = refOf(await planTask("Existing work", parent));
  const existingTitle = (await issueOf(existing)).title;
  const app = host(); await app.event("session_start");
  await app.event("input", { text: `/todo ref ${parent}`, source: "interactive" });
  const refused = await app.call({ op: "init", items: ["Fresh one"] });
  expect(refused.isError).toBe(true);
  const text = refused.content[0].text;
  expect(text).toContain("never in your list");
  expect(text).toContain("todo append");
  expect(text).not.toMatch(/drop (them )?first/i);

  expect((await app.call({ op: "append", items: [existingTitle] })).isError).toBeUndefined();
  const dropped = await app.call({ op: "drop", task: existingTitle });
  expect(dropped.isError, dropped.content[0]?.text).toBeUndefined();
  const init = await app.call({ op: "init", items: ["Fresh one"] });
  expect(init.isError, init.content[0]?.text).toBeUndefined();
  expect(await issueOf(existing)).toMatchObject({ status: "closed", closed_reason: "wontfix" });
  expect(await titles(parent)).toEqual([existingTitle, "Fresh one"].sort());
  expect((await issueOf(await childRef(parent, "Fresh one"))).status).toBe("open");
});

test("a task moved to another phase in omp is still refused by done on that phase while its issue is open", async () => {
  const app = host(); await app.event("session_start");
  const parent = await app.init(["Write parser", "Write docs"]);
  const child = await childRef(parent, "Write parser");
  const moved = await app.call({ op: "init", list: [{ phase: "Later", items: ["Write parser", "Write docs"] }] });
  expect(moved.isError, moved.content[0]?.text).toBeUndefined();
  expect(app.list().map(p => p.name)).toEqual(["Later"]);
  const refused = await app.call({ op: "done", phase: "Later" });
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toContain(`is open in Kata as ${child}`);
  expect(app.list()[0]!.tasks.every(t => t.status !== "completed")).toBe(true);
  expect((await issueOf(child)).status).toBe("open");
});

test("/todo ref with a bare short id makes that issue the plan parent", async () => {
  const parentShort = await issue("Explicit parent");
  const parent = refOf(parentShort);
  const app = host(); await app.event("session_start");
  const handled = await app.event("input", { text: `/todo ref ${parentShort}`, source: "interactive" });
  expect(handled).toMatchObject({ handled: true });
  expect(app.notices.at(-1)![0]).toContain("is now this plan's parent");
  const init = await app.call({ op: "init", items: ["Fresh one"] });
  expect(init.isError, init.content[0].text).toBeUndefined();
  expect(await titles(parent)).toEqual(["Fresh one"]);
});

test("/todo ref while KATA_REF names another issue is refused and the plan stays under KATA_REF", async () => {
  const fixed = refOf(await issue("Fixed parent")), other = refOf(await issue("Other parent"));
  process.env.KATA_REF = fixed;
  try {
    const app = host(); await app.event("session_start");
    await app.event("input", { text: `/todo ref ${other}`, source: "interactive" });
    expect(app.notices.at(-1)![0]).toContain("KATA_REF is set to");
    expect(app.notices.at(-1)![0]).toContain("is not used");
    const init = await app.call({ op: "init", items: ["Fresh one"] });
    expect(init.isError, init.content[0].text).toBeUndefined();
    expect(await titles(fixed)).toEqual(["Fresh one"]);
    expect(await titles(other)).toEqual([]);
  } finally { delete process.env.KATA_REF; }
});

test("/todo ref when the plan already has another parent says nothing changed, and the plan keeps its parent", async () => {
  const other = refOf(await issue("Other parent"));
  const app = host(); await app.event("session_start");
  const parent = await app.init(["Write parser"]);
  await app.event("input", { text: `/todo ref ${other}`, source: "interactive" });
  const answer = String(app.notices.at(-1)![0]);
  expect(answer).toContain(`This plan's parent is ${parent}`);
  expect(answer).toContain("not changed");
  expect(await titles(other)).toEqual([]);
  expect((await app.call({ op: "append", items: ["Write docs"] })).isError).toBeUndefined();
  expect(await titles(parent)).toEqual(["Write docs", "Write parser"]);
  expect(await titles(other)).toEqual([]);
});

test("the lead's done on a task delegated to a subagent is refused: its subagent closes it", async () => {
  const app = host(); await app.event("session_start");
  const parent = await app.init(["Delegated work", "Own work"]);
  const child = await childRef(parent, "Delegated work");
  await app.event("tool_call", { toolName: "task", toolCallId: "delegate-guard", input: { task: 'Complete "Delegated work"' } });
  app.emit("task:subagent:lifecycle", { id: "delegate-guard", status: "started", sessionFile: `${scratch}/delegate-guard.jsonl`, parentToolCallId: "delegate-guard", index: 0 });
  await eventually(async () => (await show(child)).issue.metadata?.["omp.subagent_id"], "delegate-guard");
  const before = app.list();
  const refused = await app.call({ op: "done", task: "Delegated work" });
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toContain("its subagent closes it");
  expect(refused.content[0].text).toContain(child);
  expect(app.list()).toEqual(before);
  expect((await issueOf(child)).status).toBe("open");
});

test("/todo takeover with todo.backend native is not handled by the plugin", async () => {
  const app = host(); await app.event("session_start");
  await app.init(["Write parser"]);
  await app.backend("native");
  const result = await app.event("input", { text: "/todo takeover Write parser", source: "interactive" });
  expect(result?.handled).toBeUndefined();
  // The same command is the plugin's with the Kata backend: without this, an unrecognised command would pass too.
  await app.backend("kata");
  expect((await app.event("input", { text: "/todo takeover Write parser", source: "interactive" }))?.handled).toBe(true);
});

test("an init with no op and only items, sent while omp's list is empty, is refused when it leaves out an open task from /todo ref", async () => {
  const parent = refOf(await issue("Explicit parent"));
  const existing = refOf(await planTask("Existing work", parent));
  const app = host(); await app.event("session_start");
  await app.event("input", { text: `/todo ref ${parent}`, source: "interactive" });
  const refused = await app.call({ items: ["Fresh one"] });
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toContain("leaves out tasks that are open in Kata");
  expect(app.list()).toEqual([]);
  expect((await issueOf(existing)).status).toBe("open");
  expect(await titles(parent)).toEqual([(await issueOf(existing)).title]);
});

test("an init with no op and only items, sent while omp's list is empty, is refused when it leaves out an open task from KATA_REF", async () => {
  const parent = refOf(await issue("Fixed parent"));
  const existing = refOf(await planTask("Existing work", parent));
  process.env.KATA_REF = parent;
  try {
    const app = host(); await app.event("session_start");
    const refused = await app.call({ items: ["Fresh one"] });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("leaves out tasks that are open in Kata");
    expect(app.list()).toEqual([]);
    expect((await issueOf(existing)).status).toBe("open");
  } finally { delete process.env.KATA_REF; }
});

test("after every task is removed, leaving empty phases, a call with only items and no op is not an init for `apply`", async () => {
  const parent = refOf(await issue("Explicit parent"));
  const existing = refOf(await planTask("Existing work", parent));
  const app = host(); await app.event("session_start");
  await app.event("input", { text: `/todo ref ${parent}`, source: "interactive" });
  expect((await app.call({ op: "append", items: ["Fresh one", "Fresh two"] })).isError).toBeUndefined();
  for (const task of ["Fresh one", "Fresh two"]) expect((await app.call({ op: "rm", task })).isError, task).toBeUndefined();
  expect(app.list().length).toBeGreaterThan(0);
  expect(app.list().every(p => p.tasks.length === 0)).toBe(true);
  const result = await app.call({ items: ["Fresh three"] });
  // omp's own schema error: no op can be inferred while its list has phases. The init refusal would name the open task instead.
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("op must be present");
  expect(result.content[0].text).not.toContain("leaves out");
  expect(await titles(parent)).not.toContain("Fresh three");
  expect((await issueOf(existing)).status).toBe("open");
});

const closedTicketItem = async () => {
  const closed = await issue("Closed work");
  await kata(["close", refOf(closed), "--done", "--message", message, "--test", "closed-item-fixture", "--json"]);
  return { closed, item: `${refOf(closed)}: more work` };
};

// The warning the mirror gives when Kata refuses a change, and the Kata calls that named a ticket.
const refusalsOf = (app: { notices: any[][] }) => app.notices.filter(n => /Kata refused the latest change/.test(String(n[0])));
const namingOf = (app: { calls: string[][] }, text: string) => app.calls.filter(c => c.some(arg => arg.includes(text))).length;
const refuse = (stderr: string) => ({ code: 1, stdout: "", stderr });

test("a ticket item naming a closed ticket, appended to a plan, warns once, and two unrelated list changes neither warn again nor retry it", async () => {
  const { closed, item } = await closedTicketItem();
  const app = host(); await app.event("session_start");
  await app.init(["Plain start"]);
  expect(refusalsOf(app)).toHaveLength(0);
  expect((await app.call({ op: "append", items: [item] })).isError).toBeUndefined();
  expect(refusalsOf(app)).toHaveLength(1);
  const attempts = namingOf(app, closed);
  expect(attempts).toBeGreaterThan(0);
  expect((await app.call({ op: "append", items: ["Plain one"] })).isError).toBeUndefined();
  expect((await app.call({ op: "append", items: ["Plain two"] })).isError).toBeUndefined();
  expect(refusalsOf(app)).toHaveLength(1);
  expect(namingOf(app, closed)).toBe(attempts);
});

test("two tasks refused with the same message in one pass are named by one notice, worded for a step", async () => {
  let refusing = false;
  const app = host({ before: (args: string[]) => refusing && args[0] === "create" ? refuse("create refused by the test") : undefined });
  await app.event("session_start");
  await app.init(["Plain start"]);
  refusing = true;
  expect((await app.call({ op: "append", items: ["Plain one", "Plain two"] })).isError).toBeUndefined();
  const notices = refusalsOf(app).map(n => String(n[0]));
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain("create refused by the test");
  expect(notices[0]).toContain('"Plain one", "Plain two" stay in');
  expect(notices[0]).toContain("Each is sent to Kata again only when it changes in the list");
});

test("a ticket item whose removal Kata refuses is worded for both failure points: part of the removal refused, the ticket open, its status possibly unchanged", async () => {
  const ticket = await issue("Open work");
  const item = `${refOf(ticket)}: more work`;
  let refusing = false;
  const app = host({ before: (args: string[]) => refusing && args[0] === "comment" ? refuse("comment refused by the test") : undefined });
  await app.event("session_start");
  await app.init(["Plain start", item]);
  refusing = true;
  expect((await app.call({ op: "rm", task: item })).isError).toBeUndefined();
  const notices = refusalsOf(app).map(n => String(n[0]));
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain("comment refused by the test");
  expect(notices[0]).toContain("is a ticket item. Kata refused part of removing it from the plan; the ticket stays open and needs no close, and if it was in progress or blocked, Kata may still show it so.");
  expect((await issueOf(refOf(ticket))).status).toBe("open");
});

test("a started ticket item whose status reset Kata refuses is worded the same, and the ticket keeps its working status", async () => {
  const ticket = await issue("Started work");
  const item = `${refOf(ticket)}: more work`;
  let refusing = false;
  const app = host({ before: (args: string[]) => refusing && args[0] === "meta" ? refuse("meta refused by the test") : undefined });
  await app.event("session_start");
  await app.init(["Plain start", item]);
  expect((await app.call({ op: "start", task: item })).isError).toBeUndefined();
  expect((await issueOf(refOf(ticket))).metadata?.["todo.status"]).toBe("in_progress");
  refusing = true;
  expect((await app.call({ op: "rm", task: item })).isError).toBeUndefined();
  // The refused meta write also names the plain task in the same pass; the ticket item has its own notice.
  const notices = refusalsOf(app).map(n => String(n[0])).filter(n => n.includes(`"${item}"`));
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain("meta refused by the test");
  expect(notices[0]).toContain("if it was in progress or blocked, Kata may still show it so.");
  expect((await issueOf(refOf(ticket))).status).toBe("open");
  expect((await issueOf(refOf(ticket))).metadata?.["todo.status"]).toBe("in_progress");
});

test("a ticket item naming a closed ticket, in the init that starts the plan, warns once, creates no issue for it, and later changes retry it without warning again", async () => {
  const { closed, item } = await closedTicketItem();
  const app = host(); await app.event("session_start");
  const before = await total();
  expect((await app.call({ op: "init", items: [item] })).isError).toBeUndefined();
  expect(refusalsOf(app)).toHaveLength(1);
  const attempts = namingOf(app, closed);
  expect((await app.call({ op: "append", items: ["Plain one"] })).isError).toBeUndefined();
  expect((await app.call({ op: "append", items: ["Plain two"] })).isError).toBeUndefined();
  expect(refusalsOf(app)).toHaveLength(1);
  expect(namingOf(app, closed)).toBeGreaterThan(attempts);
  expect(app.calls.filter(c => c[0] === "create" && c.some(arg => arg.includes("more work")))).toEqual([]);
  const [parent] = await sessionParents(app.sid);
  expect(await titles(parent.qualified_id)).toEqual(["Plain one", "Plain two"]);
  expect(await total()).toBe(before + 3);
});

test("a first mirror whose parent setup is refused without an outage leaves no parent, and /todo ref makes every open item of omp's list its child", async () => {
  let refused = true;
  const app = host({ before: (args: string[]) => refused && args[0] === "claim" ? (refused = false, refuse("claim refused by the test")) : undefined });
  await app.event("session_start");
  const explicit = refOf(await issue("Explicit parent"));
  expect((await app.call({ op: "init", items: ["Write parser", "Write docs"] })).isError).toBeUndefined();
  expect(refusalsOf(app)).toHaveLength(1);
  expect(refused).toBe(false);
  await app.event("input", { text: `/todo ref ${explicit}`, source: "interactive" });
  expect((await app.call({ op: "append", items: ["Write tests"] })).isError).toBeUndefined();
  expect(await titles(explicit)).toEqual(["Write docs", "Write parser", "Write tests"]);
});

test("a first mirror whose parent setup is refused without an outage is retried by the next change once the refusal lifts, and every open item becomes a child of the parent", async () => {
  let refused = true;
  const app = host({ before: (args: string[]) => refused && args[0] === "claim" ? refuse("claim refused by the test") : undefined });
  await app.event("session_start");
  expect((await app.call({ op: "init", items: ["Write parser", "Write docs"] })).isError).toBeUndefined();
  expect(refusalsOf(app)).toHaveLength(1);
  refused = false;
  expect((await app.call({ op: "append", items: ["Write tests"] })).isError).toBeUndefined();
  const [parent] = await sessionParents(app.sid);
  expect(parent).toBeDefined();
  expect(await titles(parent.qualified_id)).toEqual(["Write docs", "Write parser", "Write tests"]);
});

test("a refusal warns once, a later clean change goes through, and the same refusal then warns again", async () => {
  const app = host({ before: (args: string[]) => args[0] === "create" && args.some(a => a.includes("Refused")) ? refuse("create refused by the test") : undefined });
  await app.event("session_start");
  await app.init(["Plain start"]);
  expect((await app.call({ op: "append", items: ["Refused one"] })).isError).toBeUndefined();
  expect(refusalsOf(app)).toHaveLength(1);
  expect((await app.call({ op: "append", items: ["Plain one"] })).isError).toBeUndefined();
  expect(refusalsOf(app)).toHaveLength(1);
  expect((await app.call({ op: "append", items: ["Refused two"] })).isError).toBeUndefined();
  expect(refusalsOf(app)).toHaveLength(2);
});

test("two different refusals in one mirror pass are each warned once, a later change that repeats both warns neither, and the step notice names its task", async () => {
  const one = await closedTicketItem();
  const two = await closedTicketItem();
  const app = host(); await app.event("session_start");
  await app.init(["Plain start"]);
  expect((await app.call({ op: "append", items: [one.item, two.item] })).isError).toBeUndefined();
  const warned = refusalsOf(app);
  expect(warned).toHaveLength(2);
  expect(warned.filter(n => String(n[0]).includes(`"${one.item}"`))).toHaveLength(1);
  expect(warned.filter(n => String(n[0]).includes(`"${two.item}"`))).toHaveLength(1);
  const attempts = namingOf(app, one.closed) + namingOf(app, two.closed);
  expect((await app.call({ op: "start", task: one.item })).isError).toBeUndefined();
  expect((await app.call({ op: "start", task: two.item })).isError).toBeUndefined();
  expect(namingOf(app, one.closed) + namingOf(app, two.closed)).toBeGreaterThan(attempts);
  expect(refusalsOf(app)).toHaveLength(2);
});
