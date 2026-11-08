import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { createKataCore } from "../core/kata-core";
import type { DelegateEvent, DelegateRecord } from "../core/delegates";
import { assertIsolated } from "./isolation";
import { isolatedKata, memoryDelegateStore } from "./kata-fixture";
assertIsolated();

// The delegate lifecycle through the core's delegate events, against real Kata in a throwaway store.
const binary = process.env.KATA_TEST_EXECUTABLE!;
const root = mkdtempSync(path.join(process.env.KATA_TEST_ROOT!, "delegates-"));
const cwd = path.join(root, "workspace");
mkdirSync(cwd);
const env = { ...process.env, KATA_HOME: path.join(root, "home"), KATA_AUTHOR: "lead-actor" };
for (const key of ["KATA_REF", "KATA_TEAMMATE", "KATA_INBOX_USER"]) delete env[key];
const run = isolatedKata(binary, env, cwd, 60000);
async function kata(args: string[]) { const r = await run(args); if (r.code) throw new Error(r.stderr); return JSON.parse(r.stdout || "null"); }
const show = (ref: string) => kata(["show", ref, "--json"]);
const labels = (view: any) => (view.labels ?? []).map((l: any) => l.label);
const LEAD = "lead-mate";
let seq = 0, failing: ((args: string[]) => boolean) | undefined, holding: ((args: string[]) => Promise<void> | undefined) | undefined;

// A lead session and its delegates: each is an agent with its own core, as in omp, sharing the one delegate store.
// `from` resumes a past session (same id and entries, no records in memory) or, with `fork`, forks it (new id, parentSession in the header).
function lead(from?: { entries: any[]; id: string; fork?: boolean }) {
  const entries: any[] = from ? structuredClone(from.entries) : [], id = from?.fork ? `${from.id}-fork` : from?.id ?? `delegates-lead-${++seq}`;
  const header = from?.fork ? { parentSession: from.id } : {};
  const store = memoryDelegateStore();
  const agent = () => createKataCore({
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    exec: async (_file, args, opts) => { await holding?.(args); return failing?.(args) ? { code: 1, stdout: "", stderr: "delegation service permission denied" } : run(args, opts.cwd); },
    isMain: ctx => ctx.agent?.kind === "main",
    delegateStore: store,
  }, { namespace: "omp", executable: binary, executableVars: ["KATA_OMP_EXECUTABLE"] });
  const core = agent();
  const ctx = { cwd, agent: { kind: "main", id: "lead" }, sessionManager: { getSessionId: () => id, getBranch: () => entries, getHeader: () => header } };
  const plan = async (items: string[]) => {
    const result = await core.todo.apply(ctx, "init", { items });
    if (result.isError) throw new Error(result.content[0].text);
    return result.details.kata.parent as string;
  };
  const view = () => core.todo.apply(ctx, "view", {});
  const delegate = (name: string) => {
    const own = agent(), delegateCtx = { cwd, agent: { kind: "sub", id: name }, sessionManager: { getSessionId: () => name } };
    return {
      // What the delegate's next prompt tells it about its issue; undefined when it has none.
      assignment: async () => (await own.session.beforePrompt(delegateCtx, { context: false })).sections.assignment,
      // The message its todo call gives a delegate with no issue.
      unassigned: async () => (await own.todo.apply(delegateCtx, "view", {})).content[0].text as string,
    };
  };
  const started = (name: string, text: string, extra: Partial<Extract<DelegateEvent, { type: "started" }>> = {}): DelegateEvent => ({
    type: "started", id: name, sessionId: name, leadSessionId: id, leadTeammate: LEAD, teammate: `mate-${name}`, text, single: true, ...extra,
  });
  // Whether the lead may still work an issue: a delegated task refuses the lead's start.
  const delegated = async (title: string) => {
    const result = await core.todo.apply(ctx, "start", { task: title });
    return !!result.isError && /delegate/.test(result.content[0].text);
  };
  return { core, ctx, id, entries, store, plan, view, delegate, started, delegated, delegates: core.delegates };
}

