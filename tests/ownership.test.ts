import { assertIsolated } from "./isolation";
import { unwrapEnv } from "./kata-fixture";
assertIsolated();
import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import ompKata from "../kata";

const exec = promisify(execFile);
const binary = process.env.KATA_TEST_EXECUTABLE;
if (!binary || !path.isAbsolute(binary)) throw new Error("Set KATA_TEST_EXECUTABLE to an absolute kata-main binary path.");
const scratch = mkdtempSync(path.join(process.env.KATA_TEST_ROOT!, "omp-kata-ownership-"));
const cwd = path.join(scratch, "workspace");
mkdirSync(cwd);
const env = { ...process.env, KATA_HOME: path.join(scratch, "khome"), KATA_AUTHOR: "actor-a", KATA_TEAMMATE: "worker-a" };
for (const key of ["KATA_SERVER", "KATA_DAEMON", "KATA_AUTH_TOKEN", "KATA_REF", "KATA_SESSION_ID", "KATA_INBOX_USER"]) delete env[key];
process.env.KATA_AUTHOR = "actor-a";
process.env.KATA_TEAMMATE = "worker-a";
delete process.env.KATA_REF;
delete process.env.KATA_INBOX_USER;

async function run(args: string[]) {
  assertIsolated(env);
  try {
    const out = await exec(binary!, args, { cwd, env, timeout: 15000 });
    return { ...out, code: 0, killed: false };
  } catch (err: any) {
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? err.message, code: err.code ?? 1, killed: !!err.killed };
  }
}
async function kata(args: string[]) {
  const out = await run(args);
  if (out.code !== 0) throw new Error(`${args.join(" ")}: ${out.stderr}`);
  return JSON.parse(out.stdout);
}
let sequence = 0;
async function issue(meta: string[] = [], parent?: string) {
  const args = ["create", `Ownership regression ${++sequence}`, "--force-new", "--json"];
  if (parent) args.push("--parent", parent);
  for (const value of meta) args.push("--meta", value);
  return (await kata(args)).issue.short_id as string;
}
async function show(ref: string) { return (await kata(["show", ref, "--json"])).issue; }
async function set(ref: string, key: string, value: string) { await kata(["meta", "set", ref, key, value, "--json"]); }
async function claim(ref: string, actor = "actor-a") { await kata(["claim", ref, "--as", actor, "--json"]); }

type Before = (args: string[]) => Promise<any>;
function host(parent: string | undefined, before?: Before) {
  let tool: any;
  const events = new Map<string, any>();
  const calls: string[][] = [];
  const notices: string[] = [];
  const schema: any = new Proxy(() => schema, { get: () => schema });
  const ctx = {
    cwd,
    agent: { kind: "main", id: "ownership-main" },
    sessionManager: { getSessionId: () => `ownership-${parent}`, getBranch: () => parent ? [{ type: "custom", customType: "io.kata.omp.parent", data: { parent } }] : [] },
    ui: { notify: (message: string) => notices.push(message), setWidget() {} },
  };
  ompKata({
    zod: schema,
    registerTool(value: any) { tool = value; },
    appendEntry() {},
    on(name: string, callback: any) { events.set(name, callback); },
    async exec(file: string, wrapped: string[]) {
      const { args } = unwrapEnv(file, wrapped);
      // Legacy race hooks target short refs; execution still uses the pinned refs.
      const comparable = args.map(a => a.startsWith("omptest#") ? a.slice(8) : a);
      calls.push(comparable);
      const override = await before?.(comparable);
      return override ?? run(args);
    },
  });
  return {
    calls, notices,
    async begin() { await events.get("session_start")({}, ctx); await tool.execute("flush", { op: "view" }, undefined, undefined, ctx); },
    async shutdown() { await events.get("session_shutdown")({}, ctx); await tool.execute("flush", { op: "view" }, undefined, undefined, ctx); },
    async call(params: any) { return tool.execute("test", params, undefined, undefined, ctx); },
    async input(text: string) { return events.get("input")({ text, source: "interactive" }, ctx); },
  };
}
beforeAll(async () => {
  const result = await run(["init", "--project", "omptest"]);
  if (result.code !== 0) throw new Error(result.stderr);
  console.log(`Real Kata throwaway store: ${scratch}`);
}, 20000);
afterAll(async () => { await run(["daemon", "stop"]); });

