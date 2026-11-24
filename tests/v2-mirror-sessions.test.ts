import { expect, test } from "bun:test";
import { eventually, holdKata, holdNext, memoryDelegateStore } from "./kata-fixture";
import { v2Fixture } from "./v2-fixture";
import { clearTranscriptEnv, kataViews, mirrorFailures, ompHost, rawOmpHost as rawHost } from "./omp-host";
import { createKataCore, snapshotEntry } from "../core/kata-core";
import { nodePlatform } from "../core/node-host";

// The omp adapter against a real Kata, on omp's native `todo`: how the mirror and the session's task ownership hold up when the
// session changes under it (/new, a fork, /tree) or Kata is away. One behaviour per test.
const { binary: kataBinary, scratch, cwd, run, show, issue, host, down, commentsOf, kata, unique } = v2Fixture();

// Every test names its own tasks: a title shared with another test would let the harness's title lookup find that test's plan.
const names = () => { const id = unique(); return { parser: `Write parser ${id}`, docs: `Write docs ${id}`, tests: `Write tests ${id}` }; };

const { children, childRef, labelsOf } = kataViews(show);
const planParentOf = async (title: string): Promise<string> => {
  const found = (await kata(["list", "--all", "--status", "all", "--json"])).issues.find((i: any) => i.title === title && i.parent);
  if (!found) throw new Error(`No plan task "${title}"`);
  return found.parent.qualified_id;
};
const holder = async (ref: string) => (await show(ref)).issue.metadata?.["todo.session"];
// A host bound to an existing plan parent, as a second lead of the same user is.
const lead = (parent: string) => host({ entries: [{ type: "custom", customType: "io.kata.omp.parent", data: { parent } }] });

test("a /new whose list reaches the backend before session_switch still releases the tasks the previous session started", async () => {
  const { parser: parserTask, docs: docsTask } = names();
  const app = host(); await app.event("session_start");
  const parent = await app.init([parserTask, docsTask]);
  const parser = await childRef(parent, parserTask);
  const started = app.sid;
  expect(await holder(parser)).toBe(started);
  await app.switchSession(`${started}-new`, { listFirst: true });
  await eventually(() => holder(parser), undefined);
  // Another lead, which started nothing, is not refused the task.
  const other = lead(parent); await other.event("session_start");
  await other.edit([{ name: "Tasks", tasks: [{ content: parserTask, status: "in_progress" }] }]);
  const result = await other.call({ op: "done", task: parserTask });
  expect(result.content[0].text).not.toContain("another session");
});

test("a fork whose list reaches the backend before session_switch holds the tasks its source started", async () => {
  const { parser: parserTask, docs: docsTask } = names();
  const app = host(); await app.event("session_start");
  const parent = await app.init([parserTask, docsTask]);
  const parser = await childRef(parent, parserTask);
  const source = app.sid;
  await app.switchSession(`${source}-fork`, { listFirst: true, fork: true });
  await eventually(() => holder(parser), `${source}-fork`);
});

test("an append that is a fork's first change returns only after the handoff of the source's tasks, while its replace is still held", async () => {
  const { parser: parserTask, docs: docsTask, tests: testsTask } = names();
  const hold = holdNext(args => args[0] === "meta" && args[1] === "set");
  const app = host({ before: hold.before }); await app.event("session_start");
  const parent = await app.init([parserTask, docsTask]);
  const parser = await childRef(parent, parserTask);
  const source = app.sid;
  // omp does not wait for session_switch before the model's next call: the handoff is still held in Kata when the append is asked.
  hold.arm();
  const switching = app.switchSession(`${source}-fork`, { fork: true });
  await hold.entered;
  const release = app.holdReplace();
  let released = false;
  // A real delay on purpose: a call that does not wait in apply for the handoff returns before the hold is released.
  const timer = setTimeout(() => { released = true; hold.release(); }, 300);
  try {
    expect((await app.call({ op: "append", items: [testsTask] })).isError).toBeUndefined();
    expect(released).toBe(true);
    expect(await holder(parser)).toBe(`${source}-fork`);
  } finally {
    clearTimeout(timer); hold.release(); release();
    await switching;
  }
  await app.settled();
  expect(await childRef(parent, testsTask)).toBeTruthy();
});

