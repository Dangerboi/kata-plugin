import { beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createKataCore, type Job } from "../core/kata-core";
import { NO_JOB } from "../core/kata-cli";
import { nodePlatform } from "../core/node-host";
import { EVIDENCE, isolatedKata, later, memoryDelegateStore, MESSAGE as message, planOf, planParent, realKata, retryNote, until } from "./kata-fixture";
import { daemonUnavailable, notInitialized, notInitializedBound, notInitializedNoData, notInitializedProject, siblingThrottle } from "./kata-errors";
const { binary, scratch: root, cwd, env, run, text, kata, show, issue, closesOf, deleteIssue, sessionParents } = realKata({ prefix: "reliability", author: "actor-a", project: "reliability-test" });
const outside = path.join(root, "outside"), localProject = path.join(root, "local-project");
mkdirSync(outside); mkdirSync(localProject);
const issueOf = async (ref: string) => (await show(ref)).issue;
let seq = 0;
function app(options: any = {}) {
  const entries: any[] = options.entries || [], calls: string[][] = [], contexts: any[] = [];
  const id = options.sid || `reliability-${++seq}`;
  const ctx = { cwd: options.cwd || cwd, sessionManager: { getSessionId: () => id, getBranch: () => entries } };
  const core = createKataCore({ platform: nodePlatform, contextTimers: ctx => ctx.setTimeout ? { setTimer: ctx.setTimeout, clearTimer: ctx.clearTimer } : undefined, appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    exec: async (_file, args, opts) => { calls.push(args); contexts.push(opts.ctx); return await options.before?.(args) ?? run(args, opts.cwd); }, delegateStore: memoryDelegateStore(), isMain: options.isMain,
  }, { namespace: "omp", executable: binary, executableVars: ["KATA_OMP_EXECUTABLE"], explicitRef: () => options.ref });
  return { core, calls, contexts, entries, ctx, call: (p: any, job: Job = NO_JOB) => core.todo.apply(ctx, p.op, p, job) };
}
// Kata unusable: the only case that selects a local plan.
const down = daemonUnavailable;
const done = { op: "done", message, evidence: EVIDENCE };
async function init(a: ReturnType<typeof app>, items = ["First", "Second"], options: { replace?: true } = {}) {
  const r = await a.call({ op: "init", items, ...options }); if (r.isError) throw new Error(r.content[0].text); return planOf(r).parent!;
}
// The plan as a todo result reports it, and a plan task's qualified ref as Kata knows it.
const tasksOf = (result: any): { content: string; status: string; blocker?: string }[] => result.details.kata.phases.flatMap((p: any) => p.tasks);
async function child(parent: string, title: string) { return `${parent.split("#")[0]}#${(await show(parent)).children.find((c: any) => c.title === title).short_id}`; }
beforeAll(async () => { await text(["init", "--project", "local-reliability"], localProject); });

// V2 requires real Kata evidence even when a project name starts with local-.
test("local-prefixed projects still require Kata completion evidence", async () => {
  const a = app({ cwd: localProject }); const parent = await init(a);
  const ref = await child(parent, "First");
  expect((await a.call({ op: "done", task: "First" })).isError).toBe(true);
  expect((await issueOf(ref)).status).toBe("open");
  expect((await issueOf(parent)).status).toBe("open");
});
test("ambiguous recovered local identities are rejected without replacing tasks", async () => {
  const a = app({ cwd: outside, before: down }); await init(a, ["Repeated"]);
  const saved = a.entries.filter(e => e.customType === "io.kata.omp.state").at(-1).data;
  saved.plan.tasks.push({ ...saved.plan.tasks[0] });
  const b = app({ cwd: outside, before: down, entries: a.entries, sid: a.ctx.sessionManager.getSessionId() });
  const result = await b.call({ op: "append", items: ["Repeated"] });
  expect(result.isError).toBe(true);
  expect(tasksOf(await b.call({ op: "view" }))).toHaveLength(2);
});

