import { expect, test } from "bun:test";
import { v2Fixture } from "./v2-fixture";

// The omp adapter against a real Kata, on omp's native `todo`: the guard that refuses calls (`tool_call`) and the mirror that follows
// the list into Kata (the todo backend's `replace`). Edge cases of both, one behaviour per test.
const { show, issue, host, down, total, commentsOf, sessionParents, closesOf } = v2Fixture();

const refOf = (short: string) => `v2test#${short}`;
async function children(parent: string): Promise<any[]> { return (await show(parent)).children ?? []; }
async function childRef(parent: string, title: string): Promise<string> {
  const child = (await children(parent)).find((c: any) => c.title === title);
  if (!child) throw new Error(`${parent} has no child "${title}"`);
  return refOf(child.short_id);
}
const issueOf = async (ref: string) => (await show(ref)).issue;
const labelsOf = async (ref: string): Promise<string[]> => ((await show(ref)).labels ?? []).map((l: any) => l.label);
// A pre-existing plan task (todo.phase set), as an earlier session's mirror leaves it; `issue` suffixes the title.
const planTask = (title: string, parent: string) => issue(title, { parent, meta: ["todo.phase=Tasks", "todo.status=pending"] });
const titles = async (parent: string) => (await children(parent)).map((c: any) => c.title).sort();

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

test("with todo.backend native the plugin neither guards nor mirrors and says so once; switching back mirrors the current list", async () => {
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

test("a delegate's todo with no assignment is neither guarded nor mirrored", async () => {
  const lead = host(); await lead.event("session_start");
  const parent = await lead.init(["Lead task"]);
  const delegate = host({ agent: { kind: "sub", id: "unassigned-delegate", parentId: lead.ctx.agent.id } });
  const before = await total();
  expect((await delegate.call({ op: "init", items: ["Own task", "Other task"] })).isError).toBeUndefined();
  expect((await delegate.call({ op: "done", task: "Own task" })).isError).toBeUndefined();
  expect(await total()).toBe(before);
  expect(await sessionParents(delegate.sid)).toHaveLength(0);
  expect(await titles(parent)).toEqual(["Lead task"]);
  expect(delegate.backendErrors).toEqual([]);
});

test("a mirror while Kata is unreachable does not throw, and the change lands in Kata on the next change once it answers", async () => {
  let unreachable = false;
  const app = host({ before: (args: string[]) => unreachable && (args[0] === "create" || args[0] === "show") ? down() : undefined });
  await app.event("session_start");
  unreachable = true;
  const before = await total();
  const init = await app.call({ op: "init", items: ["Write parser", "Write docs"] });
  expect(init.isError, init.content[0].text).toBeUndefined();
  expect(app.backendErrors).toEqual([]);
  expect(await total()).toBe(before);

  unreachable = false;
  const appended = await app.call({ op: "append", items: ["Write tests"] });
  expect(appended.isError, appended.content[0].text).toBeUndefined();
  expect(app.backendErrors).toEqual([]);
  const [parent] = await sessionParents(app.sid);
  expect(parent).toBeDefined();
  expect(await titles(parent.qualified_id)).toEqual(["Write docs", "Write parser", "Write tests"]);
});
