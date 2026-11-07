import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { KataError } from "../core/kata-core";
import { createSettlement, MAX_FAILURES, RETRY_MS, type CloseRequest, type TaskClose } from "../core/settlement";
import { assertIsolated } from "./isolation";
import { isolatedKata } from "./kata-fixture";
assertIsolated();
const binary = process.env.KATA_TEST_EXECUTABLE!;
const root = mkdtempSync(path.join(process.env.KATA_TEST_ROOT!, "settlement-"));
const cwd = path.join(root, "workspace");
mkdirSync(cwd);
const env = { ...process.env, KATA_HOME: path.join(root, "home"), KATA_AUTHOR: "actor-a" };
for (const key of ["KATA_REF", "KATA_TEAMMATE", "KATA_INBOX_USER"]) delete env[key];
const run = isolatedKata(binary, env, cwd, 60000);
const withJson = (args: string[]) => args.includes("--json") ? args : [...args, "--json"];
const kata = async (args: string[]) => { const r = await run(withJson(args)); if (r.code) throw new Error(r.stderr); return JSON.parse(r.stdout || "null"); };
const view = (ref: string) => kata(["show", ref]);
const message = "Verified the isolated settlement fixture with the behavioral regression suite.";
const SESSION = "settle-session";
beforeAll(async () => { expect((await run(["init", "--project", "settlement-test"])).code).toBe(0); });
afterAll(async () => { await run(["daemon", "stop"]); });

let seq = 0;
// A qualified ref for a new issue; an automatic parent carries the session markers.
async function create(title: string, options: { parent?: string; auto?: boolean } = {}) {
  const out = await kata(["create", `${title} ${++seq}`, "--force-new", ...(options.parent ? ["--parent", options.parent] : [])]);
  const ref = `${(out.event ?? out.original_event).project_name}#${out.issue.short_id}`;
  if (options.auto) {
    await kata(["meta", "set", ref, "omp.auto_parent", "true", "--json-value"]);
    await kata(["meta", "set", ref, "omp.session_id", JSON.stringify(SESSION), "--json-value"]);
  }
  return ref;
}
const closeDone = (ref: string) => kata(["close", ref, "--done", "--message", message, "--evidence", "test:settlement fixture"]);
const closeWontfix = (ref: string) => kata(["close", ref, "--wontfix", "--message", `${message} The task was intentionally retired without asserting completion.`]);
const labels = async (ref: string) => (await view(ref)).labels.map((l: any) => l.label);
const throttled = () => Object.assign(new Error("sibling-close throttle"), { code: "sibling_throttle" });
const change = { message, evidence: ["test:x"] };
const taskOf = async (ref: string) => ({ ref, content: "A task", phase: "Phase", status: "in_progress" as const, revision: (await view(ref)).issue.revision });
const request: CloseRequest = { key: "k", message, evidence: ["test:x"] };

// Real Kata, a fake clock and a fake timer. `fail` makes a Kata call throw before it runs.
function build(options: { fail?: (args: string[]) => Error | undefined; running?: () => boolean } = {}) {
  let now = 1_000_000, due = 0;
  const timers = new Set<() => void>(), calls: string[][] = [], flagged: { ref: string; error: unknown }[] = [], performed: string[] = [], itemsOpen = new Set<string>();
  const handlers: { task: (pending: TaskClose) => Promise<void>; ticket: (ticket: string) => Promise<void> } = {
    task: async pending => { performed.push(pending.task.ref); await closeDone(pending.task.ref); },
    ticket: async ticket => { performed.push(ticket); await closeDone(ticket); },
  };
  const settlement = createSettlement({
    namespace: "omp",
    kata: async args => {
      calls.push(args);
      const error = options.fail?.(args);
      if (error) throw error;
      const r = await run(withJson(args));
      if (r.code) throw new Error(r.stderr);
      return r.stdout;
    },
    owned: async ref => (await view(ref)).issue,
    projectList: async () => [],
    clock: () => now,
    timer: fire => { timers.add(fire); return () => { timers.delete(fire); }; },
    due: () => { due++; },
    delegatesRunning: () => options.running?.() ?? false,
    itemsOpen: ticket => itemsOpen.has(ticket),
    performTask: pending => handlers.task(pending),
    performTicket: ticket => handlers.ticket(ticket),
    flag: async (ref, _cwd, error) => { flagged.push({ ref, error }); },
    debug: e => { if (process.env.DBG) console.log("DEBUG", String(e).slice(0, 300)); },
  });
  return { settlement, timers, calls, flagged, performed, handlers, itemsOpen,
    advance: (ms: number) => { now += ms; }, dueCount: () => due,
    fire: () => { for (const fire of [...timers]) { timers.delete(fire); fire(); } } };
}