beforeAll(async () => { expect((await run(["init", "--project", "delegates-test"])).code).toBe(0); });
beforeEach(() => { process.env.KATA_AUTHOR = "lead-actor"; process.env.KATA_TEAMMATE = LEAD; delete process.env.KATA_REF; failing = undefined; holding = undefined; });
afterAll(async () => { await run(["daemon", "stop"]); });

const taskOf = async (parent: string, title: string) => (await show(parent)).children.find((c: any) => c.title === title);

test("a started delegate matching a plan task is assigned it: claim, teammate, delegate keys, in progress, attention ok", async () => {
  const a = lead(); const parent = await a.plan(["Build the alpha widget", "Lead keeps leading"]);
  const task = await taskOf(parent, "Build the alpha widget");
  const delegate = a.delegate("alpha");
  await a.delegates.apply(a.started("alpha", "Build the alpha widget"));
  const meta = (await show(`delegates-test#${task.short_id}`)).issue;
  expect(meta.owner).toBe("lead-actor");
  expect(meta.metadata).toMatchObject({ teammate: "mate-alpha", "omp.subagent_id": "alpha", "omp.session_id": a.id, "omp.parent_agent_id": "main", "omp.status": "running", "todo.status": "in_progress", "work.attention": "ok" });
  const assignment = await delegate.assignment();
  expect(assignment).toContain(`delegates-test#${task.short_id}`);
  expect(assignment).toContain("mate-alpha");
  expect(await a.delegated("Build the alpha widget")).toBe(true);
});

test("a delegate that matches nothing is untracked: holding no issue, with an explanation instead of an assignment", async () => {
  const a = lead(); const parent = await a.plan(["Build the beta widget"]);
  const before = await show(parent);
  const delegate = a.delegate("beta-scout");
  await a.delegates.apply(a.started("beta-scout", "Survey the unrelated build system"));
  expect(await delegate.assignment()).toContain("no Kata issue");
  expect(await delegate.unassigned()).toContain("no Kata issue");
  await a.delegates.apply({ type: "exited", id: "beta-scout", outcome: "completed" });
  expect((await show(parent)).children).toEqual(before.children);
});

test("a delegate that ran a tool and exits with its issue open hands it back: comment, needs-human, needs-review, task back to the lead", async () => {
  const a = lead(); const parent = await a.plan(["Build the gamma widget", "Lead step"]);
  const task = await taskOf(parent, "Build the gamma widget"), ref = `delegates-test#${task.short_id}`;
  await a.delegates.apply(a.started("gamma", "Build the gamma widget"));
  await a.delegates.apply({ type: "ranTool", id: "gamma" });
  await a.delegates.apply({ type: "exited", id: "gamma", outcome: "completed" });
  const view = await show(ref);
  expect(labels(view)).toContain("needs-review");
  expect(view.issue.status).toBe("open");
  expect(view.issue.metadata).toMatchObject({ teammate: LEAD, "todo.status": "pending", "work.attention": "needs-human", "omp.status": "completed" });
  expect(view.issue.metadata["omp.subagent_id"]).toBeUndefined();
  expect(JSON.stringify(view)).toContain("completed without closing its Kata issue");
  expect(await a.delegated("Build the gamma widget")).toBe(false);
});