test("an append that is a fork's first change enters the plan in apply, so the fork holds its source's tasks when apply resolves, before session_switch runs", async () => {
  const { parser: parserTask, docs: docsTask, tests: testsTask } = names();
  const source = `v2-fork-apply-${unique()}`;
  const { app, event, replace, switchTo } = rawOmpHost(source, () => undefined);
  await event("session_start");
  const before = listOf([parserTask, "in_progress"], [docsTask, "pending"]);
  await replace(before);
  const parent = await planParentOf(parserTask);
  const parser = await childRef(parent, parserTask);
  expect(await holder(parser)).toBe(source);
  // omp's fork changes the session before the model's next call, and session_switch is not waited for.
  switchTo(`${source}-fork`, source);
  const next = [{ name: "Tasks", tasks: [...before[0].tasks, { content: testsTask, status: "pending" as const }] }];
  await app.todoBackend.apply({ op: "append", previous: before, next }, app.ctx);
  expect(await holder(parser)).toBe(`${source}-fork`);
  await event("session_switch");
});

test("a plain item and a ticket item set while Kata was away: the ticket gets no child titled after the item, and the item works the ticket", async () => {
  const ticket = await issue("Away ticket");
  let away = true;
  const app = host({ before: (args: string[]) => away ? down() : undefined });
  await app.event("session_start");
  const item = `v2test#${ticket}: do the action`;
  expect((await app.call({ op: "init", items: ["Plain item", item] })).isError).toBeUndefined();
  away = false;
  expect((await app.call({ op: "start", task: item })).isError).toBeUndefined();
  await eventually(async () => (await show(ticket)).issue.metadata?.["todo.status"], "in_progress");
  expect((await show(ticket)).issue.owner).toBe("v2-builder");
  expect((await children(ticket))).toEqual([]);
  expect((await kata(["list", "--status", "all", "--json"])).issues.some((i: any) => i.title === item)).toBe(false);
});

test("a /tree back to a branch that still has a task in progress does not reopen the task Kata closed since", async () => {
  const { parser: parserTask, docs: docsTask } = names();
  const app = host(); await app.event("session_start");
  const parent = await app.init([parserTask, docsTask]);
  const parser = await childRef(parent, parserTask);
  // What the branch held, and omp's list on it, before the task was done.
  const earlier = structuredClone(app.entries), earlierList = app.list();
  expect((await app.done(parserTask)).isError).toBeUndefined();
  expect((await show(parser)).issue.status).toBe("closed");
  app.entries.splice(0, app.entries.length, ...earlier);
  await app.event("session_tree");
  await app.edit(earlierList);
  expect(app.mirrorFailures()).toEqual([]);
  expect((await show(parser)).issue.status).toBe("closed");
  expect(await labelsOf(parser)).not.toContain("needs-review");
});

test("a task done natively while Kata was away stays open with needs-review and one comment once Kata is back, and is not blocked", async () => {
  const { parser: parserTask, docs: docsTask, tests: testsTask } = names();
  let away = false;
  const app = host({ before: (args: string[]) => away ? down() : undefined });
  await app.event("session_start");
  const parent = await app.init([parserTask, docsTask]);
  const parser = await childRef(parent, parserTask);
  away = true;
  expect((await app.call({ op: "done", task: parserTask })).isError).toBeUndefined();
  away = false;
  expect((await app.call({ op: "append", items: [testsTask] })).isError).toBeUndefined();
  await eventually(async () => await labelsOf(parser), ["needs-review"]);
  expect((await show(parser)).issue.status).toBe("open");
  expect(await commentsOf(parser)).toHaveLength(1);
  expect((await show(parser)).issue.metadata?.["todo.status"]).not.toBe("blocked");
});

test("with omp's queue, three rapid list changes during a slow mirror leave Kata at the final list", async () => {
  const { parser: parserTask, docs: docsTask, tests: testsTask } = names();
  const hold = holdNext(args => args[0] === "claim");
  // The fixture's `host` passes no `queuedReplace`, so this host is built on the fake directly.
  const sid = `v2-queued-${unique()}`;
  const app = ompHost({ run: (args, opts) => run(args, opts.cwd, opts.timeout), cwd, sid, sessionFile: `${scratch}/${sid}.jsonl`, before: hold.before, queuedReplace: true,
    afterEvent: clearTranscriptEnv });
  await app.event("session_start");
  const parent = await app.init([parserTask, docsTask, testsTask]);
  await app.settled();
  // Only one task is in progress at a time, as omp's list keeps it.
  const working = (title: string) => [{ name: "Tasks", tasks: [parserTask, docsTask, testsTask].map(content => ({ content, status: content === title ? "in_progress" as const : "pending" as const })) }];
  hold.arm();
  // The first change's mirror claims the docs task and waits on Kata; the next two queue behind it and the third replaces the second.
  await app.edit(working(docsTask));
  await hold.entered;
  await app.edit(working(testsTask));
  await app.edit(working(parserTask));
  hold.release();
  await app.settled();
  expect(app.mirrorFailures()).toEqual([]);
  const status = async (title: string) => (await show(await childRef(parent, title))).issue.metadata?.["todo.status"];
  expect([await status(parserTask), await status(docsTask), await status(testsTask)]).toEqual(["in_progress", "pending", "pending"]);
});