for (const op of ["done", "drop", "rm"]) test(`${op} preserves foreign ownership and all issue state`, async () => {
  const a = app(); const ref = await child(await init(a), "First");
  await kata(["claim", ref, "--as", "actor-b", "--force", "--json"]);
  const before = await issueOf(ref);
  expect((await a.call({ ...done, op, task: "First" })).isError).toBe(true);
  expect(await issueOf(ref)).toEqual(before);
});
test("a final status write cannot overwrite a concurrent teammate handoff", async () => {
  let ref = "", armed = false;
  const a = app({ before: async (args: string[]) => {
    if (armed && args[0] === "meta" && args[1] === "set" && args[2] === ref && args[3] === "todo.status") {
      armed = false; await kata(["meta", "set", ref, "teammate", "other", "--json"]);
    }
  } });
  ref = await child(await init(a), "First"); armed = true;
  expect((await a.call({ op: "block", task: "First", reason: "waiting" })).isError).toBe(true);
  const state = await issueOf(ref); expect(state.metadata.teammate).toBe("other"); expect(state.metadata["todo.status"]).toBe("in_progress");
});
test("a delegate marker added during claim preserves the active task", async () => {
  let ref = "";
  const a = app({ before: async (args: string[]) => {
    if (args[0] === "claim" && args[1] === ref) {
      const claimed = await run(args);
      await kata(["meta", "set", ref, "omp.subagent_id", "new-worker", "--json"]);
      return claimed;
    }
  } });
  const p = await init(a); const active = await child(p, "First"); ref = await child(p, "Second");
  const before = await issueOf(active);
  expect((await a.call({ op: "start", task: "Second" })).isError).toBe(true);
  expect(await issueOf(active)).toEqual(before);
  const delegated = await issueOf(ref);
  expect(delegated.metadata["omp.subagent_id"]).toBe("new-worker");
  expect(delegated.metadata["todo.status"]).toBe("pending");
});
test("init rejects blank input before retiring existing tasks", async () => {
  const a = app(); const ref = await child(await init(a), "Second"), before = await issueOf(ref);
  expect((await a.call({ op: "init", items: ["First", "   "] })).isError).toBe(true);
  expect(await issueOf(ref)).toEqual(before);
});
// `--json` is a flag the core itself appends to its calls.
test("a plan or task title that reads like a flag is data, not a Kata option", async () => {
  const a = app(); const r = await a.call({ op: "init", message: "--json", items: ["--json"] });
  expect(r.isError).toBeUndefined();
  expect(tasksOf(r).map(t => t.content)).toEqual(["--json"]);
  const parent = await show(planParent(r));
  expect(parent.issue.title).toBe("--json");
  expect(parent.children[0].title).toBe("--json");
});
test("a conflicting explicit binding is refused before either plan changes", async () => {
  const a = app(); const p = await init(a); const b = app(); const q = await init(b, ["Other"]);
  const bound = app({ ref: p }); await bound.call({ op: "view" });
  const before = await show(p);
  expect((await bound.call({ op: "init", ref: q, items: ["Replacement"] })).isError).toBe(true);
  expect(await show(p)).toEqual(before);
});
test("qualified full UID and short ref restore the same removed child", async () => {
  // One session throughout: another session's replace may not drop the task this session started.
  const sid = "reliability-replay";
  const a = app({ sid }); const p = await init(a); const uid = (await issueOf(p)).uid;
  const b = app({ sid, ref: `reliability-test#${uid.toLowerCase()}` });
  const first = await child(await init(b, ["Replay"], { replace: true }), "Replay");
  await b.call({ op: "rm", task: "Replay" });
  const c = app({ sid, ref: p }); await init(c, ["Replay"]);
  expect(await child(p, "Replay")).toBe(first);
});
for (const failure of ["marker", "claim"]) test(`automatic parent setup recovers after failed ${failure}`, async () => {
  let once = true;
  const a = app({ before: (args: string[]) => {
    if (once && (failure === "marker" ? args[0] === "meta" && args[3] === "omp.auto_parent" : args[0] === "claim")) {
      once = false; return { code: 1, stdout: "", stderr: "transport interrupted" };
    }
  } });
  expect((await a.call({ op: "init", items: ["Recovered"] })).isError).toBe(true);
  const p = await init(a, ["Recovered"]);
  const state = await issueOf(p); expect(state.owner).toBe("actor-a"); expect(state.metadata["work.attention"]).toBe("ok");
});
for (const status of ["pending", "in_progress", "completed", "blocked"]) test(`local append reuses a ${status} task without losing state`, async () => {
  const a = app({ cwd: outside, before: down }); await init(a, ["Anchor", "Repeated"]);
  if (status === "in_progress") await a.call({ op: "start", task: "Repeated" });
  if (status === "completed") await a.call({ op: "done", task: "Repeated" });
  if (status === "blocked") await a.call({ op: "block", task: "Repeated", reason: "Retained blocker" });
  const appended = tasksOf(await a.call({ op: "append", items: ["Repeated", "Repeated"] }));
  expect(appended).toHaveLength(2);
  const task = appended.find(t => t.content === "Repeated")!;
  expect(task.status).toBe(status);
  expect(task.blocker).toBe(status === "blocked" ? "Retained blocker" : undefined);
});
test("a local plan resumes with its tasks after a failed bind, and the view clears the error", async () => {
  const a = app({ cwd: outside, before: down }); await init(a);
  await a.call({ op: "block", task: "Second", reason: "Retained wait" });
  // Kata answers with a failure that is not an outage: the resumed session cannot bind, so its snapshot carries the error.
  const refused = { code: 1, stdout: "", stderr: '{"error":{"kind":"internal","code":"internal","message":"transient bind failure","exit_code":1}}\n' };
  const failed = app({ cwd: outside, before: (args: string[]) => args[0] === "list" ? refused : undefined, entries: a.entries, sid: a.ctx.sessionManager.getSessionId() });
  expect((await failed.call({ op: "view" })).isError).toBe(true);
  const b = app({ cwd: outside, before: down, entries: a.entries, sid: a.ctx.sessionManager.getSessionId() });
  const view = await b.call({ op: "view" });
  expect(view.content[0].text).toContain("Session-local");
  expect(view.content[0].text).not.toContain("transient bind failure");
  expect(tasksOf(view)).toHaveLength(2);
  expect(tasksOf(view).find(t => t.content === "Second")?.blocker).toBe("Retained wait");
});
test("automatic parent refuses foreign owner after children close", async () => {
  const a = app(); const p = await init(a, ["Only"]);
  await kata(["claim", p, "--as", "actor-b", "--force", "--json"]); const before = await issueOf(p);
  await a.call({ ...done, task: "Only" }); expect(await issueOf(p)).toEqual(before);
});
test("a deferred removal is invalidated when init keeps the task", async () => {
  let throttle = true;
  const a = app({ before: (args: string[]) => args[0] === "close" && throttle ? siblingThrottle() : undefined });
  const p = await init(a); const ref = await child(p, "First");
  await a.call({ op: "rm", task: "First" });
  await init(a);
  throttle = false;
  // Resume after the retry deadline without sleeping.
  await later(async () => { await app({ entries: a.entries, sid: a.ctx.sessionManager.getSessionId() }).call({ op: "view" }); });
  expect((await issueOf(ref)).status).toBe("open"); expect((await issueOf(ref)).metadata["todo.removed"]).not.toBe(true);
  expect((await issueOf(p)).status).toBe("open");
});

