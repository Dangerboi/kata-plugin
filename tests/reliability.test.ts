import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createKataCore } from "../core/kata-core";
import { assertIsolated } from "./isolation";
import { isolatedKata } from "./kata-fixture";
import { daemonUnavailable, notInitialized, notInitializedBound, notInitializedNoData, notInitializedProject, siblingThrottle } from "./kata-errors";
assertIsolated();
const binary = process.env.KATA_TEST_EXECUTABLE!;
const root = mkdtempSync(path.join(process.env.KATA_TEST_ROOT!, "reliability-"));
const cwd = path.join(root, "workspace"), outside = path.join(root, "outside"), localProject = path.join(root, "local-project");
mkdirSync(cwd); mkdirSync(outside); mkdirSync(localProject);
const env = { ...process.env, KATA_HOME: path.join(root, "home"), KATA_AUTHOR: "actor-a" };
for (const key of ["KATA_REF", "KATA_TEAMMATE", "KATA_INBOX_USER"]) delete env[key];
const run = isolatedKata(binary, env, cwd, 60000);
async function kata(args: string[]) { const r = await run(args); if (r.code) throw new Error(r.stderr); return JSON.parse(r.stdout || "null"); }
const show = async (ref: string) => (await kata(["show", ref, "--json"])).issue;
let seq = 0;
function app(options: any = {}) {
  const entries: any[] = options.entries || [], calls: string[][] = [];
  const id = options.sid || `reliability-${++seq}`;
  const ctx = { cwd: options.cwd || cwd, sessionManager: { getSessionId: () => id, getBranch: () => entries } };
  const core = createKataCore({ appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    exec: async (_file, args, opts) => { calls.push(args); return await options.before?.(args) ?? run(args, opts.cwd); },
  }, { namespace: "omp", executable: binary, executableVars: ["KATA_OMP_EXECUTABLE"], delegateKeys: ["omp.subagent_id"], explicitRef: () => options.ref });
  return { core, calls, entries, ctx, call: (p: any) => core.execute(p, ctx) };
}
// Kata unusable: the only case that selects a session-local plan.
const down = daemonUnavailable;
const message = "Verified the isolated reliability task with the behavioral regression suite.";
const done = { op: "done", message, evidence: ["test:reliability fixture"] };
async function init(a: ReturnType<typeof app>, items = ["First", "Second"], options: { replace?: true } = {}) {
  const r = await a.call({ op: "init", items, ...options }); if (r.isError) throw new Error(r.content[0].text); return r.details.kata.parent!;
}
beforeAll(async () => { expect((await run(["init", "--project", "reliability-test"])).code).toBe(0); expect((await run(["init", "--project", "local-reliability"], localProject)).code).toBe(0); });
beforeEach(() => { process.env.KATA_AUTHOR = "actor-a"; delete process.env.KATA_TEAMMATE; delete process.env.KATA_REF; });
afterAll(async () => { await run(["daemon", "stop"]); });