test("a /tree back to a branch with a task in progress, whose list arrives before session_tree, does not reopen the task Kata closed since", async () => {
  const { parser: parserTask, docs: docsTask } = names();
  const app = host(); await app.event("session_start");
  const parent = await app.init([parserTask, docsTask]);
  const parser = await childRef(parent, parserTask);
  expect((await app.call({ op: "start", task: parserTask })).isError).toBeUndefined();
  const earlier = structuredClone(app.entries), earlierList = app.list();
  expect(earlierList[0].tasks.find((t: any) => t.content === parserTask)?.status).toBe("in_progress");
  expect((await app.done(parserTask)).isError).toBeUndefined();
  expect((await show(parser)).issue.status).toBe("closed");
  app.entries.splice(0, app.entries.length, ...earlier);
  await app.edit(earlierList);
  await app.event("session_tree");
  expect(app.mirrorFailures()).toEqual([]);
  expect((await show(parser)).issue.status).toBe("closed");
  expect(await labelsOf(parser)).not.toContain("needs-review");
});

test("a task started natively on a plan made while Kata was away, whose replayed start Kata refuses, gets needs-review and one comment and is not blocked", async () => {
  const { parser: parserTask, docs: docsTask, tests: testsTask } = names();
  let mode: "away" | "refusing" = "away", claims = 0;
  const refusal = { code: 1, stdout: "", stderr: '{"error":{"kind":"conflict","code":"claim_refused","message":"claim refused by a hook","exit_code":1}}\n' };
  const app = host({ before: (args: string[]) => mode === "away" ? down() : args[0] === "claim" && ++claims > 1 ? refusal : undefined });
  await app.event("session_start");
  expect((await app.call({ op: "init", items: [parserTask, docsTask] })).isError).toBeUndefined();
  expect((await app.call({ op: "start", task: parserTask })).isError).toBeUndefined();
  // The replay claims the plan parent first (let through), then the started task (refused).
  mode = "refusing";
  expect((await app.call({ op: "append", items: [testsTask] })).isError).toBeUndefined();
  const parent = (await planParentOf(parserTask));
  const parser = await childRef(parent, parserTask);
  await eventually(async () => await labelsOf(parser), ["needs-review"]);
  expect(await commentsOf(parser)).toHaveLength(1);
  expect((await show(parser)).issue.metadata?.["todo.status"]).not.toBe("blocked");
});

test("a ticket item set in omp's list while Kata was away reports an outage, not a refusal, and lands once Kata is back", async () => {
  const ticket = await issue("Outage ticket");
  let away = true;
  const app = host({ before: (args: string[]) => away ? down() : undefined });
  await app.event("session_start");
  const item = `v2test#${ticket}: do the action`;
  await app.edit([{ name: "Tasks", tasks: [{ content: item, status: "in_progress" }] }]);
  expect(app.mirrorFailures()).toHaveLength(1);
  expect(String(app.mirrorFailures()[0][0])).toContain("did not take");
  expect(app.notices.some(n => /refused the latest change/.test(String(n[0])))).toBe(false);
  away = false;
  await app.edit([{ name: "Tasks", tasks: [{ content: item, status: "in_progress" }, { content: `Plain ${unique()}`, status: "pending" }] }]);
  await eventually(async () => (await show(ticket)).issue.metadata?.["todo.status"], "in_progress");
  expect((await show(ticket)).issue.owner).toBe("v2-builder");
});

const statusOf = async (ref: string) => (await show(ref)).issue.metadata?.["todo.status"];