test("a delegate that exits having run no tool has its assignment rolled back, with no needs-review", async () => {
  const a = lead(); const parent = await a.plan(["Build the delta widget", "Lead step"]);
  const task = await taskOf(parent, "Build the delta widget"), ref = `delegates-test#${task.short_id}`;
  const before = await show(ref);
  await a.delegates.apply(a.started("delta", "Build the delta widget"));
  expect((await show(ref)).issue.metadata["omp.subagent_id"]).toBe("delta");
  await a.delegates.apply({ type: "exited", id: "delta", outcome: "ended" });
  const view = await show(ref);
  expect(labels(view)).not.toContain("needs-review");
  expect(view.issue.owner).toBe(before.issue.owner);
  for (const key of ["omp.subagent_id", "omp.session_id", "omp.status", "omp.parent_agent_id"]) expect(view.issue.metadata[key]).toBeUndefined();
  for (const key of ["teammate", "work.attention", "todo.status"]) expect(view.issue.metadata[key]).toEqual(before.issue.metadata[key]);
  expect(await a.delegated("Build the delta widget")).toBe(false);
});

test("a delegate that ran a tool is handed back at exit, never rolled back", async () => {
  const a = lead(); const parent = await a.plan(["Build the epsilon widget"]);
  const task = await taskOf(parent, "Build the epsilon widget"), ref = `delegates-test#${task.short_id}`;
  await a.delegates.apply(a.started("epsilon", "Build the epsilon widget"));
  await a.delegates.apply({ type: "ranTool", id: "epsilon" });
  await a.delegates.apply({ type: "exited", id: "epsilon", outcome: "aborted" });
  expect(labels(await show(ref))).toContain("needs-review");
});

test("a failed assignment is a named state; the delegate's next use retries it", async () => {
  const a = lead(); const parent = await a.plan(["Build the zeta widget", "Lead step"]);
  const task = await taskOf(parent, "Build the zeta widget"), ref = `delegates-test#${task.short_id}`;
  const delegate = a.delegate("zeta");
  failing = args => args[0] === "meta" && args[3] === "omp.subagent_id";
  await a.delegates.apply(a.started("zeta", "Build the zeta widget"));
  expect(await delegate.assignment()).toBeUndefined();
  expect(await delegate.unassigned()).toContain("delegation service permission denied");
  expect(await a.delegated("Build the zeta widget")).toBe(true);
  failing = undefined;
  await a.delegates.apply({ type: "nextUse", id: "zeta" });
  expect(await delegate.assignment()).toContain(ref);
  expect((await show(ref)).issue.metadata["omp.subagent_id"]).toBe("zeta");
});

test("a delegate's next use waits for its own assignment, not for the ones queued behind it", async () => {
  const a = lead(); const parent = await a.plan(["Build the iota widget", "Build the kappa gadget"]);
  const later = await taskOf(parent, "Build the kappa gadget");
  const gate = Promise.withResolvers<void>();
  holding = args => args.some(arg => arg.includes(later.short_id)) ? gate.promise : undefined;
  const first = a.delegates.apply(a.started("iota", "Build the iota widget"));
  const second = a.delegates.apply(a.started("kappa-gadget", "Build the kappa gadget"));
  // Resolves while the later assignment is still held; queued behind it, this call would never return.
  await a.delegates.apply({ type: "nextUse", id: "iota" });
  expect(await a.delegate("iota").assignment()).toContain((await taskOf(parent, "Build the iota widget")).short_id);
  gate.resolve();
  await Promise.all([first, second]);
});

test("a next use that joins a still-queued assignment retries it once if that attempt fails", async () => {
  const a = lead(); const parent = await a.plan(["Build the lambda widget", "Lead step"]);
  const task = await taskOf(parent, "Build the lambda widget");
  let failures = 1;
  failing = args => args[0] === "meta" && args[3] === "omp.subagent_id" && failures-- > 0;
  const start = a.delegates.apply(a.started("lambda", "Build the lambda widget"));
  await a.delegates.apply({ type: "nextUse", id: "lambda" });
  await start;
  expect(await a.delegate("lambda").assignment()).toContain(task.short_id);
});

