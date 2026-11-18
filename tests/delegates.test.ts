import { beforeEach, expect, test } from "bun:test";
import { createKataCore } from "../core/kata-core";
import { NO_JOB } from "../core/kata-cli";
import { nodePlatform } from "../core/node-host";
import { teammateFor, type DelegateEvent } from "../core/delegates";
import { TODO_WORDING, type ToolWording } from "../core/model";
import { eventually, EVIDENCE, holdKata, holdNext, MESSAGE, memoryDelegateStore, planOf, realKata, unique } from "./kata-fixture";
import { daemonUnavailable, siblingThrottle } from "./kata-errors";

// The delegate lifecycle through the core's delegate events, against real Kata in a throwaway store.
const LEAD = "lead-mate";
const { binary, cwd, run, kata, show, issue, deleteIssue, commentsOf, sessionParents, closesOf } = realKata({ prefix: "delegates", author: "lead-actor", project: "delegates-test", process: { KATA_TEAMMATE: LEAD } });
const labels = (view: any) => (view.labels ?? []).map((l: any) => l.label);
let failing: ((args: string[]) => boolean) | undefined, throttled: ((args: string[]) => boolean) | undefined, unreachable: ((args: string[]) => boolean) | undefined, holding: ((args: string[], opts: any) => Promise<unknown>) | undefined;

// A lead session and its delegates: each is an agent with its own core, as in omp, sharing the one delegate store.
// `from` resumes a past session (same id and entries, no records in memory) or, with `fork`, forks it (new id, parentSession in the header).
function lead(from?: { entries: any[]; id: string; fork?: boolean }, wording?: ToolWording) {
  const entries: any[] = from ? structuredClone(from.entries) : [], id = from?.fork ? `${from.id}-fork` : from?.id ?? `delegates-lead-${unique()}`;
  const header = from?.fork ? { parentSession: from.id } : {};
  const store = memoryDelegateStore();
  const agent = () => createKataCore({
    platform: nodePlatform,
    contextTimers: ctx => ctx.setTimeout ? { setTimer: ctx.setTimeout, clearTimer: ctx.clearTimer } : undefined,
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    exec: async (_file, args, opts) => { await holding?.(args, opts); if (throttled?.(args)) return siblingThrottle(); if (unreachable?.(args)) return daemonUnavailable(); return failing?.(args) ? { code: 1, stdout: "", stderr: "delegation service permission denied" } : run(args, opts.cwd); },
    isMain: ctx => ctx.agent?.kind === "main",
    delegateStore: store,
  }, { namespace: "omp", executable: binary, executableVars: ["KATA_OMP_EXECUTABLE"], wording });
  const core = agent();
  // omp's ctx timer: the settlement's retries are armed here and fired by the test.
  const timers: (() => void)[] = [];
  const ctx = { cwd, agent: { kind: "main", id: "lead" }, sessionManager: { getSessionId: () => id, getBranch: () => entries, getHeader: () => header },
    setTimeout: (fire: () => void) => timers.push(fire), clearTimer: () => {} };
  const plan = async (items: string[]) => {
    const result = await core.todo.apply(ctx, "init", { items }, NO_JOB);
    if (result.isError) throw new Error(result.content[0].text);
    return planOf(result).parent as string;
  };
  const view = () => core.todo.apply(ctx, "view", {}, NO_JOB);
  const delegate = (name: string) => {
    const own = agent(), delegateCtx = { cwd, agent: { kind: "sub", id: name }, sessionManager: { getSessionId: () => name } };
    return {
      // What the delegate's next prompt tells it about its issue; undefined when it has none.
      assignment: async () => (await own.session.beforePrompt(delegateCtx, { context: false })).sections.assignment,
      // The message its todo call gives a delegate with no issue.
      unassigned: async () => (await own.todo.apply(delegateCtx, "view", {}, NO_JOB)).content[0].text as string,
    };
  };
  const started = (name: string, text: string, extra: Partial<Extract<DelegateEvent, { type: "started" }>> = {}): DelegateEvent => ({
    type: "started", id: name, sessionId: name, leadSessionId: id, leadTeammate: LEAD, teammate: `mate-${name}`, text, ...extra,
  });
  // Whether the lead may still work an issue: a delegated task refuses the lead's start.
  const delegated = async (title: string) => {
    const result = await core.todo.apply(ctx, "start", { task: title }, NO_JOB);
    return !!result.isError && /delegate/.test(result.content[0].text);
  };
  const scout = async (name: string, report: string) => {
    await core.delegates.apply(started(name, "List the top-level directories of the repository", { agent: "scout" }), NO_JOB);
    await core.delegates.apply({ type: "reported", id: name, text: report }, NO_JOB);
    await core.delegates.apply({ type: "exited", id: name, outcome: "completed" }, NO_JOB);
  };
  return { core, ctx, id, entries, store, plan, view, delegate, started, delegated, scout, timers, delegates: core.delegates };
}

beforeEach(() => { failing = undefined; throttled = undefined; unreachable = undefined; holding = undefined; });

const taskOf = async (parent: string, title: string) => (await show(parent)).children.find((c: any) => c.title === title);
const PROJECT = "delegates-test";
const qref = (issue: { short_id: string }) => `${PROJECT}#${issue.short_id}`;
const refOf = async (parent: string, title: string) => qref(await taskOf(parent, title));
// A ticket outside any plan, qualified.
const ticketRef = async (title: string) => `${PROJECT}#${await issue(title)}`;
// The same session resumed on `options.entries` (default: what `a` saved), or forked from it: a lead holding no records in memory.
async function resume(a: ReturnType<typeof lead>, options: { entries?: any[]; fork?: boolean } = {}) {
  const b = lead({ entries: options.entries ?? a.entries, id: a.id, fork: options.fork });
  await b.core.session.start(b.ctx);
  return b;
}
const closeByDelegate = (ref: string, teammate: string) => kata(["close", ref, "--done", "--message", MESSAGE, "--evidence", EVIDENCE[0], "--teammate", teammate, "--json"]);
// Another session's delegate holds the issue: its teammate and markers, as an assignment writes them.
async function heldByAnotherDelegate(ref: string, name: string, extra: [string, string][] = []) {
  for (const [key, value] of [["teammate", `mate-${name}`], ["omp.subagent_id", name], ["omp.status", "running"], ...extra]) await kata(["meta", "set", ref, key, value, "--json"]);
}
// A rolled-back assignment leaves the issue as it was before it: no hand back, same owner, the delegate's keys gone.
const expectRolledBack = (view: any, before: any) => {
  expect(labels(view)).not.toContain("needs-review");
  expect(view.issue.owner).toBe(before.issue.owner);
  for (const key of ["omp.subagent_id", "omp.session_id", "omp.status", "omp.parent_agent_id"]) expect(view.issue.metadata[key]).toBeUndefined();
  for (const key of ["teammate", "work.attention", "todo.status"]) expect(view.issue.metadata[key]).toEqual(before.issue.metadata[key]);
};

test("a started delegate matching a plan task is assigned it: claim, teammate, delegate keys, in progress, attention ok", async () => {
  const a = lead(); const parent = await a.plan(["Build the alpha widget", "Lead keeps leading"]);
  const task = await taskOf(parent, "Build the alpha widget");
  const delegate = a.delegate("alpha");
  await a.delegates.apply(a.started("alpha", "Build the alpha widget"), NO_JOB);
  const meta = (await show(qref(task))).issue;
  expect(meta.owner).toBe("lead-actor");
  expect(meta.metadata).toMatchObject({ teammate: "mate-alpha", "omp.subagent_id": "alpha", "omp.session_id": a.id, "omp.parent_agent_id": "main", "omp.status": "running", "todo.status": "in_progress", "work.attention": "ok" });
  const assignment = await delegate.assignment();
  expect(assignment).toContain(qref(task));
  expect(assignment).toContain("mate-alpha");
  expect(await a.delegated("Build the alpha widget")).toBe(true);
});

