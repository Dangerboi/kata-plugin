import { expect, test } from "bun:test";
import { eventually, holdNext, memoryDelegateStore } from "./kata-fixture";
import { v2Fixture } from "./v2-fixture";
import { ompHost } from "./omp-host";
import { TRANSCRIPT_ENV } from "../core/kata-cli";
import { createKataCore } from "../core/kata-core";
import { nodePlatform } from "../core/node-host";

// The omp adapter against a real Kata, on omp's native `todo`: how the mirror and the session's task ownership hold up when the
// session changes under it (/new, a fork, /tree) or Kata is away. One behaviour per test.
const { binary: kataBinary, scratch, cwd, run, show, issue, host, down, commentsOf, kata, unique } = v2Fixture();

// Every test names its own tasks: a title shared with another test would let the harness's title lookup find that test's plan.
const names = () => { const id = unique(); return { parser: `Write parser ${id}`, docs: `Write docs ${id}`, tests: `Write tests ${id}` }; };

const refOf = (short: string) => `v2test#${short}`;
const children = async (parent: string): Promise<any[]> => (await show(parent)).children ?? [];
async function childRef(parent: string, title: string): Promise<string> {
  const child = (await children(parent)).find((c: any) => c.title === title);
  if (!child) throw new Error(`${parent} has no child "${title}"`);
  return refOf(child.short_id);
}
const planParentOf = async (title: string): Promise<string> => {
  const found = (await kata(["list", "--all", "--status", "all", "--json"])).issues.find((i: any) => i.title === title && i.parent);
  if (!found) throw new Error(`No plan task "${title}"`);
  return found.parent.qualified_id;
};
const holder = async (ref: string) => (await show(ref)).issue.metadata?.["todo.session"];
const labelsOf = async (ref: string): Promise<string[]> => ((await show(ref)).labels ?? []).map((l: any) => l.label);
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
    afterEvent: () => { for (const key of TRANSCRIPT_ENV) delete process.env[key]; } });
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
