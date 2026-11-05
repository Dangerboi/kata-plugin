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
let seq = 0, failing: ((args: string[]) => boolean) | undefined;

// A lead session and its delegates: each is an agent with its own core, as in omp, sharing the one delegate store.
function lead() {
  const entries: any[] = [], id = `delegates-lead-${++seq}`;
  const store = memoryDelegateStore();
  const agent = () => createKataCore({
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    exec: async (_file, args, opts) => failing?.(args) ? { code: 1, stdout: "", stderr: "delegation service permission denied" } : run(args, opts.cwd),
    isMain: ctx => ctx.agent?.kind === "main",
    delegateStore: store,
  }, { namespace: "omp", executable: binary, executableVars: ["KATA_OMP_EXECUTABLE"] });
  const core = agent();
  const ctx = { cwd, agent: { kind: "main", id: "lead" }, sessionManager: { getSessionId: () => id, getBranch: () => entries } };
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
  return { core, ctx, id, plan, view, delegate, started, delegated, delegates: core.delegates };
}

beforeAll(async () => { expect((await run(["init", "--project", "delegates-test"])).code).toBe(0); });
beforeEach(() => { process.env.KATA_AUTHOR = "lead-actor"; process.env.KATA_TEAMMATE = LEAD; delete process.env.KATA_REF; failing = undefined; });
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