test("a delegate whose assignment failed is handed back when it exits, even with no tool run", async () => {
  const a = lead(); const parent = await a.plan(["Build the eta widget", "Lead step"]);
  const task = await taskOf(parent, "Build the eta widget"), ref = `delegates-test#${task.short_id}`;
  failing = args => args[0] === "meta" && args[3] === "omp.subagent_id";
  await a.delegates.apply(a.started("eta", "Build the eta widget"));
  failing = args => args[0] === "label";
  await a.delegates.apply({ type: "exited", id: "eta", outcome: "completed" });
  // The hand back cannot finish while the write keeps failing; it runs again on the next settlement.
  failing = undefined;
  await a.view();
  const view = await show(ref);
  expect(labels(view)).toContain("needs-review");
  expect(view.issue.metadata.teammate).toBe(LEAD);
  expect(await a.delegated("Build the eta widget")).toBe(false);
});

test("a rollback that failed partway finishes on the next settle instead of refusing the lead", async () => {
  const a = lead(); const parent = await a.plan(["Build the iota widget", "Lead step"]);
  const task = await taskOf(parent, "Build the iota widget"), ref = `delegates-test#${task.short_id}`;
  await a.delegates.apply(a.started("iota", "Build the iota widget"));
  failing = args => args[0] === "meta" && args[1] === "unset" && args[3] === "omp.status";
  await a.delegates.apply({ type: "exited", id: "iota", outcome: "ended" });
  expect(await a.delegated("Build the iota widget")).toBe(true);
  failing = undefined;
  await a.view();
  const view = await show(ref);
  expect(await a.delegated("Build the iota widget")).toBe(false);
  for (const key of ["omp.subagent_id", "omp.session_id", "omp.status", "omp.parent_agent_id"]) expect(view.issue.metadata[key]).toBeUndefined();
  expect(view.issue.metadata.teammate).toBe(LEAD);
});

test("a resumed delegate whose settle never finished keeps its issue instead of handing it back mid-work", async () => {
  const a = lead(); const parent = await a.plan(["Build the kappa widget", "Lead step"]);
  const task = await taskOf(parent, "Build the kappa widget"), ref = `delegates-test#${task.short_id}`;
  await a.delegates.apply(a.started("kappa", "Build the kappa widget"));
  failing = args => args[0] === "meta" && args[3] === "todo.status";
  await a.delegates.apply({ type: "exited", id: "kappa", outcome: "ended" });
  failing = undefined;
  await a.delegates.apply({ type: "nextUse", id: "kappa" });
  await a.view();
  const view = await show(ref);
  expect(view.issue.metadata["omp.subagent_id"]).toBe("kappa");
  expect(view.issue.metadata.teammate).toBe("mate-kappa");
  expect(await a.delegated("Build the kappa widget")).toBe(true);
});

// Resuming settles in the background on the lead's queue, so a todo view returns only after the settle is done.
const savedDelegates = (entries: any[]) => entries.filter(e => e.customType === "io.kata.omp.state").at(-1)?.data.delegates;
// The newest saved snapshot with `change` applied to its first delegate, as a process that died at that point would have left it.
const withSnapshot = (entries: any[], change: (record: any) => void) => {
  const data = structuredClone(entries.filter(e => e.customType === "io.kata.omp.state").at(-1).data);
  change(data.delegates[0]);
  return [...structuredClone(entries), { type: "custom", customType: "io.kata.omp.state", data }];
};

test("a lead resumed with a delegate's hand back unfinished finishes it: needs-review, needs-human, a request to the lead", async () => {
  const a = lead(); const parent = await a.plan(["Build the xi widget", "Lead step"]);
  const task = await taskOf(parent, "Build the xi widget"), ref = `delegates-test#${task.short_id}`;
  await a.delegates.apply(a.started("xi", "Build the xi widget"));
  await a.delegates.apply({ type: "ranTool", id: "xi" });
  failing = args => args[0] === "label";
  await a.delegates.apply({ type: "exited", id: "xi", outcome: "completed" });
  failing = undefined;
  expect(savedDelegates(a.entries)).toMatchObject([{ id: "xi", ranTool: true, exited: "completed", state: "assigned" }]);
  expect(labels(await show(ref))).not.toContain("needs-review");
  const b = lead({ entries: a.entries, id: a.id });
  await b.core.session.start(b.ctx);
  await b.view();
  const view = await show(ref);
  expect(labels(view)).toContain("needs-review");
  expect(view.issue.metadata).toMatchObject({ teammate: LEAD, "work.attention": "needs-human", "omp.status": "completed" });
  expect(view.issue.metadata["omp.subagent_id"]).toBeUndefined();
  expect((await kata(["inbox", "--for", `lead-actor/${LEAD}`, "--json"])).requests.some((r: any) => r.ref.endsWith(task.short_id))).toBe(true);
  expect(savedDelegates(b.entries)).toBeUndefined();
});