test("a delegate that matches nothing is untracked: holding no issue, with an explanation instead of an assignment", async () => {
  const a = lead(); const parent = await a.plan(["Build the beta widget"]);
  const before = await show(parent);
  const delegate = a.delegate("beta-scout");
  await a.delegates.apply(a.started("beta-scout", "Survey the unrelated build system"), NO_JOB);
  expect(await delegate.assignment()).toContain("no Kata issue");
  expect(await delegate.unassigned()).toContain("no Kata issue");
  await a.delegates.apply({ type: "exited", id: "beta-scout", outcome: "completed" }, NO_JOB);
  expect((await show(parent)).children).toEqual(before.children);
});

const missionsOf = async (parent: string) => (await show(parent)).children.filter((c: any) => c.metadata?.["omp.mission"] === "true");

test("an untracked delegate that exits with a report gets a closed mission under the plan parent: its task, and its report under its teammate", async () => {
  const a = lead(); const parent = await a.plan(["Build the rho widget"]);
  await a.delegates.apply(a.started("rho-scout", "Survey the unrelated build system", { agent: "scout" }), NO_JOB);
  await a.delegates.apply({ type: "reported", id: "rho-scout", text: "The build system is plain make, with no generated files." }, NO_JOB);
  await a.delegates.apply({ type: "exited", id: "rho-scout", outcome: "completed" }, NO_JOB);
  const [record] = await missionsOf(parent);
  const mission = await show(qref(record));
  expect(mission.issue).toMatchObject({ status: "closed", closed_reason: "audit-no-change" });
  expect(mission.issue.metadata).toMatchObject({ "omp.mission_subagent_id": "rho-scout", "omp.mission_agent": "scout" });
  expect(mission.issue.body).toContain("Survey the unrelated build system");
  expect(mission.comments.map((c: any) => [c.teammate, c.body.includes("plain make, with no generated files")])).toEqual([["mate-rho-scout", true]]);
  expect(labels(mission)).not.toContain("needs-review");
  // The plan is still the lead's own work.
  expect((await a.view()).content[0].text).not.toContain(mission.issue.title);
});

test("a lead with no plan parent gets an automatic parent for an untracked delegate's mission, which closes it as audit-no-change", async () => {
  const a = lead(); await a.view();
  await a.scout("sigma-scout", "core, docs, plugins, scripts and tests.");
  const [parent] = await sessionParents("omp", a.id, true);
  expect(parent.metadata["omp.auto_parent"]).toBe(true);
  const view = await show(parent.qualified_id);
  expect(view.children.map((c: any) => [c.metadata["omp.mission_subagent_id"], c.status])).toEqual([["sigma-scout", "closed"]]);
  expect(view.issue).toMatchObject({ status: "closed", closed_reason: "audit-no-change" });
  expect(labels(view)).not.toContain("needs-review");
});

test("an explicit parent takes the mission, and no automatic parent is made beside it", async () => {
  const explicit = await ticketRef("Explicit epic");
  process.env.KATA_REF = explicit;
  const a = lead(); await a.view();
  await a.scout("tau-scout", "Nothing unusual in the layout.");
  expect((await missionsOf(explicit)).map((c: any) => [c.metadata["omp.mission_subagent_id"], c.status])).toEqual([["tau-scout", "closed"]]);
  expect(await sessionParents("omp", a.id, true)).toEqual([]);
  expect((await show(explicit)).issue.status).toBe("open");
});

test("a mission whose close failed is finished by the next settle, as one issue with one report", async () => {
  const a = lead(); const parent = await a.plan(["Build the upsilon widget"]);
  failing = args => args[0] === "close" && args.includes("--audit-no-change");
  await a.scout("upsilon-scout", "The layout is flat.");
  expect((await missionsOf(parent)).map((c: any) => c.status)).toEqual(["open"]);
  failing = undefined;
  await a.core.session.stop(a.ctx, []);
  const missions = await missionsOf(parent);
  expect(missions.map((c: any) => c.status)).toEqual(["closed"]);
  expect((await show(qref(missions[0]))).comments).toHaveLength(1);
});

test("a mission close Kata throttles is retried by the settlement timer, with no turn end needed", async () => {
  const a = lead(); const parent = await a.plan(["Build the omega widget"]);
  throttled = args => args[0] === "close" && args.includes("--audit-no-change");
  await a.scout("omega-scout", "The layout is flat.");
  expect((await missionsOf(parent)).map((c: any) => c.status)).toEqual(["open"]);
  throttled = undefined;
  // Only the drain the timer starts closes it: nothing else touches the core meanwhile.
  for (const fire of a.timers.splice(0)) fire();
  await eventually(async () => (await missionsOf(parent)).map((c: any) => c.status), ["closed"]);
});

test("sibling missions close with messages of their own, which Kata's close throttle would refuse as repeats otherwise", async () => {
  const a = lead(); const parent = await a.plan(["Build the kappa gadget"]);
  await a.scout("kappa-one", "First survey.");
  await a.scout("kappa-two", "Second survey.");
  const ids = (await missionsOf(parent)).map((c: any) => c.short_id);
  const messages = (await Promise.all(ids.map(closesOf))).flat().map(event => event.payload.message);
  expect(messages).toHaveLength(2);
  expect(new Set(messages).size).toBe(2);
});

test("a follow-up of an untracked delegate posts its new report on the mission its first run made, even one that repeats the first", async () => {
  const a = lead(); const parent = await a.plan(["Build the phi widget"]);
  await a.scout("phi-scout", "The layout is flat.");
  await a.delegates.apply(a.started("phi-scout", "List the top-level directories of the repository", { agent: "scout" }), NO_JOB);
  await a.delegates.apply({ type: "reported", id: "phi-scout", text: "The layout is flat." }, NO_JOB);
  await a.delegates.apply({ type: "exited", id: "phi-scout", outcome: "completed" }, NO_JOB);
  const missions = await missionsOf(parent);
  expect(missions.map((c: any) => c.status)).toEqual(["closed"]);
  expect((await reportsOf(qref(missions[0]))).map(c => c.body)).toEqual([
    "Report from subagent phi-scout:\n\nThe layout is flat.",
    "Report from subagent phi-scout (after a follow-up):\n\nThe layout is flat.",
  ]);
  expect(a.core.session.owes()).toBe(false);
});

test("a lead resumed before a follow-up's report reached its mission posts it from the saved record", async () => {
  const a = lead(); const parent = await a.plan(["Build the psi widget"]);
  await a.scout("psi-scout", "First pass.");
  await a.delegates.apply(a.started("psi-scout", "List the top-level directories of the repository", { agent: "scout" }), NO_JOB);
  await a.delegates.apply({ type: "reported", id: "psi-scout", text: "Second pass: two more folders." }, NO_JOB);
  failing = args => args[0] === "comment";
  await a.delegates.apply({ type: "exited", id: "psi-scout", outcome: "completed" }, NO_JOB);
  failing = undefined;
  const b = await resume(a);
  await b.view();
  const [mission] = await missionsOf(parent);
  expect((await reportsOf(qref(mission))).map(c => c.body)).toEqual([
    "Report from subagent psi-scout:\n\nFirst pass.",
    "Report from subagent psi-scout (after a follow-up):\n\nSecond pass: two more folders.",
  ]);
});