// V2 requires real Kata evidence even when a project name starts with local-.
test("local-prefixed projects still require Kata completion evidence", async () => {
  const a = app({ cwd: localProject }); const parent = await init(a);
  const ref = a.core.plan.tasks[0].ref;
  expect((await a.call({ op: "done", task: "First" })).isError).toBe(true);
  expect((await show(ref)).status).toBe("open");
  expect((await show(parent)).status).toBe("open");
});
for (const op of ["done", "drop", "rm"]) test(`${op} preserves foreign ownership and all issue state`, async () => {
  const a = app(); await init(a); const ref = a.core.plan.tasks[0].ref;
  await kata(["claim", ref, "--as", "actor-b", "--force", "--json"]);
  const before = await show(ref);
  expect((await a.call({ ...done, op, task: "First" })).isError).toBe(true);
  expect(await show(ref)).toEqual(before);
});
test("a final status write cannot overwrite a concurrent teammate handoff", async () => {
  let ref = "", armed = false;
  const a = app({ before: async (args: string[]) => {
    if (armed && args[0] === "meta" && args[1] === "set" && args[2] === ref && args[3] === "todo.status") {
      armed = false; await kata(["meta", "set", ref, "teammate", "other", "--json"]);
    }
  } });
  await init(a); ref = a.core.plan.tasks[0].ref; armed = true;
  expect((await a.call({ op: "block", task: "First", reason: "waiting" })).isError).toBe(true);
  const state = await show(ref); expect(state.metadata.teammate).toBe("other"); expect(state.metadata["todo.status"]).toBe("in_progress");
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
  await init(a); const active = a.core.plan.tasks[0].ref; ref = a.core.plan.tasks[1].ref;
  const before = await show(active);
  expect((await a.call({ op: "start", task: "Second" })).isError).toBe(true);
  expect(await show(active)).toEqual(before);
  const delegated = await show(ref);
  expect(delegated.metadata["omp.subagent_id"]).toBe("new-worker");
  expect(delegated.metadata["todo.status"]).toBe("pending");
});
test("init rejects blank input before retiring existing tasks", async () => {
  const a = app(); await init(a); const ref = a.core.plan.tasks[1].ref, before = await show(ref);
  expect((await a.call({ op: "init", items: ["First", "   "] })).isError).toBe(true);
  expect(await show(ref)).toEqual(before);
});
test("dash-leading parent and task titles are data", async () => {
  const a = app(); const r = await a.call({ op: "init", message: "--parent title", items: ["--task title"] });
  expect(r.isError).toBeUndefined();
  expect((await show(r.details.kata.parent!)).title).toBe("--parent title");
  expect(a.core.plan.tasks[0].content).toBe("--task title");
});
test("a conflicting explicit binding is refused before either plan changes", async () => {
  const a = app(); const p = await init(a); const b = app(); const q = await init(b, ["Other"]);
  const bound = app({ ref: p }); await bound.call({ op: "view" });
  const before = await kata(["show", p, "--json"]);
  expect((await bound.call({ op: "init", ref: q, items: ["Replacement"] })).isError).toBe(true);
  expect(await kata(["show", p, "--json"])).toEqual(before);
});
test("qualified full UID and short ref restore the same removed child", async () => {
  const a = app(); const p = await init(a); const uid = (await show(p)).uid;
  const b = app({ ref: `reliability-test#${uid.toLowerCase()}` });
  await init(b, ["Replay"], { replace: true }); const first = b.core.plan.tasks[0].ref;
  await b.call({ op: "rm", task: "Replay" });
  const c = app({ ref: p }); await init(c, ["Replay"]);
  expect(c.core.plan.tasks[0].ref).toBe(first);
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
  const state = await show(p); expect(state.owner).toBe("actor-a"); expect(state.metadata["work.attention"]).toBe("ok");
});
for (const status of ["pending", "in_progress", "completed", "blocked"]) test(`local append reuses a ${status} task without losing state`, async () => {
  const a = app({ cwd: outside, before: down }); await init(a, ["Anchor", "Repeated"]);
  if (status === "in_progress") await a.call({ op: "start", task: "Repeated" });
  if (status === "completed") await a.call({ op: "done", task: "Repeated" });
  if (status === "blocked") await a.call({ op: "block", task: "Repeated", reason: "Retained blocker" });
  await a.call({ op: "append", items: ["Repeated", "Repeated"] });
  expect(a.core.plan.tasks).toHaveLength(2);
  const task = a.core.plan.tasks.find(t => t.content === "Repeated")!;
  expect(task.status).toBe(status);
  expect(task.blocker).toBe(status === "blocked" ? "Retained blocker" : undefined);
});
test("local view clears a recovered error and preserves snapshot tasks", async () => {
  const a = app({ cwd: outside, before: down }); await init(a);
  await a.call({ op: "block", task: "Second", reason: "Retained wait" });
  const saved = a.entries.filter(e => e.customType === "io.kata.omp.state").at(-1).data;
  saved.plan.error = "Transient bind failure";
  const b = app({ cwd: outside, before: down, entries: a.entries, sid: a.ctx.sessionManager.getSessionId() });
  expect((await b.call({ op: "view" })).content[0].text).toContain("Session-local");
  expect(b.core.plan.tasks).toHaveLength(2);
  expect(b.core.plan.tasks.find(t => t.content === "Second")?.blocker).toBe("Retained wait");
});
test("automatic parent refuses foreign owner after children close", async () => {
  const a = app(); const p = await init(a, ["Only"]);
  await kata(["claim", p, "--as", "actor-b", "--force", "--json"]); const before = await show(p);
  await a.call({ ...done, task: "Only" }); expect(await show(p)).toEqual(before);
});
test("a deferred removal is invalidated when init keeps the task", async () => {
  let throttle = true;
  const a = app({ before: (args: string[]) => args[0] === "close" && throttle ? siblingThrottle() : undefined });
  const p = await init(a); const ref = a.core.plan.tasks[0].ref;
  await a.call({ op: "rm", task: "First" });
  await init(a);
  const saved = a.entries.filter(e => e.customType === "io.kata.omp.state").at(-1).data;
  // Resume after the retry deadline without sleeping or patching production time.
  for (const [, pending] of saved.retries) pending.at = 0;
  throttle = false;
  const b = app({ entries: a.entries, sid: a.ctx.sessionManager.getSessionId() });
  await b.call({ op: "view" });
  expect((await show(ref)).status).toBe("open"); expect((await show(ref)).metadata["todo.removed"]).not.toBe(true);
  expect((await show(p)).status).toBe("open");
});