test("a lead resumed with a delegate that ran no tool rolls its assignment back", async () => {
  const a = lead(); const parent = await a.plan(["Build the omicron widget", "Lead step"]);
  const task = await taskOf(parent, "Build the omicron widget"), ref = `delegates-test#${task.short_id}`;
  const before = await show(ref);
  await a.delegates.apply(a.started("omicron", "Build the omicron widget"));
  failing = args => args[0] === "meta" && args[1] === "unset" && args[3] === "omp.status";
  await a.delegates.apply({ type: "exited", id: "omicron", outcome: "ended" });
  failing = undefined;
  expect(savedDelegates(a.entries)).toMatchObject([{ id: "omicron", exited: "ended" }]);
  expect(savedDelegates(a.entries)[0].ranTool).toBeFalsy();
  const b = lead({ entries: a.entries, id: a.id });
  await b.core.session.start(b.ctx);
  await b.view();
  const view = await show(ref);
  expect(labels(view)).not.toContain("needs-review");
  expect(view.issue.owner).toBe(before.issue.owner);
  for (const key of ["omp.subagent_id", "omp.session_id", "omp.status", "omp.parent_agent_id"]) expect(view.issue.metadata[key]).toBeUndefined();
  for (const key of ["teammate", "work.attention", "todo.status"]) expect(view.issue.metadata[key]).toEqual(before.issue.metadata[key]);
});

test("a saved delegate with no exit is settled as aborted when the lead is resumed", async () => {
  const a = lead(); const parent = await a.plan(["Build the pi widget", "Lead step"]);
  const task = await taskOf(parent, "Build the pi widget"), ref = `delegates-test#${task.short_id}`;
  await a.delegates.apply(a.started("pi-w", "Build the pi widget"));
  await a.delegates.apply({ type: "ranTool", id: "pi-w" });
  expect(savedDelegates(a.entries)).toMatchObject([{ id: "pi-w", ranTool: true }]);
  expect(savedDelegates(a.entries)[0].exited).toBeUndefined();
  const b = lead({ entries: a.entries, id: a.id });
  await b.core.session.start(b.ctx);
  await b.view();
  const view = await show(ref);
  expect(labels(view)).toContain("needs-review");
  expect(view.issue.metadata["omp.status"]).toBe("aborted");
  expect(JSON.stringify(view)).toContain("aborted without closing its Kata issue");
});

test("a fork does not settle the source's delegates", async () => {
  const a = lead(); const parent = await a.plan(["Build the rho widget", "Lead step"]);
  const task = await taskOf(parent, "Build the rho widget"), ref = `delegates-test#${task.short_id}`;
  await a.delegates.apply(a.started("rho", "Build the rho widget"));
  await a.delegates.apply({ type: "ranTool", id: "rho" });
  const f = lead({ entries: a.entries, id: a.id, fork: true });
  await f.core.session.start(f.ctx);
  // A fork that wrongly settled would queue it in the background; the view returns only after that queue.
  await f.view();
  const view = await show(ref);
  expect(labels(view)).not.toContain("needs-review");
  expect(view.issue.metadata).toMatchObject({ teammate: "mate-rho", "omp.subagent_id": "rho", "omp.status": "running" });
  expect(savedDelegates(f.entries.slice(a.entries.length))).toBeUndefined();
});