test("an untracked delegate whose run left no report keeps its untracked note, and a follow-up's report makes its mission", async () => {
  const a = lead(); const parent = await a.plan(["Build the chi widget"]);
  const delegate = a.delegate("chi-scout");
  await a.delegates.apply(a.started("chi-scout", "Survey the unrelated build system"), NO_JOB);
  await a.delegates.apply({ type: "exited", id: "chi-scout", outcome: "completed" }, NO_JOB);
  expect(await missionsOf(parent)).toEqual([]);
  expect(await delegate.assignment()).toContain("no Kata issue");
  expect(await delegate.unassigned()).toContain("matched no plan item or ticket");
  await a.delegates.apply(a.started("chi-scout", "Survey the unrelated build system"), NO_JOB);
  await a.delegates.apply({ type: "reported", id: "chi-scout", text: "Second pass: it is plain make." }, NO_JOB);
  await a.delegates.apply({ type: "exited", id: "chi-scout", outcome: "completed" }, NO_JOB);
  const missions = await missionsOf(parent);
  expect(missions.map((c: any) => c.status)).toEqual(["closed"]);
  expect((await reportsOf(qref(missions[0]))).map(c => c.body)).toEqual(["Report from subagent chi-scout:\n\nSecond pass: it is plain make."]);
});

test("a delegate that ran a tool and exits with its issue open hands it back: comment, needs-human, needs-review, task back to the lead", async () => {
  const a = lead(); const parent = await a.plan(["Build the gamma widget", "Lead step"]);
  const ref = await refOf(parent, "Build the gamma widget");
  await a.delegates.apply(a.started("gamma", "Build the gamma widget"), NO_JOB);
  await a.delegates.apply({ type: "ranTool", id: "gamma" }, NO_JOB);
  await a.delegates.apply({ type: "exited", id: "gamma", outcome: "completed" }, NO_JOB);
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
  const ref = await refOf(parent, "Build the delta widget");
  const before = await show(ref);
  await a.delegates.apply(a.started("delta", "Build the delta widget"), NO_JOB);
  expect((await show(ref)).issue.metadata["omp.subagent_id"]).toBe("delta");
  await a.delegates.apply({ type: "exited", id: "delta", outcome: "ended" }, NO_JOB);
  expectRolledBack(await show(ref), before);
  expect(await a.delegated("Build the delta widget")).toBe(false);
});

test("a delegate that ran a tool is handed back at exit, never rolled back", async () => {
  const a = lead(); const parent = await a.plan(["Build the epsilon widget"]);
  const ref = await refOf(parent, "Build the epsilon widget");
  await a.delegates.apply(a.started("epsilon", "Build the epsilon widget"), NO_JOB);
  await a.delegates.apply({ type: "ranTool", id: "epsilon" }, NO_JOB);
  await a.delegates.apply({ type: "exited", id: "epsilon", outcome: "aborted" }, NO_JOB);
  expect(labels(await show(ref))).toContain("needs-review");
});

test("a failed assignment is a named state; the delegate's next use retries it", async () => {
  const a = lead(); const parent = await a.plan(["Build the zeta widget", "Lead step"]);
  const ref = await refOf(parent, "Build the zeta widget");
  const delegate = a.delegate("zeta");
  failing = args => args[0] === "meta" && args[3] === "omp.subagent_id";
  await a.delegates.apply(a.started("zeta", "Build the zeta widget"), NO_JOB);
  expect(await delegate.assignment()).toBeUndefined();
  expect(await delegate.unassigned()).toContain("delegation service permission denied");
  expect(await a.delegated("Build the zeta widget")).toBe(true);
  failing = undefined;
  await a.delegates.apply({ type: "nextUse", id: "zeta" }, NO_JOB);
  expect(await delegate.assignment()).toContain(ref);
  expect((await show(ref)).issue.metadata["omp.subagent_id"]).toBe("zeta");
});

test("a delegate's next use waits for its own assignment, not for the ones queued behind it", async () => {
  const a = lead(); const parent = await a.plan(["Build the iota widget", "Build the kappa gadget"]);
  const later = await taskOf(parent, "Build the kappa gadget");
  const held = holdKata(args => args.some(arg => arg.includes(later.short_id)));
  holding = held.before;
  const first = a.delegates.apply(a.started("iota", "Build the iota widget"), NO_JOB);
  const second = a.delegates.apply(a.started("kappa-gadget", "Build the kappa gadget"), NO_JOB);
  // Resolves while the later assignment is still held; queued behind it, this call would never return.
  await a.delegates.apply({ type: "nextUse", id: "iota" }, NO_JOB);
  expect(await a.delegate("iota").assignment()).toContain((await taskOf(parent, "Build the iota widget")).short_id);
  held.release();
  await Promise.all([first, second]);
});

test("a next use that joins a still-queued assignment retries it once if that attempt fails", async () => {
  const a = lead(); const parent = await a.plan(["Build the lambda widget", "Lead step"]);
  const task = await taskOf(parent, "Build the lambda widget");
  let failures = 1;
  failing = args => args[0] === "meta" && args[3] === "omp.subagent_id" && failures-- > 0;
  const start = a.delegates.apply(a.started("lambda", "Build the lambda widget"), NO_JOB);
  await a.delegates.apply({ type: "nextUse", id: "lambda" }, NO_JOB);
  await start;
  expect(await a.delegate("lambda").assignment()).toContain(task.short_id);
});

test("a delegate whose assignment failed is handed back when it exits, even with no tool run", async () => {
  const a = lead(); const parent = await a.plan(["Build the eta widget", "Lead step"]);
  const ref = await refOf(parent, "Build the eta widget");
  failing = args => args[0] === "meta" && args[3] === "omp.subagent_id";
  await a.delegates.apply(a.started("eta", "Build the eta widget"), NO_JOB);
  failing = args => args[0] === "label";
  await a.delegates.apply({ type: "exited", id: "eta", outcome: "completed" }, NO_JOB);
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
  const ref = await refOf(parent, "Build the iota widget");
  await a.delegates.apply(a.started("iota", "Build the iota widget"), NO_JOB);
  failing = args => args[0] === "meta" && args[1] === "unset" && args[3] === "omp.status";
  await a.delegates.apply({ type: "exited", id: "iota", outcome: "ended" }, NO_JOB);
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
  const ref = await refOf(parent, "Build the kappa widget");
  await a.delegates.apply(a.started("kappa", "Build the kappa widget"), NO_JOB);
  failing = args => args[0] === "meta" && args[3] === "todo.status";
  await a.delegates.apply({ type: "exited", id: "kappa", outcome: "ended" }, NO_JOB);
  failing = undefined;
  await a.delegates.apply({ type: "nextUse", id: "kappa" }, NO_JOB);
  await a.view();
  const view = await show(ref);
  expect(view.issue.metadata["omp.subagent_id"]).toBe("kappa");
  expect(view.issue.metadata.teammate).toBe("mate-kappa");
  expect(await a.delegated("Build the kappa widget")).toBe(true);
});

const latestSnapshot = (entries: any[]) => entries.filter(e => e.customType === "io.kata.omp.state").at(-1)?.data;
const savedDelegates = (entries: any[]) => latestSnapshot(entries)?.delegates;
const requestsFor = async (ref: string) => (await kata(["inbox", "--for", `lead-actor/${LEAD}`, "--json"])).requests.filter((r: any) => r.ref.endsWith(ref.split("#").pop()!)).length;
// The newest saved snapshot with `change` applied to its first delegate, as a process that died at that point would have left it.
const withSnapshot = (entries: any[], change: (record: any) => void) => {
  const data = structuredClone(latestSnapshot(entries));
  change(data.delegates[0]);
  return [...structuredClone(entries), { type: "custom", customType: "io.kata.omp.state", data }];
};