for (const op of ["init", "append"]) test(`kept ${op} preserves a promised completion through restored retry`, async () => {
  let throttle = true;
  const a = app({ before: (args: string[]) => args[0] === "close" && args.includes("--done") && throttle
    ? siblingThrottle() : undefined });
  await init(a); const ref = a.core.plan.tasks[0].ref;
  expect((await a.call({ ...done, task: "First" })).isError).toBeUndefined();
  expect((await a.call({ op, items: op === "init" ? ["First", "Second"] : ["First"] })).isError).toBeUndefined();
  const saved = a.entries.filter(e => e.customType === "io.kata.omp.state").at(-1).data;
  for (const [, pending] of saved.retries) pending.at = 0;
  throttle = false;
  const resumed = app({ entries: a.entries, sid: a.ctx.sessionManager.getSessionId() });
  await resumed.call({ op: "view" });
  const state = await show(ref);
  expect(state.status).toBe("closed");
  expect(state.closed_reason).toBe("done");
});

test("rm leaves a foreign closed task unchanged", async () => {
  const a = app(); await init(a); const ref = a.core.plan.tasks[1].ref;
  await kata(["claim", ref, "--as", "actor-b", "--force", "--json"]);
  await kata(["close", ref, "--done", "--message", message, "--test", "foreign proof", "--json"]);
  const before = await show(ref);
  expect((await a.call({ op: "rm", task: "Second" })).isError).toBe(true);
  expect(await show(ref)).toEqual(before);
});
test("starting foreign work does not demote the current task", async () => {
  const a = app(); await init(a); const first = a.core.plan.tasks[0].ref, second = a.core.plan.tasks[1].ref;
  await kata(["claim", second, "--as", "actor-b", "--force", "--json"]);
  const before = await show(first);
  expect((await a.call({ op: "start", task: "Second" })).isError).toBe(true);
  expect(await show(first)).toEqual(before);
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
  reorder = true; await a.call({ op: "view" });
  expect(a.core.plan.tasks.map(t => t.content)).toEqual(["First", "Second", "Third"]);
});
test("bounded audit still closes with the exact current evidence union", async () => {
  let bounded = false;
  const a = app({ before: (args: string[]) => {
    if (args[0] === "audit") { bounded = args.includes("--since"); if (!bounded) return { code: 1, stderr: "unbounded audit rejected", stdout: "" }; }
  } });
  const p = await init(a);
  await a.call({ ...done, task: "First", evidence: ["test:first accepted proof"] });
  await a.call({ ...done, task: "Second", evidence: ["test:second accepted proof"] });
  expect(bounded).toBe(true); expect((await show(p)).status).toBe("closed");
  const rows = (await kata(["audit", "closes", "--json"])).rows;
  const row = rows.find((r: any) => r.issue === p.split("#")[1]);
  const event = (await kata(["events", "--after", String(row.event_id - 1), "--limit", "1", "--json"])).events[0];
  expect(event.payload.evidence.toSorted((a: any, b: any) => a.command.localeCompare(b.command))).toEqual([{ type: "test", command: "first accepted proof" }, { type: "test", command: "second accepted proof" }]);
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
  const authRun = isolatedKata(binary, authEnv, authCwd, 15000);
  try {
    const issued = await authRun(["tokens", "create", "--actor", "token-actor", "--json"]); if (issued.code) throw new Error(issued.stderr);
    const token = JSON.parse(issued.stdout).plaintext; expect(typeof token).toBe("string");
    writeFileSync(tokenFile, token, { mode: 0o600 });
    const setup = await authRun(["init", "--project", "authenticated-fixture"]); if (setup.code) throw new Error(setup.stderr);
    const ref = JSON.parse((await authRun(["create", "Token actor plan", "--json"])).stdout).issue.short_id;
    const status = JSON.parse((await authRun(["status", ref, "--json"])).stdout); expect(status.actor).toBe("token-actor");
    const core = createKataCore({ appendEntry() {}, exec: (_file, args) => authRun(args) }, { namespace: "omp", executable: binary, executableVars: ["KATA_OMP_EXECUTABLE"], delegateKeys: ["omp.subagent_id"], explicitRef: () => ref });
    const ctx = { cwd: authCwd, sessionManager: { getSessionId: () => "auth-fixture", getBranch: () => [] } };
    const initialized = await core.execute({ op: "init", items: ["Authenticated task"] }, ctx);
    expect(initialized.isError, initialized.content[0].text).toBeUndefined();
    expect((await core.execute({ ...done, task: "Authenticated task" }, ctx)).isError).toBeUndefined();
    const child = JSON.parse((await authRun(["show", core.plan.tasks[0].ref, "--json"])).stdout).issue;
    expect(child.status).toBe("closed"); expect(child.owner).toBe("token-actor");
  } finally { await authRun(["daemon", "stop"]); }
});