// Driven on the core itself: omp's queue hands the backend one list at a time, so only the core can have two mirrors of one session
// and one of another waiting behind a running job.
test("a session's newest list still lands when another session's list is mirrored after it, behind the same slow job", async () => {
  const { parser: parserTask, docs: docsTask } = names();
  const sessionA = `v2-core-a-${unique()}`, sessionB = `v2-core-b-${unique()}`;
  const hold = holdNext(args => args[0] === "claim");
  const entries: any[] = [];
  const ctxOf = (id: string) => ({ cwd, sessionManager: { getSessionId: () => id, getBranch: () => entries } });
  const core = createKataCore({ platform: nodePlatform, appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    exec: async (_file, args, opts) => await hold.before(args, opts) ?? run(args, opts.cwd, opts.timeout), delegateStore: memoryDelegateStore() },
    { namespace: "omp", executable: kataBinary, executableVars: ["KATA_OMP_EXECUTABLE"], native: true });
  const list = (inProgress?: string) => [{ name: "Tasks", tasks: [parserTask, docsTask].map(content => ({ content, status: content === inProgress ? "in_progress" as const : "pending" as const })) }];
  const a = ctxOf(sessionA), b = ctxOf(sessionB);
  await core.todo.mirror(a, list());
  const parent = (await kata(["list", "--status", "all", "--meta", `omp.session_id=${sessionA}`, "--json"])).issues[0].qualified_id;
  hold.arm();
  const slow = core.todo.mirror(a, list(parserTask));
  await hold.entered;
  // Queued behind the slow job: two lists of A (the second replaces the first) and one of B.
  const queued = [core.todo.mirror(a, list(docsTask)), core.todo.mirror(a, list(docsTask)), core.todo.mirror(b, [])];
  hold.release();
  await Promise.all([slow, ...queued]);
  expect(await statusOf(await childRef(parent, docsTask))).toBe("in_progress");
});

test("a queued list of a session that runs after /new is diffed against that session's own branch, not the new one's", async () => {
  const { parser: parserTask, docs: docsTask } = names();
  let armed = false;
  const hold = holdKata(() => armed);
  const sid = `v2-queued-new-${unique()}`;
  const app = ompHost({ run: (args, opts) => run(args, opts.cwd, opts.timeout), cwd, sid, sessionFile: `${scratch}/${sid}.jsonl`, before: hold.before, queuedReplace: true,
    afterEvent: clearTranscriptEnv });
  await app.event("session_start");
  const parent = await app.init([parserTask, docsTask]);
  await app.settled();
  const parser = await childRef(parent, parserTask), docs = await childRef(parent, docsTask);
  // The agent closes the parser task in Kata and marks it done natively: A's snapshot has it completed and the docs task pending.
  expect((await app.done(parserTask)).isError).toBeUndefined();
  await app.settled();
  expect((await show(parser)).issue.status).toBe("closed");
  expect((await show(docs)).issue.status).toBe("open");
  const sessionA = app.sid;
  const parserBefore = JSON.stringify((await show(parser)).issue), commentsBefore = (await commentsOf(parser)).length;
  // A todo call the backend is still asked about (its Kata reads held) has A's next list (the docs task removed) queued behind it.
  armed = true;
  const reading = app.call({ op: "start", task: docsTask });
  await hold.entered;
  await app.edit([{ name: "Tasks", tasks: [{ content: parserTask, status: "completed" as const }] }]);
  // /new: B's branch holds none of A's entries. The fake session manager has one entry list for every session, so B's is made by emptying it.
  app.entries.splice(0, app.entries.length);
  await app.switchSession(`${sessionA}-b`);
  armed = false;
  hold.release();
  await reading;
  await app.settled();
  expect(app.mirrorFailures()).toEqual([]);
  // Diffed against A's snapshot, the removed docs task is removed in Kata; against B's empty one nothing would be removed.
  const removed = await show(docs);
  expect(removed.issue.status).toBe("closed");
  // The closed parser task is neither re-started, re-appended nor commented on.
  expect(JSON.stringify((await show(parser)).issue)).toBe(parserBefore);
  expect(await commentsOf(parser)).toHaveLength(commentsBefore);
  expect((await children(parent)).map((c: any) => c.title).sort()).toEqual([docsTask, parserTask].sort());
  expect(await labelsOf(parser)).not.toContain("needs-review");
});