test("a lead resumed with a delegate's hand back unfinished finishes it: needs-review, needs-human, a request to the lead", async () => {
  const a = lead(); const parent = await a.plan(["Build the xi widget", "Lead step"]);
  const ref = await refOf(parent, "Build the xi widget");
  await a.delegates.apply(a.started("xi", "Build the xi widget"), NO_JOB);
  await a.delegates.apply({ type: "ranTool", id: "xi" }, NO_JOB);
  failing = args => args[0] === "label";
  await a.delegates.apply({ type: "exited", id: "xi", outcome: "completed" }, NO_JOB);
  failing = undefined;
  expect(savedDelegates(a.entries)).toMatchObject([{ id: "xi", ranTool: true, exited: "completed", state: "assigned" }]);
  expect(labels(await show(ref))).not.toContain("needs-review");
  const b = await resume(a);
  // Resuming settles in the background on the lead's queue, so a todo view returns only after the settle is done.
  await b.view();
  const view = await show(ref);
  expect(labels(view)).toContain("needs-review");
  expect(view.issue.metadata).toMatchObject({ teammate: LEAD, "work.attention": "needs-human", "omp.status": "completed" });
  expect(view.issue.metadata["omp.subagent_id"]).toBeUndefined();
  expect(await requestsFor(ref)).toBeGreaterThan(0);
  // Handed back, the record stays saved as ended, for a follow-up that resumes the issue; nothing of it is owed.
  expect(savedDelegates(b.entries)).toMatchObject([{ id: "xi", state: "handed-back" }]);
  expect(b.core.session.owes()).toBe(false);
});

test("a lead resumed before a delegate's report was posted posts it from the saved record", async () => {
  const a = lead(); const parent = await a.plan(["Build the rho gadget", "Lead step"]);
  const ref = await refOf(parent, "Build the rho gadget");
  await a.delegates.apply(a.started("rho-gadget", "Build the rho gadget"), NO_JOB);
  await a.delegates.apply({ type: "ranTool", id: "rho-gadget" }, NO_JOB);
  await a.delegates.apply({ type: "reported", id: "rho-gadget", text: "Built the rho gadget; its tests still fail." }, NO_JOB);
  failing = args => args[0] === "comment";
  await a.delegates.apply({ type: "exited", id: "rho-gadget", outcome: "completed" }, NO_JOB);
  failing = undefined;
  expect(savedDelegates(a.entries)).toMatchObject([{ id: "rho-gadget", report: "Built the rho gadget; its tests still fail." }]);
  const b = await resume(a);
  await b.view();
  expect((await reportsOf(ref)).map(c => c.body)).toEqual(["Report from subagent rho-gadget (it left no comment of its own):\n\nBuilt the rho gadget; its tests still fail."]);
});

test("a lead resumed with a delegate that ran no tool rolls its assignment back", async () => {
  const a = lead(); const parent = await a.plan(["Build the omicron widget", "Lead step"]);
  const ref = await refOf(parent, "Build the omicron widget");
  const before = await show(ref);
  await a.delegates.apply(a.started("omicron", "Build the omicron widget"), NO_JOB);
  failing = args => args[0] === "meta" && args[1] === "unset" && args[3] === "omp.status";
  await a.delegates.apply({ type: "exited", id: "omicron", outcome: "ended" }, NO_JOB);
  failing = undefined;
  expect(savedDelegates(a.entries)).toMatchObject([{ id: "omicron", exited: "ended" }]);
  expect(savedDelegates(a.entries)[0].ranTool).toBeFalsy();
  const b = await resume(a);
  await b.view();
  const view = await show(ref);
  expectRolledBack(view, before);
});

test("a saved delegate with no exit is settled as aborted when the lead is resumed", async () => {
  const a = lead(); const parent = await a.plan(["Build the pi widget", "Lead step"]);
  const ref = await refOf(parent, "Build the pi widget");
  await a.delegates.apply(a.started("pi-w", "Build the pi widget"), NO_JOB);
  await a.delegates.apply({ type: "ranTool", id: "pi-w" }, NO_JOB);
  expect(savedDelegates(a.entries)).toMatchObject([{ id: "pi-w", ranTool: true }]);
  expect(savedDelegates(a.entries)[0].exited).toBeUndefined();
  const b = await resume(a);
  await b.view();
  const view = await show(ref);
  expect(labels(view)).toContain("needs-review");
  expect(view.issue.metadata["omp.status"]).toBe("aborted");
  expect(JSON.stringify(view)).toContain("aborted without closing its Kata issue");
});

test("a fork does not settle the source's delegates", async () => {
  const a = lead(); const parent = await a.plan(["Build the rho widget", "Lead step"]);
  const ref = await refOf(parent, "Build the rho widget");
  await a.delegates.apply(a.started("rho", "Build the rho widget"), NO_JOB);
  await a.delegates.apply({ type: "ranTool", id: "rho" }, NO_JOB);
  const f = await resume(a, { fork: true });
  // A fork that wrongly settled would queue it in the background; the view returns only after that queue.
  await f.view();
  const view = await show(ref);
  expect(labels(view)).not.toContain("needs-review");
  expect(view.issue.metadata).toMatchObject({ teammate: "mate-rho", "omp.subagent_id": "rho", "omp.status": "running" });
  expect(savedDelegates(f.entries.slice(a.entries.length))).toBeUndefined();
});

test("a /tree back to an older snapshot does not settle an already settled delegate again", async () => {
  const a = lead(); const parent = await a.plan(["Build the tau widget", "Lead step"]);
  const ref = await refOf(parent, "Build the tau widget");
  await a.delegates.apply(a.started("tau", "Build the tau widget"), NO_JOB);
  const older = a.entries.length;
  const b = await resume(a);
  await b.view();
  expect(labels(await show(ref))).not.toContain("needs-review");
  // A later holder takes the task; a second rollback or hand back would clear its keys or re-flag it.
  await kata(["assign", ref, "later-actor", "--json"]);
  await heldByAnotherDelegate(ref, "later");
  b.entries.splice(older);
  expect(savedDelegates(b.entries)).toMatchObject([{ id: "tau", state: "assigned" }]);
  // Empty memory again, as if the record had never been held: only the `newSession` check keeps /tree from restoring it.
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
  const ref = await refOf(parent, "Build the upsilon widget");
  const before = await show(ref);
  await a.delegates.apply(a.started("upsilon", "Build the upsilon widget"), NO_JOB);
  // The saved record never reached `assigned`: it has its restore point and binding but no ref.
  const cut = withSnapshot(a.entries, record => { record.state = "started"; delete record.ref; });
  expect(savedDelegates(cut)).toMatchObject([{ id: "upsilon", state: "started" }]);
  const b = await resume(a, { entries: cut });
  await b.view();
  const view = await show(ref);
  expectRolledBack(view, before);
});

test("a new process resuming from an older snapshot leaves an issue a later holder took untouched", async () => {
  const a = lead(); const parent = await a.plan(["Build the phi widget", "Lead step"]);
  const ref = await refOf(parent, "Build the phi widget");
  await a.delegates.apply(a.started("phi", "Build the phi widget"), NO_JOB);
  const older = a.entries.length;
  await a.delegates.apply({ type: "exited", id: "phi", outcome: "ended" }, NO_JOB);
  await kata(["assign", ref, "later-actor", "--json"]);
  await heldByAnotherDelegate(ref, "later", [["omp.session_id", "later-session"]]);
  const notified = await requestsFor(ref);
  // The older snapshot still lists phi as assigned: a settle that finished elsewhere never updated it.
  const c = lead({ entries: a.entries.slice(0, older), id: a.id });
  expect(savedDelegates(c.entries)).toMatchObject([{ id: "phi", state: "assigned" }]);
  await c.core.session.start(c.ctx);
  await c.view();
  const view = await show(ref);
  expect(labels(view)).not.toContain("needs-review");
  expect(await requestsFor(ref)).toBe(notified);
  expect(view.issue.owner).toBe("later-actor");
  expect(view.issue.metadata).toMatchObject({ teammate: "mate-later", "omp.subagent_id": "later", "omp.status": "running", "omp.session_id": "later-session" });
});