for (const op of ["init", "append"]) test(`kept ${op} preserves a promised completion through restored retry`, async () => {
  let throttle = true;
  const a = app({ before: (args: string[]) => args[0] === "close" && args.includes("--done") && throttle
    ? siblingThrottle() : undefined });
  const ref = await child(await init(a), "First");
  expect((await a.call({ ...done, task: "First" })).isError).toBeUndefined();
  expect((await a.call({ op, items: op === "init" ? ["First", "Second"] : ["First"] })).isError).toBeUndefined();
  throttle = false;
  await later(async () => { await app({ entries: a.entries, sid: a.ctx.sessionManager.getSessionId() }).call({ op: "view" }); });
  const state = await issueOf(ref);
  expect(state.status).toBe("closed");
  expect(state.closed_reason).toBe("done");
});

test("rm leaves a foreign closed task unchanged", async () => {
  const a = app(); const ref = await child(await init(a), "Second");
  await kata(["claim", ref, "--as", "actor-b", "--force", "--json"]);
  await kata(["close", ref, "--done", "--message", message, "--test", "foreign proof", "--json"]);
  const before = await issueOf(ref);
  expect((await a.call({ op: "rm", task: "Second" })).isError).toBe(true);
  expect(await issueOf(ref)).toEqual(before);
});
test("starting foreign work does not demote the current task", async () => {
  const a = app(); const p = await init(a); const first = await child(p, "First"), second = await child(p, "Second");
  await kata(["claim", second, "--as", "actor-b", "--force", "--json"]);
  const before = await issueOf(first);
  expect((await a.call({ op: "start", task: "Second" })).isError).toBe(true);
  expect(await issueOf(first)).toEqual(before);
});
test("numeric creation times choose the earliest pending task", async () => {
  let reorder = false;
  const a = app({ before: async (args: string[]) => {
    if (!reorder || args[0] !== "show") return;
    const out = await run(args); if (out.code) return out;
    const data = JSON.parse(out.stdout);
    const times: Record<string, string> = { First: "2026-10-26T01:02:03Z", Second: "2026-10-26T01:02:03.6Z", Third: "2026-10-26T01:02:03.65Z" };
    for (const child of data.children || []) child.created_at = times[child.title];
    return { ...out, stdout: JSON.stringify(data) };
  } });
  await init(a, ["First", "Second", "Third"]);
  await a.call({ op: "block", task: "First", reason: "wait" });
  await a.call({ op: "block", task: "Second", reason: "wait" });
  await a.call({ op: "block", task: "Third", reason: "wait" });
  reorder = true;
  expect(tasksOf(await a.call({ op: "view" })).map(t => t.content)).toEqual(["First", "Second", "Third"]);
});
test("bounded audit still closes with the exact current evidence union", async () => {
  let bounded = false;
  const a = app({ before: (args: string[]) => {
    if (args[0] === "audit") { bounded = args.includes("--since"); if (!bounded) return { code: 1, stderr: "unbounded audit rejected", stdout: "" }; }
  } });
  const p = await init(a);
  await a.call({ ...done, task: "First", evidence: ["test:first accepted proof"] });
  await a.call({ ...done, task: "Second", evidence: ["test:second accepted proof"] });
  expect((await issueOf(p)).status).toBe("closed");
  const [close] = await closesOf(p);
  expect(close.payload.evidence.toSorted((a: any, b: any) => a.command.localeCompare(b.command))).toEqual([{ type: "test", command: "first accepted proof" }, { type: "test", command: "second accepted proof" }]);
});

test("authenticated daemon actor can create and complete a plan despite local actor mismatch", async () => {
  const authRoot = mkdtempSync(path.join(root, "auth-"));
  const authHome = path.join(authRoot, "home"), authCwd = path.join(authRoot, "workspace");
  mkdirSync(authHome); mkdirSync(authCwd);
  const tokenFile = path.join(authRoot, "token");
  const bootstrapFile = path.join(authRoot, "bootstrap");
  writeFileSync(bootstrapFile, "isolated-bootstrap-only", { mode: 0o600 });
  writeFileSync(tokenFile, "isolated-bootstrap-only", { mode: 0o600 });
  writeFileSync(path.join(authHome, "config.toml"), `[auth]\ntoken_file = ${JSON.stringify(bootstrapFile)}\nrequire_token_identity = true\n`);
  const authEnv = { ...env, KATA_HOME: authHome, KATA_AUTH_TOKEN_FILE: tokenFile };
  const authRun = isolatedKata(binary, authEnv, authCwd);
  try {
    const issued = await authRun(["tokens", "create", "--actor", "token-actor", "--json"]); if (issued.code) throw new Error(issued.stderr);
    const token = JSON.parse(issued.stdout).plaintext; expect(typeof token).toBe("string");
    writeFileSync(tokenFile, token, { mode: 0o600 });
    const setup = await authRun(["init", "--project", "authenticated-fixture"]); if (setup.code) throw new Error(setup.stderr);
    const ref = JSON.parse((await authRun(["create", "Token actor plan", "--json"])).stdout).issue.short_id;
    const status = JSON.parse((await authRun(["status", ref, "--json"])).stdout); expect(status.actor).toBe("token-actor");
    const core = createKataCore({ platform: nodePlatform, appendEntry() {}, exec: (_file, args) => authRun(args), delegateStore: memoryDelegateStore() }, { namespace: "omp", executable: binary, executableVars: ["KATA_OMP_EXECUTABLE"], explicitRef: () => ref });
    const ctx = { cwd: authCwd, sessionManager: { getSessionId: () => "auth-fixture", getBranch: () => [] } };
    const initialized = await core.todo.apply(ctx, "init", { items: ["Authenticated task"] }, NO_JOB);
    expect(initialized.isError, initialized.content[0].text).toBeUndefined();
    expect((await core.todo.apply(ctx, "done", { ...done, task: "Authenticated task" }, NO_JOB)).isError).toBeUndefined();
    const parent = planParent(initialized);
    const taskId = JSON.parse((await authRun(["show", parent, "--json"])).stdout).children[0].short_id;
    const child = JSON.parse((await authRun(["show", `${parent.split("#")[0]}#${taskId}`, "--json"])).stdout).issue;
    expect(child.status).toBe("closed"); expect(child.owner).toBe("token-actor");
  } finally { await authRun(["daemon", "stop"]); }
});

