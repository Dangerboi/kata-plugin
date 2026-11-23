import { afterEach, expect, test } from "bun:test";
import { eventually, later } from "./kata-fixture";
import { siblingThrottle } from "./kata-errors";
import { piFixture } from "./pi-fixture";

// Ownership of a plan task between two pi leads of one actor, through pi's own todo tool and /todo command: refusals for another
// session's task, takeover, init that leaves held tasks out, bare done, blocked and same-title tasks.
const { show, closesOf, host, evidence, message, unique } = piFixture();
afterEach(() => { delete process.env.KATA_REF; });

const held = (parent: string, title: string) => show(parent).then(shown => shown.children.find((c: { title: string }) => c.title === title));
const said = (lead: { messages: any[] }) => lead.messages.at(-1)[0].content as string;
const start = async () => { const lead = await host(); await lead.event("session_start", { reason: "startup" }); return lead; };
// The first lead plans and starts `title`; the next host is a second lead on the same parent.
async function twoLeads(title: string, ...others: string[]) {
  const a = await start();
  const parent = await a.init([title, ...others]);
  await a.call({ op: "start", task: title });
  process.env.KATA_REF = parent;
  const b = await start();
  return { a, b, parent, ref: (await held(parent, title)).qualified_id as string };
}

test("start, done, drop and block of a task another pi lead started are refused", async () => {
  const { a, b, ref } = await twoLeads("Held pi task");
  for (const params of [{ op: "start", task: "Held pi task" }, { op: "done", task: "Held pi task", message, evidence }, { op: "drop", task: "Held pi task", message: "not needed" }, { op: "block", task: "Held pi task", reason: "waiting" }]) {
    const result = await b.call(params);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(`started by another session (${a.sid})`);
  }
  const after = await show(ref);
  expect(after.issue.status).toBe("open");
  expect(after.issue.metadata["todo.status"]).toBe("in_progress");
  expect(after.issue.metadata["todo.session"]).toBe(a.sid);
  // The first lead keeps working its task.
  expect((await a.call({ op: "done", task: "Held pi task", message, evidence })).isError).toBeUndefined();
  expect((await show(ref)).issue.status).toBe("closed");
});

test("a /todo command is refused on another pi lead's task; /todo takeover takes it over", async () => {
  const { a, b, ref } = await twoLeads("Commanded pi task");
  await b.command("done Commanded pi task");
  expect(said(b)).toContain(`started by another session (${a.sid})`);
  expect((await show(ref)).issue.status).toBe("open");
  await b.command("takeover Commanded pi task");
  const taken = await show(ref);
  expect(taken.issue.metadata["todo.session"]).toBe(b.sid);
  expect(taken.comments.some((c: { body: string }) => c.body.startsWith(`Taken over by session ${b.sid}`))).toBe(true);
  await b.command("done Commanded pi task");
  expect((await show(ref)).issue.status).toBe("closed");
});

test("takeover moves the task to the new pi lead and records both sessions on the issue, again and again between two leads", async () => {
  const { a, b, ref } = await twoLeads("Passed pi task");
  for (const [who, other] of [[b, a], [a, b], [b, a]] as const) {
    expect((await who.call({ op: "start", task: "Passed pi task", takeover: true })).isError).toBeUndefined();
    expect((await show(ref)).issue.metadata["todo.session"]).toBe(who.sid);
    const refused = await other.call({ op: "done", task: "Passed pi task", message, evidence });
    expect(refused.content[0].text).toContain(`started by another session (${who.sid})`);
  }
  const comments = (await show(ref)).comments.filter((c: { body: string }) => c.body.startsWith("Taken over by session"));
  expect(comments.length).toBe(3);
});

test("init replace cannot drop a task another pi lead started, and the refusal names the takeover in pi's words", async () => {
  const { b, parent, ref } = await twoLeads("Kept pi task");
  const result = await b.call({ op: "init", replace: true, items: ["A different plan"] });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("leaves out tasks another session started");
  expect(result.content[0].text).toContain("take them over first (todo start with takeover: true), or keep them in the list.");
  expect((await show(parent)).children.map((c: { title: string }) => c.title)).not.toContain("A different plan");
  expect((await show(ref)).issue.status).toBe("open");
});

test("init does not take tasks over: takeover on init is an error that changes nothing", async () => {
  const { a, parent } = await twoLeads("Planned pi task");
  const result = await a.call({ op: "init", ref: parent, takeover: true, items: ["A takeover plan"] });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("init does not take tasks over");
  expect((await show(parent)).children.map((c: { title: string }) => c.title)).not.toContain("A takeover plan");
});

