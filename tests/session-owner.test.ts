import { expect, test } from "bun:test";
import { eventually, EVIDENCE, MESSAGE, realKata, unique } from "./kata-fixture";
import { ompHost } from "./omp-host";
import type { TodoStatus } from "./omp-native-todo";

// Who holds a plan task when several lead sessions of one user share a plan parent, on omp's native todo. Two leads have the same
// actor and the same empty teammate (no KATA_TEAMMATE): only the session marker tells them apart. A session marks the tasks its
// native list starts (the first pending task starts with an init), the guard refuses a todo call on a task another session holds,
// and only the user's `/todo takeover <task>` moves it. Releases at shutdown and switch, forks and resumes are checked here too.
const store = realKata({ prefix: "session-owner", author: "actor-a", project: "omptest", adopt: true });
const { cwd, run, kata, show } = store;
const issue = (parent?: string) => store.issue(`Session owner ${unique()}`, { parent });
const meta = async (ref: string) => (await show(ref)).issue.metadata ?? {};
// A plan task the native list names by its title; the title is the list's content.
const title = (label: string) => `${label} ${unique()}`;
const task = (parent: string, content: string, status: "pending" | "in_progress" = "pending", extra: string[] = []) =>
  store.issue(content, { parent, meta: ["todo.phase=Tasks", `todo.status=${status}`, ...extra] });
// The agent's own `kata close` in its shell: the guard lets a native done through once Kata has the close.
const closeTask = (ref: string) => kata(["close", ref, "--done", "--message", MESSAGE, ...EVIDENCE.flatMap(e => ["--evidence", e]), "--json"]);

// A refusal for a task another session holds: names the holder and sends the model to the user.
function heldBy(result: { isError?: boolean; content: { text: string }[] }, session: string) {
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain(`was started by another session (${session}), which has not released it`);
  expect(result.content[0].text).toContain("ask the user to run /todo takeover");
}
// A refusal for this session's own task: only the Kata close is missing.
function ownTask(result: { isError?: boolean; content: { text: string }[] }) {
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("Close it first");
  expect(result.content[0].text).not.toContain("held by session");
}

// `header` makes the lead a fork of another session.
function lead(sid: string, parent: string, header?: unknown) {
  const app = ompHost({ run: args => run(args), cwd, sid, agent: { kind: "main", id: `main-${sid}` }, header,
    entries: [{ type: "custom", customType: "io.kata.omp.parent", data: { parent } }] });
  return {
    app,
    entries: app.entries,
    // The session starts and inits its native list with `titles`: the first starts, as omp's init does, so this session holds it.
    async begin(...titles: string[]) { await app.event("session_start"); if (titles.length) expect((await app.call({ op: "init", items: titles })).isError).toBeUndefined(); },
    // The session starts with a native list it did not start itself (a fork's copy, a resumed list, a second lead's own list): nothing starts.
    async seed(...items: [string, TodoStatus][]) { await app.event("session_start"); await app.edit([{ name: "Tasks", tasks: items.map(([content, status]) => ({ content, status })) }]); },
    call: (params: any) => app.call(params),
    // The lead's own shell close, then the native done.
    async done(ref: string, content: string) { await closeTask(ref); return app.call({ op: "done", task: content }); },
    command: async (text: string) => { await app.event("input", { text, source: "interactive" }); return app.notices.at(-1)?.[0] as string; },
    shutdown: () => app.event("session_shutdown"),
    // The same process switches to another session (omp /new or /resume), or to a fork of this one (`header`);
    // `branch` replaces the session entries the new session sees (a fork of history from before the plan).
    switchTo: (next: string, header?: unknown, branch?: unknown[]) => {
      const sm = app.ctx.sessionManager;
      return app.event("session_switch", {}, { ...app.ctx,
        sessionManager: { getSessionFile: () => sm.getSessionFile(), getEntries: () => sm.getEntries(), getSessionId: () => next, getHeader: () => header, getBranch: () => branch ?? sm.getBranch() } });
    },
  };
}