// The agent's own `kata claim` of another issue makes that issue the plan parent. The result is read through a view: adoption runs in the session queue.
const claimed = (a: ReturnType<typeof app>, ref: string) => a.core.tools.result(a.ctx, { toolName: "bash", input: { command: `kata claim ${ref}` }, details: { exitCode: 0 } });
test("adoption leaves a populated automatic parent's relationship unchanged", async () => {
  const a = app(); const old = await init(a); const b = app(); const next = await init(b, ["Elsewhere"]);
  const before = await issueOf(old);
  await claimed(a, next);
  expect(planParent(await a.call({ op: "view" }))).toBe(next);
  expect(await issueOf(old)).toEqual(before);
});
test("adoption refuses a foreign empty automatic parent", async () => {
  const a = app(); const old = (await a.core.tools.call(a.ctx, { startsChild: true })).parent!;
  await kata(["claim", old, "--as", "actor-b", "--force", "--json"]);
  const next = `reliability-test#${await issue("Adoption destination")}`;
  await kata(["claim", next, "--json"]);
  const before = await issueOf(old);
  await claimed(a, next);
  expect(planParent(await a.call({ op: "view" }))).toBe(old);
  expect(await issueOf(old)).toEqual(before);
});

test("blank append leaves a completed automatic parent closed", async () => {
  const a = app(); const p = await init(a, ["Complete first"]);
  await a.call({ ...done, task: "Complete first" });
  const before = await issueOf(p); expect(before.status).toBe("closed");
  expect((await a.call({ op: "append", items: ["  "] })).isError).toBe(true);
  expect(await issueOf(p)).toEqual(before);
});

// Current membership, not the parent recorded at close time, determines the union.
test("bounded evidence lookup includes a reparented closed child", async () => {
  const a = app(); const p = await init(a, ["Current child"]);
  const other = await issue("Previous parent");
  const child = await issue("Reparented proof", { parent: other });
  await kata(["close", child, "--done", "--message", message, "--test", "reparented verification", "--json"]);
  await kata(["edit", child, "--parent", p, "--json"]);
  expect((await a.call({ ...done, task: "Current child" })).isError).toBeUndefined();
  expect((await issueOf(p)).status).toBe("closed");
});
for (const corrupt of ["reset", "uid", "time", "evidence"]) test(`parent remains open when current child evidence has invalid ${corrupt}`, async () => {
  const a = app({ before: async (args: string[]) => {
    if (args[0] !== "events") return;
    const out = await run(args); const data = JSON.parse(out.stdout);
    if (corrupt === "reset") data.reset_required = true;
    else if (corrupt === "uid") data.events[0].issue_uid = "foreign-child";
    else if (corrupt === "time") data.events[0].payload.closed_at = "2000-01-01T00:00:00Z";
    else data.events[0].payload.evidence = [{ type: "test" }];
    return { ...out, stdout: JSON.stringify(data) };
  } });
  const p = await init(a, ["Proof to validate"]);
  await a.call({ ...done, task: "Proof to validate" });
  const parent = await show(p);
  expect(parent.issue.status).toBe("open");
  expect(parent.labels.some((label: any) => label.label === "needs-review")).toBe(true);
});
for (const op of ["done", "drop", "rm"]) test(`${op} preserves another delegate's marker even with the same teammate`, async () => {
  const a = app(); const ref = await child(await init(a), "First");
  await kata(["meta", "set", ref, "omp.subagent_id", "other-session-worker", "--json"]);
  const before = await issueOf(ref);
  expect((await a.call({ ...done, op, task: "First" })).isError).toBe(true);
  expect(await issueOf(ref)).toEqual(before);
});

test("throttled First completion survives starting Second and retry drain", async () => {
  let throttle = true;
  const a = app({ before: (args: string[]) => args[0] === "close" && throttle ? siblingThrottle() : undefined });
  const p = await init(a);
  const first = await child(p, "First");
  const completion = await a.call({ ...done, task: "First" });
  expect(completion.isError).toBeUndefined();
  expect(completion.content[0].text).toContain(retryNote);
  const started = await a.call({ op: "start", task: "Second" });
  expect(started.isError).toBeUndefined();
  throttle = false;
  await later(async () => { await app({ entries: a.entries, sid: a.ctx.sessionManager.getSessionId() }).call({ op: "view" }); });
  const actual = await issueOf(first);
  expect(actual.status).toBe("closed");
  expect(actual.metadata["todo.status"]).toBe("completed");
  expect((await issueOf(await child(p, "Second"))).metadata["todo.status"]).toBe("in_progress");
});

