import { expect, test } from "bun:test";
import { eventually, later, realKata } from "./kata-fixture";
import { siblingThrottle } from "./kata-errors";
import { ompHost } from "./omp-host";
import { TRANSCRIPT_ENV } from "../core/kata-cli";

// Two lead sessions of one user, no KATA_TEAMMATE: same actor, same empty teammate. Only the session marker tells them apart.
const { cwd, run, kata, show } = realKata({ prefix: "session-owner", author: "actor-a", project: "omptest", adopt: true });
let sequence = 0;
async function issue(meta: string[] = [], parent?: string) {
  const args = ["create", `Session owner ${++sequence}`, "--force-new", "--json"];
  if (parent) args.push("--parent", parent);
  for (const value of meta) args.push("--meta", value);
  return (await kata(args)).issue.short_id as string;
}
const meta = async (ref: string) => (await show(ref)).issue.metadata ?? {};

// `header` makes the lead a fork of another session.
function lead(sid: string, parent: string, header?: unknown) {
  const app = ompHost({ run: args => run(args), cwd, sid, agent: { kind: "main", id: `main-${sid}` }, header,
    entries: [{ type: "custom", customType: "io.kata.omp.parent", data: { parent } }] });
  return {
    entries: app.entries,
    async begin() { await app.event("session_start"); await app.call({ op: "view" }); },
    call: (params: any) => app.call(params),
    command: async (text: string) => { await app.event("input", { text, source: "interactive" }); return app.notices.at(-1)?.[0] as string; },
    shutdown: () => app.event("session_shutdown"),
    // The same process switches to another session (omp /new or /resume), or to a fork of this one (`header`);
    // `branch` replaces the session entries the new session sees (a fork of history from before the plan).
    switchTo: (next: string, header?: unknown, branch?: unknown[]) => app.event("session_switch", {}, { ...app.ctx,
      sessionManager: { ...app.ctx.sessionManager, getSessionId: () => next, getHeader: () => header, ...(branch ? { getBranch: () => branch } : {}) } }),
  };
}
const proof = { message: "Finished the step and checked the result with the session test.", evidence: ["test:session-owner"] };

test("a task one lead started is refused to another lead of the same actor and teammate", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const a = lead("session-a", parent), b = lead("session-b", parent);
  await a.begin();
  expect((await a.call({ op: "start", task: ref })).isError).toBeUndefined();
  expect((await meta(ref))["todo.session"]).toBe("session-a");
  await b.begin();
  for (const params of [{ op: "start", task: ref }, { op: "done", task: ref, ...proof }, { op: "drop", task: ref, message: "not needed" }, { op: "block", task: ref, reason: "waiting" }]) {
    const result = await b.call(params);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("started by another session (session-a)");
  }
  const after = await show(ref);
  expect(after.issue.status).toBe("open");
  expect(after.issue.metadata["todo.status"]).toBe("in_progress");
  expect(after.issue.metadata["todo.session"]).toBe("session-a");
  // The first session keeps working its task.
  expect((await a.call({ op: "done", task: ref, ...proof })).isError).toBeUndefined();
  expect((await show(ref)).issue.status).toBe("closed");
});

test("takeover moves the task to the new session and records both sessions on the issue", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const a = lead("session-a", parent), b = lead("session-b", parent);
  await a.begin();
  await a.call({ op: "start", task: ref });
  await b.begin();
  expect((await b.call({ op: "start", task: ref, takeover: true })).isError).toBeUndefined();
  const after = await show(ref);
  expect(after.issue.metadata["todo.session"]).toBe("session-b");
  expect(after.issue.metadata["todo.status"]).toBe("in_progress");
  expect((after.comments ?? []).map((c: { body: string }) => c.body)).toContain("Taken over by session session-b from session session-a, which started it.");
  // Now the first session is the other one.
  const refused = await a.call({ op: "done", task: ref, ...proof });
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toContain("started by another session (session-b)");
});

test("a /todo command is refused on another session's task; /todo takeover takes it over", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const a = lead("session-a", parent), b = lead("session-b", parent);
  await a.begin();
  await a.call({ op: "start", task: ref });
  await b.begin();
  expect(await b.command(`/todo done ${ref}`)).toContain("started by another session (session-a)");
  expect((await show(ref)).issue.status).toBe("open");
  await b.command(`/todo takeover ${ref}`);
  const taken = await show(ref);
  expect(taken.issue.metadata["todo.session"]).toBe("session-b");
  expect((taken.comments ?? []).some((c: { body: string }) => c.body.startsWith("Taken over by session session-b"))).toBe(true);
  await b.command(`/todo done ${ref}`);
  expect((await show(ref)).issue.status).toBe("closed");
});