test("a task one lead started is refused to another lead of the same actor and teammate", async () => {
  const parent = await issue();
  const name = title("Held task"), ref = await task(parent, name);
  const a = lead("session-a", parent), b = lead("session-b", parent);
  await a.begin(name);
  expect((await meta(ref))["todo.session"]).toBe("session-a");
  await b.seed([name, "pending"]);
  for (const params of [{ op: "start", task: name }, { op: "done", task: name }, { op: "drop", task: name }, { op: "rm", task: name }]) heldBy(await b.call(params), "session-a");
  const after = await show(ref);
  expect(after.issue.status).toBe("open");
  expect(after.issue.metadata["todo.status"]).toBe("in_progress");
  expect(after.issue.metadata["todo.session"]).toBe("session-a");
  // The first session keeps working its task.
  expect((await a.done(ref, name)).isError).toBeUndefined();
  expect((await show(ref)).issue.status).toBe("closed");
});

test("/todo takeover moves the task to the new session and records both sessions on the issue", async () => {
  const parent = await issue();
  const name = title("Taken task"), ref = await task(parent, name);
  const a = lead("session-a", parent), b = lead("session-b", parent);
  await a.begin(name);
  await b.seed([name, "pending"]);
  await b.command(`/todo takeover ${name}`);
  const after = await show(ref);
  expect(after.issue.metadata["todo.session"]).toBe("session-b");
  expect(after.issue.metadata["todo.status"]).toBe("in_progress");
  expect((after.comments ?? []).map((c: { body: string }) => c.body)).toContain("Taken over by session session-b from session session-a, which started it.");
  // Now the first session is the other one.
  heldBy(await a.call({ op: "done", task: name }), "session-b");
  // The taker works the task on: its own done wants the Kata close, then goes through.
  ownTask(await b.call({ op: "done", task: name }));
  expect((await b.done(ref, name)).isError).toBeUndefined();
  expect((await show(ref)).issue.status).toBe("closed");
});

test("an init that leaves out a task another session started is refused naming the holder, and changes nothing", async () => {
  const parent = await issue();
  const name = title("Kept task"), ref = await task(parent, name);
  const a = lead("session-a", parent), b = lead("session-b", parent);
  await a.begin(name);
  await b.seed([name, "pending"]);
  const result = await b.call({ op: "init", items: ["A different plan"] });
  heldBy(result, "session-a");
  expect(result.content[0].text).toContain(name);
  expect((await show(parent)).children.map((c: { title: string }) => c.title)).not.toContain("A different plan");
  expect((await show(ref)).issue.status).toBe("open");
  expect(b.app.list()[0].tasks.map(t => t.content)).toEqual([name]);
});

test("a fork works on what its source started; its source does not get the fork's", async () => {
  const parent = await issue();
  const first = title("First"), second = title("Second");
  const firstRef = await task(parent, first), secondRef = await task(parent, second);
  const a = lead("session-a", parent);
  await a.begin(first, second);
  const fork = lead("session-f", parent, { parentSession: "/sessions/2026-11-13T00-00-00_session-a.jsonl" });
  await fork.seed([first, "in_progress"], [second, "pending"]);
  ownTask(await fork.call({ op: "done", task: first }));
  expect((await fork.done(firstRef, first)).isError).toBeUndefined();
  expect((await fork.call({ op: "start", task: second })).isError).toBeUndefined();
  expect((await meta(secondRef))["todo.session"]).toBe("session-f");
  heldBy(await a.call({ op: "done", task: second }), "session-f");
});

test("a resumed session keeps its fork lineage from the snapshot", async () => {
  const parent = await issue();
  const name = title("Lineage task"), ref = await task(parent, name);
  const a = lead("session-a", parent);
  await a.begin(name);
  const fork = lead("session-f", parent, { parentSession: "session-a" });
  await fork.seed([name, "in_progress"]);
  const snapshot = fork.entries.findLast(e => e.customType === "io.kata.omp.state")?.data;
  expect(snapshot.ownSessions).toEqual(["session-f", "session-a"]);
  // Resumed with the same branch but no fork header: the saved sessions still include the source.
  const resumed = ompHost({ run: args => run(args), cwd, sid: "session-f", agent: { kind: "main", id: "main-session-f" }, entries: [...fork.entries] });
  await resumed.event("session_start");
  await resumed.edit([{ name: "Tasks", tasks: [{ content: name, status: "in_progress" }] }]);
  ownTask(await resumed.call({ op: "done", task: name }));
  await closeTask(ref);
  expect((await resumed.call({ op: "done", task: name })).isError).toBeUndefined();
});