test("a started delegate saved before its restore point existed leaves the issue alone on resume", async () => {
  const a = lead(); const parent = await a.plan(["Build the psi widget", "Lead step"]);
  const ref = await refOf(parent, "Build the psi widget");
  await a.delegates.apply(a.started("psi", "Build the psi widget"), NO_JOB);
  // A sibling's save during the first show: the record has its binding but nothing was written or captured yet.
  const cut = withSnapshot(a.entries, record => { record.state = "started"; delete record.ref; delete record.restore; });
  expect(savedDelegates(cut)).toMatchObject([{ id: "psi", state: "started", binding: {} }]);
  // The live assignment ends rolled back, so Kata shows the issue as that unwritten record left it.
  await a.delegates.apply({ type: "exited", id: "psi", outcome: "ended" }, NO_JOB);
  const before = await show(ref);
  expect(before.issue.metadata["omp.subagent_id"]).toBeUndefined();
  const notified = await requestsFor(ref);
  const b = await resume(a, { entries: cut });
  await b.view();
  const view = await show(ref);
  expect(labels(view)).not.toContain("needs-review");
  expect(await requestsFor(ref)).toBe(notified);
  expect(view.issue.metadata).toEqual(before.issue.metadata);
  expect(view.issue.owner).toBe(before.issue.owner);
});

test("a started delegate saved with its restore point leaves an issue another actor claimed since untouched on resume", async () => {
  const a = lead(); const parent = await a.plan(["Build the sigma widget", "Lead step"]);
  const ref = await refOf(parent, "Build the sigma widget");
  // The lead claimed its plan tasks; release this one so the delegate's capture finds it unowned (restore.claimed).
  await kata(["unassign", ref, "--json"]);
  await a.delegates.apply(a.started("sigma", "Build the sigma widget"), NO_JOB);
  // The saved record is cut off before its ref: it has its restore point (issue unowned at capture) and its binding.
  const cut = withSnapshot(a.entries, record => { record.state = "started"; delete record.ref; });
  expect(savedDelegates(cut)).toMatchObject([{ id: "sigma", state: "started", restore: { claimed: true } }]);
  // The live assignment ends rolled back, then someone else claims the issue under another teammate.
  await a.delegates.apply({ type: "exited", id: "sigma", outcome: "ended" }, NO_JOB);
  await kata(["assign", ref, "later-actor", "--json"]);
  await kata(["meta", "set", ref, "teammate", "mate-later", "--json"]);
  const before = await show(ref);
  const b = await resume(a, { entries: cut });
  await b.view();
  const view = await show(ref);
  expect(view.issue.owner).toBe("later-actor");
  expect(view.issue.metadata).toEqual(before.issue.metadata);
  expect(labels(view)).not.toContain("needs-review");
});

test("an assignment saves its restore point before its first write", async () => {
  const a = lead(); await a.plan(["Build the omega widget", "Lead step"]);
  const held = holdKata(args => args[0] === "meta" && args[1] === "set" && args[3] === "teammate");
  holding = held.before;
  const start = a.delegates.apply(a.started("omega", "Build the omega widget"), NO_JOB);
  await held.entered;
  expect(savedDelegates(a.entries)).toMatchObject([{ id: "omega", state: "started", restore: { meta: {} } }]);
  held.release();
  await start;
});

test("a delegate whose issue was deleted settles instead of waiting forever", async () => {
  const a = lead(); const parent = await a.plan(["Build the chi widget", "Lead step"]);
  const ref = await refOf(parent, "Build the chi widget");
  await a.delegates.apply(a.started("chi", "Build the chi widget"), NO_JOB);
  await a.delegates.apply({ type: "ranTool", id: "chi" }, NO_JOB);
  await deleteIssue(ref);
  await a.delegates.apply({ type: "exited", id: "chi", outcome: "completed" }, NO_JOB);
  expect(savedDelegates(a.entries)).toMatchObject([{ id: "chi", state: "settled" }]);
});

test("a delegate that exits with its issue closed leaves it closed and returns it to the lead, so a new plan can retire it", async () => {
  const a = lead(); const parent = await a.plan(["Build the theta widget", "Lead step"]);
  const ref = await refOf(parent, "Build the theta widget");
  await a.delegates.apply(a.started("theta", "Build the theta widget"), NO_JOB);
  await closeByDelegate(ref, "mate-theta");
  await a.delegates.apply({ type: "exited", id: "theta", outcome: "completed" }, NO_JOB);
  const view = await show(ref);
  expect(view.issue.status).toBe("closed");
  expect(labels(view)).not.toContain("needs-review");
  expect(view.issue.metadata).toMatchObject({ teammate: LEAD, "todo.status": "completed", "omp.status": "completed" });
  expect(view.issue.metadata["omp.subagent_id"]).toBeUndefined();
  await a.plan(["Lead step", "Build the eta widget"]);
  const retired = await show(ref);
  expect(retired.issue.status).toBe("closed");
  expect(retired.issue.metadata["todo.removed"]).toBe(true);
});

test("a refused delegate that exits leaves the closed issue of the delegate holding it alone", async () => {
  const a = lead(); const parent = await a.plan(["Build the omicron widget", "Lead step"]);
  const ref = await refOf(parent, "Build the omicron widget");
  await a.delegates.check(["Build the omicron widget"], "rho-call", undefined, NO_JOB);
  // Between the check and the start, another session's delegate takes the task: the holder refuses rho's assignment.
  await heldByAnotherDelegate(ref, "omicron");
  await a.delegates.apply(a.started("rho", "Build the omicron widget", { call: "rho-call" }), NO_JOB);
  expect(await a.delegate("rho").unassigned()).toContain("belongs to a delegate");
  await closeByDelegate(ref, "mate-omicron");
  await a.delegates.apply({ type: "exited", id: "rho", outcome: "failed" }, NO_JOB);
  expect((await show(ref)).issue.metadata).toMatchObject({ teammate: "mate-omicron", "omp.subagent_id": "omicron", "omp.status": "running" });
});

// A fork that reserved the source's task while it was free, before the source's own delegate of that name took it.
async function forkReserving(a: ReturnType<typeof lead>, text: string) {
  const f = lead({ entries: a.entries, id: a.id, fork: true });
  await f.view();
  await f.delegates.check([text], "fork-call", undefined, NO_JOB);
  return f;
}

test("a forked session's refused delegate with the same name leaves the source delegate's closed issue alone", async () => {
  const a = lead(); const parent = await a.plan(["Build the omicron2 widget", "Lead step"]);
  const ref = await refOf(parent, "Build the omicron2 widget");
  const f = await forkReserving(a, "Build the omicron2 widget");
  await a.delegates.apply(a.started("omicron2", "Build the omicron2 widget"), NO_JOB);
  await f.delegates.apply(f.started("omicron2", "Build the omicron2 widget", { teammate: "mate-omicron2-fork", call: "fork-call" }), NO_JOB);
  // The fork's delegate reached the refused state against this issue: it got no assignment.
  expect(await f.delegate("omicron2").assignment()).toBeUndefined();
  await closeByDelegate(ref, "mate-omicron2");
  await f.delegates.apply({ type: "exited", id: "omicron2", outcome: "failed" }, NO_JOB);
  expect((await show(ref)).issue.metadata).toMatchObject({ teammate: "mate-omicron2", "omp.subagent_id": "omicron2", "omp.session_id": a.id, "omp.status": "running" });
});