test("init replace cannot drop a task another session started", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const a = lead("session-a", parent), b = lead("session-b", parent);
  await a.begin();
  await a.call({ op: "start", task: ref });
  await b.begin();
  const result = await b.call({ op: "init", ref: parent, replace: true, items: ["A different plan"] });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("leaves out tasks another session started");
  const after = await show(parent);
  expect(after.children.map((c: { title: string }) => c.title)).not.toContain("A different plan");
  expect((await show(ref)).issue.status).toBe("open");
});

test("a fork works on what its source started; its source does not get the fork's", async () => {
  const parent = await issue();
  const first = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const second = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const a = lead("session-a", parent);
  await a.begin();
  await a.call({ op: "start", task: first });
  const fork = lead("session-f", parent, { parentSession: "/sessions/2026-11-13T00-00-00_session-a.jsonl" });
  await fork.begin();
  expect((await fork.call({ op: "done", task: first, ...proof })).isError).toBeUndefined();
  expect((await fork.call({ op: "start", task: second })).isError).toBeUndefined();
  expect((await meta(second))["todo.session"]).toBe("session-f");
  const refused = await a.call({ op: "done", task: second, ...proof });
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toContain("started by another session (session-f)");
});

test("a resumed session keeps its fork lineage from the snapshot", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const a = lead("session-a", parent);
  await a.begin();
  await a.call({ op: "start", task: ref });
  const fork = lead("session-f", parent, { parentSession: "session-a" });
  await fork.begin();
  const snapshot = fork.entries.findLast(e => e.customType === "io.kata.omp.state")?.data;
  expect(snapshot.ownSessions).toEqual(["session-f", "session-a"]);
  // Resumed with the same branch but no fork header: the saved sessions still include the source.
  const resumed = ompHost({ run: args => run(args), cwd, sid: "session-f", agent: { kind: "main", id: "main-session-f" }, entries: [...fork.entries] });
  await resumed.event("session_start");
  expect((await resumed.call({ op: "done", task: ref, ...proof })).isError).toBeUndefined();
});

test("pending items and items without the marker keep the actor and teammate rule", async () => {
  const parent = await issue();
  const unmarked = await issue(["todo.phase=Tasks", "todo.status=in_progress"], parent);
  const pending = await issue(["todo.phase=Tasks", "todo.status=pending", "todo.session=session-a"], parent);
  const b = lead("session-b", parent);
  await b.begin();
  expect((await b.call({ op: "done", task: unmarked, ...proof })).isError).toBeUndefined();
  expect((await b.call({ op: "start", task: pending })).isError).toBeUndefined();
  expect((await meta(pending))["todo.session"]).toBe("session-b");
});

test("items a lead creates carry its session", async () => {
  const parent = await issue();
  const a = lead("session-a", parent);
  await a.begin();
  expect((await a.call({ op: "append", items: ["A marked item"] })).isError).toBeUndefined();
  const child = (await show(parent)).children.find((c: { title: string }) => c.title === "A marked item");
  expect(child.metadata["todo.session"]).toBe("session-a");
});

test("a bare done never picks this session's task while another session's task is in progress", async () => {
  const parent = await issue();
  const first = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const a = lead("session-a", parent), b = lead("session-b", parent);
  await a.begin();
  await a.call({ op: "start", task: first });
  await b.begin();
  const view = await b.call({ op: "view" });
  expect(view.content[0].text).toContain(`(omptest#${first}) — started by session session-a`);
  // Starting another task leaves two in progress, one of them not this session's.
  const second = (await show(parent)).children.find((c: { short_id: string }) => c.short_id !== first).short_id;
  expect((await b.call({ op: "start", task: second })).isError).toBeUndefined();
  const refused = await b.call({ op: "done", ...proof });
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toContain("Several tasks are in progress");
  expect((await show(second)).issue.status).toBe("open");
});

test("a lead that shuts down releases its started tasks, so the next session continues them without a takeover", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const a = lead("session-a", parent);
  await a.begin();
  await a.call({ op: "start", task: ref });
  await a.shutdown();
  const released = await meta(ref);
  expect(released["todo.session"]).toBeUndefined();
  expect(released["todo.status"]).toBe("in_progress");
  const b = lead("session-b", parent);
  await b.begin();
  expect((await b.call({ op: "done", ...proof })).isError).toBeUndefined();
  expect((await show(ref)).issue.status).toBe("closed");
});

test("a switch to another session releases the tasks the previous one started", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const a = lead("session-a", parent);
  await a.begin();
  await a.call({ op: "start", task: ref });
  await a.switchTo("session-a2");
  await eventually(async () => (await meta(ref))["todo.session"], undefined);
});

test("a switch to a fork of the session hands it the tasks the source held, and the fork's end releases them", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const a = lead("session-a", parent);
  await a.begin();
  await a.call({ op: "start", task: ref });
  await a.switchTo("session-a-fork", { parentSession: "session-a" });
  await eventually(async () => (await meta(ref))["todo.session"], "session-a-fork");
  await a.shutdown();
  await eventually(async () => (await meta(ref))["todo.session"], undefined);
});