test("pending items and items without the marker keep the actor and teammate rule", async () => {
  const parent = await issue();
  const [unmarkedName, pendingName] = [title("Unmarked"), title("Pending")];
  const unmarked = await task(parent, unmarkedName, "in_progress");
  const pending = await task(parent, pendingName, "pending", ["todo.session=session-a"]);
  const b = lead("session-b", parent);
  await b.seed([unmarkedName, "in_progress"], [pendingName, "pending"]);
  ownTask(await b.call({ op: "done", task: unmarkedName }));
  // The done moves omp's list on: the next pending task starts, and it is session-b's.
  expect((await b.done(unmarked, unmarkedName)).isError).toBeUndefined();
  expect((await meta(pending))["todo.session"]).toBe("session-b");
  expect((await meta(pending))["todo.status"]).toBe("in_progress");
});

test("items a lead creates carry its session", async () => {
  const parent = await issue();
  const name = title("A marked item");
  const a = lead("session-a", parent);
  await a.begin();
  expect((await a.call({ op: "append", items: [name] })).isError).toBeUndefined();
  const child = (await show(parent)).children.find((c: { title: string }) => c.title === name);
  expect(child.metadata["todo.session"]).toBe("session-a");
});

test("a lead that shuts down releases its started tasks, so the next session continues them without a takeover", async () => {
  const parent = await issue();
  const name = title("Released task"), ref = await task(parent, name);
  const a = lead("session-a", parent);
  await a.begin(name);
  await a.shutdown();
  const released = await meta(ref);
  expect(released["todo.session"]).toBeUndefined();
  expect(released["todo.status"]).toBe("in_progress");
  const b = lead("session-b", parent);
  await b.seed([name, "in_progress"]);
  expect((await b.done(ref, name)).isError).toBeUndefined();
  expect((await show(ref)).issue.status).toBe("closed");
});

test("a switch to another session releases the tasks the previous one started", async () => {
  const parent = await issue();
  const name = title("Switched task"), ref = await task(parent, name);
  const a = lead("session-a", parent);
  await a.begin(name);
  await a.switchTo("session-a2");
  await eventually(async () => (await meta(ref))["todo.session"], undefined);
});

test("a switch to a fork of the session hands it the tasks the source held, and the fork's end releases them", async () => {
  const parent = await issue();
  const name = title("Forked task"), ref = await task(parent, name);
  const a = lead("session-a", parent);
  await a.begin(name);
  await a.switchTo("session-a-fork", { parentSession: "session-a" });
  await eventually(async () => (await meta(ref))["todo.session"], "session-a-fork");
  await a.shutdown();
  await eventually(async () => (await meta(ref))["todo.session"], undefined);
});

test("a fork's shutdown leaves its source's started tasks held", async () => {
  const parent = await issue();
  const name = title("Source task"), ref = await task(parent, name);
  const a = lead("session-a", parent);
  await a.begin(name);
  const fork = lead("session-f", parent, { parentSession: "session-a" });
  await fork.seed([name, "in_progress"]);
  await fork.shutdown();
  expect((await meta(ref))["todo.session"]).toBe("session-a");
});

test("restarting a task closed outside the plan takes it, whoever's marker it still carries", async () => {
  const parent = await issue();
  const name = title("Closed outside"), ref = await task(parent, name, "in_progress", ["todo.session=session-a"]);
  await kata(["claim", ref, "--json"]);
  await kata(["close", ref, "--done", "--message", "Closed outside the plan by a person in the Kata terminal UI.", "--evidence", "test:external", "--json"]);
  const b = lead("session-b", parent);
  await b.begin(name);
  const after = await show(ref);
  expect(after.issue.status).toBe("open");
  expect(after.issue.metadata["todo.session"]).toBe("session-b");
});