test("a /tree back to an older snapshot does not settle an already settled delegate again", async () => {
  const a = lead(); const parent = await a.plan(["Build the tau widget", "Lead step"]);
  const task = await taskOf(parent, "Build the tau widget"), ref = `delegates-test#${task.short_id}`;
  await a.delegates.apply(a.started("tau", "Build the tau widget"));
  const older = a.entries.length;
  const b = lead({ entries: a.entries, id: a.id });
  await b.core.session.start(b.ctx);
  await b.view();
  expect(labels(await show(ref))).not.toContain("needs-review");
  // A later holder takes the task; a second rollback or hand back would clear its keys or re-flag it.
  await kata(["assign", ref, "later-actor", "--json"]);
  for (const [key, value] of [["teammate", "mate-later"], ["omp.subagent_id", "later"], ["omp.status", "running"]]) await kata(["meta", "set", ref, key, value, "--json"]);
  b.entries.splice(older);
  expect(savedDelegates(b.entries)).toMatchObject([{ id: "tau", state: "assigned" }]);
  // Empty memory again, as if the record had never been held: only the `resumed` check keeps /tree from restoring it.
  b.store.drop("tau");
  await b.core.session.tree(b.ctx);
  await b.view();
  expect(b.store.get("tau")).toBeUndefined();
  const view = await show(ref);
  expect(labels(view)).not.toContain("needs-review");
  expect(view.issue.owner).toBe("later-actor");
  expect(view.issue.metadata).toMatchObject({ teammate: "mate-later", "omp.subagent_id": "later", "omp.status": "running" });
});

test("a lead resumed with a delegate whose assignment was cut off after its first writes rolls the issue back", async () => {
  const a = lead(); const parent = await a.plan(["Build the upsilon widget", "Lead step"]);
  const task = await taskOf(parent, "Build the upsilon widget"), ref = `delegates-test#${task.short_id}`;
  const before = await show(ref);
  await a.delegates.apply(a.started("upsilon", "Build the upsilon widget"));
  // The saved record never reached `assigned`: it has its restore point and binding but no ref.
  const cut = withSnapshot(a.entries, record => { record.state = "started"; delete record.ref; });
  expect(savedDelegates(cut)).toMatchObject([{ id: "upsilon", state: "started" }]);
  const b = lead({ entries: cut, id: a.id });
  await b.core.session.start(b.ctx);
  await b.view();
  const view = await show(ref);
  expect(labels(view)).not.toContain("needs-review");
  expect(view.issue.owner).toBe(before.issue.owner);
  for (const key of ["omp.subagent_id", "omp.session_id", "omp.status", "omp.parent_agent_id"]) expect(view.issue.metadata[key]).toBeUndefined();
  for (const key of ["teammate", "work.attention", "todo.status"]) expect(view.issue.metadata[key]).toEqual(before.issue.metadata[key]);
});

test("a new process resuming from an older snapshot leaves an issue a later holder took untouched", async () => {
  const a = lead(); const parent = await a.plan(["Build the phi widget", "Lead step"]);
  const task = await taskOf(parent, "Build the phi widget"), ref = `delegates-test#${task.short_id}`;
  await a.delegates.apply(a.started("phi", "Build the phi widget"));
  const older = a.entries.length;
  await a.delegates.apply({ type: "exited", id: "phi", outcome: "ended" });
  await kata(["assign", ref, "later-actor", "--json"]);
  for (const [key, value] of [["teammate", "mate-later"], ["omp.subagent_id", "later"], ["omp.status", "running"], ["omp.session_id", "later-session"]]) await kata(["meta", "set", ref, key, value, "--json"]);
  const inbox = async () => (await kata(["inbox", "--for", `lead-actor/${LEAD}`, "--json"])).requests.filter((r: any) => r.ref.endsWith(task.short_id)).length;
  const notified = await inbox();
  // The older snapshot still lists phi as assigned: a settle that finished elsewhere never updated it.
  const c = lead({ entries: a.entries.slice(0, older), id: a.id });
  expect(savedDelegates(c.entries)).toMatchObject([{ id: "phi", state: "assigned" }]);
  await c.core.session.start(c.ctx);
  await c.view();
  const view = await show(ref);
  expect(labels(view)).not.toContain("needs-review");
  expect(await inbox()).toBe(notified);
  expect(view.issue.owner).toBe("later-actor");
  expect(view.issue.metadata).toMatchObject({ teammate: "mate-later", "omp.subagent_id": "later", "omp.status": "running", "omp.session_id": "later-session" });
});