for (const invalid of ["missing proof", "short message"]) test(`rejected done with ${invalid} preserves its promised close`, async () => {
  let throttle = true;
  const a = app({ before: (args: string[]) => args[0] === "close" && throttle
    ? siblingThrottle() : undefined });
  const ref = await child(await init(a), "First");
  const promised = await a.call({ ...done, task: "First" });
  expect(promised.isError).toBeUndefined();
  expect(promised.content[0].text).toContain(retryNote);
  const refused = await a.call({ ...done, task: "First", ...(invalid === "missing proof" ? { evidence: [] } : { message: "short" }) });
  expect(refused.isError).toBe(true);
  throttle = false;
  await later(async () => { await app({ entries: a.entries, sid: a.ctx.sessionManager.getSessionId() }).call({ op: "view" }); });
  const actual = await issueOf(ref);
  expect(actual.status).toBe("closed");
  expect(actual.metadata["todo.status"]).toBe("completed");
});

test("invalid typed proof preserves an unowned task", async () => {
  const a = app(); const ref = await child(await init(a), "Second"), before = await issueOf(ref);
  expect(before.owner).toBeFalsy();
  expect((await a.call({ ...done, task: "Second", evidence: ["bogus"] })).isError).toBe(true);
  expect(await issueOf(ref)).toEqual(before);
});
test("an unclaimed pending task can retire, re-add and complete without being claimed", async () => {
  const a = app(); const p = await init(a); const ref = await child(p, "Second");
  expect((await issueOf(ref)).owner).toBeFalsy();
  expect((await a.call({ op: "drop", task: "Second", message: "This planned task is no longer needed." })).isError).toBeUndefined();
  expect((await issueOf(ref)).owner).toBeFalsy();
  expect((await a.call({ op: "rm", task: "Second" })).isError).toBeUndefined();
  expect((await a.call({ op: "append", items: ["Second"] })).isError).toBeUndefined();
  expect(await child(p, "Second")).toBe(ref);
  expect((await issueOf(ref)).status).toBe("open");
  expect((await issueOf(ref)).owner).toBeFalsy();
  expect((await a.call({ ...done, task: "Second" })).isError).toBeUndefined();
  const final = await issueOf(ref);
  expect(final.status).toBe("closed");
  expect(final.owner).toBeFalsy();
  expect(final.metadata["todo.status"]).toBe("completed");
});
test("matching qualified init resolves a short explicit binding in its pinned workspace", async () => {
  const origin = app(); const parent = await init(origin), short = parent.split("#")[1];
  const bound = app({ ref: short }); await init(bound);
  bound.ctx.cwd = outside;
  const result = await bound.call({ op: "init", ref: parent, items: ["First", "Second"] });
  expect(result.isError, result.content[0].text).toBeUndefined();
  expect(planParent(result)).toBe(parent);
});
for (const outcome of ["interrupted", "unrelated", "reassigned"]) test(`deferred removal handles an ${outcome} close without hiding newer work`, async () => {
  let throttle = true;
  const a = app({ before: (args: string[]) => args[0] === "close" && throttle
    ? siblingThrottle() : undefined });
  const ref = await child(await init(a), "First");
  const removed = await a.call({ op: "rm", task: "First" });
  expect(removed.isError).toBeUndefined();
  expect(removed.content[0].text).toContain(retryNote);
  throttle = false;
  let interrupted = false, newer: any;
  if (outcome === "unrelated") {
    await kata(["close", ref, "--wontfix", "--message", "Another instruction retired this task independently after reviewing the outstanding work.", "--json"]);
    newer = await issueOf(ref);
  }
  const b = app({ entries: a.entries, sid: a.ctx.sessionManager.getSessionId(), before: async (args: string[]) => {
    if (args[0] === "close" && args[1] === ref && outcome !== "unrelated" && !interrupted) {
      const result = await run(args); expect(result.code).toBe(0); interrupted = true;
      if (outcome === "reassigned") {
        await kata(["meta", "set", ref, "teammate", "new-worker", "--json"]);
        newer = await issueOf(ref);
      }
      return { code: 1, stdout: "", stderr: "response interrupted after accepted close" };
    }
  } });
  await later(async () => { await b.call({ op: "view" }); });
  expect(interrupted).toBe(outcome !== "unrelated");
  await later(async () => { await b.call({ op: "view" }); });
  const final = await issueOf(ref);
  expect(final.status).toBe("closed");
  expect(final.metadata["todo.removed"]).not.toBe(true);
  if (outcome === "interrupted") {
    expect((await b.call({ op: "rm", task: "First" })).isError).toBeUndefined();
    expect((await issueOf(ref)).metadata["todo.removed"]).toBe(true);
  } else expect(final).toEqual(newer);
  expect(tasksOf(await b.call({ op: "view" })).some(t => t.content === "First")).toBe(outcome !== "interrupted");
});