test("every /todo takeover leaves its own comment, also back and forth between two sessions", async () => {
  const parent = await issue();
  const name = title("Passed task"), ref = await task(parent, name);
  const a = lead("session-a", parent), b = lead("session-b", parent);
  await a.begin(name);
  await b.seed([name, "pending"]);
  for (const [who, session] of [[b, "session-b"], [a, "session-a"], [b, "session-b"]] as const) {
    await who.command(`/todo takeover ${name}`);
    expect((await meta(ref))["todo.session"]).toBe(session);
  }
  const comments = ((await show(ref)).comments ?? []).filter((c: { body: string }) => c.body.startsWith("Taken over by session"));
  expect(comments.length).toBe(3);
});

test("a ticket item may name another plan's task that session holds; tickets keep the actor and teammate rule", async () => {
  const other = await issue();
  const name = title("Held elsewhere"), held = await task(other, name);
  const a = lead("session-a", other);
  await a.begin(name);
  const parent = await issue();
  const b = lead("session-b", parent);
  await b.begin();
  const item = `omptest#${held}: review the change`;
  const result = await b.call({ op: "append", items: [item] });
  expect(result.isError).toBeUndefined();
  expect(b.app.list().flatMap(p => p.tasks.map(t => t.content))).toEqual([item]);
  // The mirror reported no refusal for the held ticket.
  expect(b.app.mirrorFailures()).toEqual([]);
});

test("a /todo takeover that names no task takes nothing", async () => {
  const parent = await issue();
  const name = title("Unnamed takeover"), ref = await task(parent, name);
  const a = lead("session-a", parent), b = lead("session-b", parent);
  await a.begin(name);
  await b.seed([name, "pending"]);
  expect(await b.command("/todo takeover")).toContain("takeover needs the task");
  expect((await meta(ref))["todo.session"]).toBe("session-a");
});

test("a switch to a fork whose history predates the plan releases the source's tasks", async () => {
  const parent = await issue();
  const name = title("Early fork task"), ref = await task(parent, name);
  const a = lead("session-a", parent);
  await a.begin(name);
  await a.switchTo("session-a-early-fork", { parentSession: "session-a" }, []);
  expect((await meta(ref))["todo.session"]).toBeUndefined();
});

test("starting a task its session released holds it for the session that continues it", async () => {
  const parent = await issue();
  const name = title("Continued task"), ref = await task(parent, name);
  const a = lead("session-a", parent);
  await a.begin(name);
  await a.shutdown();
  const b = lead("session-b", parent);
  await b.seed([name, "pending"]);
  expect((await b.call({ op: "start", task: name })).isError).toBeUndefined();
  expect((await meta(ref))["todo.session"]).toBe("session-b");
  const c = lead("session-c", parent);
  await c.seed([name, "pending"]);
  heldBy(await c.call({ op: "done", task: name }), "session-b");
  expect((await show(ref)).issue.status).toBe("open");
});

test("a switch to a session whose plan parent no longer resolves still releases the previous session's tasks", async () => {
  const parent = await issue();
  const name = title("Gone parent task"), ref = await task(parent, name);
  const a = lead("session-a", parent);
  await a.begin(name);
  await a.switchTo("session-gone", undefined, [{ type: "custom", customType: "io.kata.omp.parent", data: { parent: "omptest#zzzz" } }]);
  await eventually(async () => (await meta(ref))["todo.session"], undefined);
});

test("a lead's start marks the task with its session when a sub identity's session start reaches its handlers mid-call", async () => {
  const parent = await issue();
  const name = title("Midcall task"), ref = await task(parent, name);
  let midCall: (() => void) | undefined;
  const app = ompHost({ run: args => run(args), cwd, sid: "session-midcall", agent: { kind: "main", id: "main-session-midcall" },
    entries: [{ type: "custom", customType: "io.kata.omp.parent", data: { parent } }],
    before: () => { midCall?.(); midCall = undefined; } });
  await app.event("session_start");
  await app.edit([{ name: "Tasks", tasks: [{ content: name, status: "pending" }] }]);
  // A sub identity of the session (omp's advisor) starts while the lead's call waits for Kata.
  let started: Promise<unknown> | undefined;
  midCall = () => { started = app.event("session_start", {}, { ...app.ctx, agent: { kind: "sub", id: "Advisor" } }); };
  expect((await app.call({ op: "start", task: name })).isError).toBeUndefined();
  await started;
  expect(started).toBeDefined();
  expect((await meta(ref))["todo.session"]).toBe("session-midcall");
});