test("adoption leaves a populated automatic parent's relationship unchanged", async () => {
  const a = app(); const old = await init(a); const b = app(); const next = await init(b, ["Elsewhere"]);
  const before = await show(old);
  await a.core.adopt(next, a.ctx);
  expect(await show(old)).toEqual(before);
  expect(a.core.plan.parent).toBe(next);
});
test("adoption refuses a foreign empty automatic parent", async () => {
  const a = app(); const old = await a.core.ensureParent({}, a.ctx);
  await kata(["claim", old!, "--as", "actor-b", "--force", "--json"]);
  const next = (await kata(["create", "Adoption destination", "--force-new", "--json"])).issue.short_id;
  const before = await show(old!);
  await expect(a.core.adopt(next, a.ctx)).rejects.toThrow();
  expect(await show(old!)).toEqual(before);
});

test("blank append leaves a completed automatic parent closed", async () => {
  const a = app(); const p = await init(a, ["Complete first"]);
  await a.call({ ...done, task: "Complete first" });
  const before = await show(p); expect(before.status).toBe("closed");
  expect((await a.call({ op: "append", items: ["  "] })).isError).toBe(true);
  expect(await show(p)).toEqual(before);
});

// Current membership, not the parent recorded at close time, determines the union.
test("bounded evidence lookup includes a reparented closed child", async () => {
  const a = app(); const p = await init(a, ["Current child"]);
  const other = (await kata(["create", "Previous parent", "--force-new", "--json"])).issue.short_id;
  const child = (await kata(["create", "Reparented proof", "--parent", other, "--force-new", "--json"])).issue.short_id;
  await kata(["close", child, "--done", "--message", message, "--test", "reparented verification", "--json"]);
  await kata(["edit", child, "--parent", p, "--json"]);
  expect((await a.call({ ...done, task: "Current child" })).isError).toBeUndefined();
  expect((await show(p)).status).toBe("closed");
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
  const parent = await kata(["show", p, "--json"]);
  expect(parent.issue.status).toBe("open");
  expect(parent.labels.some((label: any) => label.label === "needs-review")).toBe(true);
});