// A raw host for this file's store: omp's todo backend handed to the test.
const rawOmpHost = (sid: string, before: (args: string[], opts: any) => any) => rawHost(sid, { run: (args, opts) => run(args, opts.cwd, opts.timeout), cwd, before });
const listOf = (...tasks: [string, "pending" | "in_progress" | "completed"][]) => [{ name: "Tasks", tasks: tasks.map(([content, status]) => ({ content, status })) }];

test("a list captured while the session's previous mirror still runs is diffed against that mirror's snapshot, not a duplicate of a task the agent closed", async () => {
  const { parser: parserTask, docs: docsTask } = names();
  // The plan parent, then the parser task and the docs task are created: the third create is held, with the parser task in Kata.
  let creates = 0;
  const hold = holdKata((args) => args[0] === "create" && ++creates === 3);
  const { app, event, replace } = rawOmpHost(`v2-late-mirror-${unique()}`, hold.before);
  await event("session_start");
  // Mirror N plans both tasks, then waits on Kata.
  const first = replace(listOf([parserTask, "pending"], [docsTask, "pending"]));
  await hold.entered;
  const parent = (await planParentOf(parserTask));
  const parser = await childRef(parent, parserTask);
  // The agent closes the parser task in Kata; list N+1 is captured before N has saved its snapshot.
  await kata(["close", parser, "--done", "--message", "Closed by the agent in Kata, outside the list.", "--evidence", "test:agent closed it", "--json"]);
  const second = replace(listOf([parserTask, "pending"], [docsTask, "pending"], [`Extra ${unique()}`, "pending"]));
  hold.release();
  await Promise.all([first, second]);
  expect(mirrorFailures(app.notices)).toEqual([]);
  const titles = (await children(parent)).map((c: any) => c.title);
  expect(titles.filter((t: string) => t === parserTask)).toHaveLength(1);
  expect((await show(parser)).issue.status).toBe("closed");
  const duplicates = (await kata(["list", "--all", "--status", "all", "--json"])).issues.filter((i: any) => i.title === parserTask);
  expect(duplicates).toHaveLength(1);
});

test("a mirror of the previous session still running when /new switches the session saves no snapshot of it into the new session's entries", async () => {
  const { parser: parserTask, docs: docsTask } = names();
  let armed = false;
  const hold = holdKata((args) => armed && args[0] === "claim");
  const sessionA = `v2-snap-a-${unique()}`;
  const { app, event, replace, switchTo } = rawOmpHost(sessionA, hold.before);
  await event("session_start");
  armed = true;
  const mirroring = replace(listOf([parserTask, "in_progress"], [docsTask, "pending"]));
  await hold.entered;
  armed = false;
  const before = app.entries.length;
  switchTo(`${sessionA}-b`);
  await event("session_switch");
  hold.release();
  await mirroring;
  const snapshots = app.entries.slice(before).filter((e: any) => e.customType === snapshotEntry("omp"));
  expect(snapshots.filter((e: any) => e.data?.sessionId === sessionA)).toEqual([]);
});

test("a mirror still running when /tree moves the session to another branch is diffed against its own branch, so the new branch's open tasks are not removed", async () => {
  const { parser: parserTask, docs: docsTask } = names();
  let armed = false;
  const hold = holdKata(() => armed);
  const { app, event, replace, moveTo, moveAfterNextAppend } = rawOmpHost(`v2-tree-${unique()}`, hold.before);
  await event("session_start");
  // Branch Y holds the snapshot of a list with both tasks open.
  await replace(listOf([parserTask, "pending"], [docsTask, "pending"]));
  const parent = await planParentOf(parserTask);
  const docs = await childRef(parent, docsTask);
  const branchY = [...app.entries];
  const leafY = branchY[branchY.length - 1].id;
  // A slow mirror of branch X (one entry of its own) is held; the next list of X is captured behind it and binds only when it runs.
  moveTo([{ id: "entry-x", type: "custom", customType: "other", data: {} }], "entry-x");
  armed = true;
  const slow = replace(listOf([parserTask, "pending"]));
  await hold.entered;
  armed = false;
  const queued = replace(listOf([parserTask, "pending"]));
  moveAfterNextAppend(branchY, leafY);
  hold.release();
  await Promise.all([slow, queued]);
  expect((await show(docs)).issue.status).toBe("open");
});