test("a fork's shutdown leaves its source's started tasks held", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const a = lead("session-a", parent);
  await a.begin();
  await a.call({ op: "start", task: ref });
  const fork = lead("session-f", parent, { parentSession: "session-a" });
  await fork.begin();
  await fork.shutdown();
  expect((await meta(ref))["todo.session"]).toBe("session-a");
});

test("restarting a task closed outside the plan takes it, whoever's marker it still carries", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=in_progress", "todo.session=session-a"], parent);
  await kata(["claim", ref, "--json"]);
  await kata(["close", ref, "--done", "--message", "Closed outside the plan by a person in the Kata terminal UI.", "--evidence", "test:external", "--json"]);
  const b = lead("session-b", parent);
  await b.begin();
  expect((await b.call({ op: "start", task: ref })).isError).toBeUndefined();
  const after = await show(ref);
  expect(after.issue.status).toBe("open");
  expect(after.issue.metadata["todo.session"]).toBe("session-b");
});

test("every takeover leaves its own comment, also back and forth between two sessions", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const a = lead("session-a", parent), b = lead("session-b", parent);
  await a.begin(); await b.begin();
  await a.call({ op: "start", task: ref });
  for (const [who, session] of [[b, "session-b"], [a, "session-a"], [b, "session-b"]] as const) {
    expect((await who.call({ op: "start", task: ref, takeover: true })).isError).toBeUndefined();
    expect((await meta(ref))["todo.session"]).toBe(session);
  }
  const comments = ((await show(ref)).comments ?? []).filter((c: { body: string }) => c.body.startsWith("Taken over by session"));
  expect(comments.length).toBe(3);
});

test("a phase without a task takes nothing over for an op that needs one task", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const a = lead("session-a", parent), b = lead("session-b", parent);
  await a.begin();
  await a.call({ op: "start", task: ref });
  await b.begin();
  expect((await b.call({ op: "start", phase: "Tasks", takeover: true })).isError).toBe(true);
  const after = await show(ref);
  expect(after.issue.metadata["todo.session"]).toBe("session-a");
  expect((after.comments ?? []).some((c: { body: string }) => c.body.startsWith("Taken over by session"))).toBe(false);
});

test("a ticket item may name another plan's task that session holds; tickets keep the actor and teammate rule", async () => {
  const other = await issue();
  const held = await issue(["todo.phase=Tasks", "todo.status=pending"], other);
  const a = lead("session-a", other);
  await a.begin();
  await a.call({ op: "start", task: held });
  const parent = await issue();
  const b = lead("session-b", parent);
  await b.begin();
  const result = await b.call({ op: "append", items: [`omptest#${held}: review the change`] });
  expect(result.isError).toBeUndefined();
  expect(result.content[0].text).toContain(`omptest#${held}: review the change`);
});

test("a takeover that names no task is refused and takes nothing", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const a = lead("session-a", parent), b = lead("session-b", parent);
  await a.begin();
  await a.call({ op: "start", task: ref });
  await b.begin();
  const refused = await b.call({ op: "start", takeover: true });
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toContain("takeover needs the task");
  expect(await b.command("/todo takeover")).toContain("takeover needs the task");
  expect((await meta(ref))["todo.session"]).toBe("session-a");
});

test("a switch to a fork whose history predates the plan releases the source's tasks", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const a = lead("session-a", parent);
  await a.begin();
  await a.call({ op: "start", task: ref });
  await a.switchTo("session-a-early-fork", { parentSession: "session-a" }, []);
  expect((await meta(ref))["todo.session"]).toBeUndefined();
});

test("starting a task its session released holds it for the session that continues it", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const a = lead("session-a", parent);
  await a.begin();
  await a.call({ op: "start", task: ref });
  await a.shutdown();
  const b = lead("session-b", parent);
  await b.begin();
  expect((await b.call({ op: "start", task: ref })).isError).toBeUndefined();
  expect((await meta(ref))["todo.session"]).toBe("session-b");
  const c = lead("session-c", parent);
  await c.begin();
  const refused = await c.call({ op: "done", task: ref, ...proof });
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toContain("started by another session (session-b)");
  expect((await show(ref)).issue.status).toBe("open");
});

test("a switch to a session whose plan parent no longer resolves still releases the previous session's tasks", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const a = lead("session-a", parent);
  await a.begin();
  await a.call({ op: "start", task: ref });
  await a.switchTo("session-gone", undefined, [{ type: "custom", customType: "io.kata.omp.parent", data: { parent: "omptest#zzzz" } }]);
  await eventually(async () => (await meta(ref))["todo.session"], undefined);
});