test("ambiguous recovered local identities are rejected without replacing tasks", async () => {
  const a = app({ cwd: outside, before: down }); await init(a, ["Repeated"]);
  const saved = a.entries.filter(e => e.customType === "io.kata.omp.state").at(-1).data;
  saved.plan.tasks.push({ ...saved.plan.tasks[0] });
  const b = app({ cwd: outside, before: down, entries: a.entries, sid: a.ctx.sessionManager.getSessionId() });
  const result = await b.call({ op: "append", items: ["Repeated"] });
  expect(result.isError).toBe(true);
  expect(b.core.plan.tasks).toHaveLength(2);
});

for (const op of ["done", "drop", "rm"]) test(`${op} preserves another delegate's marker even with the same teammate`, async () => {
  const a = app(); await init(a); const ref = a.core.plan.tasks[0].ref;
  await kata(["meta", "set", ref, "omp.subagent_id", "other-session-worker", "--json"]);
  const before = await show(ref);
  expect((await a.call({ ...done, op, task: "First" })).isError).toBe(true);
  expect(await show(ref)).toEqual(before);
});

test("throttled First completion survives starting Second and retry drain", async () => {
  let throttle = true;
  const a = app({ before: (args: string[]) => args[0] === "close" && throttle ? siblingThrottle() : undefined });
  await init(a);
  const first = a.core.plan.tasks[0].ref;
  const completion = await a.call({ ...done, task: "First" });
  expect(completion.isError).toBeUndefined();
  expect(completion.content[0].text).toContain("retry after 60 seconds");
  const pendingBeforeStart = a.entries.filter(e => e.customType === "io.kata.omp.state").at(-1).data.retries.length;
  expect(pendingBeforeStart).toBe(1);
  const started = await a.call({ op: "start", task: "Second" });
  expect(started.isError).toBeUndefined();
  const saved = a.entries.filter(e => e.customType === "io.kata.omp.state").at(-1).data;
  for (const [, pending] of saved.retries) pending.at = 0;
  throttle = false;
  const b = app({ entries: a.entries, sid: a.ctx.sessionManager.getSessionId() });
  await b.call({ op: "view" });
  const actual = await show(first);
  expect(actual.status).toBe("closed");
  expect(actual.metadata["todo.status"]).toBe("completed");
  expect((await show(a.core.plan.tasks[1].ref)).metadata["todo.status"]).toBe("in_progress");
});

for (const invalid of ["missing proof", "short message"]) test(`rejected done with ${invalid} preserves its promised close`, async () => {
  let throttle = true;
  const a = app({ before: (args: string[]) => args[0] === "close" && throttle
    ? siblingThrottle() : undefined });
  await init(a); const ref = a.core.plan.tasks[0].ref;
  const promised = await a.call({ ...done, task: "First" });
  expect(promised.isError).toBeUndefined();
  expect(promised.content[0].text).toContain("retry after 60 seconds");
  const refused = await a.call({ ...done, task: "First", ...(invalid === "missing proof" ? { evidence: [] } : { message: "short" }) });
  expect(refused.isError).toBe(true);
  const saved = a.entries.filter(e => e.customType === "io.kata.omp.state").at(-1).data;
  for (const [, pending] of saved.retries) pending.at = 0;
  throttle = false;
  const resumed = app({ entries: a.entries, sid: a.ctx.sessionManager.getSessionId() });
  await resumed.call({ op: "view" });
  const actual = await show(ref);
  expect(actual.status).toBe("closed");
  expect(actual.metadata["todo.status"]).toBe("completed");
});