test("a list captured at an earlier entry of a branch whose tip the in-memory list came from is diffed against that entry's snapshot", async () => {
  const { parser: parserTask, docs: docsTask } = names();
  const extraTask = `Extra ${unique()}`;
  const { app, event, replace, moveToEntry } = rawOmpHost(`v2-tree-back-${unique()}`, () => undefined);
  await event("session_start");
  // Entry L: the branch after the first list, whose snapshot has the parser and docs tasks.
  await replace(listOf([parserTask, "pending"], [docsTask, "pending"]));
  const leafL = app.entries[app.entries.length - 1].id;
  const parent = await planParentOf(parserTask);
  // Two more lists add a third task; the second is captured at the tip, past L, so the in-memory list comes from there.
  await replace(listOf([parserTask, "pending"], [docsTask, "pending"], [extraTask, "pending"]));
  await replace(listOf([parserTask, "pending"], [docsTask, "pending"], [extraTask, "pending"]));
  const extra = await childRef(parent, extraTask);
  // /tree back to L, whose subtree still exists: the list captured there is diffed against L's snapshot, which never had the third task,
  // so the third task is not one omp's list removed.
  moveToEntry(leafL);
  await replace(listOf([parserTask, "pending"], [docsTask, "pending"]));
  expect(mirrorFailures(app.notices)).toEqual([]);
  expect((await show(extra)).issue.status).toBe("open");
});

test("a /tree forward to a later entry of the same branch loads that entry's snapshot, so a task started there is not started again", async () => {
  const { parser: parserTask, docs: docsTask } = names();
  const { app, event, replace, moveToEntry } = rawOmpHost(`v2-tree-fwd-${unique()}`, () => undefined);
  await event("session_start");
  // Entry L: the branch after the first list, whose snapshot has both tasks pending.
  await replace(listOf([parserTask, "pending"], [docsTask, "pending"]));
  const leafL = app.entries[app.entries.length - 1].id;
  const parent = await planParentOf(parserTask);
  const parser = await childRef(parent, parserTask);
  // Later on the same branch: the parser task is started; the tip T's snapshot has it in progress.
  await replace(listOf([parserTask, "in_progress"], [docsTask, "pending"]));
  const tip = app.entries[app.entries.length - 1].id;
  expect((await show(parser)).issue.metadata?.["todo.status"]).toBe("in_progress");
  // /tree back to L and a list there: the in-memory list now comes from L.
  moveToEntry(leafL);
  await replace(listOf([parserTask, "pending"], [docsTask, "pending"]));
  const before = JSON.stringify((await show(parser)).issue), commentsBefore = (await commentsOf(parser)).length;
  // /tree forward to T: the memory from L is older than T's snapshot, which is the one the list is diffed against.
  moveToEntry(tip);
  await replace(listOf([parserTask, "in_progress"], [docsTask, "pending"]));
  expect(mirrorFailures(app.notices)).toEqual([]);
  expect(JSON.stringify((await show(parser)).issue)).toBe(before);
  expect(await commentsOf(parser)).toHaveLength(commentsBefore);
});

test("a fork's /tree forward to a later entry of its source's branch, before its rebind, loads that entry's snapshot, so a task started there is not started again", async () => {
  const { parser: parserTask, docs: docsTask } = names();
  const source = `v2-fork-fwd-${unique()}`;
  const { app, event, replace, switchTo, moveToEntry } = rawOmpHost(source, () => undefined);
  await event("session_start");
  await replace(listOf([parserTask, "pending"], [docsTask, "pending"]));
  const leafL = app.entries[app.entries.length - 1].id;
  const parent = await planParentOf(parserTask);
  const parser = await childRef(parent, parserTask);
  await replace(listOf([parserTask, "in_progress"], [docsTask, "pending"]));
  const tip = app.entries[app.entries.length - 1].id;
  expect((await show(parser)).issue.metadata?.["todo.status"]).toBe("in_progress");
  // The agent sets the task back to pending in Kata: a memory kept from L would see it started in the list and start it again.
  await kata(["meta", "set", parser, "todo.status", "pending", "--json"]);
  // The fork is made at L: it binds from the source's snapshot there, which has the task pending.
  moveToEntry(leafL);
  switchTo(`${source}-fork`);
  app.ctx.sessionManager.getHeader = () => ({ parentSession: source });
  await event("session_switch");
  // /tree forward to T, a snapshot of the source, with the list arriving before the fork's rebind: T's snapshot, not the one from L, is what the list is diffed against.
  moveToEntry(tip);
  await replace(listOf([parserTask, "in_progress"], [docsTask, "pending"]));
  expect(mirrorFailures(app.notices)).toEqual([]);
  expect((await show(parser)).issue.metadata?.["todo.status"]).toBe("pending");
});