// Removing the ownership gate or swallowing claim failures must fail these.
for (const op of ["start", "block", "unblock"]) {
  for (const foreign of ["actor", "teammate"]) {
    test(`${op} leaves ${foreign}-owned attention unchanged`, async () => {
      const parent = await issue();
      const ref = await issue(["todo.phase=Tasks", `todo.status=${op === "unblock" ? "blocked" : "pending"}`, "work.attention=needs-human", "work.attention_msg=foreign worker note"], parent);
      await claim(ref, foreign === "actor" ? "actor-b" : "actor-a");
      if (foreign === "teammate") await set(ref, "teammate", "worker-b");
      const app = host(parent);
      await app.begin();
      const result = await app.call({ op, task: ref, reason: "waiting on a service" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/own|teammate/i);
      expect((await show(ref)).metadata["work.attention"]).toBe("needs-human");
      expect((await show(ref)).metadata["work.attention_msg"]).toBe("foreign worker note");
      expect(app.calls.filter(args => args[0] === "meta" && args[3]?.startsWith("work."))).toEqual([]);
    }, 20000);
  }
}
test("failed claim on an unowned task is reported before attention writes", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const app = host(parent, async args => args[0] === "claim" ? { code: 1, stderr: "claim transport failed", stdout: "" } : undefined);
  await app.begin();
  const result = await app.call({ op: "start", task: ref });
  expect(result.isError).toBe(true);
  expect((await show(ref)).metadata["work.attention"]).toBeUndefined();
  expect((await show(ref)).metadata["todo.status"]).toBe("pending");
});
test("failed parent claim is reported before creating or starting children", async () => {
  let parentRef: string | undefined;
  const app = host(undefined, async args => {
    if (!parentRef && args[0] === "claim") {
      parentRef = args[1];
      return { code: 1, stderr: "parent claim transport failed", stdout: "" };
    }
  });
  const result = await app.call({ op: "init", message: "A fresh plan with a failed parent claim", items: ["A child that must never start"] });
  expect(result.isError).toBe(true);
  expect(parentRef).toBeDefined();
  expect((await kata(["show", parentRef!, "--json"])).children ?? []).toEqual([]);
  expect(app.calls.filter(args => args[0] === "meta" && args[3]?.startsWith("work."))).toEqual([]);
});
test("automatic advance refuses a foreign pending task", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending", "work.attention=needs-human"], parent);
  await claim(ref, "actor-b");
  const app = host(parent);
  await app.begin();
  const result = await app.call({ op: "append", items: ["A separate pending plan task"] });
  expect(result.isError).toBe(true);
  expect((await show(ref)).metadata["work.attention"]).toBe("needs-human");
});
test("owned tasks can start, block, and unblock using guarded attention writes", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const app = host(parent);
  await app.begin();
  expect((await app.call({ op: "start", task: ref })).isError).toBeUndefined();
  expect((await show(ref)).owner).toBe("actor-a");
  expect((await app.call({ op: "block", task: ref, reason: "waiting for review" })).isError).toBeUndefined();
  expect((await show(ref)).metadata["work.attention"]).toBe("stuck");
  expect((await app.call({ op: "unblock", task: ref })).isError).toBeUndefined();
  const final = await show(ref);
  expect(final.metadata["work.attention"]).toBe("ok");
  expect(final.metadata["work.attention_msg"]).toBeUndefined();
  const writes = app.calls.filter(args => args[0] === "meta" && args[3]?.startsWith("work."));
  expect(writes.length).toBeGreaterThan(0);
  for (const args of writes) {
    expect(args).toContain("--if-match");
    expect(args.includes("--if-absent") || args.includes("--if-value")).toBe(true);
  }
}, 20000);
test("closed task block skips all work metadata writes", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  await claim(ref);
  await kata(["close", ref, "--done", "--message", "Verified the isolated ownership regression task before closing it.", "--evidence", "test:ownership harness", "--json"]);
  const app = host(parent);
  await app.begin();
  const result = await app.call({ op: "block", task: ref, reason: "too late" });
  expect(result.isError).toBe(true);
  expect((await show(ref)).status).toBe("closed");
  expect((await show(ref)).metadata["work.attention"]).toBeUndefined();
});
test("explicit restart reopens an owned task after start and done", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const app = host(parent);
  await app.begin();
  expect((await app.call({ op: "start", task: ref })).isError).toBeUndefined();
  expect((await app.call({ op: "done", task: ref, message: "Verified the restart fixture before closing its first lifecycle.", evidence: ["test:ownership harness"] })).isError).toBeUndefined();
  expect((await show(ref)).status).toBe("closed");
  expect((await app.call({ op: "start", task: ref })).isError).toBeUndefined();
  const final = await show(ref);
  expect(final.status).toBe("open");
  expect(final.owner).toBe("actor-a");
  expect(final.metadata.teammate).toBe("worker-a");
  expect(final.metadata["todo.status"]).toBe("in_progress");
  expect(final.metadata["work.attention"]).toBe("ok");
});
for (const foreign of ["actor", "teammate"]) {
  test(`explicit restart refuses a closed ${foreign}-owned task`, async () => {
    const parent = await issue();
    const ref = await issue(["todo.phase=Tasks", "todo.status=pending", "work.attention=stuck"], parent);
    await claim(ref, foreign === "actor" ? "actor-b" : "actor-a");
    if (foreign === "teammate") await set(ref, "teammate", "worker-b");
    await kata(["close", ref, "--wontfix", "--message", "Retired this isolated foreign restart fixture after checking that its worker must retain control.", "--json"]);
    const app = host(parent);
    await app.begin();
    expect((await app.call({ op: "start", task: ref })).isError).toBe(true);
    expect((await show(ref)).status).toBe("closed");
    expect((await show(ref)).metadata["work.attention"]).toBe("stuck");
  });
}
for (const race of ["teammate", "metadata"]) {
  test(`explicit restart rejects a ${race} change during reopen`, async () => {
    const parent = await issue();
    const ref = await issue(["todo.phase=Tasks", "todo.status=pending", "work.attention=stuck"], parent);
    await claim(ref);
    await kata(["close", ref, "--wontfix", "--message", "Retired this isolated restart fixture to test a concurrent handoff at the reopen boundary.", "--json"]);
    let raced = false;
    const app = host(parent, async args => {
      if (!raced && args[0] === "reopen" && args[1] === ref) {
        raced = true;
        await set(ref, race === "teammate" ? "teammate" : "work.attention_msg", race === "teammate" ? "worker-b" : "new blocker during restart");
      }
    });
    await app.begin();
    expect((await app.call({ op: "start", task: ref })).isError).toBe(true);
    expect(raced).toBe(true);
    expect((await show(ref)).metadata["work.attention"]).toBe("stuck");
    expect((await show(ref)).metadata["todo.status"]).toBe("pending");
  });
}
for (const foreign of ["actor", "teammate", "closed"]) {
  test(`session attention skips a ${foreign} parent`, async () => {
    const parent = await issue(["work.attention=needs-human"]);
    await claim(parent, foreign === "actor" ? "actor-b" : "actor-a");
    if (foreign === "teammate") await set(parent, "teammate", "worker-b");
    if (foreign === "closed") await kata(["close", parent, "--wontfix", "--message", "This isolated session attention task is retired because its regression fixture has completed.", "--json"]);
    process.env.KATA_REF = parent;
    try {
      const app = host(parent);
      await app.begin();
      expect(app.calls.filter(args => args[0] === "agent-hook" || (args[0] === "meta" && args[3]?.startsWith("work.")))).toEqual([]);
      expect((await show(parent)).metadata["work.attention"]).toBe("needs-human");
      expect(app.notices).toEqual([]);
    } finally { delete process.env.KATA_REF; }
  });
}
test("a concurrent attention update defeats the guarded start write", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  let raced = false;
  const app = host(parent, async args => {
    if (!raced && args[0] === "meta" && args[3] === "work.attention") {
      raced = true;
      await set(ref, "work.attention", "needs-human");
    }
  });
  await app.begin();
  const result = await app.call({ op: "start", task: ref });
  expect(result.isError).toBe(true);
  expect((await show(ref)).metadata["work.attention"]).toBe("needs-human");
});
for (const race of ["owner", "teammate", "close", "owner-ABA"]) {
  test(`${race} handoff between ownership read and write prevents attention mutation`, async () => {
    const parent = await issue();
    const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
    await claim(ref);
    let raced = false;
    const app = host(parent, async args => {
      if (!raced && args[0] === "meta" && args[3] === "work.attention") {
        raced = true;
        if (race === "teammate") await set(ref, "teammate", "worker-b");
        else if (race === "close") await kata(["close", ref, "--wontfix", "--message", "Retired this isolated fixture during the ownership race to verify closed metadata stays untouched.", "--json"]);
        else {
          await kata(["claim", ref, "--as", "actor-b", "--force", "--json"]);
          if (race === "owner-ABA") await kata(["claim", ref, "--as", "actor-a", "--force", "--json"]);
        }
      }
    });
    await app.begin();
    const result = await app.call({ op: "start", task: ref });
    expect(result.isError).toBe(true);
    expect((await show(ref)).metadata["work.attention"]).toBeUndefined();
    expect((await show(ref)).metadata["todo.status"]).toBe("pending");
  });
}
test("owned session attention is delegated to Kata's native hook", async () => {
  const parent = await issue();
  await claim(parent);
  process.env.KATA_REF = parent;
  try {
    const app = host(parent);
    await app.begin();
    const started = await show(parent);
    expect(started.metadata["work.attention"]).toBe("ok");
    expect(started.metadata["work.attention_session"]).toBeTruthy();
    await app.shutdown();
    const ended = await show(parent);
    expect(ended.metadata["work.attention"]).toBe("needs-human");
    expect(ended.metadata["work.attention_session"]).not.toBe(started.metadata["work.attention_session"]);
    const hooks = app.calls.filter(args => args[0] === "agent-hook");
    expect(hooks.map(args => args.slice(0, 4))).toEqual([["agent-hook", "attention-native", "pi", "start"], ["agent-hook", "attention-native", "pi", "end"]]);
    for (const args of hooks) expect(args).toEqual(expect.arrayContaining(["--session", `ownership-${parent}`, "--host-pid", String(process.pid), "--ref", parent]));
    expect(app.calls.filter(args => args[0] === "meta" && args[3]?.startsWith("work."))).toEqual([]);
  } finally { delete process.env.KATA_REF; }
});
test("session end leaves a blocker set during the session", async () => {
  const parent = await issue();
  await claim(parent);
  process.env.KATA_REF = parent;
  try {
    const app = host(parent);
    await app.begin();
    await set(parent, "work.attention", "stuck");
    await set(parent, "work.attention_msg", "waiting on an upstream fix");
    await app.shutdown();
    const final = await show(parent);
    expect(final.metadata["work.attention"]).toBe("stuck");
    expect(final.metadata["work.attention_msg"]).toBe("waiting on an upstream fix");

  } finally { delete process.env.KATA_REF; }
});
test("session shutdown respects a teammate handoff", async () => {
  const parent = await issue();
  await claim(parent);
  process.env.KATA_REF = parent;
  try {
    const app = host(parent);
    await app.begin();
    await set(parent, "teammate", "worker-b");
    await set(parent, "work.attention", "stuck");
    await set(parent, "work.attention_msg", "another worker is investigating");
    const callsBefore = app.calls.length;
    await app.shutdown();
    expect(app.calls.slice(callsBefore).filter(args => args[0] === "meta")).toEqual([]);
    expect((await show(parent)).metadata["work.attention_msg"]).toBe("another worker is investigating");
  } finally { delete process.env.KATA_REF; }
});
for (const op of ["start", "block", "unblock"]) {
test(`${op} preserves a changed decision before the conditional attention write`, async () => {
  const parent = await issue();
  const status = op === "unblock" ? "blocked" : "pending";
  const ref = await issue(["todo.phase=Tasks", `todo.status=${status}`], parent);
  await claim(ref);
  let raced = false;
  const app = host(parent, async args => {
    if (!raced && args[0] === "meta" && args[2] === ref) {
      raced = true;
      await set(ref, "work.attention", "stuck");
      await set(ref, "work.attention_msg", "new task blocker before conditional write");
    }
  });
  await app.begin();
  expect((await app.call({ op, task: ref, reason: "replace the blocker" })).isError).toBe(true);
  expect(raced).toBe(true);
  const final = await show(ref);
  expect(final.metadata["work.attention"]).toBe("stuck");
  expect(final.metadata["work.attention_msg"]).toBe("new task blocker before conditional write");
  expect(final.metadata["todo.status"]).toBe(status);
});
}
test("an attention message race cannot be cleared during unblock", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=blocked", "work.attention=stuck", "work.attention_msg=old blocker"], parent);
  await claim(ref);
  let raced = false;
  const app = host(parent, async args => {
    if (!raced && args[0] === "meta" && args[1] === "unset" && args[3] === "work.attention_msg") {
      raced = true;
      await set(ref, "work.attention_msg", "new blocker from another writer");
    }
  });
  await app.begin();
  const result = await app.call({ op: "unblock", task: ref });
  expect(result.isError).toBe(true);
  expect((await show(ref)).metadata["work.attention_msg"]).toBe("new blocker from another writer");
});
test("slash command start reports ownership failure without attention writes", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending", "work.attention=stuck"], parent);
  await claim(ref, "actor-b");
  const app = host(parent);
  await app.begin();
  await app.input(`/todo start ${ref}`);
  expect(app.notices.some(message => /not owned/.test(message))).toBe(true);
  expect((await show(ref)).metadata["work.attention"]).toBe("stuck");
});
test("init automatic advance cannot claim another teammate's task", async () => {
  const parent = await issue();
  const app = host(parent);
  await app.begin();
  expect((await app.call({ op: "init", ref: parent, items: ["A stable initialized task"] })).isError).toBeUndefined();
  const ref = (await kata(["show", parent, "--json"])).children[0].short_id;
  await set(ref, "todo.status", "pending");
  await set(ref, "teammate", "worker-b");
  await set(ref, "work.attention", "needs-human");
  const result = await app.call({ op: "init", ref: parent, items: ["A stable initialized task"] });
  expect(result.isError).toBe(true);
  expect((await show(ref)).metadata["work.attention"]).toBe("needs-human");
});
test("successful done does not overwrite the next foreign task", async () => {
  const parent = await issue();
  const first = await issue(["todo.phase=Tasks", "todo.status=in_progress"], parent);
  await claim(first);
  const next = await issue(["todo.phase=Tasks", "todo.status=pending", "work.attention=needs-human"], parent);
  await claim(next, "actor-b");
  const app = host(parent);
  await app.begin();
  const result = await app.call({ op: "done", task: first, message: "Completed the first isolated fixture with real Kata ownership checks.", evidence: ["test:ownership harness"] });
  expect(result.isError).toBe(true);
  expect((await show(first)).status).toBe("closed");
  expect((await show(next)).metadata["work.attention"]).toBe("needs-human");
});