test("a started delegate saved before its restore point existed leaves the issue alone on resume", async () => {
  const a = lead(); const parent = await a.plan(["Build the psi widget", "Lead step"]);
  const task = await taskOf(parent, "Build the psi widget"), ref = `delegates-test#${task.short_id}`;
  await a.delegates.apply(a.started("psi", "Build the psi widget"));
  const before = await show(ref);
  const inbox = async () => (await kata(["inbox", "--for", `lead-actor/${LEAD}`, "--json"])).requests.filter((r: any) => r.ref.endsWith(task.short_id)).length;
  const notified = await inbox();
  // A sibling's save during the first show: the record has its binding but nothing was written or captured yet.
  const cut = withSnapshot(a.entries, record => { record.state = "started"; delete record.ref; delete record.restore; });
  expect(savedDelegates(cut)).toMatchObject([{ id: "psi", state: "started", binding: {} }]);
  const b = lead({ entries: cut, id: a.id });
  await b.core.session.start(b.ctx);
  await b.view();
  const view = await show(ref);
  expect(labels(view)).not.toContain("needs-review");
  expect(await inbox()).toBe(notified);
  expect(view.issue.metadata).toEqual(before.issue.metadata);
  expect(view.issue.owner).toBe(before.issue.owner);
});

test("an assignment saves its restore point before its first write", async () => {
  const a = lead(); await a.plan(["Build the omega widget", "Lead step"]);
  const gate = Promise.withResolvers<void>(), reached = Promise.withResolvers<void>();
  holding = args => args[0] === "meta" && args[1] === "set" && args[3] === "teammate" ? (reached.resolve(), gate.promise) : undefined;
  const start = a.delegates.apply(a.started("omega", "Build the omega widget"));
  await reached.promise;
  expect(savedDelegates(a.entries)).toMatchObject([{ id: "omega", state: "started", restore: { meta: {} } }]);
  gate.resolve();
  await start;
});

test("a delegate whose issue was deleted settles instead of waiting forever", async () => {
  const a = lead(); const parent = await a.plan(["Build the chi widget", "Lead step"]);
  const task = await taskOf(parent, "Build the chi widget"), ref = `delegates-test#${task.short_id}`;
  await a.delegates.apply(a.started("chi", "Build the chi widget"));
  await a.delegates.apply({ type: "ranTool", id: "chi" });
  await kata(["delete", ref, "--force", "--confirm", `DELETE ${ref}`, "--json"]);
  await a.delegates.apply({ type: "exited", id: "chi", outcome: "completed" });
  // The public delegates API has no `waiting`: a settled record no longer appears in the saved snapshot.
  expect(savedDelegates(a.entries)).toBeUndefined();
});

test("a delegate that exits with its issue closed leaves it closed and releases it", async () => {
  const a = lead(); const parent = await a.plan(["Build the theta widget", "Lead step"]);
  const task = await taskOf(parent, "Build the theta widget"), ref = `delegates-test#${task.short_id}`;
  await a.delegates.apply(a.started("theta", "Build the theta widget"));
  await kata(["close", ref, "--done", "--message", "Closed by the delegate itself with verified behaviour.", "--test", "delegates fixture", "--teammate", "mate-theta", "--json"]);
  await a.delegates.apply({ type: "exited", id: "theta", outcome: "completed" });
  const view = await show(ref);
  expect(view.issue.status).toBe("closed");
  expect(labels(view)).not.toContain("needs-review");
});