test("a snapshot another caller saved from the bind's memory after the captured tip does not reload the memory on a late mirror", async () => {
  const { parser: parserTask, docs: docsTask } = names();
  const { app, event, replace, moveTo } = rawOmpHost(`v2-bind-after-tip-${unique()}`, () => undefined);
  const base = { id: "entry-base", type: "custom", customType: "other", data: {} };
  const message = { id: "entry-message", type: "custom", customType: "other", data: {} };
  app.entries.push(base);
  moveTo(app.entries, base.id);
  await event("session_start");
  const bound = app.entries.find((e: any) => e.customType === snapshotEntry("omp")).data;
  // The pass captures a branch that goes on past the bind's leaf with no snapshot of the session on it.
  const branch = [base, message];
  moveTo(branch, message.id);
  await replace(listOf([parserTask, "pending"], [docsTask, "pending"]));
  // Another caller saved a snapshot from the bind's memory, which had no list; it landed after the pass's own.
  branch.push({ id: "entry-bind-after-tip", type: "custom", customType: snapshotEntry("omp"), data: { ...bound, native: { ...bound.native, leaf: base.id } } });
  // The agent closes the docs task in Kata. The kept memory has it pending, as the list does, so the list changes nothing; a memory
  // reloaded from the bind's snapshot, which has no list, would see the pending docs task as new and create it again.
  const parent = await planParentOf(parserTask), docs = await childRef(parent, docsTask);
  await kata(["close", docs, "--done", "--message", "Closed by the agent in Kata, outside the list.", "--evidence", "test:agent closed it", "--json"]);
  await replace(listOf([parserTask, "pending"], [docsTask, "pending"]));
  expect(mirrorFailures(app.notices)).toEqual([]);
  expect((await children(parent)).filter((c: any) => c.title === docsTask)).toHaveLength(1);
  expect((await show(docs)).issue.status).toBe("closed");
});

test("a snapshot another caller saved from the same memory after the mirror's own does not reload the memory, so nothing is mirrored again", async () => {
  const { parser: parserTask, docs: docsTask } = names();
  const { app, event, replace } = rawOmpHost(`v2-same-memory-${unique()}`, () => undefined);
  await event("session_start");
  await replace(listOf([parserTask, "pending"], [docsTask, "pending"]));
  const stale = app.entries[app.entries.length - 1].data;
  // The parser task is started: the mirror's snapshot has it in progress.
  await replace(listOf([parserTask, "in_progress"], [docsTask, "pending"]));
  const mirrored = app.entries[app.entries.length - 1];
  // Another caller (a delegate exit) saved a snapshot after it from the same memory. Its content is the older list's here, so a reload from it would start the task again.
  app.entries.push({ id: "entry-other-caller", type: "custom", customType: snapshotEntry("omp"), data: { ...stale, native: { ...stale.native, leaf: mirrored.id } } });
  // The agent sets the task back to pending in Kata. The kept memory has it in progress, as the list does, so the list changes nothing; a
  // reload from the older snapshot, which has it pending, would see it started in the list and start it again.
  const parent = await planParentOf(parserTask), parser = await childRef(parent, parserTask);
  await kata(["meta", "set", parser, "todo.status", "pending", "--json"]);
  await replace(listOf([parserTask, "in_progress"], [docsTask, "pending"]));
  expect(mirrorFailures(app.notices)).toEqual([]);
  expect((await show(parser)).issue.metadata?.["todo.status"]).toBe("pending");
});