test("a lead's end keeps the hold of a task whose close Kata deferred, and the resumed session makes that close", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const entries: any[] = [{ type: "custom", customType: "io.kata.omp.parent", data: { parent } }];
  let throttled = true;
  // The adapter spawns closes itself while a transcript session is exported; without one they go through the host, which can refuse them.
  const session = () => ompHost({ run: args => run(args), cwd, sid: "session-t", agent: { kind: "main", id: "main-session-t" }, entries,
    before: (args: string[]) => args[0] === "close" && throttled ? siblingThrottle() : undefined,
    afterEvent: () => { for (const key of TRANSCRIPT_ENV) delete process.env[key]; } });
  const a = session();
  await a.event("session_start");
  await a.call({ op: "start", task: ref });
  const deferred = await a.call({ op: "done", task: ref, ...proof });
  expect(deferred.content[0].text).toContain("deferred");
  const revision = (await show(ref)).issue.revision;
  await a.event("session_shutdown");
  const kept = (await show(ref)).issue;
  expect(kept.metadata["todo.session"]).toBe("session-t");
  expect(kept.revision).toBe(revision);
  throttled = false;
  // The retry is due when the session resumes: its bind restores the pending close and makes it.
  const resumed = session();
  await later(async () => {
    await resumed.event("session_start");
    await eventually(async () => (await show(ref)).issue.status, "closed");
  });
});

test("tasks of one title in two phases are dropped with close messages of their own", async () => {
  const parent = await issue();
  const a = lead("session-a", parent);
  await a.begin();
  expect((await a.call({ op: "init", ref: parent, list: [{ phase: "Build", items: ["Same title"] }, { phase: "Verify", items: ["Same title"] }] })).isError).toBeUndefined();
  const ids: string[] = (await show(parent)).children.map((c: { short_id: string }) => c.short_id);
  for (const id of ids) expect((await a.call({ op: "drop", task: `omptest#${id}`, message: "covered elsewhere" })).isError).toBeUndefined();
  const messages = (await kata(["audit", "closes", "--json"])).rows.filter((r: { issue: string }) => ids.includes(r.issue)).map((r: { message: string }) => r.message);
  expect(messages).toHaveLength(2);
  // With Kata's close throttle on, a close that repeats a sibling's message is refused (duplicate_message).
  expect(new Set(messages).size).toBe(2);
});

test("/todo takeover of a blocked task takes it over as it is and reports no error", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const a = lead("session-a", parent), b = lead("session-b", parent);
  await a.begin();
  await a.call({ op: "start", task: ref });
  await a.call({ op: "block", task: ref, reason: "waiting on review" });
  await b.begin();
  const said = await b.command(`/todo takeover ${ref}`);
  expect(said).not.toContain("unblock it first");
  expect(said).toContain("blocked: waiting on review");
  const taken = await show(ref);
  expect(taken.issue.metadata["todo.session"]).toBe("session-b");
  expect(taken.issue.metadata["todo.status"]).toBe("blocked");
  expect((taken.comments ?? []).some((c: { body: string }) => c.body.startsWith("Taken over by session session-b"))).toBe(true);
});

test("a lead's start marks the task with its session when a sub identity's session start reaches its handlers mid-call", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  let midCall: (() => void) | undefined;
  const app = ompHost({ run: args => run(args), cwd, sid: "session-midcall", agent: { kind: "main", id: "main-session-midcall" },
    entries: [{ type: "custom", customType: "io.kata.omp.parent", data: { parent } }],
    before: () => { midCall?.(); midCall = undefined; } });
  await app.event("session_start");
  await app.call({ op: "view" });
  // A sub identity of the session (omp's advisor) starts while the lead's call waits for Kata.
  let started: Promise<unknown> | undefined;
  midCall = () => { started = app.event("session_start", {}, { ...app.ctx, agent: { kind: "sub", id: "Advisor" } }); };
  expect((await app.call({ op: "start", task: ref })).isError).toBeUndefined();
  await started;
  expect(started).toBeDefined();
  expect((await meta(ref))["todo.session"]).toBe("session-midcall");
});

test("the init refusal for a held task names the takeover in the host's words", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const a = lead("session-a", parent), b = lead("session-b", parent);
  await a.begin();
  await a.call({ op: "start", task: ref });
  await b.begin();
  const result = await b.call({ op: "init", ref: parent, replace: true, items: ["A different plan"] });
  expect(result.content[0].text).toContain("take them over first (todo start with takeover: true), or keep them in the list.");
});

test("init does not take tasks over: takeover on init is an error that changes nothing", async () => {
  const parent = await issue();
  await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const a = lead("session-a", parent);
  await a.begin();
  const result = await a.call({ op: "init", ref: parent, takeover: true, items: ["A takeover plan"] });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("init does not take tasks over");
  expect((await show(parent)).children.map((c: { title: string }) => c.title)).not.toContain("A takeover plan");
});