test("a phase without a task takes nothing over for an op that needs one task", async () => {
  const { a, b, ref } = await twoLeads("Phased pi task");
  expect((await b.call({ op: "start", phase: "Tasks", takeover: true })).isError).toBe(true);
  const after = await show(ref);
  expect(after.issue.metadata["todo.session"]).toBe(a.sid);
  expect(after.comments.some((c: { body: string }) => c.body.startsWith("Taken over by session"))).toBe(false);
});

test("a takeover that names no task is refused and takes nothing, through the tool and through /todo", async () => {
  const { a, b, ref } = await twoLeads("Unnamed pi task");
  const refused = await b.call({ op: "start", takeover: true });
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toContain("takeover needs the task");
  await b.command("takeover");
  expect(said(b)).toContain("takeover needs the task");
  expect((await show(ref)).issue.metadata["todo.session"]).toBe(a.sid);
});

test("a bare done never picks this lead's task while another lead's task is in progress", async () => {
  const { a, b, parent, ref } = await twoLeads("First pi task", "Second pi task");
  const view = await b.call({ op: "view" });
  expect(view.content[0].text).toContain(`(${ref}) — started by session ${a.sid}`);
  // Starting another task leaves two in progress, one of them not this lead's.
  const second = await held(parent, "Second pi task");
  expect((await b.call({ op: "start", task: "Second pi task" })).isError).toBeUndefined();
  const refused = await b.call({ op: "done", message, evidence });
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toContain("Several tasks are in progress");
  expect((await show(second.qualified_id)).issue.status).toBe("open");
});

test("/todo takeover of a blocked task takes it over as it is and reports no error", async () => {
  const { a, b, ref } = await twoLeads("Blocked pi task");
  await a.call({ op: "block", task: "Blocked pi task", reason: "waiting on review" });
  await b.command("takeover Blocked pi task");
  expect(said(b)).not.toContain("unblock it first");
  expect(said(b)).toContain("blocked: waiting on review");
  const taken = await show(ref);
  expect(taken.issue.metadata["todo.session"]).toBe(b.sid);
  expect(taken.issue.metadata["todo.status"]).toBe("blocked");
  expect(taken.comments.some((c: { body: string }) => c.body.startsWith(`Taken over by session ${b.sid}`))).toBe(true);
});

test("tasks of one title in two phases are dropped with close messages of their own", async () => {
  const a = await start();
  expect((await a.call({ op: "init", list: [{ phase: "Build", items: ["Same title"] }, { phase: "Verify", items: ["Same title"] }] })).isError).toBeUndefined();
  const parent = (await a.call({ op: "view" })).details?.kata?.parent as string | undefined;
  const children = parent ? (await show(parent)).children : [];
  expect(children).toHaveLength(2);
  for (const child of children) expect((await a.call({ op: "drop", task: child.qualified_id, message: "covered elsewhere" })).isError).toBeUndefined();
  const messages = (await Promise.all(children.map((c: { qualified_id: string }) => closesOf(c.qualified_id)))).flat().map(event => event.payload.message);
  expect(messages).toHaveLength(2);
  // With Kata's close throttle on, a close that repeats a sibling's message is refused (duplicate_message).
  expect(new Set(messages).size).toBe(2);
});

test("a lead's end keeps the hold of a task whose close Kata deferred, and the resumed session makes that close", async () => {
  let throttled = true;
  const sid = `pi-deferred-${unique()}`;
  const a = await host({ sid, before: (args: string[]) => args[0] === "close" && throttled ? siblingThrottle() : undefined });
  await a.event("session_start", { reason: "startup" });
  const parent = await a.init(["Deferred pi close"]);
  await a.call({ op: "start", task: "Deferred pi close" });
  const ref = (await held(parent, "Deferred pi close")).qualified_id as string;
  expect((await a.call({ op: "done", task: "Deferred pi close", message, evidence })).isError).toBeUndefined();
  const open = await show(ref);
  expect(open.issue.status).toBe("open");
  await a.event("session_shutdown", {});
  const kept = (await show(ref)).issue;
  expect(kept.status).toBe("open");
  expect(kept.metadata["todo.session"]).toBe(sid);
  expect(kept.revision).toBe(open.issue.revision);
  throttled = false;
  // The retry is due when the session resumes: its bind restores the pending close and makes it.
  const resumed = await host({ sid, entries: a.entries });
  await later(async () => {
    await resumed.event("session_start", { reason: "resume" });
    await eventually(async () => (await show(ref)).issue.status, "closed");
  });
});