test("a throttled task close waits out the retry window, then runs once and leaves the snapshot", async () => {
  const child = await create("Throttled task");
  const s = build();
  expect(s.settlement.pendTaskClose(await taskOf(child), "completed", change, cwd)).toContain("retry after 60 seconds");
  expect(s.timers.size).toBe(1);
  expect(s.settlement.snapshot().retries.map(([ref]) => ref)).toEqual([child]);
  s.advance(RETRY_MS - 1);
  await s.settlement.drain();
  expect(s.performed).toEqual([]);
  s.advance(1);
  await s.settlement.drain();
  expect(s.performed).toEqual([child]);
  expect((await view(child)).issue.status).toBe("closed");
  expect(s.settlement.snapshot().retries).toEqual([]);
});

test("the timer wakes the core, and a close that is throttled again is pending anew, never failed", async () => {
  const child = await create("Rethrottled task");
  const s = build();
  s.handlers.task = async pending => { s.performed.push(pending.task.ref); s.settlement.pendTaskClose(pending.task, pending.to, pending.change, pending.cwd); throw new Error("deferred again"); };
  s.settlement.pendTaskClose(await taskOf(child), "completed", change, cwd);
  s.fire();
  expect(s.dueCount()).toBe(1);
  for (let i = 0; i < MAX_FAILURES + 1; i++) { s.advance(RETRY_MS + 1); await s.settlement.drain(); }
  expect(s.performed).toHaveLength(MAX_FAILURES + 1);
  expect(s.timers.size).toBe(1);
  expect(s.flagged).toEqual([]);
  expect(s.settlement.snapshot().retries.map(([ref]) => ref)).toEqual([child]);
});

test("a pending close that Kata no longer needs is dropped without running", async () => {
  const child = await create("Closed elsewhere");
  const s = build();
  s.settlement.pendTaskClose(await taskOf(child), "completed", change, cwd);
  await closeDone(child);
  s.advance(RETRY_MS + 1);
  await s.settlement.drain();
  expect(s.performed).toEqual([]);
  expect(s.settlement.snapshot().retries).toEqual([]);
});

test("cancelling a removal drops a pending removal and leaves a pending completion", async () => {
  const s = build();
  const fake = (ref: string) => ({ ref, content: "A task", phase: "Phase", status: "in_progress" as const, revision: 1 });
  s.settlement.pendTaskClose(fake("a#aaaa"), "abandoned", { remove: true }, cwd);
  s.settlement.pendTaskClose(fake("a#bbbb"), "completed", change, cwd);
  s.settlement.cancelRemoval("a#aaaa");
  s.settlement.cancelRemoval("a#bbbb");
  expect([s.settlement.hasTaskClose("a#aaaa"), s.settlement.hasTaskClose("a#bbbb")]).toEqual([false, true]);
});

test("a close is never dropped for the drains Kata was unreachable, and completes once it returns", async () => {
  const child = await create("Outage task");
  let down = true;
  const outage = new KataError("daemon unavailable", { exit: 7, code: "daemon_unavailable" });
  const s = build({ fail: args => down && args[0] === "show" ? outage : undefined });
  s.settlement.pendTaskClose(await taskOf(child), "completed", change, cwd);
  for (let i = 0; i < MAX_FAILURES + 2; i++) { s.advance(RETRY_MS + 1); await s.settlement.drain(); }
  expect(s.flagged).toEqual([]);
  expect(s.settlement.snapshot().retries.map(([ref]) => ref)).toEqual([child]);
  down = false;
  s.advance(RETRY_MS + 1);
  await s.settlement.drain();
  expect(s.performed).toEqual([child]);
  expect((await view(child)).issue.status).toBe("closed");
});