test("rejected append preserves a completed automatic parent and its foreign child", async () => {
  const a = app(); const parent = await init(a, ["Foreign closed"]), ref = await child(parent, "Foreign closed");
  await kata(["claim", ref, "--as", "actor-b", "--force", "--json"]);
  await kata(["close", ref, "--done", "--message", message, "--test", "foreign accepted proof", "--json"]);
  await a.call({ op: "view" });
  const before = await issueOf(parent), childBefore = await issueOf(ref);
  expect(before.status).toBe("closed");
  expect((await a.call({ op: "append", items: ["Foreign closed"] })).isError).toBe(true);
  expect(await issueOf(parent)).toEqual(before);
  expect(await issueOf(ref)).toEqual(childBefore);
});
for (const [name, title] of [
  ["qualified lowercase UID", "First"],
  ["verbatim UID-shaped title", "00000000000000000000000000"],
  ["verbatim title ending in #UID", "Follow up kata#00000000000000000000000000"],
]) test(`${name} selects the same task as its short reference`, async () => {
  const a = app(); const ref = await child(await init(a, [title, "Second"]), title), issue = await issueOf(ref);
  const result = await a.call({ ...done, task: title === "First" ? `reliability-test#${issue.uid.toLowerCase()}` : title });
  expect(result.isError, result.content[0].text).toBeUndefined();
  expect((await issueOf(ref)).status).toBe("closed");
});
for (const [kind, proof] of [["missing", undefined], ["empty", []], ["empty paths", [{ type: "reviewed-paths", paths: [] }]]]) {
  test(`valid sibling proof cannot hide ${kind} child evidence`, async () => {
    let corruptUID = "";
    const a = app({ before: async (args: string[]) => {
      if (args[0] !== "events") return;
      const out = await run(args), data = JSON.parse(out.stdout);
      if (data.events?.[0]?.issue_uid === corruptUID) data.events[0].payload.evidence = proof;
      return { ...out, stdout: JSON.stringify(data) };
    } });
    const parent = await init(a); corruptUID = (await issueOf(await child(parent, "First"))).uid;
    expect((await a.call({ ...done, task: "First" })).isError).toBeUndefined();
    expect((await a.call({ ...done, task: "Second" })).isError).toBeUndefined();
    const final = await show(parent);
    expect(final.children.every((child: any) => child.status === "closed")).toBe(true);
    expect(final.issue.status).toBe("open");
    expect(final.labels.some((label: any) => label.label === "needs-review")).toBe(true);
  });
}
test("refused replacement leaves every previous task unchanged", async () => {
  const a = app(); const p = await init(a); const first = await child(p, "First"), second = await child(p, "Second");
  await kata(["claim", second, "--as", "actor-b", "--force", "--json"]);
  const before = await issueOf(first), foreign = await issueOf(second);
  expect((await a.call({ op: "init", items: ["Replacement"] })).isError).toBe(true);
  expect(await issueOf(first)).toEqual(before);
  expect(await issueOf(second)).toEqual(foreign);
});
test("refused replacement retains a previously promised completion", async () => {
  let throttle = true;
  const a = app({ before: (args: string[]) => args[0] === "close" && args.includes("--done") && throttle
    ? siblingThrottle() : undefined });
  const p = await init(a); const first = await child(p, "First"), second = await child(p, "Second");
  expect((await a.call({ ...done, task: "First" })).isError).toBeUndefined();
  await kata(["claim", second, "--as", "actor-b", "--force", "--json"]);
  const foreign = await issueOf(second);
  expect((await a.call({ op: "init", items: ["First"] })).isError).toBe(true);
  throttle = false;
  await later(async () => { await app({ entries: a.entries, sid: a.ctx.sessionManager.getSessionId() }).call({ op: "view" }); });
  expect((await issueOf(first)).status).toBe("closed");
  expect(await issueOf(second)).toEqual(foreign);
});