test("invalid typed proof preserves an unowned task", async () => {
  const a = app(); await init(a); const ref = a.core.plan.tasks[1].ref, before = await show(ref);
  expect(before.owner).toBeFalsy();
  expect((await a.call({ ...done, task: "Second", evidence: ["bogus"] })).isError).toBe(true);
  expect(await show(ref)).toEqual(before);
});
test("an unclaimed pending task can retire, re-add and complete without being claimed", async () => {
  const a = app(); await init(a); const ref = a.core.plan.tasks[1].ref;
  expect((await show(ref)).owner).toBeFalsy();
  expect((await a.call({ op: "drop", task: "Second", message: "This planned task is no longer needed." })).isError).toBeUndefined();
  expect((await show(ref)).owner).toBeFalsy();
  expect((await a.call({ op: "rm", task: "Second" })).isError).toBeUndefined();
  expect((await a.call({ op: "append", items: ["Second"] })).isError).toBeUndefined();
  expect(a.core.plan.tasks.find(t => t.content === "Second")?.ref).toBe(ref);
  expect((await show(ref)).status).toBe("open");
  expect((await show(ref)).owner).toBeFalsy();
  expect((await a.call({ ...done, task: "Second" })).isError).toBeUndefined();
  const final = await show(ref);
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
  expect(result.details.kata.parent).toBe(parent);
});
for (const outcome of ["interrupted", "unrelated", "reassigned"]) test(`deferred removal handles an ${outcome} close without hiding newer work`, async () => {
  let throttle = true;
  const a = app({ before: (args: string[]) => args[0] === "close" && throttle
    ? siblingThrottle() : undefined });
  await init(a); const ref = a.core.plan.tasks[0].ref;
  expect((await a.call({ op: "rm", task: "First" })).isError).toBeUndefined();
  const saved = a.entries.filter(e => e.customType === "io.kata.omp.state").at(-1).data;
  expect(saved.retries).toHaveLength(1);
  for (const [, pending] of saved.retries) pending.at = 0;
  throttle = false;
  let interrupted = false, newer: any;
  if (outcome === "unrelated") {
    await kata(["close", ref, "--wontfix", "--message", "Another instruction retired this task independently after reviewing the outstanding work.", "--json"]);
    newer = await show(ref);
  }
  const b = app({ entries: a.entries, sid: a.ctx.sessionManager.getSessionId(), before: async (args: string[]) => {
    if (args[0] === "close" && args[1] === ref && outcome !== "unrelated" && !interrupted) {
      const result = await run(args); expect(result.code).toBe(0); interrupted = true;
      if (outcome === "reassigned") {
        await kata(["meta", "set", ref, "teammate", "new-worker", "--json"]);
        newer = await show(ref);
      }
      return { code: 1, stdout: "", stderr: "response interrupted after accepted close" };
    }
  } });
  await b.call({ op: "view" });
  expect(interrupted).toBe(outcome !== "unrelated");
  await b.core.drain();
  const final = await show(ref);
  expect(final.status).toBe("closed");
  expect(final.metadata["todo.removed"]).not.toBe(true);
  if (outcome === "interrupted") {
    expect((await b.call({ op: "rm", task: "First" })).isError).toBeUndefined();
    expect((await show(ref)).metadata["todo.removed"]).toBe(true);
  } else expect(final).toEqual(newer);
  await b.call({ op: "view" });
  expect(b.core.plan.tasks.some(t => t.ref === ref)).toBe(outcome !== "interrupted");
});