test("a forked session's refused delegate with the same name leaves the source delegate's open issue alone", async () => {
  const a = lead(); const parent = await a.plan(["Build the omicron3 widget", "Lead step"]);
  const ref = await refOf(parent, "Build the omicron3 widget");
  const f = await forkReserving(a, "Build the omicron3 widget");
  await a.delegates.apply(a.started("omicron3", "Build the omicron3 widget"), NO_JOB);
  await f.delegates.apply(f.started("omicron3", "Build the omicron3 widget", { teammate: "mate-omicron3-fork", call: "fork-call" }), NO_JOB);
  expect(await f.delegate("omicron3").assignment()).toBeUndefined();
  await f.delegates.apply({ type: "ranTool", id: "omicron3" }, NO_JOB);
  await f.delegates.apply({ type: "exited", id: "omicron3", outcome: "failed" }, NO_JOB);
  const view = await show(ref);
  expect(view.issue.status).toBe("open");
  expect(labels(view)).not.toContain("needs-review");
  expect(view.issue.metadata).toMatchObject({ teammate: "mate-omicron3", "omp.subagent_id": "omicron3", "omp.session_id": a.id, "omp.status": "running", "todo.status": "in_progress" });
  expect(Object.keys(view.issue.metadata).filter(k => k.startsWith("notify."))).toEqual([]);
  expect(JSON.stringify(view.comments ?? [])).not.toContain("without closing its Kata issue");
});

test("a delegate that closes its issue as wontfix and exits leaves it abandoned and returned to the lead", async () => {
  const a = lead(); const parent = await a.plan(["Build the sigma widget", "Lead step"]);
  const ref = await refOf(parent, "Build the sigma widget");
  await a.delegates.apply(a.started("sigma", "Build the sigma widget"), NO_JOB);
  await kata(["close", ref, "--wontfix", "--message", "Not needed: the sigma widget is covered by the existing module already.", "--teammate", "mate-sigma", "--json"]);
  await a.delegates.apply({ type: "exited", id: "sigma", outcome: "completed" }, NO_JOB);
  const view = await show(ref);
  expect(view.issue.status).toBe("closed");
  expect(view.issue.metadata).toMatchObject({ teammate: LEAD, "todo.status": "abandoned" });
  expect(view.issue.metadata["omp.subagent_id"]).toBeUndefined();
});

test("a lead with no record of the delegate returns its closed plan item when a new plan replaces the list", async () => {
  const a = lead(); const parent = await a.plan(["Build the tau widget", "Lead step"]);
  const ref = await refOf(parent, "Build the tau widget");
  await a.delegates.apply(a.started("tau", "Build the tau widget"), NO_JOB);
  await closeByDelegate(ref, "mate-tau");
  // The same session resumed: its plan is adopted again, but no record in memory holds the item.
  const b = lead({ entries: a.entries, id: a.id });
  await b.plan(["Lead step", "Build the upsilon widget"]);
  const view = await show(ref);
  expect(view.issue.status).toBe("closed");
  expect(view.issue.metadata).toMatchObject({ teammate: LEAD, "todo.removed": true, "omp.status": "ended", "todo.status": "completed" });
  expect(view.issue.metadata["omp.subagent_id"]).toBeUndefined();
});

test("a closed plan item whose delegate has not exited still refuses a new plan", async () => {
  const a = lead(); const parent = await a.plan(["Build the phi widget", "Lead step"]);
  const ref = await refOf(parent, "Build the phi widget");
  await a.delegates.apply(a.started("phi", "Build the phi widget"), NO_JOB);
  await closeByDelegate(ref, "mate-phi");
  await expect(a.plan(["Lead step", "Build the psi widget"])).rejects.toThrow(/belongs to a delegate/);
  expect((await show(ref)).issue.metadata).toMatchObject({ teammate: "mate-phi", "omp.subagent_id": "phi" });
});

test("starting a closed item a past delegate still marks reopens it on the first call", async () => {
  const a = lead(); const parent = await a.plan(["Build the chi2 widget", "Lead step"]);
  const ref = await refOf(parent, "Build the chi2 widget");
  await a.delegates.apply(a.started("chi2", "Build the chi2 widget"), NO_JOB);
  await closeByDelegate(ref, "mate-chi2");
  const b = lead({ entries: a.entries, id: a.id });
  const result = await b.core.todo.apply(b.ctx, "start", { task: "Build the chi2 widget" }, NO_JOB);
  expect(result.isError, result.content[0].text).toBeFalsy();
  const view = await show(ref);
  expect(view.issue.status).toBe("open");
  expect(view.issue.metadata).toMatchObject({ teammate: LEAD, "todo.status": "in_progress" });
  expect(view.issue.metadata["omp.subagent_id"]).toBeUndefined();
});

const reportsOf = async (ref: string): Promise<{ body: string; teammate?: string }[]> => ((await show(ref)).comments ?? []).filter((c: { body: string }) => c.body.startsWith("Report from subagent"));

test("a delegate handed back without a comment of its own gets its latest report posted under its teammate", async () => {
  const a = lead(); const parent = await a.plan(["Build the lambda gadget", "Lead step"]);
  const ref = await refOf(parent, "Build the lambda gadget");
  await a.delegates.apply(a.started("lambda", "Build the lambda gadget"), NO_JOB);
  await a.delegates.apply({ type: "ranTool", id: "lambda" }, NO_JOB);
  await a.delegates.apply({ type: "reported", id: "lambda", text: "Starting on the gadget." }, NO_JOB);
  await a.delegates.apply({ type: "reported", id: "lambda", text: "Wrote the gadget; its tests fail on the parser, which still needs work." }, NO_JOB);
  await a.delegates.apply({ type: "exited", id: "lambda", outcome: "completed" }, NO_JOB);
  const reports = await reportsOf(ref);
  expect(reports).toHaveLength(1);
  expect(reports[0].body).toContain("its tests fail on the parser");
  expect(reports[0].body).not.toContain("Starting on the gadget");
  expect(reports[0].teammate).toBe("mate-lambda");
  expect((await commentsOf(ref)).join("\n")).toContain("completed without closing its Kata issue");
});

test("a delegate that closed its issue gets its report posted only when it left no comment of its own", async () => {
  const a = lead(); const parent = await a.plan(["Build the mu gadget", "Build the xi gadget", "Lead step"]);
  const mu = await refOf(parent, "Build the mu gadget"), xi = await refOf(parent, "Build the xi gadget");
  await a.delegates.apply(a.started("mu", "Build the mu gadget"), NO_JOB);
  await a.delegates.apply(a.started("xi", "Build the xi gadget"), NO_JOB);
  await kata(["comment", xi, "--body", "Built the xi gadget; its tests pass.", "--teammate", "mate-xi", "--json"]);
  for (const [id, ref] of [["mu", mu], ["xi", xi]]) {
    await closeByDelegate(ref, `mate-${id}`);
    await a.delegates.apply({ type: "reported", id, text: `The ${id} gadget is built and verified.` }, NO_JOB);
    await a.delegates.apply({ type: "exited", id, outcome: "completed" }, NO_JOB);
  }
  expect((await reportsOf(mu)).map(c => c.body)).toEqual(["Report from subagent mu (it left no comment of its own):\n\nThe mu gadget is built and verified."]);
  expect(await reportsOf(xi)).toHaveLength(0);
});

test("an automatic parent stays open while a delegate runs, and closes once it has exited", async () => {
  const a = lead(); const parent = await a.plan(["Build the nu widget"]);
  const ref = await refOf(parent, "Build the nu widget");
  await a.delegates.apply(a.started("nu", "Build the nu widget"), NO_JOB);
  await closeByDelegate(ref, "mate-nu");
  await a.view();
  expect((await show(parent)).issue.status).toBe("open");
  await a.delegates.apply({ type: "exited", id: "nu", outcome: "completed" }, NO_JOB);
  await a.view();
  expect((await show(parent)).issue.status).toBe("closed");
});