// Kata's error codes and exit codes decide the branch; the wording around them may change.
const reworded = <F extends { stderr: string }>(failure: F, from: string, to: string): F => ({ ...failure, stderr: failure.stderr.replace(from, to) });
test("an unreachable daemon is recognised by its code, whatever the message says", async () => {
  const a = app({ cwd: outside, before: () => reworded(daemonUnavailable(), "selected daemon is unavailable while connecting", "kata could not reach its server") });
  const r = await a.call({ op: "init", items: ["Offline by code"] });
  expect(r.isError).toBeUndefined();
  expect(r.content[0].text).toContain("Session-local");
});
test("outage wording on a failure Kata gave another code is an error, not a local plan", async () => {
  const a = app({ cwd: outside, before: () => ({ code: 1, stdout: "", stderr: '{"error":{"kind":"internal","code":"internal","message":"connection refused by upstream hook; dial tcp daemon unreachable","exit_code":1}}\n' }) });
  const r = await a.call({ op: "init", items: ["Not offline"] });
  expect(r.isError).toBe(true);
  expect(r.content[0].text).not.toContain("Session-local");
});
test("a throttled close is deferred by its code, whatever the message says", async () => {
  const a = app({ before: (args: string[]) => args[0] === "close" ? reworded(siblingThrottle(), "sibling-close throttle", "too fast") : undefined });
  const ref = await child(await init(a), "First");
  const r = await a.call({ ...done, task: "First" });
  expect(r.isError).toBeUndefined();
  expect(r.content[0].text).toContain(retryNote);
  expect((await issueOf(ref)).status).toBe("open");
});
test("a throttled close is deferred when Kata prints a warning line before the envelope", async () => {
  // Kata 0.21 with close transcripts on and no session prints this line ahead of the JSON error.
  const warned = () => { const t = siblingThrottle(); return { ...t, stderr: `close: transcript: current session unavailable or invalid; skipping attachment\n${t.stderr}` }; };
  const a = app({ before: (args: string[]) => args[0] === "close" ? warned() : undefined });
  const ref = await child(await init(a), "First");
  const r = await a.call({ ...done, task: "First" });
  expect(r.isError).toBeUndefined();
  expect(r.content[0].text).toContain(retryNote);
  expect((await issueOf(ref)).status).toBe("open");
});
test("throttle wording on a close Kata refused for another reason is an error, not a deferral", async () => {
  const a = app({ before: (args: string[]) => args[0] === "close" ? { code: 1, stdout: "", stderr: '{"error":{"kind":"internal","code":"internal","message":"sibling-close throttle: too many closes","exit_code":1}}\n' } : undefined });
  await init(a);
  const r = await a.call({ ...done, task: "First" });
  expect(r.isError).toBe(true);
  expect(r.content[0].text).not.toContain("retry after");
});
const refuseList = (failure: ReturnType<typeof notInitialized>) => (args: string[]) => args[0] === "list" && args.includes("--limit") && args[args.indexOf("--limit") + 1] === "1" ? failure : undefined;
test("an unregistered git workspace plans in the project named by the refusal's alias, whatever the message says", async () => {
  const a = app({ cwd: outside, before: refuseList(reworded(notInitialized(), "alias github.com/acme/inferred-widgets is not registered", "nothing found here")) });
  expect(await init(a)).toMatch(/^inferred-widgets#/);
});
test("a refusal naming a project plans in that project, whatever the message says", async () => {
  const a = app({ cwd: outside, before: refuseList(reworded(notInitializedProject(), "project nope is not registered", "nothing found here")) });
  expect(await init(a)).toMatch(/^nope#/);
});
test("a .kata.toml-bound unregistered project plans in the bound project", async () => {
  const a = app({ cwd: outside, before: refuseList(notInitializedBound()) });
  expect(await init(a)).toMatch(/^bound-proj#/);
});
test("the alias is slugged: local:// scheme, trailing slashes and .git dropped, last segment kept", async () => {
  const slugged = (alias: string) => ({ ...notInitialized(), stderr: notInitialized().stderr.replaceAll("github.com/acme/inferred-widgets", alias) });
  for (const [alias, name] of [["local:///tmp/work/My.Repo/", "My.Repo"], ["github.com/acme/widgets.git", "widgets"]]) {
    const a = app({ cwd: outside, before: refuseList(slugged(alias)) });
    expect(await init(a)).toMatch(new RegExp(`^${name.replace(/\./g, "\\.")}#`));
  }
});
test("a refusal without data falls back to the folder name", async () => {
  const a = app({ cwd: outside, before: refuseList(notInitializedNoData()) });
  expect(await init(a)).toMatch(/^outside#/);
});

// A person can delete the automatic parent (Kata 0.22's TUI does it with X). The plan goes with it; its tasks stay.
test("after the automatic parent is deleted, init says so, creates a new parent and leaves the old tasks alone", async () => {
  const a = app(); const parent = await init(a); const first = await child(parent, "First");
  await deleteIssue(parent);
  const fresh = await a.call({ op: "init", items: ["Fresh"] });
  expect(fresh.isError).toBeFalsy();
  expect(fresh.content[0].text).toContain(`${parent} was deleted`);
  const next = planParent(fresh);
  expect(next).not.toBe(parent);
  expect((await show(next)).children.map((c: any) => c.title)).toEqual(["Fresh"]);
  expect((await issueOf(first)).status).toBe("open");
});
test("a deleted automatic parent is reported on every op beside ticket items, until a ticket-only init starts a new plan", async () => {
  const ticket = `reliability-test#${await issue("Deletion notice ticket")}`;
  const a = app(); const parent = await init(a, ["First", `${ticket}: check it`]);
  await deleteIssue(parent);
  const finished = await a.call({ ...done, task: "First" });
  expect(finished.isError).toBe(true);
  expect(finished.content[0].text).toContain(`${parent} was deleted`);
  const view = await a.call({ op: "view" });
  expect(view.isError).toBeFalsy();
  expect(view.content[0].text).toContain(`${parent} was deleted`);
  expect(tasksOf(view).map(t => t.content)).toEqual([`${ticket}: check it`]);
  const restarted = await a.call({ op: "init", items: [`${ticket}: check it`] });
  expect(restarted.content[0].text).toContain(`${parent} was deleted`);
  expect((await a.call({ op: "view" })).content[0].text).not.toContain("was deleted");
});
// The session's automatic parents Kata still has (a deleted one is left out).
const parentsOf = (a: { ctx: any }) => sessionParents("omp", a.ctx.sessionManager.getSessionId(), true);
test("a session resumed after its automatic parent was deleted reports it and starts a new plan on init", async () => {
  const a = app(); const parent = await init(a);
  await deleteIssue(parent);
  const b = app({ entries: a.entries, sid: a.ctx.sessionManager.getSessionId() });
  const resumed = await b.call({ op: "view" });
  expect(resumed.isError).toBeFalsy();
  expect(resumed.content[0].text).toContain(`${parent} was deleted`);
  expect(await init(b, ["Fresh"])).not.toBe(parent);
});
test("a deletion noticed at shutdown is still reported after a resume, in todo and /todo", async () => {
  const a = app(); const parent = await init(a);
  await deleteIssue(parent);
  await a.core.session.shutdown(a.ctx);
  const b = app({ entries: a.entries, sid: a.ctx.sessionManager.getSessionId() });
  expect(await b.core.todo.command(b.ctx, "")).toContain(`${parent} was deleted`);
  expect((await b.call({ op: "view" })).content[0].text).toContain(`${parent} was deleted`);
});
test("append after the automatic parent is deleted asks for init and creates no parent", async () => {
  const a = app(); const parent = await init(a);
  await deleteIssue(parent);
  const appended = await a.call({ op: "append", items: ["Later"] });
  expect(appended.isError).toBe(true);
  expect(appended.content[0].text).toContain(`${parent} was deleted`);
  expect(appended.content[0].text).toContain("op=init");
  expect(await parentsOf(a)).toEqual([]);
});
test("init refuses to drop the open tasks of a deleted parent that was restored meanwhile", async () => {
  const a = app(); const parent = await init(a); const first = await child(parent, "First");
  await deleteIssue(parent);
  await a.call({ op: "view" });
  await kata(["restore", parent, "--json"]);
  expect((await a.call({ op: "init", items: ["Fresh"] })).isError).toBe(true);
  expect((await issueOf(first)).status).toBe("open");
});
test("a deleted explicit parent stays an error and no automatic parent replaces it", async () => {
  const ref = `reliability-test#${await issue("Explicit parent to delete")}`;
  const a = app();
  expect((await a.call({ op: "init", ref, items: ["First"] })).isError).toBeUndefined();
  await deleteIssue(ref);
  expect((await a.call({ op: "view" })).isError).toBe(true);
  expect((await a.call({ op: "init", items: ["Fresh"] })).isError).toBe(true);
  expect(await parentsOf(a)).toEqual([]);
});
test("a deleted automatic parent's pending task closes never run, also when the retry timer fires first", async () => {
  let throttle = true;
  const a = app({ before: (args: string[]) => args[0] === "close" && throttle ? siblingThrottle() : undefined });
  const fires: (() => void)[] = [];
  Object.assign(a.ctx, { setTimeout: (fire: () => void) => fires.push(fire), clearTimer: () => {} });
  const parent = await init(a); const first = await child(parent, "First");
  expect((await a.call({ ...done, task: "First" })).content[0].text).toContain(retryNote);
  await deleteIssue(parent);
  throttle = false;
  // The timer's drain runs in the serial queue; the view after it waits for it.
  await later(async () => { fires.at(-1)!(); await a.call({ op: "view" }); });
  expect((await issueOf(first)).status).toBe("open");
});

test("a todo call's Kata calls serve its own context while another event moves the latest one", async () => {
  const mover: { ctx?: any; moved?: boolean } = {};
  const a = app({ before: (args: string[]) => {
    if (args[0] !== "meta" || mover.moved) return undefined;
    mover.moved = true;
    void a.core.tools.call(mover.ctx);
    return undefined;
  } });
  await init(a);
  mover.ctx = { ...a.ctx, sessionManager: { ...a.ctx.sessionManager, getSessionId: () => "other-event" } };
  mover.moved = false;
  a.contexts.length = 0;
  expect((await a.call({ op: "start", task: "Second" })).isError).toBeUndefined();
  expect(mover.moved).toBe(true);
  expect(a.contexts.length).toBeGreaterThan(2);
  expect(a.contexts.every(ctx => ctx === a.ctx)).toBe(true);
});

test("a batch is one job: its todo calls run inside it in order, and a call made meanwhile waits for the whole batch", async () => {
  const a = app(); await init(a);
  const order: string[] = [];
  const gate = Promise.withResolvers<void>();
  const batch = a.core.todo.batch(a.ctx, async job => {
    await gate.promise;
    order.push("batch: start");
    expect((await a.call({ op: "start", task: "Second" }, job)).isError).toBeUndefined();
    order.push("batch: started Second");
    expect((await a.call({ op: "start", task: "First" }, job)).isError).toBeUndefined();
    order.push("batch: started First");
    return "done";
  });
  // Made from outside the batch while it holds the queue: on its own it would run between the batch's two calls.
  const outside = a.call({ op: "view" }).then(result => { order.push(`outside: ${tasksOf(result).map(t => t.status).join()}`); });
  gate.resolve();
  expect(await batch).toBe("done");
  await outside;
  expect(order).toEqual(["batch: start", "batch: started Second", "batch: started First", "outside: in_progress,pending"]);
});
// A call that deadlocked behind its own batch never settles, so these tests fail by timeout.
test("a delegate check made with a batch's job runs inside the batch instead of queueing behind it", async () => {
  const a = app(); await init(a);
  const batch = a.core.todo.batch(a.ctx, async job => {
    const reserved = await a.core.delegates.check(["Work nothing the plan names"], "batch-call", undefined, job);
    expect((await a.call({ op: "view" }, job)).isError).toBeUndefined();
    return reserved.length;
  });
  expect(await batch).toBe(1);
  a.core.delegates.release("batch-call");
});

test("a job held after its batch ended queues like any other call", async () => {
  const a = app(); await init(a);
  let held!: Job;
  await a.core.todo.batch(a.ctx, async job => { held = job; });
  expect((await a.call({ op: "view" }, held)).isError).toBeUndefined();
});

test("a turn's inbox section shows a request sent while an earlier inbox read was still answering", async () => {
  // A delegate's prompt waits up to 3 s for the inbox, so the held read below decides the result, not the machine's speed.
  const address = `actor-a/inflight-${++seq}`, note = `inflight-note-${seq}`;
  process.env.KATA_INBOX_USER = address;
  let holding = true, answered = false;
  const { promise: released, resolve: release } = Promise.withResolvers<void>();
  const a = app({ isMain: () => false, before: async (args: string[]) => {
    if (args[0] !== "inbox" || !holding) return undefined;
    // The first read answers from before the notify, but only once the second turn has started.
    holding = false;
    const out = await run(args, cwd);
    answered = true;
    await released;
    return out;
  } });
  const ref = await issue("In-flight inbox read");
  const first = a.core.session.beforePrompt(a.ctx);
  expect(await until(() => answered)).toBe(true);
  await kata(["notify", ref, "--to", address, "--message", note, "--json"]);
  const second = a.core.session.beforePrompt(a.ctx);
  release();
  expect((await first).sections.inbox ?? "").not.toContain(note);
  expect((await second).sections.inbox).toContain(note);
  await kata(["notify", ref, "--to", address, "--clear", "--json"]);
});