test("rejected append preserves a completed automatic parent and its foreign child", async () => {
  const a = app(); const parent = await init(a, ["Foreign closed"]), ref = a.core.plan.tasks[0].ref;
  await kata(["claim", ref, "--as", "actor-b", "--force", "--json"]);
  await kata(["close", ref, "--done", "--message", message, "--test", "foreign accepted proof", "--json"]);
  await a.call({ op: "view" });
  const before = await show(parent), childBefore = await show(ref);
  expect(before.status).toBe("closed");
  expect((await a.call({ op: "append", items: ["Foreign closed"] })).isError).toBe(true);
  expect(await show(parent)).toEqual(before);
  expect(await show(ref)).toEqual(childBefore);
});
for (const [name, title] of [
  ["qualified lowercase UID", "First"],
  ["verbatim UID-shaped title", "00000000000000000000000000"],
  ["verbatim title ending in #UID", "Follow up kata#00000000000000000000000000"],
]) test(`${name} selects the same task as its short reference`, async () => {
  const a = app(); await init(a, [title, "Second"]); const ref = a.core.plan.tasks[0].ref, issue = await show(ref);
  const result = await a.call({ ...done, task: title === "First" ? `reliability-test#${issue.uid.toLowerCase()}` : title });
  expect(result.isError, result.content[0].text).toBeUndefined();
  expect((await show(ref)).status).toBe("closed");
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
    const parent = await init(a); corruptUID = (await show(a.core.plan.tasks[0].ref)).uid;
    expect((await a.call({ ...done, task: "First" })).isError).toBeUndefined();
    expect((await a.call({ ...done, task: "Second" })).isError).toBeUndefined();
    const final = await kata(["show", parent, "--json"]);
    expect(final.children.every((child: any) => child.status === "closed")).toBe(true);
    expect(final.issue.status).toBe("open");
    expect(final.labels.some((label: any) => label.label === "needs-review")).toBe(true);
  });
}
test("refused replacement leaves every previous task unchanged", async () => {
  const a = app(); await init(a); const first = a.core.plan.tasks[0].ref, second = a.core.plan.tasks[1].ref;
  await kata(["claim", second, "--as", "actor-b", "--force", "--json"]);
  const before = await show(first), foreign = await show(second);
  expect((await a.call({ op: "init", items: ["Replacement"] })).isError).toBe(true);
  expect(await show(first)).toEqual(before);
  expect(await show(second)).toEqual(foreign);
});
test("refused replacement retains a previously promised completion", async () => {
  let throttle = true;
  const a = app({ before: (args: string[]) => args[0] === "close" && args.includes("--done") && throttle
    ? siblingThrottle() : undefined });
  await init(a); const first = a.core.plan.tasks[0].ref, second = a.core.plan.tasks[1].ref;
  expect((await a.call({ ...done, task: "First" })).isError).toBeUndefined();
  await kata(["claim", second, "--as", "actor-b", "--force", "--json"]);
  const foreign = await show(second);
  expect((await a.call({ op: "init", items: ["First"] })).isError).toBe(true);
  const saved = a.entries.filter(e => e.customType === "io.kata.omp.state").at(-1).data;
  for (const [, pending] of saved.retries) pending.at = 0;
  throttle = false;
  const resumed = app({ entries: a.entries, sid: a.ctx.sessionManager.getSessionId() });
  await resumed.call({ op: "view" });
  expect((await show(first)).status).toBe("closed");
  expect(await show(second)).toEqual(foreign);
});

// Kata's error codes and exit codes decide the branch; the wording around them may change.
const reworded = (failure: { code: number; stderr: string }, from: string, to: string) => ({ ...failure, stderr: failure.stderr.replace(from, to) });
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
  await init(a); const ref = a.core.plan.tasks[0].ref;
  const r = await a.call({ ...done, task: "First" });
  expect(r.isError).toBeUndefined();
  expect(r.content[0].text).toContain("retry after 60 seconds");
  expect((await show(ref)).status).toBe("open");
});
test("a throttled close is deferred when Kata prints a warning line before the envelope", async () => {
  // Kata 0.21 with close transcripts on and no session prints this line ahead of the JSON error.
  const warned = () => { const t = siblingThrottle(); return { ...t, stderr: `close: transcript: current session unavailable or invalid; skipping attachment\n${t.stderr}` }; };
  const a = app({ before: (args: string[]) => args[0] === "close" ? warned() : undefined });
  await init(a); const ref = a.core.plan.tasks[0].ref;
  const r = await a.call({ ...done, task: "First" });
  expect(r.isError).toBeUndefined();
  expect(r.content[0].text).toContain("retry after 60 seconds");
  expect((await show(ref)).status).toBe("open");
});
test("throttle wording on a close Kata refused for another reason is an error, not a deferral", async () => {
  const a = app({ before: (args: string[]) => args[0] === "close" ? { code: 1, stdout: "", stderr: '{"error":{"kind":"internal","code":"internal","message":"sibling-close throttle: too many closes","exit_code":1}}\n' } : undefined });
  await init(a);
  const r = await a.call({ ...done, task: "First" });
  expect(r.isError).toBe(true);
  expect(a.entries.filter(e => e.customType === "io.kata.omp.state").at(-1)?.data.retries ?? []).toHaveLength(0);
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