test("a pending close that fails for another reason is retried on three drains, then dropped and flagged", async () => {
  const child = await create("Failing task");
  const s = build();
  const refusal = Object.assign(new Error("kata close failed"), { code: "validation" });
  s.handlers.task = async pending => { s.performed.push(pending.task.ref); throw refusal; };
  s.settlement.pendTaskClose(await taskOf(child), "completed", change, cwd);
  for (let i = 1; i < MAX_FAILURES; i++) {
    s.advance(RETRY_MS + 1);
    await s.settlement.drain();
    expect(s.flagged).toEqual([]);
    expect(s.settlement.hasTaskClose(child)).toBe(true);
  }
  s.advance(RETRY_MS + 1);
  await s.settlement.drain();
  expect(s.performed).toHaveLength(MAX_FAILURES);
  expect(s.flagged).toEqual([{ ref: child, error: refusal }]);
  expect(s.settlement.snapshot().retries).toEqual([]);
  s.advance(RETRY_MS + 1);
  await s.settlement.drain();
  expect(s.performed).toHaveLength(MAX_FAILURES);
});

test("a ticket close waits for its open children, retried at each drain with no timer", async () => {
  const ticket = await create("Umbrella");
  const child = await create("Blocking child", { parent: ticket });
  const s = build();
  s.settlement.holdTicketClose(ticket, request, cwd);
  await s.settlement.drain();
  expect(s.performed).toEqual([]);
  expect(s.timers.size).toBe(0);
  await closeDone(child);
  await s.settlement.drain();
  expect(s.performed).toEqual([ticket]);
  expect((await view(ticket)).issue.status).toBe("closed");
  expect(s.settlement.snapshot().pendingCloses).toBeUndefined();
});

test("a held ticket close is abandoned when a session item for the ticket is open again", async () => {
  const ticket = await create("Reopened work");
  const s = build();
  s.settlement.holdTicketClose(ticket, request, cwd);
  s.itemsOpen.add(ticket);
  await s.settlement.drain();
  expect(s.performed).toEqual([]);
  expect(s.settlement.snapshot().pendingCloses).toBeUndefined();
});

test("a held ticket close that keeps failing is dropped and flagged after three drains", async () => {
  const ticket = await create("Unclosable umbrella");
  const s = build();
  const refusal = Object.assign(new Error("kata close failed"), { code: "validation" });
  s.handlers.ticket = async () => { throw refusal; };
  s.settlement.holdTicketClose(ticket, request, cwd);
  for (let i = 0; i < MAX_FAILURES; i++) await s.settlement.drain();
  expect(s.flagged).toEqual([{ ref: ticket, error: refusal }]);
  expect(s.settlement.snapshot().pendingCloses).toBeUndefined();
});

test("an automatic parent closes once every child is closed with evidence", async () => {
  const parent = await create("Plan", { auto: true });
  const child = await create("Only task", { parent });
  const s = build();
  s.settlement.addAutoParent({ parent, workspace: cwd, sessionId: SESSION, auto: true });
  await s.settlement.drain();
  expect((await view(parent)).issue.status).toBe("open");
  await closeDone(child);
  await s.settlement.drain();
  expect((await view(parent)).issue.status).toBe("closed");
});

test("a running delegate pauses only the automatic-parent audit", async () => {
  const parent = await create("Plan", { auto: true });
  await closeDone(await create("Delegated task", { parent }));
  const other = await create("Throttled elsewhere");
  let running = true;
  const s = build({ running: () => running });
  s.settlement.addAutoParent({ parent, workspace: cwd, sessionId: SESSION, auto: true });
  s.settlement.pendTaskClose(await taskOf(other), "completed", change, cwd);
  s.advance(RETRY_MS + 1);
  await s.settlement.drain();
  expect(s.performed).toEqual([other]);
  expect((await view(parent)).issue.status).toBe("open");
  running = false;
  await s.settlement.drain();
  expect((await view(parent)).issue.status).toBe("closed");
});

test("a throttled automatic-parent close is not flagged and arms the timer", async () => {
  const parent = await create("Plan", { auto: true });
  await closeDone(await create("Only task", { parent }));
  const s = build({ fail: args => args[0] === "close" && args.includes(parent) ? throttled() : undefined });
  s.settlement.addAutoParent({ parent, workspace: cwd, sessionId: SESSION, auto: true });
  await s.settlement.drain();
  expect(s.timers.size).toBe(1);
  expect(await labels(parent)).not.toContain("needs-review");
  expect((await view(parent)).issue.status).toBe("open");
});