test("an automatic parent stays open while a delegate runs, and closes once it has exited", async () => {
  const a = lead(); const parent = await a.plan(["Build the nu widget"]);
  const task = await taskOf(parent, "Build the nu widget"), ref = `delegates-test#${task.short_id}`;
  await a.delegates.apply(a.started("nu", "Build the nu widget"));
  await kata(["close", ref, "--done", "--message", "Closed by the delegate itself with verified behaviour.", "--test", "delegates fixture", "--teammate", "mate-nu", "--json"]);
  await a.view();
  expect((await show(parent)).issue.status).toBe("open");
  await a.delegates.apply({ type: "exited", id: "nu", outcome: "completed" });
  await a.view();
  expect((await show(parent)).issue.status).toBe("closed");
});

test("check refuses a task naming two plan items, an already delegated task, and an unclaimable ticket", async () => {
  const a = lead(); await a.plan(["Build the iota widget", "Build the kappa widget"]);
  await expect(a.delegates.check([{ text: 'Do "Build the iota widget" and "Build the kappa widget"' }])).rejects.toThrow(/names more than one/);
  const [first] = await a.delegates.check([{ text: 'Complete "Build the iota widget"' }]);
  expect(first.ref).toMatch(/^delegates-test#/);
  await a.delegates.apply(a.started("iota", 'Complete "Build the iota widget"', { reserved: first }));
  await expect(a.delegates.check([{ text: 'Complete "Build the iota widget"' }])).rejects.toThrow(/already delegated/);
  const foreign = (await kata(["create", "Someone else's ticket", "--force-new", "--json"])).issue.short_id;
  await kata(["claim", foreign, "--as", "someone-else", "--json"]);
  await expect(a.delegates.check([{ text: `Work delegates-test#${foreign}` }])).rejects.toThrow(/cannot be delegated/);
});

test("a spawn naming a ticket outside the plan is reserved as that ticket and assigned it", async () => {
  const a = lead(); await a.plan(["Build the lambda widget"]);
  const ticket = (await kata(["create", "Outside ticket", "--force-new", "--json"])).issue.short_id, ref = `delegates-test#${ticket}`;
  const [reserved] = await a.delegates.check([{ text: `Work ${ref}: write the thing` }]);
  expect(reserved).toEqual({ ref, ticket: true });
  await a.delegates.apply(a.started("lambda", `Work ${ref}`, { reserved }));
  expect((await show(ref)).issue.metadata["omp.subagent_id"]).toBe("lambda");
  expect(await a.delegate("lambda").assignment()).toContain(ref);
});

test("a delegate refused an issue another delegate holds leaves it with its holder when it exits", async () => {
  const a = lead(); const parent = await a.plan(["Build the mu widget", "Lead step"]);
  const task = await taskOf(parent, "Build the mu widget"), ref = `delegates-test#${task.short_id}`;
  const [reserved] = await a.delegates.check([{ text: "Build the mu widget" }]);
  await a.delegates.apply(a.started("mu-holder", "Build the mu widget"));
  await a.delegates.apply(a.started("mu-late", "Build the mu widget", { reserved }));
  expect(await a.delegate("mu-late").assignment()).toBeUndefined();
  await a.delegates.apply({ type: "exited", id: "mu-late", outcome: "failed" });
  const view = await show(ref);
  expect(labels(view)).not.toContain("needs-review");
  expect(view.issue.metadata).toMatchObject({ teammate: "mate-mu-holder", "omp.subagent_id": "mu-holder", "omp.status": "running" });
  expect(JSON.stringify(view)).not.toContain("mu-late");
});