test("check refuses a task naming two plan items, an already delegated task, and an unclaimable ticket", async () => {
  const a = lead(); await a.plan(["Build the iota widget", "Build the kappa widget"]);
  await expect(a.delegates.check(['Do "Build the iota widget" and "Build the kappa widget"'], undefined, undefined, NO_JOB)).rejects.toThrow(/names more than one/);
  const [first] = await a.delegates.check(['Complete "Build the iota widget"'], "iota-call", undefined, NO_JOB);
  expect(first.ref).toMatch(/^delegates-test#/);
  await a.delegates.apply(a.started("iota", 'Complete "Build the iota widget"', { call: "iota-call" }), NO_JOB);
  await expect(a.delegates.check(['Complete "Build the iota widget"'], undefined, undefined, NO_JOB)).rejects.toThrow(/already delegated/);
  const foreign = await issue("Someone else's ticket");
  await kata(["claim", foreign, "--as", "someone-else", "--json"]);
  await expect(a.delegates.check([`Work delegates-test#${foreign}`], undefined, undefined, NO_JOB)).rejects.toThrow(/cannot be delegated/);
});

test("check refuses to delegate a ticket that other open plan items name, and allows it once it is the last one", async () => {
  const a = lead();
  const ref = await ticketRef("Shared ticket");
  await a.plan([`${ref}: write the omicron parser`, `${ref}: test the omicron parser`]);
  // The delegate would close the ticket and strand the lead's other item on it.
  await expect(a.delegates.check([`Do "${ref}: test the omicron parser"`], undefined, undefined, NO_JOB)).rejects.toThrow(/other open plan items name it/);
  await expect(a.delegates.check([`Work ${ref}`], undefined, undefined, NO_JOB)).rejects.toThrow(/other open plan items name it/);
  const done = await a.core.todo.apply(a.ctx, "done", { task: `${ref}: write the omicron parser`, message: "Wrote the omicron parser and verified it against the fixture.", evidence: ["test:delegates fixture"] }, NO_JOB);
  expect(done.isError).toBeUndefined();
  expect(await a.delegates.check([`Do "${ref}: test the omicron parser"`], undefined, undefined, NO_JOB)).toEqual([{ ref, ticket: true, title: "test the omicron parser" }]);
  expect(await a.delegates.check([`Work ${ref}`], undefined, undefined, NO_JOB)).toEqual([{ ref, ticket: true, title: "test the omicron parser" }]);
});

test("parallel spawns naming nothing are not refused next to open ticket items, and bind none of them", async () => {
  const a = lead();
  const epic = await ticketRef("Suite epic");
  const ship = await ticketRef("Ship it");
  const init = await a.core.todo.apply(a.ctx, "init", { ref: epic, items: [`${ship}: package, docs and changelog`, `${epic}: full suite, deep-review rounds until clean`] }, NO_JOB);
  expect(init.isError).toBeUndefined();
  expect((await a.core.todo.apply(a.ctx, "start", { task: `${ship}: package, docs and changelog` }, NO_JOB)).isError).toBeUndefined();
  const spawns = ["standards", "spec", "correctness"].map(axis => `${axis} axis. Review the diff against the deep-review rounds so far and report findings.\nReview${axis}`);
  expect((await a.delegates.check(spawns, undefined, undefined, NO_JOB)).map(r => r.ref)).toEqual([undefined, undefined, undefined]);
});

test("a spawn naming a ticket outside the plan is reserved as that ticket and assigned it", async () => {
  const a = lead(); await a.plan(["Build the lambda widget"]);
  const ref = await ticketRef("Outside ticket");
  const [reserved] = await a.delegates.check([`Work ${ref}: write the thing`], "lambda-call", undefined, NO_JOB);
  expect(reserved).toEqual({ ref, ticket: true, title: "Outside ticket" });
  await a.delegates.apply(a.started("lambda", `Work ${ref}`, { call: "lambda-call" }), NO_JOB);
  expect((await show(ref)).issue.metadata["omp.subagent_id"]).toBe("lambda");
  expect(await a.delegate("lambda").assignment()).toContain(ref);
});

test("a delegate naming a ticket outside the plan keeps it when Kata is unreachable for that one read, and is assigned it on its next use", async () => {
  const a = lead(); await a.plan(["Build the xi widget"]);
  const ticket = (await kata(["create", "Outage ticket", "--force-new", "--json"])).issue.short_id, ref = `delegates-test#${ticket}`;
  const delegate = a.delegate("xi");
  unreachable = args => args[0] === "show" && args.includes(ref);
  await a.delegates.apply(a.started("xi", `Work ${ref}`), NO_JOB);
  expect(await delegate.assignment()).toBeUndefined();
  unreachable = undefined;
  await a.delegates.apply({ type: "nextUse", id: "xi" }, NO_JOB);
  expect(await delegate.assignment()).toContain(ref);
  expect((await show(ref)).issue.metadata["omp.subagent_id"]).toBe("xi");
});

test("a delegate refused an issue another delegate holds leaves it with its holder when it exits", async () => {
  const a = lead(); const parent = await a.plan(["Build the mu widget", "Lead step"]);
  const ref = await refOf(parent, "Build the mu widget");
  await a.delegates.check(["Build the mu widget"], "late-call", undefined, NO_JOB);
  // Between the check and the start, another session's delegate takes the task.
  await heldByAnotherDelegate(ref, "mu-holder");
  await a.delegates.apply(a.started("mu-late", "Build the mu widget", { call: "late-call" }), NO_JOB);
  expect(await a.delegate("mu-late").assignment()).toBeUndefined();
  await a.delegates.apply({ type: "exited", id: "mu-late", outcome: "failed" }, NO_JOB);
  const view = await show(ref);
  expect(labels(view)).not.toContain("needs-review");
  expect(view.issue.metadata).toMatchObject({ teammate: "mate-mu-holder", "omp.subagent_id": "mu-holder", "omp.status": "running" });
  expect(JSON.stringify(view)).not.toContain("mu-late");
});

test("a delegate whose assignment failed on an issue another teammate owns writes nothing to it when it exits", async () => {
  const a = lead(); const parent = await a.plan(["Build the nu gadget", "Lead step"]);
  const ref = await refOf(parent, "Build the nu gadget");
  // Another teammate of the lead's actor took the task. No delegate marker says so, so the spawn is not refused up front.
  await kata(["meta", "set", ref, "teammate", "other-mate", "--json"]);
  await a.delegates.apply(a.started("nu-gadget", "Build the nu gadget"), NO_JOB);
  expect(await a.delegate("nu-gadget").unassigned()).toContain("belongs to teammate other-mate");
  await a.delegates.apply({ type: "ranTool", id: "nu-gadget" }, NO_JOB);
  await a.delegates.apply({ type: "reported", id: "nu-gadget", text: "I could not take the task." }, NO_JOB);
  const before = await show(ref), notified = await requestsFor(ref);
  await a.delegates.apply({ type: "exited", id: "nu-gadget", outcome: "completed" }, NO_JOB);
  const view = await show(ref);
  expect(view.issue.metadata).toEqual(before.issue.metadata);
  expect(labels(view)).toEqual(labels(before));
  expect(view.comments ?? []).toEqual(before.comments ?? []);
  expect(await requestsFor(ref)).toBe(notified);
  // Settled: nothing of it is left to save.
  expect(savedDelegates(a.entries)).toBeUndefined();
});

test("a mission is saved with its delegate as soon as it is made, so a resumed lead still closes one whose close Kata refused", async () => {
  const a = lead(); const parent = await a.plan(["Build the xi gadget"]);
  throttled = args => args[0] === "close" && args.includes("--audit-no-change");
  await a.scout("xi-scout", "The layout is flat.");
  throttled = undefined;
  const [open] = await missionsOf(parent);
  expect(open.status).toBe("open");
  expect(savedDelegates(a.entries)).toMatchObject([{ id: "xi-scout", state: "untracked", exited: "completed", mission: { ref: qref(open) } }]);
  expect(a.core.session.owes()).toBe(true);
  // The lead dies before its retry: the resumed one finishes the mission, as one issue with one report.
  const b = await resume(a);
  await b.view();
  const missions = await missionsOf(parent);
  expect(missions.map((c: any) => [c.short_id, c.status])).toEqual([[open.short_id, "closed"]]);
  expect((await reportsOf(qref(open))).map(c => c.body)).toEqual(["Report from subagent xi-scout:\n\nThe layout is flat."]);
  expect(b.core.session.owes()).toBe(false);
});

test("check binds nothing for a spawn naming a blocked item, a plan task or a ticket item", async () => {
  const a = lead();
  const ref = await ticketRef("Blocked ticket");
  await a.plan(["Build the rho gizmo", `${ref}: wire the rho gizmo`]);
  for (const task of ["Build the rho gizmo", `${ref}: wire the rho gizmo`]) {
    expect((await a.core.todo.apply(a.ctx, "block", { task, reason: "Waiting on the vendor's reply about the rho gizmo." }, NO_JOB)).isError).toBeUndefined();
  }
  expect(await a.delegates.check(['Do "Build the rho gizmo"', `Work ${ref}`], undefined, undefined, NO_JOB)).toEqual([{}, {}]);
});

test("a delegate that starts unchecked on a ticket other open items name is untracked, as check refuses it", async () => {
  const a = lead();
  const epic = await ticketRef("Sigma epic");
  expect((await a.core.todo.apply(a.ctx, "init", { ref: epic, items: [`${epic}: write the sigma parser`, `${epic}: test the sigma parser`] }, NO_JOB)).isError).toBeUndefined();
  const text = `Do "${epic}: test the sigma parser"`;
  await expect(a.delegates.check([text], undefined, undefined, NO_JOB)).rejects.toThrow(/other open plan items name it/);
  // No check saw this spawn (todo init and the task call shared a batch): the delegate would close the epic and strand the other item.
  await a.delegates.apply(a.started("sigma-test", text), NO_JOB);
  expect(await a.delegate("sigma-test").assignment()).toContain("no Kata issue");
  expect((await show(epic)).issue.metadata["omp.subagent_id"]).toBeUndefined();
});

test("a delegate that starts unchecked on a ticket another teammate owns is untracked, as check refuses it", async () => {
  const a = lead(); await a.plan(["Build the tau widget"]);
  const foreign = await issue("Tau's ticket");
  await kata(["claim", foreign, "--as", "someone-else", "--json"]);
  await a.delegates.apply(a.started("tau", `Work delegates-test#${foreign}`), NO_JOB);
  expect(await a.delegate("tau").assignment()).toContain("no Kata issue");
});

test("start fills the lead's teammate and the delegate's own, salted by the lead's session", async () => {
  const a = lead(); const parent = await a.plan(["Build the upsilon widget"]);
  await a.delegates.start({ id: "upsilon", sessionId: "upsilon", leadSessionId: a.id, text: "Build the upsilon widget" }, NO_JOB);
  const ref = await refOf(parent, "Build the upsilon widget");
  expect((await show(ref)).issue.metadata).toMatchObject({ teammate: teammateFor("upsilon", a.id), "omp.subagent_id": "upsilon" });
  // The lead's own teammate is what the issue goes back to when the delegate ends without closing it.
  await a.delegates.apply({ type: "ranTool", id: "upsilon" }, NO_JOB);
  await a.delegates.apply({ type: "exited", id: "upsilon", outcome: "completed" }, NO_JOB);
  expect((await show(ref)).issue.metadata.teammate).toBe(LEAD);
});

test("a refusal for a delegated task gives the host's refresh words", async () => {
  const a = lead(undefined, { ...TODO_WORDING, refresh: "Send the list again to refresh." }); await a.plan(["Build the chi widget", "Lead step"]);
  await a.delegates.apply(a.started("chi", "Build the chi widget"), NO_JOB);
  const result = await a.core.todo.apply(a.ctx, "done", { task: "Build the chi widget", message: "Finished the chi widget and checked it with the fixture.", evidence: ["test:delegates fixture"] }, NO_JOB);
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("is delegated. Its subagent must manage and close it. Send the list again to refresh.");
});

test("a long init message titles the automatic parent cut to 120 characters", async () => {
  const a = lead();
  const result = await a.core.todo.apply(a.ctx, "init", { items: ["Build the omega widget"], message: `Omega plan ${"x".repeat(200)}` }, NO_JOB);
  expect(result.isError).toBeUndefined();
  expect((await show(planOf(result).parent!)).issue.title).toHaveLength(120);
});

test("session end does not rely on `this`, so a host may call it detached", async () => {
  const a = lead(); await a.plan(["Build the psi widget"]);
  const { end } = a.core.session;
  expect(typeof await end(a.ctx)).toBe("boolean");
});

test("a check that finishes after its spawn's delegate started still gives the delegate its plan item", async () => {
  const a = lead(); const parent = await a.plan(["Build the sigma widget", "Lead step"]);
  const ref = await refOf(parent, "Build the sigma widget");
  const held = holdNext();
  holding = held.before;
  held.arm();
  const checking = a.delegates.check(["Build the sigma widget"], "sigma-call", undefined, NO_JOB);
  await held.entered;
  // The spawn went on without waiting for its check: the delegate starts, and the check lands its reservation afterwards.
  const starting = a.delegates.apply(a.started("sigma", "Build the sigma widget", { call: "sigma-call" }), NO_JOB);
  held.release();
  await Promise.all([checking, starting]);
  expect(await a.delegate("sigma").assignment()).toContain(ref);
  expect((await show(ref)).issue.metadata["omp.subagent_id"]).toBe("sigma");
});

test("a call released while its check is still running leaves no reservation once the check finishes", async () => {
  const a = lead(); const parent = await a.plan(["Build the upsilon widget", "Lead step"]);
  const ref = await refOf(parent, "Build the upsilon widget");
  const held = holdNext();
  holding = held.before;
  held.arm();
  const checking = a.delegates.check(["Build the upsilon widget"], "upsilon-call", undefined, NO_JOB);
  await held.entered;
  a.delegates.release("upsilon-call");
  held.release();
  await checking;
  const [again] = await a.delegates.check(["Build the upsilon widget"], "upsilon-next", undefined, NO_JOB);
  expect(again).toMatchObject({ ref });
});

test("a delegate's core restores nothing from the saved entries of the session it shares with its lead", async () => {
  const a = lead(); await a.plan(["Build the tau widget", "Lead step"]);
  throttled = args => args[0] === "close";
  await a.core.todo.apply(a.ctx, "done", { task: "Lead step", message: MESSAGE, evidence: EVIDENCE }, NO_JOB);
  throttled = undefined;
  expect(a.core.session.owes()).toBe(true);
  await a.delegates.apply(a.started("tau", "Build the tau widget"), NO_JOB);
  // A host without a session of its own for the delegate (Claude Code) gives its context the lead's id and entries.
  const own = a.core.delegate("tau");
  await own.todo.apply({ cwd, agent: { kind: "sub", id: "tau" }, sessionManager: { getSessionId: () => a.id, getBranch: () => a.entries, getHeader: () => ({}) } }, "view", {}, NO_JOB);
  expect(own.session.owes()).toBe(false);
  expect(a.core.session.owes()).toBe(true);
});