test("a parent flagged for missing evidence is audited again only when its revision or children change", async () => {
  const parent = await create("Plan", { auto: true });
  await closeWontfix(await create("Retired task", { parent }));
  const s = build();
  s.settlement.addAutoParent({ parent, workspace: cwd, sessionId: SESSION, auto: true });
  const labelCalls = () => s.calls.filter(args => args[0] === "label").length;
  await s.settlement.drain();
  expect(await labels(parent)).toContain("needs-review");
  expect(labelCalls()).toBe(1);
  await s.settlement.drain();
  await s.settlement.drain();
  expect(labelCalls()).toBe(1);
  await kata(["meta", "set", parent, "reviewer", "someone"]);
  await s.settlement.drain();
  expect(labelCalls()).toBe(2);
  await s.settlement.drain();
  expect(labelCalls()).toBe(2);
  await closeWontfix(await create("Another retired task", { parent }));
  await s.settlement.drain();
  expect(labelCalls()).toBe(3);
});

test("a parent flagged because its close was refused is audited again only when its revision or children change", async () => {
  const parent = await create("Plan", { auto: true });
  await closeDone(await create("Finished task", { parent }));
  const refusal = Object.assign(new Error("kata close failed"), { code: "validation" });
  const s = build({ fail: args => args[0] === "close" && args.includes(parent) ? refusal : undefined });
  s.settlement.addAutoParent({ parent, workspace: cwd, sessionId: SESSION, auto: true });
  const audits = () => s.calls.filter(args => args[0] === "audit" || args[0] === "label").length;
  await s.settlement.drain();
  expect(await labels(parent)).toContain("needs-review");
  const after = audits();
  expect(after).toBeGreaterThan(0);
  await s.settlement.drain();
  await s.settlement.drain();
  expect(audits()).toBe(after);
  await closeDone(await create("Later task", { parent }));
  await s.settlement.drain();
  expect(audits()).toBeGreaterThan(after);
});

test("restore clears the verdict memory, so a session start audits a flagged parent once more", async () => {
  const parent = await create("Plan", { auto: true });
  await closeWontfix(await create("Retired task", { parent }));
  const s = build();
  s.settlement.addAutoParent({ parent, workspace: cwd, sessionId: SESSION, auto: true });
  const labelCalls = () => s.calls.filter(args => args[0] === "label").length;
  await s.settlement.drain();
  await s.settlement.drain();
  expect(labelCalls()).toBe(1);
  s.settlement.restore(s.settlement.snapshot());
  await s.settlement.drain();
  expect(labelCalls()).toBe(2);
});

test("a snapshot restores the three kinds of close and re-arms the timer; restoring nothing clears them", async () => {
  const child = await create("Saved task"), ticket = await create("Saved umbrella"), parent = await create("Saved plan", { auto: true });
  const first = build();
  first.settlement.pendTaskClose(await taskOf(child), "completed", change, cwd);
  first.settlement.holdTicketClose(ticket, request, cwd);
  first.settlement.addAutoParent({ parent, workspace: cwd, sessionId: SESSION, auto: true });
  const saved = JSON.parse(JSON.stringify(first.settlement.snapshot()));
  expect(Object.keys(saved).sort()).toEqual(["autoParents", "pendingCloses", "retries"]);

  const second = build();
  second.settlement.restore(saved);
  expect(second.timers.size).toBe(1);
  expect(JSON.parse(JSON.stringify(second.settlement.snapshot()))).toEqual(saved);
  second.settlement.restore(undefined);
  expect(second.timers.size).toBe(0);
  expect(second.settlement.snapshot()).toEqual({ autoParents: [], retries: [] });
});

test("an automatic parent follows a rehomed ref and can be dropped", async () => {
  const parent = await create("Plan", { auto: true });
  await closeDone(await create("Only task", { parent }));
  const s = build();
  s.settlement.addAutoParent({ parent: "old#aaaa", workspace: cwd, sessionId: SESSION, auto: true });
  s.settlement.renamePlan("old#aaaa", parent);
  expect(s.settlement.snapshot().autoParents.map(b => b.parent)).toEqual([parent]);
  await s.settlement.drain();
  expect((await view(parent)).issue.status).toBe("closed");
  s.settlement.dropAutoParent(parent);
  expect(s.settlement.snapshot().autoParents).toEqual([]);
});