test("a snapshot of branch Z that landed on branch W (a mirror held across /tree) is not loaded by W's next mirror, so W's open tasks stay open", async () => {
  const { parser: parserTask, docs: docsTask } = names();
  let armed = false;
  const hold = holdKata(() => armed);
  const { app, event, replace, moveTo } = rawOmpHost(`v2-tree-live-${unique()}`, hold.before);
  await event("session_start");
  // Branch W holds the snapshot of a list with the parser task only.
  await replace(listOf([parserTask, "pending"]));
  const parent = await planParentOf(parserTask);
  const branchW = [...app.entries];
  const leafW = branchW[branchW.length - 1].id;
  // Mirror A of branch Z (a list that adds the docs task) is held; /tree moves to W before it saves.
  moveTo([{ id: "entry-z", type: "custom", customType: "other", data: {} }], "entry-z");
  armed = true;
  const slow = replace(listOf([parserTask, "pending"], [docsTask, "pending"]));
  await hold.entered;
  armed = false;
  moveTo(branchW, leafW);
  hold.release();
  await slow;
  // The held mirror's snapshot landed on W, stamped with Z's leaf, which is not on W: W's next mirror must not load it.
  const landed = branchW.filter((e: any) => e.customType === snapshotEntry("omp") && e.data.native?.leaf === "entry-z");
  expect(landed.length).toBeGreaterThan(0);
  // W is bound again (a /tree): its memory comes from the latest snapshot on W whose leaf is on W, not from Z's.
  await event("session_tree");
  // W's next list: the docs task was never on W, so nothing of Z's memory may remove it.
  const docs = await childRef(parent, docsTask);
  await replace(listOf([parserTask, "pending"]));
  expect(mirrorFailures(app.notices)).toEqual([]);
  expect((await show(docs)).issue.status).toBe("open");
});

test("an accepted change between a held mirror and the next one does not move the memory's branch, so the next list is still diffed against the held mirror's list", async () => {
  const { parser: parserTask, docs: docsTask } = names();
  let creates = 0;
  const hold = holdKata((args) => args[0] === "create" && ++creates === 3);
  const { app, event, replace, afterNextAppend } = rawOmpHost(`v2-guard-keeps-${unique()}`, hold.before);
  await event("session_start");
  // Mirror N plans both tasks, then waits on Kata with the branch it captured.
  const first = replace(listOf([parserTask, "pending"], [docsTask, "pending"]));
  await hold.entered;
  const parent = await planParentOf(parserTask);
  // Another caller's entry lands right after N's snapshot, so the live branch ends past it and N's own snapshot is not its last entry.
  afterNextAppend(() => app.entries.push({ id: "entry-after-snapshot", type: "custom", customType: "other", data: {} }));
  // `apply` of a start is queued behind N, and mirror N+1 captures N's branch, which has no snapshot of N's, with the docs task removed.
  const accepted = app.todoBackend.apply({ op: "start", previous: listOf([parserTask, "pending"], [docsTask, "pending"]), next: listOf([parserTask, "pending"], [docsTask, "in_progress"]) }, app.ctx);
  // `apply` awaits its cached backend lookup and job sync before queuing; neither waits on Kata,
  // so a few event-loop turns put it in the core's queue ahead of N+1.
  for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setImmediate(resolve));
  const second = replace(listOf([parserTask, "pending"]));
  hold.release();
  await Promise.all([first, accepted, second]);
  expect(mirrorFailures(app.notices)).toEqual([]);
  // `apply` did not move the memory to the live tip, which is not on the captured branch: N's list is what N+1 is diffed against, so the docs task is removed.
  expect((await show(await childRef(parent, docsTask))).issue.status).toBe("closed");
});

test("a done asked after a /tree to a branch whose memory is behind omp's list catches Kata up first, so the task Kata lacks is refused", async () => {
  const { parser: parserTask, docs: docsTask } = names();
  const refusal = { code: 1, stdout: "", stderr: '{"error":{"kind":"conflict","code":"create_refused","message":"create refused by a hook","exit_code":1}}\n' };
  let refusing = false;
  const { app, event, replace, moveToEntry } = rawOmpHost(`v2-tree-accept-${unique()}`, (args: string[]) => refusing && args[0] === "create" ? refusal : undefined);
  await event("session_start");
  await replace(listOf([parserTask, "pending"]));
  // The first snapshot of the session: the branch up to it has a memory of no tasks.
  const early = app.entries.find((e: any) => e.customType === snapshotEntry("omp")).id;
  // Kata refuses the docs task's issue; the memory still counts it as mirrored, so omp's list and the tip's memory agree while Kata lacks it.
  const both = listOf([parserTask, "pending"], [docsTask, "pending"]);
  refusing = true;
  await replace(both);
  refusing = false;
  // On the early branch only the catch-up from omp's list gives Kata a child for the docs task.
  moveToEntry(early);
  const done = listOf([parserTask, "pending"], [docsTask, "completed"]);
  expect(await app.todoBackend.apply({ op: "done", previous: both, next: done }, app.ctx)).toEqual({ block: true, reason: expect.stringContaining(`"${docsTask}" is open in Kata`) });
});
