import fc from "fast-check";
import { afterAll, afterEach, beforeAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { assertIsolated } from "./isolation";
import { adoptIsolatedKata, isolatedKata, later } from "./kata-fixture";
import { daemonUnavailable, missingExecutable, siblingThrottle } from "./kata-errors";
import { ompHost } from "./omp-host";
assertIsolated();
const exec = promisify(execFile);
const binary = process.env.KATA_TEST_EXECUTABLE!;
if (!binary || !path.isAbsolute(binary)) throw new Error("Set KATA_TEST_EXECUTABLE to the absolute Kata binary.");
const scratch = mkdtempSync(path.join(process.env.KATA_TEST_ROOT!, "v2-"));
const cwd = path.join(scratch, "workspace"), outside = path.join(scratch, "outside");
mkdirSync(cwd); mkdirSync(outside);
const env = { ...process.env, KATA_HOME: path.join(scratch, "home"), KATA_AUTHOR: "v2-builder" };
for (const key of ["KATA_SERVER", "KATA_DAEMON", "KATA_AUTH_TOKEN", "KATA_REF", "KATA_TEAMMATE", "KATA_INBOX_USER"]) delete env[key];
const run = isolatedKata(binary, env, cwd, 5000);
async function kata(args: string[], workspace = cwd): Promise<any> {
  const out = await run(args, workspace);
  if (out.code) throw new Error(out.stderr);
  return JSON.parse(out.stdout);
}
const show = async (ref: string) => kata(["show", ref, "--json"]);
let sequence = 0;
async function issue(title = "Explicit parent") { return (await kata(["create", `${title} ${++sequence}`, "--force-new", "--json"])).issue.short_id; }
const down = daemonUnavailable;
const evidence = ["test:bun test fixture"];
const message = "Implemented this isolated fixture and verified its behavior with the regression suite.";
function host(options: any = {}) {
  const sid = options.sid === null ? undefined : options.sid || `v2-${++sequence}`;
  const contractReady = Promise.withResolvers<void>();
  const app = ompHost({
    run: (args, opts) => run(args, opts.cwd, opts.timeout), cwd: options.cwd || cwd, sid, agent: options.agent, entries: options.entries,
    sessionFile: options.sessionFile || `${scratch}/${sid}.jsonl`, header: options.header, snapshot: options.snapshot, before: options.before,
    after: args => { if (args[0] === "agent-contract-hook") contractReady.resolve(); },
    // The adapter spawns paired closes itself, so a host that must see or fail closes runs without the pair; `transcript: true` keeps it.
    afterEvent: () => { if (!options.transcript) { delete process.env.KATA_TRANSCRIPT_AGENT; delete process.env.KATA_TRANSCRIPT_SESSION_ID; delete process.env.KATA_CLOSE_TRANSCRIPT_ENABLED; } },
  });
  return { ...app, contractReady: contractReady.promise,
    async init(items = ["Implement fixture", "Verify fixture"]) { const result = await app.call({ op: "init", items }); expect(result.isError).toBeUndefined(); return result.details.kata.parent; },
  };
}
beforeAll(async () => { const out = await run(["init", "--project", "v2test"]); if (out.code) throw new Error(out.stderr); });
let restore: (() => void) | undefined;
beforeEach(() => { restore = adoptIsolatedKata(binary, env.KATA_HOME); process.env.KATA_AUTHOR = "v2-builder"; for (const key of ["KATA_REF", "KATA_TEAMMATE", "KATA_INBOX_USER", "KATA_TRANSCRIPT_AGENT", "KATA_TRANSCRIPT_SESSION_ID", "KATA_CLOSE_TRANSCRIPT_ENABLED"]) delete process.env[key]; });
afterEach(() => restore?.());
afterAll(async () => { await run(["daemon", "stop"]); });

test("subagent start and shutdown never touch main attention or widget", async () => {
  const ref = await issue(); await kata(["claim", ref, "--json"]); await kata(["meta", "set", ref, "work.attention", "ok", "--json"]);
  process.env.KATA_REF = ref;
  const app = host({ agent: { kind: "sub", id: "child-a", parentId: "main" } });
  await app.event("session_start"); await app.event("session_shutdown");
  expect((await show(ref)).issue.metadata["work.attention"]).toBe("ok");
  expect(app.calls.filter(a => a[0] === "meta")).toEqual([]);
  expect(app.widgets).toEqual([]);
});

test("the main session exports its transcript identity on start and switch, and leaves it for the next start on shutdown", async () => {
  const saved = [process.env.KATA_TRANSCRIPT_AGENT, process.env.KATA_TRANSCRIPT_SESSION_ID];
  delete process.env.KATA_TRANSCRIPT_AGENT; delete process.env.KATA_TRANSCRIPT_SESSION_ID;
  try {
  const app = host({ sid: "transcript-main", transcript: true });
  await app.event("session_start");
  expect([process.env.KATA_TRANSCRIPT_AGENT, process.env.KATA_TRANSCRIPT_SESSION_ID]).toEqual(["omp", "transcript-main"]);
  const next = host({ sid: "transcript-next", transcript: true });
  await next.event("session_switch");
  expect(process.env.KATA_TRANSCRIPT_SESSION_ID).toBe("transcript-next");
  const child = host({ agent: { kind: "sub", id: "child-t", parentId: "main" }, transcript: true });
  await child.event("session_start"); await child.event("session_shutdown");
  expect(process.env.KATA_TRANSCRIPT_SESSION_ID).toBe("transcript-next");
  await next.event("session_shutdown");
  expect([process.env.KATA_TRANSCRIPT_AGENT, process.env.KATA_TRANSCRIPT_SESSION_ID]).toEqual(["omp", "transcript-next"]);
  await host({ sid: "transcript-after", transcript: true }).event("session_start");
  expect(process.env.KATA_TRANSCRIPT_SESSION_ID).toBe("transcript-after");
  } finally {
    for (const [key, value] of [["KATA_TRANSCRIPT_AGENT", saved[0]], ["KATA_TRANSCRIPT_SESSION_ID", saved[1]]] as const) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

// A host whose spawn fails reports a bare failure with no output; the paired close, spawned by the adapter, must read the same.
for (const [name, bareResult, pairedBin] of [
  ["missing", () => { throw missingExecutable(); }, (dir: string) => dir],
  ["not executable", () => ({ code: 1, stdout: "", stderr: "" }), (dir: string) => { writeFileSync(path.join(dir, "kata"), "#!/bin/sh\n", { mode: 0o644 }); return dir; }],
] as const) {
  test(`a close whose Kata executable is ${name} is an outage whether or not the transcript pair is set`, async () => {
    const outcome = async (withPair: boolean) => {
      const saved = process.env.PATH, bin = mkdtempSync(path.join(scratch, "nowhere-"));
      // Without the pair the close goes through the host's exec; with it, the adapter spawns Kata itself.
      const app = host({ sid: `${name}-${withPair}`, transcript: withPair, before: (args: string[]) => args[0] === "close" ? bareResult() : undefined });
      await app.event("session_start");
      const a = await issue("Ticket A");
      await app.call({ op: "init", items: [`v2test#${a}: only step`] });
      // The paired close is spawned by the adapter itself, so PATH must lead to the broken executable.
      if (withPair) process.env.PATH = pairedBin(bin);
      try {
        const result = await app.call({ op: "done", message, evidence });
        return { isError: result.isError, text: result.content[0].text.replace(/:?\s*(Executable not found[^\n]*|spawn kata \w+)|v2test#\w+/g, "") };
      } finally { process.env.PATH = saved; }
    };
    const bare = await outcome(false);
    expect(bare.isError).toBe(true);
    expect(await outcome(true)).toEqual(bare);
  });
}

test("a plugin close records the omp session as its transcript with no transcript config", async () => {
  const app = host({ sid: "transcript-recorded", transcript: true });
  await app.event("session_start");
  const a = await issue("Ticket A");
  await app.call({ op: "init", items: [`v2test#${a}: only step`] });
  const done = await app.call({ op: "done", message, evidence });
  expect(done.isError, done.content?.[0]?.text).toBeUndefined();
  expect(app.calls.some(c => c[0] === "close")).toBe(false);
  const closes = (await kata(["events", "--after", "0", "--limit", "500", "--json"])).events.filter((e: any) => e.type === "issue.closed" && e.payload?.transcript?.session_id === "transcript-recorded");
  expect(closes.length).toBeGreaterThan(0);
  expect(closes[0].payload.transcript).toMatchObject({ agent: "omp", session_id: "transcript-recorded" });
});

test("a plugin close records no transcript when KATA_CLOSE_TRANSCRIPT_ENABLED is false before the session starts", async () => {
  process.env.KATA_CLOSE_TRANSCRIPT_ENABLED = "false";
  const app = host({ sid: "transcript-off", transcript: true });
  await app.event("session_start");
  expect(process.env.KATA_CLOSE_TRANSCRIPT_ENABLED).toBe("false");
  const a = await issue("Ticket transcript off");
  await app.call({ op: "init", items: [`v2test#${a}: only step`] });
  const done = await app.call({ op: "done", message, evidence });
  expect(done.isError, done.content?.[0]?.text).toBeUndefined();
  expect(await closeSessions(a)).toEqual([undefined]);
});

test("a plan of only ticket items reports an id-shaped task that names no issue as a Kata error, as a plan with a parent does", async () => {
  const app = host({ sid: "ticket-only-id-target" }); await app.event("session_start");
  const a = await issue("Ticket A");
  await app.call({ op: "init", items: [`v2test#${a}: only step`] });
  const result = await app.call({ op: "done", task: "0123456789abcdefghjkmnpqrs", message, evidence });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("issue not found");
});

test("an unreachable Kata gets a local plan without Kata mutations and one warning", async () => {
  const app = host({ cwd: outside, before: down }); await app.event("session_start");
  await app.init();
  expect((await app.call({ op: "done", task: "Implement fixture" })).isError).toBeUndefined();
  expect((await app.call({ op: "view" })).content[0].text).toContain("Session-local");
  expect(app.calls.some(a => ["create", "claim", "meta", "close"].includes(a[0]))).toBe(false);
  expect(app.notices.map(n => n[1])).toEqual(["warning"]);
});

test("KATA_REF beats stored session binding and is qualified", async () => {
  const old = await issue(), next = await issue(); process.env.KATA_REF = next;
  const app = host({ entries: [{ type: "custom", customType: "io.kata.omp.parent", data: { parent: old } }] });
  await app.event("session_start"); const view = await app.call({ op: "view" });
  expect(view.details.kata.parent).toBe(`v2test#${next}`);
});

test("auto parents carry typed identity and close exactly once from child evidence", async () => {
  const app = host(); const ref = await app.init();
  expect(ref).toMatch(/^v2test#/);
  expect((await show(ref)).issue.metadata["omp.auto_parent"]).toBe(true);
  expect((await show(ref)).issue.metadata["omp.session_id"]).toBe(app.sid);
  for (const task of ["Implement fixture", "Verify fixture"]) expect((await app.call({ op: "done", task, message, evidence })).isError).toBeUndefined();
  expect((await show(ref)).issue.status).toBe("closed");
  await app.call({ op: "view" }); await app.event("session_stop");
  const rows = (await kata(["audit", "closes", "--json"])).rows.filter((r: any) => r.issue === ref.split("#")[1]);
  expect(rows).toHaveLength(1);
  const evt = (await kata(["events", "--after", String(rows[0].event_id - 1), "--limit", "1", "--json"])).events[0];
  expect(evt.payload.evidence).toEqual([{ type: "test", command: "bun test fixture" }]);
  // Every Kata call pins the plan's workspace, so a worktree or a moved cwd never resolves another project.
  expect(app.calls.every(a => a.includes("--workspace"))).toBe(true);
});

test("explicit parent is never auto-closed and rejected close leaves status active", async () => {
  const ref = await issue(); process.env.KATA_REF = ref;
  let deny = true;
  const app = host({ before: (a: string[]) => a[0] === "close" && deny ? { code: 1, stderr: "evidence denied", stdout: "" } : undefined });
  await app.event("session_start"); await app.init(["A guarded task"]);
  expect((await app.call({ op: "done", message, evidence })).isError).toBe(true);
  expect((await show(ref)).children[0].metadata["todo.status"]).toBe("in_progress");
  deny = false; expect((await app.call({ op: "done", message, evidence })).isError).toBeUndefined();
  expect((await show(ref)).issue.status).toBe("open");
});

test("wontfix floors and slash sibling messages pass real Kata guards", async () => {
  const app = host(); const ref = await app.init(["x", "y", "z"]);
  expect((await app.call({ op: "drop", task: "x", message: "no" })).isError).toBeUndefined();
  await app.event("input", { text: "/todo done", source: "interactive" });
  await app.event("input", { text: "/todo done", source: "interactive" });
  expect((await show(ref)).children.every((c: any) => c.status === "closed")).toBe(true);
});

test("id-less session never creates an unknown automatic parent", async () => {
  const app = host({ sid: null });
  expect((await app.call({ op: "init", items: ["No session identity"] })).isError).toBe(true);
  expect(app.calls.some(a => a[0] === "create")).toBe(false);
});

test("contract is cached verbatim, inbox read every turn, slow hooks bounded and failures quiet", async () => {
  process.env.KATA_INBOX_USER = "v2-builder/lead";
  const app = host(); await app.event("session_start"); await app.contractReady;
  const first = await app.event("before_agent_start", { systemPrompt: ["base"] });
  const second = await app.event("before_agent_start", { systemPrompt: ["base"] });
  const contract = JSON.parse((await run(["agent-contract-hook", "--source", "kata-agent-contract-hook"])).stdout).hookSpecificOutput.additionalContext;
  expect(first.systemPrompt.join("\n")).toContain(contract);
  expect(second.systemPrompt.join("\n")).toContain(contract);
  expect(app.calls.filter(a => a[0] === "agent-contract-hook")).toHaveLength(1);
  expect(app.calls.filter(a => a[0] === "inbox")).toHaveLength(3);
  const slow = host({ before: async () => { await Bun.sleep(600); return { code: 1, stderr: "offline", stdout: "" }; } });
  const start = performance.now(); await slow.event("session_start"); await slow.event("before_agent_start", { systemPrompt: ["base"] });
  expect(performance.now() - start).toBeLessThan(600);
  expect(slow.notices).toEqual([]);
});

test("external closes reconcile an auto parent, including non-todo children", async () => {
  const app = host(); const ref = await app.init(["External task"]);
  const extra = (await kata(["create", "External verification child", "--parent", ref, "--force-new", "--json"])).issue.short_id;
  expect((await app.call({ op: "done", message, evidence })).isError).toBeUndefined();
  expect((await show(ref)).issue.status).toBe("open");
  await kata(["close", extra, "--done", "--message", "Externally verified this additional child with an independent test run.", "--test", "external verifier", "--json"]);
  await app.call({ op: "view" }); expect((await show(ref)).issue.status).toBe("closed");
});

test("a delegate bound to an existing plan item gets a teammate, the verbatim contract and closes it itself", async () => {
  const parent = host(); await parent.event("session_start"); const ref = await parent.init(["Await delegated work", "Keep leading while delegated"]);
  const sessionFile = `${scratch}/delegate-one.jsonl`;
  parent.emit("task:subagent:lifecycle", { id: "Build.Widget", agent: "task", status: "started", sessionFile, description: "Await delegated work" });
  const child = host({ agent: { kind: "sub", id: "Build.Widget", parentId: parent.ctx.agent.id }, sessionFile });
  await child.event("session_start");
  // Startup hooks deliberately return after 250ms; await the actual contract
  // request before asserting the next prompt contains its completed cache.
  await child.contractReady;
  const prompt = await child.event("before_agent_start", { systemPrompt: ["child base"] });
  await parent.call({ op: "view" });
  const tracked = (await show(ref)).children.find((c: any) => c.metadata?.["omp.subagent_id"] === "Build.Widget");
  expect(tracked).toBeDefined();
  const teammate = tracked.metadata.teammate;
  expect(teammate).toMatch(/^[a-z0-9][a-z0-9._-]{0,63}$/);
  expect(prompt.systemPrompt.join("\n")).toContain(`v2test#${tracked.short_id}`);
  const contract = JSON.parse((await run(["agent-contract-hook", "--source", "kata-agent-contract-hook"])).stdout).hookSpecificOutput.additionalContext;
  expect(prompt.systemPrompt.join("\n")).toContain(contract);
  const rewritten = await child.event("tool_call", { toolName: "bash", input: { command: `kata close v2test#${tracked.short_id} --done --message '${message}' --test 'subagent verification'` } });
  expect(rewritten.input.command).toContain(`--teammate '${teammate}'`);
  // Execute the actual rewritten child command, not a parent-generated close.
  await exec("/bin/sh", ["-c", rewritten.input.command.replace(/^kata /, `'${binary}' `)], { env, cwd });
  expect((await show(`v2test#${tracked.short_id}`)).issue.status).toBe("closed");
  await child.event("session_shutdown");
  expect((await parent.call({ op: "done", task: "Keep leading while delegated", message, evidence })).isError).toBeUndefined();
  expect((await show(ref)).issue.status).toBe("open"); // Native agent still running.
  parent.emit("task:subagent:lifecycle", { id: "Build.Widget", status: "completed", sessionFile });
  await parent.call({ op: "view" }); expect((await show(ref)).issue.status).toBe("closed");
  expect(child.widgets).toEqual([]);
  expect(child.calls.some(a => a[0] === "meta" && a[3]?.startsWith("work."))).toBe(false);
});

test("a delegate's close carries the transcript identity from its session file header, read again until the header exists", async () => {
  const parent = host(); await parent.event("session_start"); const ref = await parent.init(["Header delegated work", "Keep leading"]);
  const sessionFile = `${scratch}/delegate-header.jsonl`;
  writeFileSync(sessionFile, "");
  parent.emit("task:subagent:lifecycle", { id: "Header.Delegate", agent: "task", status: "started", sessionFile, description: "Header delegated work" });
  const child = host({ agent: { kind: "sub", id: "Header.Delegate", parentId: parent.ctx.agent.id }, sessionFile });
  await child.event("session_start"); await child.contractReady;
  await child.event("before_agent_start", { systemPrompt: ["child base"] });
  await parent.call({ op: "view" });
  const tracked = (await show(ref)).children.find((c: any) => c.metadata?.["omp.subagent_id"] === "Header.Delegate");
  const close = () => child.event("tool_call", { toolName: "bash", input: { command: `kata close v2test#${tracked.short_id} --done --message '${message}' --test 'header fixture'` } });
  expect((await close()).input.command).not.toContain("KATA_TRANSCRIPT");
  writeFileSync(sessionFile, '{"type":"session","version":3,"id":"delegate-header-id"}\n{"type":"message"}\n');
  expect((await close()).input.command).toStartWith("env KATA_TRANSCRIPT_AGENT='omp' KATA_TRANSCRIPT_SESSION_ID='delegate-header-id' kata ");
  await child.event("session_shutdown");
});

test("finished unclosed delegates remain open needs-review, with no parent proof fallback", async () => {
  const app = host(); await app.event("session_start"); const parent = await app.init(["Await unverified delegate", "Lead keeps working"]);
  const sessionFile = `${scratch}/delegate-unclosed.jsonl`;
  app.emit("task:subagent:lifecycle", { id: "unclosed", agent: "task", status: "started", sessionFile, description: "Await unverified delegate" });
  await app.call({ op: "view" });
  await ran(app, "unclosed", sessionFile);
  app.emit("task:subagent:lifecycle", { id: "unclosed", status: "completed", sessionFile });
  await app.call({ op: "done", task: "Lead keeps working", message, evidence });
  const child = (await show(parent)).children.find((c: any) => c.title === "Await unverified delegate");
  expect(child.status).toBe("open");
  const view = await show(`v2test#${child.short_id}`);
  expect(view.labels.some((l: any) => l.label === "needs-review")).toBe(true);
  expect((await show(parent)).issue.status).toBe("open");
});

test("a delegate on a worker thread that runs a tool before its assignment reaches it is handed back, not rolled back", async () => {
  // The lead's assignment write is slow, so the worker's copy has no record yet when its delegate runs a tool. A real delay:
  // the race is between two threads and real Kata processes, which fake timers cannot order, and the fixed copy waits for the answer.
  const app = host({ before: async (args: string[]) => { if (args[0] === "meta" && args[3] === "omp.subagent_id") await Bun.sleep(1500); } });
  await app.event("session_start"); const parent = await app.init(["Worker delegated work", "Lead keeps working"]);
  const sessionFile = `${scratch}/delegate-worker.jsonl`, id = "Worker.Delegate";
  app.emit("task:subagent:lifecycle", { id, agent: "task", status: "started", sessionFile, description: "Worker delegated work" });
  // Exit only after the lead has heard of the tool use, as it would from a real delegate's later turns; a report that
  // never comes still ends the wait, and the hand-back check below fails.
  const channel = new BroadcastChannel("kata-plugin:omp-delegates:1");
  const reported = new Promise<void>(resolve => {
    const timer = setTimeout(resolve, 8000);
    channel.onmessage = event => { if (event.data?.kind === "ranTool" && event.data.id === id) { clearTimeout(timer); resolve(); } };
  });
  const worker = new Worker(new URL("./omp-worker-delegate.ts", import.meta.url), { workerData: { binary, env, cwd, sessionFile, id, parentId: app.ctx.agent.id } } as any);
  const ran = new Promise(resolve => worker.addEventListener("message", resolve, { once: true }));
  try {
    await reported;
    await ran;
  } finally { worker.terminate(); channel.close(); }
  app.emit("task:subagent:lifecycle", { id, status: "completed", sessionFile });
  await app.call({ op: "done", task: "Lead keeps working", message, evidence });
  const child = (await show(parent)).children.find((c: any) => c.title === "Worker delegated work");
  expect(child.status).toBe("open");
  expect((await show(`v2test#${child.short_id}`)).labels.some((l: any) => l.label === "needs-review")).toBe(true);
}, 20_000);

test("subagent bash attribution ignores quoted data, replaces teammates and refuses --as", async () => {
  const child = host({ agent: { kind: "sub", id: "Quoted-Agent", parentId: "parent" } });
  for (const command of ["kata --as actor-b list", "kata claim abc --as=actor-b", "echo hi && '/usr/bin/kata' --as actor-b list"]) {
    expect((await child.event("tool_call", { toolName: "bash", input: { command } })).block).toBe(true);
  }
  const data = "echo 'kata --as actor-b'; printf '%s' 'kata claim abc'";
  expect(await child.event("tool_call", { toolName: "bash", input: { command: data } })).toBeUndefined();
  const command = "kata comment abc --body '--as is just prose' --teammate other && kata list";
  const result = await child.event("tool_call", { toolName: "bash", input: { command } });
  expect(result.block).toBeUndefined();
  expect(result.input.command).toContain("--body '--as is just prose'");
  expect(result.input.command).not.toContain("--teammate other");
  expect(result.input.command.match(/--teammate/g)).toHaveLength(2);
});

test("pinned plan survives cwd changes and ignores another session's saved binding", async () => {
  const app = host(); const parent = await app.init(["Pinned task"]);
  app.ctx.cwd = outside;
  expect((await app.call({ op: "append", items: ["Another pinned task"] })).isError).toBeUndefined();
  expect((await show(parent)).children).toHaveLength(2);
  const next = host({ entries: app.entries }); await next.event("session_start");
  expect((await next.call({ op: "view" })).details.kata.parent).toBeUndefined();
});

test("new work reopens an auto parent; all-wontfix parents require review", async () => {
  const app = host(); const parent = await app.init(["Initial work"]);
  await app.call({ op: "done", message, evidence });
  expect((await show(parent)).issue.status).toBe("closed");
  await app.call({ op: "append", items: ["Additional work"] });
  expect((await show(parent)).issue.status).toBe("open");
  const dropped = host(); const retired = await dropped.init(["x"]);
  await dropped.call({ op: "drop", message: "no" });
  const view = await show(retired);
  expect(view.issue.status).toBe("open");
  expect(view.labels.some((l: any) => l.label === "needs-review")).toBe(true);
});

test("a flagged automatic parent is not re-audited until its revision changes", async () => {
  const app = host(); const parent = await app.init(["x"]);
  await app.call({ op: "drop", message: "no" });
  const turn = async () => {
    const before = app.calls.length;
    await app.event("session_stop"); await app.call({ op: "view" });
    return app.calls.slice(before).map(a => a[0]).filter(verb => ["audit", "events", "label"].includes(verb));
  };
  expect(await turn()).toEqual([]);
  await kata(["meta", "set", parent, "reviewer", "someone", "--json"]);
  expect(await turn()).toContain("label");
  expect(await turn()).toEqual([]);
});

test("a throttled automatic-parent close does not label the parent for review", async () => {
  let parent = "";
  const timers = new Set<{ run: () => void }>();
  const app = host({ before: (a: string[]) => a[0] === "close" && a.includes(parent) ? siblingThrottle() : undefined });
  app.ctx.setTimeout = (callback: () => void) => { const timer = { run: callback }; timers.add(timer); return timer; };
  app.ctx.clearTimer = (timer: any) => { timers.delete(timer); };
  parent = await app.init(["Throttled parent"]);
  await app.call({ op: "done", message, evidence });
  const view = await show(parent);
  expect(view.issue.status).toBe("open");
  expect(view.labels.some((l: any) => l.label === "needs-review")).toBe(false);
  expect(timers.size).toBe(1);
});

// Like omp: the host owns retry timers, and sweeps whatever is pending on shutdown.
function throttledClose() {
  const timers = new Set<{ run: () => void }>();
  let throttled = true, reached!: () => void;
  const closing = new Promise<void>(resolve => reached = resolve);
  const app = host({ before: (a: string[]) => {
    if (a[0] !== "close") return undefined;
    if (throttled) return siblingThrottle();
    reached();
    return undefined;
  } });
  app.ctx.setTimeout = (callback: () => void) => { const timer = { run: callback }; timers.add(timer); return timer; };
  app.ctx.clearTimer = (timer: any) => { timers.delete(timer); };
  return { app, timers, closing, lift: () => { throttled = false; } };
}
test("a throttled close is retried by the host timer", async () => {
  const { app, timers, closing, lift } = throttledClose();
  const parent = await app.init(["Throttled task"]);
  expect((await app.call({ op: "done", message, evidence })).content[0].text).toContain("retry");
  expect(timers.size).toBe(1);
  lift();
  setSystemTime(new Date(Date.now() + 120_000));
  try { for (const timer of [...timers]) timer.run(); await closing; } finally { setSystemTime(); }
  await app.call({ op: "view" });
  expect((await show(parent)).issue.status).toBe("closed");
});
test("binding another session cancels the pending retry through the host", async () => {
  const { app, timers } = throttledClose();
  await app.init(["Throttled task"]);
  await app.call({ op: "done", message, evidence });
  expect(timers.size).toBe(1);
  const other = { ...app.ctx, sessionManager: { getSessionId: () => `${app.sid}-other`, getBranch: () => [] } };
  await app.event("session_branch", {}, other);
  expect(timers.size).toBe(0);
});

test("sibling throttle retries the pinned close and does not falsely complete metadata", async () => {
  let throttled = false;
  const app = host({ before: (a: string[]) => {
    if (!throttled && a[0] === "close") { throttled = true; return siblingThrottle(); }
  } });
  const parent = await app.init(["Throttled task"]);
  const result = await app.call({ op: "done", message, evidence });
  expect(result.isError).toBeUndefined();
  expect(result.content[0].text).toContain("retry");
  expect((await show(parent)).children[0].metadata["todo.status"]).toBe("in_progress");
  await later(async () => { const resumed = host({ cwd: outside, sid: app.sid, entries: app.entries }); await resumed.event("session_start"); await resumed.call({ op: "view" }); });
  expect((await show(parent)).issue.status).toBe("closed");
});

test("membership changes during evidence retrieval prevent auto-parent close", async () => {
  let mutate = false;
  let parent: string;
  const app = host({ before: async (a: string[]) => {
    if (mutate && a[0] === "events") { mutate = false; await kata(["create", "Concurrent child", "--parent", parent, "--force-new", "--json"]); }
  } });
  parent = await app.init(["Initial closed child"]); mutate = true;
  await app.call({ op: "done", message, evidence });
  expect((await show(parent)).issue.status).toBe("open");
});

test("cross-project adoption pins new children to the claimed project", async () => {
  const other = path.join(scratch, `other-${++sequence}`); mkdirSync(other);
  await kata(["init", "--project", "v2other", "--json"], other);
  const foreign = (await kata(["create", "Cross-project claimed issue", "--owner", "v2-builder", "--force-new", "--json"], other)).issue.short_id;
  const app = host(); const original = await app.init(["Original task"]);
  await app.event("tool_result", { toolName: "bash", input: { command: `kata --workspace '${other}' claim ${foreign}` }, isError: false });
  const current = await app.call({ op: "view" });
  expect(current.details.kata.parent).toBe(`v2other#${foreign}`);
  expect((await app.call({ op: "append", items: ["Claimed-project task"] })).isError).toBeUndefined();
  const view = await show(`v2other#${foreign}`);
  const child = view.children.find((c: any) => c.title === "Claimed-project task");
  expect(child.project_id).toBe(view.issue.project_id);
  expect((await show(original)).issue.status).toBe("open");
});

test("typed automatic parent can be recovered after losing the session entry", async () => {
  const app = host(); const parent = await app.init(["Durable existing task"]);
  const recovered = host({ sid: app.sid }); await recovered.event("session_start");
  expect((await recovered.call({ op: "view" })).details.kata.parent).toBe(parent);
});

// A delegate that exits having run no tool has its assignment rolled back; these tests need one that did work.
async function ran(lead: ReturnType<typeof host>, id: string, sessionFile: string) {
  await host({ sessionFile, agent: { kind: "sub", id, parentId: lead.ctx.agent.id } }).event("tool_call", { toolName: "read", input: { path: "README.md" } });
}

test("async snapshot settles a delegate when terminal lifecycle delivery is missing", async () => {
  let recent: any[] = [];
  const app = host({ snapshot: () => ({ running: [], recent }) });
  await app.event("session_start"); const parent = await app.init(["Wait for snapshot"]);
  app.emit("task:subagent:lifecycle", { id: "snapshot-child", agent: "task", status: "started", sessionFile: `${scratch}/snapshot-child.jsonl`, description: "Wait for snapshot" });
  await app.call({ op: "view" });
  await ran(app, "snapshot-child", `${scratch}/snapshot-child.jsonl`);
  recent = [{ id: "snapshot-child", type: "task", status: "completed" }];
  await app.event("session_stop"); await app.call({ op: "view" });
  const child = (await show(parent)).children.find((c: any) => c.title === "Wait for snapshot");
  expect((await show(`v2test#${child.short_id}`)).labels.some((l: any) => l.label === "needs-review")).toBe(true);
});

for (const yielded of [false, true]) test(`a delegate's report is ${yielded ? "what it yielded" : "its last assistant text"}, read from its session events`, async () => {
  const app = host(); await app.event("session_start"); const parent = await app.init(["Report the gizmo"]);
  const id = `report-${yielded}`, sessionFile = `${scratch}/${id}.jsonl`;
  app.emit("task:subagent:lifecycle", { id, agent: "task", status: "started", sessionFile, description: "Report the gizmo" });
  await app.call({ op: "view" });
  await ran(app, id, sessionFile);
  const message = (type: string, role: string, text: string) => app.emit("task:subagent:event", { id, event: { type, message: { role, content: [{ type: "text", text }, { type: "toolCall", name: "read" }] } } });
  message("message_end", "assistant", "Looking at the gizmo first.");
  message("message_end", "assistant", "The gizmo needs a new spring; I left it open.");
  message("message_update", "assistant", "partial streaming text");
  message("message_end", "user", "a user turn");
  // Strict-mode providers send an untyped final yield as `type: null`, and some fill `error` with "" beside the data.
  if (yielded) app.emit("task:subagent:event", { id, event: { type: "tool_execution_start", toolName: "yield", args: { type: null, data: { spring: "replaced" }, error: "" } } });
  // An incremental section is part of a result, never the report.
  app.emit("task:subagent:event", { id, event: { type: "tool_execution_start", toolName: "yield", args: { type: ["confidence"], data: 0.8 } } });
  app.emit("task:subagent:lifecycle", { id, status: "completed", sessionFile });
  await app.call({ op: "view" });
  const comments = (await show(`v2test#${(await show(parent)).children[0].short_id}`)).comments.map((c: any) => c.body);
  const report = yielded ? JSON.stringify({ spring: "replaced" }, null, 2) : "The gizmo needs a new spring; I left it open.";
  expect(comments.filter((b: string) => b.startsWith("Report from subagent"))).toEqual([`Report from subagent ${id} (it left no comment of its own):\n\n${report}`]);
});

test("a missed delegate exit found at a prompt does not wait for the settlement", async () => {
  let recent: any[] = [], slow = false;
  const reached = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
  const app = host({ snapshot: () => ({ running: [], recent }), before: async (args: string[]) => {
    if (slow && ["show", "label", "close", "comment"].includes(args[0])) { reached.resolve(); await gate.promise; }
    return undefined;
  } });
  try {
    await app.event("session_start"); const parent = await app.init(["Wait for slow settlement"]);
    app.emit("task:subagent:lifecycle", { id: "slow-exit", agent: "task", status: "started", sessionFile: `${scratch}/slow-exit.jsonl`, description: "Wait for slow settlement" });
    await app.call({ op: "view" });
    await ran(app, "slow-exit", `${scratch}/slow-exit.jsonl`);
    recent = [{ id: "slow-exit", type: "task", status: "cancelled" }]; slow = true;
    await app.event("before_agent_start", { systemPrompt: ["base"] });
    await reached.promise;
    gate.resolve();
    await app.call({ op: "view" });
    const task = (await show(parent)).children.find((c: any) => c.title === "Wait for slow settlement");
    expect((await show(`v2test#${task.short_id}`)).labels.some((l: any) => l.label === "needs-review")).toBe(true);
  } finally { gate.resolve(); }
});

// Real delays, like the neighbouring tests: the hook races real Kata processes, which fake timers cannot order.
test("a lead turn with no exited delegate ends within the short bound even when Kata is slow", async () => {
  let slow = false;
  const app = host({ before: async (args: string[]) => { if (slow) await Bun.sleep(1500); return undefined; } });
  await app.event("session_start"); await app.init(["Slow Kata, nothing exited"]);
  app.emit("task:subagent:lifecycle", { id: "still-running", agent: "task", status: "started", sessionFile: `${scratch}/still-running.jsonl`, description: "Slow Kata, nothing exited" });
  await app.call({ op: "view" });
  slow = true;
  const start = performance.now();
  await app.event("session_stop", { messages: [] });
  expect(performance.now() - start).toBeLessThan(1000);
  slow = false; await app.call({ op: "view" }); // drain the background hook
});

test("a lead turn with an exited delegate waits for its slow hand back before the turn ends", async () => {
  let recent: any[] = [], slow = false;
  const app = host({ snapshot: () => ({ running: [], recent }), before: async (args: string[]) => {
    if (slow && ["show", "label", "close", "comment", "meta", "notify"].includes(args[0])) await Bun.sleep(150);
    return undefined;
  } });
  await app.event("session_start"); const parent = await app.init(["Slow hand back at turn end"]);
  app.emit("task:subagent:lifecycle", { id: "slow-hand-back", agent: "task", status: "started", sessionFile: `${scratch}/slow-hand-back.jsonl`, description: "Slow hand back at turn end" });
  await app.call({ op: "view" });
  await ran(app, "slow-hand-back", `${scratch}/slow-hand-back.jsonl`);
  recent = [{ id: "slow-hand-back", type: "task", status: "cancelled" }]; slow = true;
  const start = performance.now();
  await app.event("session_stop", { messages: [] });
  expect(performance.now() - start).toBeGreaterThan(250);
  const task = (await show(parent)).children.find((c: any) => c.title === "Slow hand back at turn end");
  expect((await show(`v2test#${task.short_id}`)).labels.some((l: any) => l.label === "needs-review")).toBe(true);
});

test("a lead turn does not wait out the deadline for a hand back that keeps failing", async () => {
  let recent: any[] = [], failing = false;
  const app = host({ snapshot: () => ({ running: [], recent }), before: async (args: string[]) => {
    if (failing && args[0] === "label") return { code: 1, stdout: "", stderr: "permission denied" };
    return undefined;
  } });
  await app.event("session_start"); await app.init(["Failing hand back at turn end"]);
  app.emit("task:subagent:lifecycle", { id: "failing-hand-back", agent: "task", status: "started", sessionFile: `${scratch}/failing-hand-back.jsonl`, description: "Failing hand back at turn end" });
  await app.call({ op: "view" });
  await ran(app, "failing-hand-back", `${scratch}/failing-hand-back.jsonl`);
  recent = [{ id: "failing-hand-back", type: "task", status: "cancelled" }]; failing = true;
  const start = performance.now();
  await app.event("session_stop", { messages: [] });
  expect(performance.now() - start).toBeLessThan(2000);
  failing = false; await app.call({ op: "view" }); // drain the cleanup now that Kata answers
});

test("a lead turn also waits for a delegate that exits while the first one's hand back runs", async () => {
  let recent: any[] = [], slow = false, fired = false;
  const app = host({ snapshot: () => ({ running: [], recent }), before: async (args: string[]) => {
    if (!slow) return undefined;
    // The first hand back's first write: the cleanup pass already holds its list, so the second exit is not on it.
    if (args[0] === "label" && !fired) { fired = true; app.emit("task:subagent:lifecycle", { id: "late-exit", status: "completed", sessionFile: `${scratch}/late-exit.jsonl` }); }
    if (["show", "label", "close", "comment", "meta", "notify"].includes(args[0])) await Bun.sleep(150);
    return undefined;
  } });
  await app.event("session_start"); const parent = await app.init(["Early exit at turn end", "Late exit at turn end"]);
  for (const [id, description] of [["early-exit", "Early exit at turn end"], ["late-exit", "Late exit at turn end"]]) {
    app.emit("task:subagent:lifecycle", { id, agent: "task", status: "started", sessionFile: `${scratch}/${id}.jsonl`, description });
    await app.call({ op: "view" });
    await ran(app, id, `${scratch}/${id}.jsonl`);
  }
  recent = [{ id: "early-exit", type: "task", status: "cancelled" }]; slow = true;
  await app.event("session_stop", { messages: [] });
  expect(fired).toBe(true);
  const children = (await show(parent)).children;
  for (const title of ["Early exit at turn end", "Late exit at turn end"]) {
    const task = children.find((c: any) => c.title === title);
    expect((await show(`v2test#${task.short_id}`)).labels.some((l: any) => l.label === "needs-review")).toBe(true);
  }
});

test("an aborted turn-end wait returns at once and leaves the reminder state alone", async () => {
  let recent: any[] = [], slow = false;
  const app = host({ snapshot: () => ({ running: [], recent }), before: async (args: string[]) => {
    if (slow && ["show", "label", "close", "comment", "meta", "notify"].includes(args[0])) await Bun.sleep(150);
    return undefined;
  } });
  await app.event("session_start"); const parent = await app.init(["Aborted hand back", "Lead keeps working"]);
  app.emit("task:subagent:lifecycle", { id: "aborted-wait", agent: "task", status: "started", sessionFile: `${scratch}/aborted-wait.jsonl`, description: "Aborted hand back" });
  await app.call({ op: "view" });
  await ran(app, "aborted-wait", `${scratch}/aborted-wait.jsonl`);
  recent = [{ id: "aborted-wait", type: "task", status: "cancelled" }]; slow = true;
  const controller = new AbortController(), start = performance.now();
  setTimeout(() => controller.abort(), 400);
  const aborted = await app.event("session_stop", { messages: [], signal: controller.signal });
  expect(performance.now() - start).toBeLessThan(900);
  expect(aborted).toBeUndefined();
  // The hand back keeps running in the background; the next stop still gets the first reminder.
  slow = false;
  const next = await app.event("session_stop", { messages: [] });
  expect(next.additionalContext).toContain("reminder 1/");
  const task = (await show(parent)).children.find((c: any) => c.title === "Aborted hand back");
  expect((await show(`v2test#${task.short_id}`)).labels.some((l: any) => l.label === "needs-review")).toBe(true);
});

test("relative lifecycle session paths join the child's absolute session path", async () => {
  const app = host(); await app.event("session_start"); const parent = await app.init(["Relative child path"]);
  app.emit("task:subagent:lifecycle", { id: "relative-child", agent: "task", status: "started", sessionFile: "../relative-session.jsonl", description: "Relative child path" });
  const child = host({ agent: { kind: "sub", id: "relative-child", parentId: app.ctx.agent.id }, sessionFile: path.join(scratch, "relative-session.jsonl") });
  await child.event("session_start");
  const result = await child.event("before_agent_start", { systemPrompt: ["base"] });
  expect(result.systemPrompt.join("\n")).toContain("<kata_binding>");
  expect(result.systemPrompt.join("\n")).toContain("Your Kata issue is");
  expect(result.systemPrompt.join("\n")).toContain("relative-child");
});

test("a delegate's first prompt waits for a slow binding instead of dropping it", async () => {
  const app = host({ before: async (args: string[]) => { if (args[0] === "meta" && args[3] === "omp.subagent_id") await Bun.sleep(600); return undefined; } });
  await app.event("session_start"); await app.init(["Slow delegate binding"]);
  app.emit("task:subagent:lifecycle", { id: "slow-child", agent: "task", status: "started", sessionFile: `${scratch}/slow-child.jsonl`, description: "Slow delegate binding" });
  const child = host({ agent: { kind: "sub", id: "slow-child", parentId: app.ctx.agent.id }, sessionFile: `${scratch}/slow-child.jsonl` });
  await child.event("session_start");
  const result = await child.event("before_agent_start", { systemPrompt: ["base"] });
  expect(result.systemPrompt.join("\n")).toContain("<kata_binding>");
  expect(result.systemPrompt.join("\n")).toContain("Your Kata issue is");
});

test("explicitly adopting the auto issue revokes and persists automatic close authority", async () => {
  const app = host(); const parent = await app.init(["Explicitly retained task"]);
  await app.call({ op: "init", ref: parent, items: ["Explicitly retained task"] });
  expect(app.entries.filter(e => e.customType === "io.kata.omp.parent").at(-1).data.auto).toBe(false);
  await app.call({ op: "done", message, evidence });
  expect((await show(parent)).issue.status).toBe("open");
  const restored = host({ sid: app.sid, entries: app.entries }); await restored.event("session_start"); await restored.call({ op: "view" });
  expect((await show(parent)).issue.status).toBe("open");
});

test("Kata rejects incompatible parent evidence without dropping it from the union", async () => {
  const app = host(); const parent = await app.init(["Typed union task"]);
  const audit = (await kata(["create", "No-change verification", "--parent", parent, "--force-new", "--json"])).issue.short_id;
  await kata(["close", audit, "--audit-no-change", "--message", "Audited the current implementation and verified no additional changes were required.", "--reviewed", "README.md", "--evidence", "no-change-audit:Existing behavior already satisfies the specification", "--json"]);
  await app.call({ op: "done", message, evidence });
  expect(app.calls.some(a => a[0] === "close" && a[1] === parent && a.includes("no-change-audit:Existing behavior already satisfies the specification"))).toBe(true);
  const view = await show(parent);
  expect(view.issue.status).toBe("open");
  expect(view.labels.some((l: any) => l.label === "needs-review")).toBe(true);
});

// Kata 0.21 records attachment close evidence as {type:"attachment",attachment_id}; Docbank is not
// configurable in the isolated store, so the real close event is rewritten on its way to the plugin.
function withAttachment(keepOthers: boolean) {
  return async (args: string[], opts: any) => {
    if (args[0] !== "events") return;
    const out = await run(args, opts.cwd, opts.timeout);
    const page = JSON.parse(out.stdout);
    for (const event of page.events ?? []) if (event.type === "issue.closed") {
      const attachment = { type: "attachment", attachment_id: "0123456789abcdef0123456789abcdef" };
      event.payload.evidence = keepOthers ? [attachment, ...event.payload.evidence] : [attachment];
    }
    return { ...out, stdout: JSON.stringify(page) };
  };
}

test("auto-parent close skips children's attachment evidence and carries the rest", async () => {
  const app = host({ before: withAttachment(true) }); const parent = await app.init(["Attachment and test evidence"]);
  expect((await app.call({ op: "done", message, evidence })).isError).toBeUndefined();
  expect((await show(parent)).issue.status).toBe("closed");
  const row = (await kata(["audit", "closes", "--json"])).rows.find((r: any) => r.issue === parent.split("#")[1]);
  const stored = (await kata(["events", "--after", String(row.event_id - 1), "--limit", "1", "--json"])).events[0];
  expect(stored.payload.evidence).toEqual([{ type: "test", command: "bun test fixture" }]);
});

test("auto parent whose children carry only attachment evidence stays open for review", async () => {
  const app = host({ before: withAttachment(false) }); const parent = await app.init(["Attachment only evidence"]);
  await app.call({ op: "done", message, evidence });
  expect(app.calls.some(a => a[0] === "close" && a[1] === parent)).toBe(false);
  const view = await show(parent);
  expect(view.issue.status).toBe("open");
  expect(view.labels.some((l: any) => l.label === "needs-review")).toBe(true);
});

test("advisor tool calls cannot steal the main session's spawn coordinator", async () => {
  const app = host(); await app.event("session_start"); const parent = await app.init(["Advisor-safe delegation"]);
  await app.event("tool_call", { toolName: "bash", input: { command: "echo advisor" } }, { ...app.ctx, agent: { kind: "sub", id: "advisor" } });
  app.emit("task:subagent:lifecycle", { id: "after-advisor", agent: "task", status: "started", sessionFile: `${scratch}/after-advisor.jsonl`, description: "Advisor-safe delegation" });
  await app.call({ op: "view" });
  expect((await show(parent)).children.some((c: any) => c.metadata?.["omp.subagent_id"] === "after-advisor")).toBe(true);
});

test("auto-parent evidence resolves cross-project children in their own projects", async () => {
  const other = path.join(scratch, `evidence-${++sequence}`); mkdirSync(other);
  await kata(["init", "--project", "v2evidence", "--json"], other);
  const app = host(); const parent = await app.init(["Local evidence task"]);
  const extra = (await kata(["create", "Cross-project evidence", "--parent", parent, "--force-new", "--json"], other)).issue.short_id;
  await kata(["close", `v2evidence#${extra}`, "--done", "--message", "Verified this cross-project component with its own independent test evidence.", "--test", "cross-project validation", "--json"], other);
  await app.call({ op: "done", message, evidence });
  expect((await show(parent)).issue.status).toBe("closed");
});

test("missing agent identity never grants main-session attention authority", async () => {
  const ref = await issue(); await kata(["claim", ref, "--json"]);
  process.env.KATA_REF = ref;
  const app = host({ agent: {} });
  await app.event("session_start"); await app.event("session_shutdown");
  expect(app.calls.some(a => a[0] === "meta" && a[3]?.startsWith("work."))).toBe(false);
  expect(app.widgets).toEqual([]);
});

for (const entry of ["lazy", "titled"]) test(`${entry} failed claim resumes the same parent and closes with accepted evidence`, async () => {
  let rejectClaim = true;
  const app = host({ before: (a: string[]) => a[0] === "claim" && rejectClaim ? { code: 1, stderr: "temporary claim failure", stdout: "" } : undefined });
  await app.event("session_start");
  await app.call({ op: "init", items: ["Recovered task"], ...(entry === "titled" ? { message: "A titled plan parent" } : {}) });
  const list = (await kata(["list", "--status", "all", "--meta", `omp.session_id=${app.sid}`, "--json"])).issues;
  const parents = list.filter((i: any) => !i.metadata?.["todo.phase"]);
  expect(parents).toHaveLength(1);
  const parent = parents[0];
  expect(parent.metadata["omp.auto_parent"]).toBeUndefined();
  expect(parent.metadata["omp.session_id"]).toBe(app.sid);
  expect(parent.metadata["omp.workspace"]).toBe(cwd);
  rejectClaim = false;
  const resumed = host({ sid: app.sid }); await resumed.event("session_start");
  const result = await resumed.call({ op: "init", items: ["Recovered task"] });
  expect(result.isError, result.content[0].text).toBeUndefined();
  const ref = result.details.kata.parent;
  expect(ref).toBe(`v2test#${parent.short_id}`);
  const setup = await show(ref);
  expect(setup.issue.metadata["omp.auto_parent"]).toBe(true);
  expect(setup.issue.title).toBe(parent.title);
  expect((await resumed.call({ op: "done", message, evidence })).isError).toBeUndefined();
  const closed = await show(ref);
  expect(closed.issue.status).toBe("closed");
  expect(closed.children).toHaveLength(1);
  expect(closed.children[0].status).toBe("closed");
  const finalParents = (await kata(["list", "--status", "all", "--meta", `omp.session_id=${app.sid}`, "--json"])).issues.filter((i: any) => !i.metadata?.["todo.phase"]);
  expect(finalParents).toHaveLength(1);
  expect(finalParents[0].short_id).toBe(parent.short_id);
});

for (const match of ["active", "named"]) test(`delegation reuses the ${match} plan task with child-owned closure`, async () => {
  const app = host(); await app.event("session_start");
  const ref = await app.init(["Implement widget", "Write widget tests"]);
  expect((await app.call({ op: "start", task: "Implement widget" })).isError).toBeUndefined();
  const expected = (await show(ref)).children.find((c: any) => c.title === (match === "active" ? "Implement widget" : "Write widget tests"));
  await app.event("tool_call", { toolName: "task", toolCallId: `call-${match}`, input: { agent: "task", task: match === "named" ? 'Complete plan task "Write widget tests" and commit it.' : "Complete the current task and commit it." } });
  const sessionFile = `${scratch}/reuse-${match}.jsonl`;
  app.emit("task:subagent:lifecycle", { id: `reuse-${match}`, status: "started", sessionFile, parentToolCallId: `call-${match}`, index: 0 });
  await app.call({ op: "view" });
  const children = (await show(ref)).children;
  expect(children).toHaveLength(2);
  const delegated = children.find((c: any) => c.metadata?.["omp.subagent_id"] === `reuse-${match}`);
  expect(delegated.short_id).toBe(expected.short_id);
  const child = host({ agent: { kind: "sub", id: `reuse-${match}`, parentId: app.ctx.agent.id }, sessionFile });
  await child.event("session_start");
  const prompt = (await child.event("before_agent_start", { systemPrompt: [] })).systemPrompt.join("\n");
  expect(prompt).toContain(`Your Kata issue is v2test#${expected.short_id};`);
  expect(prompt).toContain(`close 'v2test#${expected.short_id}'`);
  // The main cannot close the delegated issue on behalf of a running worker.
  expect((await app.call({ op: "done", task: expected.title, message, evidence })).isError).toBe(true);
  await kata(["close", expected.short_id, "--teammate", delegated.metadata.teammate, "--done", "--message", message, "--test", `delegate-${match}`, "--json"]);
  app.emit("task:subagent:lifecycle", { id: `reuse-${match}`, status: "completed", sessionFile });
  await app.call({ op: "view" });
  expect((await app.call({ op: "done", task: match === "active" ? "Write widget tests" : "Implement widget", message, evidence })).isError).toBeUndefined();
  expect((await show(ref)).issue.status).toBe("closed");
  expect(app.calls.some(a => a[0] === "close" && a[1] === `v2test#${expected.short_id}`)).toBe(false);
});

test("batch delegates bind named plan tasks by spawn index without duplicates", async () => {
  const app = host(); await app.event("session_start");
  const ref = await app.init(["Build alpha", "Build beta"]);
  const tasks = (await show(ref)).children;
  await app.event("tool_call", { toolName: "task", toolCallId: "batch-binding", input: { tasks: [{ task: "Finish Build beta" }, { task: "Finish Build alpha" }] } });
  for (const [index, id] of ["batch-beta", "batch-alpha"].entries()) app.emit("task:subagent:lifecycle", { id, status: "started", sessionFile: `${scratch}/${id}.jsonl`, parentToolCallId: "batch-binding", index });
  await app.call({ op: "view" });
  const children = (await show(ref)).children;
  expect(children).toHaveLength(2);
  for (const [title, id] of [["Build alpha", "batch-alpha"], ["Build beta", "batch-beta"]]) {
    const child = children.find((c: any) => c.title === title);
    expect(child.short_id).toBe(tasks.find((c: any) => c.title === title).short_id);
    expect(child.metadata["omp.subagent_id"]).toBe(id);
  }
});

test("a delegated plan task cannot be assigned to a second subagent", async () => {
  const app = host(); await app.event("session_start"); await app.init(["One worker only"]);
  const input = { task: 'Complete "One worker only"' };
  await app.event("tool_call", { toolName: "task", toolCallId: "first-worker", input });
  expect(await app.event("tool_call", { toolName: "task", toolCallId: "second-worker", input })).toMatchObject({ block: true });
});

test("a task prompt naming a plan item by ref binds it over a better word overlap", async () => {
  const app = host(); await app.event("session_start");
  const ref = await app.init(["Implement widget", "Write widget tests"]);
  const children0 = (await show(ref)).children;
  const target = children0.find((c: any) => c.title === "Implement widget"), other = children0.find((c: any) => c.title === "Write widget tests");
  await app.event("tool_call", { toolName: "task", toolCallId: "ref-wins", input: { name: "WriteTests", task: `Write the widget tests; the work is v2test#${target.short_id}.` } });
  app.emit("task:subagent:lifecycle", { id: "ref-wins", status: "started", sessionFile: `${scratch}/ref-wins.jsonl`, parentToolCallId: "ref-wins", index: 0 });
  await app.call({ op: "view" });
  const children = (await show(ref)).children;
  expect(children).toHaveLength(2);
  expect(children.find((c: any) => c.short_id === target.short_id).metadata["omp.subagent_id"]).toBe("ref-wins");
  expect(children.find((c: any) => c.short_id === other.short_id).metadata["omp.subagent_id"]).toBeUndefined();
});

test("a task prompt naming a plan item by short id binds it without a new issue", async () => {
  const app = host(); await app.event("session_start");
  const ref = await app.init(["Implement widget"]);
  const named = (await show(ref)).children[0];
  await app.event("tool_call", { toolName: "task", toolCallId: "short-id", input: { task: `read issue ${named.short_id} and write the tests` } });
  app.emit("task:subagent:lifecycle", { id: "short-id", status: "started", sessionFile: `${scratch}/short-id.jsonl`, parentToolCallId: "short-id", index: 0 });
  await app.call({ op: "view" });
  const children = (await show(ref)).children;
  expect(children).toHaveLength(1);
  expect(children[0].metadata["omp.subagent_id"]).toBe("short-id");
});

test("a plan item another writer owns is never bound by a task naming it", async () => {
  const app = host(); await app.event("session_start");
  const ref = await app.init(["Implement widget", "Write foreign tests"]);
  const foreign = (await show(ref)).children.find((c: any) => c.title === "Write foreign tests");
  await kata(["claim", foreign.short_id, "--as", "someone-else", "--json"]);
  await app.event("tool_call", { toolName: "task", toolCallId: "foreign", input: { task: `Work on v2test#${foreign.short_id}` } });
  app.emit("task:subagent:lifecycle", { id: "foreign", status: "started", sessionFile: `${scratch}/foreign.jsonl`, parentToolCallId: "foreign", index: 0 });
  await app.call({ op: "view" });
  const after = (await show(`v2test#${foreign.short_id}`)).issue;
  expect(after.owner).toBe("someone-else");
  expect(after.metadata["omp.subagent_id"]).toBeUndefined();
});

for (const planned of [true, false]) test(`a task prompt naming a ticket outside the plan binds it${planned ? "" : " in a session with no plan"} and creates no issue`, async () => {
  const app = host(); await app.event("session_start");
  const parent = planned ? await app.init(["Implement widget"]) : undefined;
  const ticket = await issue("Existing work");
  await app.event("tool_call", { toolName: "task", toolCallId: `ticket-${planned}`, input: { name: "Anything", task: `Finish v2test#${ticket}: make the change and close it.` } });
  app.emit("task:subagent:lifecycle", { id: `ticket-${planned}`, status: "started", sessionFile: `${scratch}/ticket-${planned}.jsonl`, parentToolCallId: `ticket-${planned}`, index: 0 });
  await app.call({ op: "view" });
  const bound = (await show(`v2test#${ticket}`)).issue;
  expect(bound.metadata["omp.subagent_id"]).toBe(`ticket-${planned}`);
  expect(bound.owner).toBe("v2-builder");
  const owned = (await kata(["list", "--status", "all", "--meta", `omp.session_id=${app.sid}`, "--json"])).issues;
  expect(owned.filter((i: any) => i.title.startsWith("Subagent"))).toHaveLength(0);
  if (parent) expect((await show(parent)).children).toHaveLength(1);
  else expect(owned.filter((i: any) => i.short_id !== ticket)).toHaveLength(0);
});

test("a task prompt naming several tickets or plan items is blocked", async () => {
  const app = host(); await app.event("session_start");
  const ref = await app.init(["Implement widget", "Write gadget docs"]);
  const [a, b] = [await issue("Ticket A"), await issue("Ticket B")];
  const plan = (await show(ref)).children.map((c: any) => `v2test#${c.short_id}`);
  const blocked = async (text: string, id: string) => expect(await app.event("tool_call", { toolName: "task", toolCallId: id, input: { task: text } })).toMatchObject({ block: true, reason: expect.stringMatching(/one ticket per task/i) });
  await blocked(`Do v2test#${a} and v2test#${b}`, "two-tickets");
  await blocked(`Do v2test#${a} then ${plan[0]}`, "ticket-and-item");
  await blocked(`Do ${plan[0]} and ${plan[1]}`, "two-items");
  await blocked('Do "Implement widget" and "Write gadget docs"', "two-titles");
  expect(await app.event("tool_call", { toolName: "task", toolCallId: "one-ticket", input: { task: `Do v2test#${a} only` } })).toBeUndefined();
});

test("a task prompt naming an unusable ticket is blocked", async () => {
  const app = host(); await app.event("session_start"); await app.init(["Implement widget"]);
  const blocked = async (text: string, id: string) => expect(await app.event("tool_call", { toolName: "task", toolCallId: id, input: { task: text } })).toMatchObject({ block: true });
  await blocked("Do v2test#zzzz now", "unresolvable");
  const closed = await issue("Closed work"); await kata(["close", closed, "--done", "--message", message, "--test", "closed-fixture", "--json"]);
  await blocked(`Do v2test#${closed} now`, "closed");
  const foreign = await issue("Foreign work"); await kata(["claim", foreign, "--as", "someone-else", "--json"]);
  await blocked(`Do v2test#${foreign} now`, "foreign");
});

test("a file anchor is plain text in a task prompt; a ref in a registered project must resolve", async () => {
  const app = host(); await app.event("session_start"); await app.init(["Implement widget"]);
  const spawn = (text: string, id: string) => app.event("tool_call", { toolName: "task", toolCallId: id, input: { task: text } });
  expect(await spawn("Fix the link in README.md#tasks", "one-anchor")).toBeUndefined();
  expect(await spawn("Fix README.md#tasks and CHANGELOG.md#added", "two-anchors")).toBeUndefined();
  expect(await spawn("See ghostproject#zzzz for background", "unregistered-project")).toBeUndefined();
  expect(await spawn("Do v2test#zzzz and README.md#tasks", "registered-missing")).toMatchObject({ block: true });
});

test("local plan and blockers survive extension recreation through session entries", async () => {
  const app = host({ cwd: outside, before: down }); await app.event("session_start");
  await app.init(["Durable local first", "Durable local second"]);
  await app.call({ op: "block", reason: "Waiting on a durable dependency" });
  const entries = JSON.parse(JSON.stringify(app.entries));
  const resumed = host({ cwd: outside, before: down, sid: app.sid, entries }); await resumed.event("session_start");
  const view = await resumed.call({ op: "view" });
  expect(view.content[0].text).toContain("Waiting on a durable dependency");
  expect(view.details.kata.phases[0].tasks.map((t: any) => t.status)).toEqual(["blocked", "in_progress"]);
  const other = host({ cwd: outside, before: down, entries }); await other.event("session_start");
  expect((await other.call({ op: "view" })).content[0].text).toContain("No todo plan");
});

test("queued close survives extension recreation and retries only after its deadline", async () => {
  const app = host({ before: (a: string[]) => a[0] === "close" ? siblingThrottle() : undefined });
  const parent = await app.init(["Durable queued close"]);
  await app.call({ op: "done", message, evidence });
  const entries = JSON.parse(JSON.stringify(app.entries));
  const resumed = host({ sid: app.sid, entries }); await resumed.event("session_start");
  expect(resumed.calls.some(a => a[0] === "close")).toBe(false);
  await later(async () => { const restarted = host({ sid: app.sid, entries }); await restarted.event("session_start"); await restarted.call({ op: "view" }); });
  expect((await show(parent)).issue.status).toBe("closed");
  expect((await kata(["audit", "closes", "--json"])).rows.filter((r: any) => r.issue === parent.split("#")[1])).toHaveLength(1);
});

// The 2026-10-19 eval: omp sent todo init and the tests delegation in one batch.
const evalPlan = ["Implement word_count and top_words in textstats", "Write unittest suite covering word_count, top_words, and empty input", "Run the suite with python3 -m unittest", "Commit the work"];
test("a delegation spawned in the same batch as todo init binds its plan task", async () => {
  const app = host(); await app.event("session_start");
  const hook = app.event("tool_call", { toolName: "task", toolCallId: "eval-batch", input: { context: "Add word_count and top_words to textstats.",
    tasks: [{ name: "WriteTests", agent: "task", task: "Write the textstats unittest suite in tests/ per the contract above" }] } });
  const ref = await app.init(evalPlan);
  await hook;
  app.emit("task:subagent:lifecycle", { id: "WriteTests", agent: "task", status: "started", sessionFile: `${scratch}/eval-batch.jsonl`, parentToolCallId: "eval-batch", index: 0 });
  await app.call({ op: "view" });
  let children = (await show(ref)).children;
  expect(children).toHaveLength(4);
  expect(children.find((c: any) => c.title === evalPlan[1]).metadata["omp.subagent_id"]).toBe("WriteTests");
  expect(children.find((c: any) => c.title === evalPlan[0]).metadata["omp.subagent_id"]).toBeUndefined();
  // The delegated task never occupies the lead's slot: finishing its own task starts the next one.
  expect((await app.call({ op: "done", task: evalPlan[0], message, evidence })).isError).toBeUndefined();
  children = (await show(ref)).children;
  expect(children.find((c: any) => c.title === evalPlan[2]).metadata["todo.status"]).toBe("in_progress");
});

test("an unrelated delegation never takes the lead's active task and creates nothing", async () => {
  const app = host(); await app.event("session_start");
  const ref = await app.init(["Implement widget", "Write widget tests"]);
  await app.event("tool_call", { toolName: "task", toolCallId: "probe", input: { agent: "scout", task: "Reply with exactly: SUBAGENT-OK" } });
  const sessionFile = `${scratch}/probe-agent.jsonl`;
  app.emit("task:subagent:lifecycle", { id: "probe-agent", status: "started", sessionFile, parentToolCallId: "probe", index: 0 });
  await app.call({ op: "view" });
  let children = (await show(ref)).children;
  expect(children).toHaveLength(2);
  expect(children.some((c: any) => c.metadata?.["omp.subagent_id"])).toBe(false);
  expect(children.find((c: any) => c.title === "Implement widget").metadata["todo.status"]).toBe("in_progress");
  const settled = app.calls.length;
  app.emit("task:subagent:lifecycle", { id: "probe-agent", status: "completed", sessionFile });
  await app.call({ op: "view" });
  expect(app.calls.slice(settled).some(a => ["comment", "label", "notify", "create"].includes(a[0]))).toBe(false);
  children = (await show(ref)).children;
  expect(children).toHaveLength(2);
  for (const child of children) expect((await show(`v2test#${child.short_id}`)).labels.some((l: any) => l.label === "needs-review")).toBe(false);
  expect((await show(ref)).labels.some((l: any) => l.label === "needs-review")).toBe(false);
  expect((await kata(["inbox", "--for", "v2-builder", "--json"])).requests.some((r: any) => [ref, ...children.map((c: any) => `v2test#${c.short_id}`)].includes(r.ref))).toBe(false);
  // Only the plan's own items keep the automatic parent open.
  expect((await app.call({ op: "done", task: "Implement widget", message, evidence })).isError).toBeUndefined();
  expect((await show(ref)).issue.status).toBe("open");
  expect((await app.call({ op: "done", task: "Write widget tests", message, evidence })).isError).toBeUndefined();
  expect((await show(ref)).issue.status).toBe("closed");
});

// A delegate of an unrelated spawn: the lead's plan has no item for it.
async function untrackedDelegate(id: string, options: any = {}) {
  const lead = host(); await lead.event("session_start");
  const ref = await lead.init(["Implement widget", "Write widget tests"]);
  const sessionFile = `${scratch}/${id}.jsonl`;
  lead.emit("task:subagent:lifecycle", { id, agent: "scout", status: "started", sessionFile, description: "Survey the repository layout" });
  await lead.call({ op: "view" });
  const worker = host({ sessionFile, agent: { kind: "sub", id, parentId: lead.ctx.agent.id }, ...options });
  return { lead, ref, worker };
}

test("an untracked delegate's todo uses omp's native list and makes no Kata calls", async () => {
  const { worker } = await untrackedDelegate("untracked-native");
  const received: any[] = [];
  const native = { content: [{ type: "text", text: "native list" }], details: { phases: [] } };
  const params = { op: "init", list: [{ phase: "Scout", items: ["Read the tree"] }] };
  const result = await worker.call(params, { ...worker.ctx, invokeTool: async (p: any) => { received.push(p); return native; } });
  expect(result).toBe(native);
  expect(received).toEqual([params]);
  expect(worker.calls.some(a => ["create", "meta", "claim", "close", "comment"].includes(a[0]))).toBe(false);
});

test("an untracked delegate's todo on an omp without invokeTool says it has no Kata issue", async () => {
  const { worker } = await untrackedDelegate("untracked-no-native");
  const result = await worker.call({ op: "view" });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("matched no plan item or ticket");
  expect(result.content[0].text).not.toContain("binding");
});

test("another lead's spawn keeps a running untracked delegate's identity", async () => {
  const { worker } = await untrackedDelegate("untracked-survives");
  const other = host(); await other.event("session_start"); await other.init(["Unrelated plan"]);
  other.emit("task:subagent:lifecycle", { id: "other-child", agent: "scout", status: "started", sessionFile: `${scratch}/other-child.jsonl`, description: "Unrelated work" });
  await other.call({ op: "view" });
  const native = { content: [{ type: "text", text: "native list" }], details: { phases: [] } };
  expect(await worker.call({ op: "view" }, { ...worker.ctx, invokeTool: async () => native })).toBe(native);
});

test("an untracked delegate's system prompt has the note, not an issue binding", async () => {
  const { worker } = await untrackedDelegate("untracked-prompt");
  process.env.KATA_REF = "v2test#inherited"; // a tern-kata Pane hands the lead's ref to its subagents
  await worker.event("session_start");
  const prompt = (await worker.event("before_agent_start", { systemPrompt: ["base"] })).systemPrompt.join("\n");
  expect(prompt).toContain("<kata_binding>");
  expect(prompt).toContain("you have no Kata issue");
  expect(prompt).toContain("inherited KATA_REF");
  expect(prompt).not.toContain("Your Kata issue is");
  expect(prompt).not.toContain("close '");
});

test("a spawn in a session with no plan creates nothing", async () => {
  const app = host(); await app.event("session_start");
  const before = await total();
  await app.event("tool_call", { toolName: "task", toolCallId: "no-plan", input: { agent: "scout", task: "Survey the repository layout" } });
  app.emit("task:subagent:lifecycle", { id: "no-plan", status: "started", sessionFile: `${scratch}/no-plan.jsonl`, parentToolCallId: "no-plan", index: 0 });
  await app.call({ op: "view" });
  expect(await sessionParents(app.sid)).toEqual([]);
  expect(await total()).toBe(before);
});

test("while the plan is local, a delegate matching a local item is not untracked", async () => {
  const lead = host({ cwd: outside, before: down }); await lead.event("session_start");
  await lead.init(["Draft the local notes", "Review the local notes"]);
  const sessionFile = `${scratch}/local-match.jsonl`;
  lead.emit("task:subagent:lifecycle", { id: "local-match", status: "started", sessionFile, description: "Draft the local notes" });
  await lead.call({ op: "view" });
  const worker = host({ cwd: outside, sessionFile, agent: { kind: "sub", id: "local-match", parentId: lead.ctx.agent.id } });
  let native = 0;
  const result = await worker.call({ op: "view" }, { ...worker.ctx, invokeTool: async () => { native++; return { content: [], details: {} }; } });
  expect(native).toBe(0);
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("Kata assignment");
  expect(result.content[0].text).not.toContain("matched no plan item");
});

test("a finished delegate that leaves its plan task open hands it back for review", async () => {
  process.env.KATA_TEAMMATE = "lead-mate";
  const app = host(); await app.event("session_start");
  const ref = await app.init(["Implement widget", "Write widget tests"]);
  await app.event("tool_call", { toolName: "task", toolCallId: "handback", input: { name: "WriteTests", task: "Write the widget tests" } });
  const sessionFile = `${scratch}/handback.jsonl`;
  app.emit("task:subagent:lifecycle", { id: "handback", status: "started", sessionFile, parentToolCallId: "handback", index: 0 });
  await app.call({ op: "view" });
  const task = (await show(ref)).children.find((c: any) => c.title === "Write widget tests");
  expect(task.metadata["omp.subagent_id"]).toBe("handback");
  expect((await app.call({ op: "done", task: "Write widget tests", message, evidence })).isError).toBe(true);
  await ran(app, "handback", sessionFile);
  app.emit("task:subagent:lifecycle", { id: "handback", status: "completed", sessionFile });
  await app.call({ op: "view" });
  const settled = await show(`v2test#${task.short_id}`);
  expect(settled.labels.some((l: any) => l.label === "needs-review")).toBe(true);
  expect(settled.issue.metadata.teammate).toBe("lead-mate");
  expect(settled.issue.metadata["todo.status"]).toBe("pending");
  expect((await kata(["inbox", "--for", "v2-builder/lead-mate", "--json"])).requests.some((r: any) => r.ref.endsWith(task.short_id))).toBe(true);
  expect((await app.call({ op: "done", task: "Write widget tests", message, evidence })).isError).toBeUndefined();
  const closed = await show(`v2test#${task.short_id}`);
  expect(closed.issue.status).toBe("closed");
  expect(closed.labels.some((l: any) => l.label === "needs-review")).toBe(false);
});

test("a delegate whose assignment failed is handed back when it exits, and the automatic parent closes", async () => {
  process.env.KATA_TEAMMATE = "lead-mate";
  const app = host({ before: (args: string[]) => args[0] === "meta" && args[3] === "omp.subagent_id" ? { code: 1, stdout: "", stderr: "delegation service permission denied" } : undefined });
  await app.event("session_start");
  const ref = await app.init(["Delegated plan task", "Lead step"]);
  const sessionFile = `${scratch}/binding-failed.jsonl`;
  app.emit("task:subagent:lifecycle", { id: "binding-failed", status: "started", sessionFile, description: "Delegated plan task" });
  await app.call({ op: "view" });
  app.emit("task:subagent:lifecycle", { id: "binding-failed", status: "completed", sessionFile });
  await app.call({ op: "view" });
  const task = (await show(ref)).children.find((c: any) => c.title === "Delegated plan task");
  const settled = await show(`v2test#${task.short_id}`);
  expect(settled.labels.some((l: any) => l.label === "needs-review")).toBe(true);
  expect(settled.issue.metadata.teammate).toBe("lead-mate");
  expect((await kata(["inbox", "--for", "v2-builder/lead-mate", "--json"])).requests.some((r: any) => r.ref.endsWith(task.short_id))).toBe(true);
  expect((await app.call({ op: "done", task: "Delegated plan task", message, evidence })).isError).toBeUndefined();
  expect((await app.call({ op: "done", task: "Lead step", message, evidence })).isError).toBeUndefined();
  await app.call({ op: "view" });
  expect((await show(ref)).issue.status).toBe("closed");
});

// The transcript session each close of an issue recorded; the store holds every earlier test's events, so page through all.
async function closeSessions(shortId: string) {
  const closed: any[] = [];
  for (let after = 0;;) {
    const page = await kata(["events", "--after", String(after), "--limit", "500", "--json"]);
    closed.push(...page.events.filter((e: any) => e.type === "issue.closed" && e.issue_short_id === shortId));
    if (page.events.length < 500) break;
    after = page.next_after_id;
  }
  return closed.map((e: any) => e.payload?.transcript?.session_id);
}

// A lead assigns one delegate, whose session header names `<name>-delegate`; with close transcripts on, the delegate plans
// one step and closes it through `todo done`. `midCall` runs once, inside the first Kata call of that done. Returns the
// sessions the step's closes recorded.
async function delegateStepCloseSessions(name: string, midCall?: (delegate: ReturnType<typeof host>) => void) {
  const lead = host({ sid: `${name}-lead`, transcript: true });
  await lead.event("session_start");
  const ref = await lead.init([`Delegated ${name} task`, `Lead ${name} step`]);
  const sessionFile = `${scratch}/delegate-${name}.jsonl`, id = `${name}.Delegate`;
  writeFileSync(sessionFile, `{"type":"session","version":3,"id":"${name}-delegate"}\n`);
  lead.emit("task:subagent:lifecycle", { id, status: "started", sessionFile, description: `Delegated ${name} task` });
  await lead.call({ op: "view" });
  const assigned = (await show(ref)).children.find((c: any) => c.metadata?.["omp.subagent_id"] === id);
  let armed = false;
  const delegate: ReturnType<typeof host> = host({ sessionFile, agent: { kind: "sub", id, parentId: lead.ctx.agent.id }, transcript: true,
    before: () => { if (armed) { armed = false; midCall?.(delegate); } } });
  await delegate.event("session_start");
  expect((await delegate.call({ op: "init", items: [`Delegate ${name} step`] })).isError).toBeUndefined();
  armed = true;
  const done = await delegate.call({ op: "done", task: `Delegate ${name} step`, message, evidence });
  expect(done.isError, done.content?.[0]?.text).toBeUndefined();
  expect(armed).toBe(false);
  const step = (await show(`v2test#${assigned.short_id}`)).children.find((c: any) => c.title === `Delegate ${name} step`);
  expect(step.status).toBe("closed");
  return await closeSessions(step.short_id);
}

test("an assigned delegate's own todo close records the delegate's session, not the lead's", async () => {
  expect(await delegateStepCloseSessions("transcript")).toEqual(["transcript-delegate"]);
});

test("a delegate's todo close keeps the delegate's session when another identity reaches its handlers mid-call", async () => {
  // omp's advisor runs as its own sub identity inside the session it advises.
  const advisor = (delegate: ReturnType<typeof host>) => { void delegate.event("tool_call", { toolName: "read", input: { path: "README.md" } }, { ...delegate.ctx, agent: { kind: "sub", id: "Advisor" } }); };
  expect(await delegateStepCloseSessions("swap", advisor)).toEqual(["swap-delegate"]);
});

test("delegate teammates differ across sessions that reuse an agent name", async () => {
  const teammates: string[] = [];
  for (const n of [1, 2]) {
    const app = host(); await app.event("session_start"); const ref = await app.init([`Reused agent name ${n}`]);
    app.emit("task:subagent:lifecycle", { id: "WriteTests", status: "started", sessionFile: `${scratch}/reused-name-${n}.jsonl`, description: `Reused agent name ${n}` });
    await app.call({ op: "view" });
    teammates.push((await show(ref)).children.find((c: any) => c.metadata?.["omp.subagent_id"] === "WriteTests").metadata.teammate);
  }
  expect(teammates[0]).not.toBe(teammates[1]);
});

test("adopting an explicit parent retires an empty automatic parent", async () => {
  const app = host({ before: (args: string[]) => args[0] === "create" && args.includes("--parent") ? { code: 1, stdout: "", stderr: "child create refused" } : undefined });
  await app.event("session_start");
  await app.call({ op: "init", items: ["Never created"] });
  const auto = (await app.call({ op: "view" })).details.kata.parent;
  expect(auto).toMatch(/^v2test#/);
  const explicit = await issue(); await kata(["claim", explicit, "--json"]);
  await app.event("tool_result", { toolName: "bash", input: { command: `kata claim ${explicit}` }, isError: false, details: { exitCode: 0 } });
  expect((await app.call({ op: "view" })).details.kata.parent).toBe(`v2test#${explicit}`);
  const retired = await show(auto);
  expect(retired.issue.status).toBe("closed");
  expect(retired.issue.closed_reason).toBe("superseded");
  expect((await show(explicit)).children ?? []).toHaveLength(0);
});

test("a long delegation spec binds the plan task its name describes", async () => {
  const plan = ["Implement word_count and top_words in textstats/__init__.py", "Write unittest suite in tests/ covering both functions incl. empty input (delegated to subagent)", "Run python3 -m unittest from repo root, all green", "Commit functions and tests"];
  const app = host(); await app.event("session_start");
  const hook = app.event("tool_call", { toolName: "task", toolCallId: "rerun-batch", input: { tasks: [{ name: "WriteTests", task: "# Target\nCreate `tests/__init__.py` (empty file) and `tests/test_textstats.py` in the current repo workspace. Do NOT create or modify anything else \u2014 in particular do NOT touch or create the `textstats/` package; its implementation lands in parallel and importing it now may fail.\n\n# Change\n1. `tests/__init__.py` \u2014 empty, so `python3 -m unittest` discovery from the repo root finds the suite.\n2. `tests/test_textstats.py` \u2014 unittest suite (e.g. TestWordCount, TestTopWords classes) covering: empty string and whitespace-only input for BOTH functions; basic multi-word counts; tabs/newlines/repeated spaces as separators; mixed-case collapsing to lowercase; tie-breaking alphabetical by word; `n == 0`; `n` greater than the number of distinct words; exact ordering of the returned list of tuples. Deterministic, stdlib only, no file/network I/O.\n\n# Acceptance\nBoth files exist and `python3 -m py_compile tests/test_textstats.py` succeeds. Do NOT run the suite against the package (implementation is mid-flight); a failing import at this stage is expected, not yours to fix." }] } });
  const ref = await app.init(plan);
  await hook;
  app.emit("task:subagent:lifecycle", { id: "WriteTests", status: "started", sessionFile: `${scratch}/rerun-batch.jsonl`, parentToolCallId: "rerun-batch", index: 0 });
  await app.call({ op: "view" });
  const children = (await show(ref)).children;
  expect(children).toHaveLength(4);
  expect(children.find((c: any) => c.title === plan[1]).metadata["omp.subagent_id"]).toBe("WriteTests");
});

test("a handed-back plan task can be delegated again", async () => {
  const app = host(); await app.event("session_start");
  const ref = await app.init(["Implement gadget", "Write gadget tests"]);
  for (const [n, state] of [[1, "completed"], [2, "started"]] as const) {
    const id = `regadget-${n}`, sessionFile = `${scratch}/${id}.jsonl`;
    expect(await app.event("tool_call", { toolName: "task", toolCallId: id, input: { name: "WriteTests", task: 'Complete "Write gadget tests"' } })).toBeUndefined();
    app.emit("task:subagent:lifecycle", { id, status: "started", sessionFile, parentToolCallId: id, index: 0 });
    await app.call({ op: "view" });
    if (state === "completed") { app.emit("task:subagent:lifecycle", { id, status: "completed", sessionFile }); await app.call({ op: "view" }); }
  }
  const children = (await show(ref)).children;
  expect(children).toHaveLength(2);
  expect(children.find((c: any) => c.title === "Write gadget tests").metadata["omp.subagent_id"]).toBe("regadget-2");
});

test("after a hand-back, a bare done closes the lead's own active task", async () => {
  const app = host(); await app.event("session_start");
  const ref = await app.init(["Write widget tests", "Implement widget"]);
  await app.event("tool_call", { toolName: "task", toolCallId: "bare-done", input: { task: 'Complete "Write widget tests"' } });
  const sessionFile = `${scratch}/bare-done.jsonl`;
  app.emit("task:subagent:lifecycle", { id: "bare-done", status: "started", sessionFile, parentToolCallId: "bare-done", index: 0 });
  await app.call({ op: "view" });
  expect((await app.call({ op: "start", task: "Implement widget" })).isError).toBeUndefined();
  await ran(app, "bare-done", sessionFile);
  app.emit("task:subagent:lifecycle", { id: "bare-done", status: "completed", sessionFile });
  await app.call({ op: "view" });
  expect((await app.call({ op: "done", message, evidence })).isError).toBeUndefined();
  const children = (await show(ref)).children;
  expect(children.find((c: any) => c.title === "Implement widget").status).toBe("closed");
  expect(children.find((c: any) => c.title === "Write widget tests").status).toBe("open");
});

test("a done plan task keeps its message and evidence as a comment, not only as the close reason", async () => {
  const app = host(); await app.event("session_start");
  const ref = await app.init(["Write widget tests"]);
  expect((await app.call({ op: "done", task: "Write widget tests", message, evidence })).isError).toBeUndefined();
  const child = (await show(ref)).children[0];
  expect(child.status).toBe("closed");
  expect(await commentsOf(child.short_id)).toEqual([`Done: ${message}\nEvidence: ${evidence.join(", ")}`]);
});

test("a task call that never spawns releases its plan task", async () => {
  const app = host(); await app.event("session_start"); await app.init(["Write gizmo tests"]);
  const input = { task: 'Complete "Write gizmo tests"' };
  expect(await app.event("tool_call", { toolName: "task", toolCallId: "denied", input })).toBeUndefined();
  await app.event("tool_result", { toolName: "task", toolCallId: "denied", isError: true, input });
  expect(await app.event("tool_call", { toolName: "task", toolCallId: "retry", input })).toBeUndefined();
});

// The lead's plan task a task call named, bound to a delegate whose start is reported after the call returned.
async function lateStart(app: ReturnType<typeof host>, ref: string, id: string) {
  app.emit("task:subagent:lifecycle", { id, status: "started", sessionFile: `${scratch}/${id}.jsonl`, parentToolCallId: id, index: 0 });
  await app.call({ op: "view" });
  return (await show(ref)).children.find((c: any) => c.title === "Write sprocket tests").metadata["omp.subagent_id"];
}

test("a synchronous task call that settled without a start leaves no assignment for a later start", async () => {
  const app = host(); await app.event("session_start"); const ref = await app.init(["Write sprocket tests"]);
  const input = { task: 'Complete "Write sprocket tests"' };
  await app.event("tool_call", { toolName: "task", toolCallId: "sync-gone", input });
  await app.event("tool_result", { toolName: "task", toolCallId: "sync-gone", isError: false, input, details: { results: [] } });
  expect(await lateStart(app, ref, "sync-gone")).toBeUndefined();
});

test("a background task call keeps its assignment for a late start until its jobs stop running", async () => {
  let running: any[] = [];
  const app = host({ snapshot: () => ({ running, recent: [] }) }); await app.event("session_start"); const ref = await app.init(["Write sprocket tests", "Write sprocket docs"]);
  const input = { task: 'Complete "Write sprocket tests"' };
  const details = { async: { state: "running", jobId: "job-1", type: "task" }, progress: [{ id: "late-1" }] };
  running = [{ id: "job-1", agentId: "late-1", type: "task", status: "running" }];
  await app.event("tool_call", { toolName: "task", toolCallId: "late-1", input });
  await app.event("tool_result", { toolName: "task", toolCallId: "late-1", isError: false, input, details });
  expect(await lateStart(app, ref, "late-1")).toBe("late-1");

  await app.event("tool_call", { toolName: "task", toolCallId: "late-2", input: { task: 'Complete "Write sprocket docs"' } });
  running = [{ id: "job-2", agentId: "late-2", type: "task", status: "running" }];
  await app.event("tool_result", { toolName: "task", toolCallId: "late-2", isError: false, input, details: { async: { jobId: "job-2" }, progress: [{ id: "late-2" }] } });
  running = [];
  await app.event("tool_call", { toolName: "read", input: { path: "README.md" } }); // any event reads the snapshot
  app.emit("task:subagent:lifecycle", { id: "late-2", status: "started", sessionFile: `${scratch}/late-2.jsonl`, parentToolCallId: "late-2", index: 0 });
  await app.call({ op: "view" });
  expect((await show(ref)).children.find((c: any) => c.title === "Write sprocket docs").metadata["omp.subagent_id"]).toBeUndefined();
});

// Hosted reads routinely take longer than the old one-second process deadline.
test("hosted show lasting over one second completes todo init", async () => {
  const ref = `v2test#${await issue()}`;
  const app = host({ before: async (args: string[], opts: any) => {
    if (args[0] !== "show") return;
    if (opts.timeout < 1100) return { code: 0, killed: true, stdout: "", stderr: "" };
  } });
  const result = await app.call({ op: "init", ref, items: ["Slow hosted read"] });
  expect(result.isError).toBeUndefined();
  expect(result.details.kata.parent).toBe(ref);
  expect((await show(ref)).children[0].title).toBe("Slow hosted read");
});

test("failed refresh never presents cached tasks as current and recovers on view", async () => {
  let unavailable = false;
  const app = host({ before: (args: string[]) => unavailable && args[0] === "show"
    ? { code: 1, stdout: "", stderr: "hosted service unavailable" } : undefined });
  const parent = await app.init(["Externally finished task"]);
  const task = (await show(parent)).children[0];
  await kata(["close", `v2test#${task.short_id}`, "--done", "--message", message, "--test", "external verification", "--json"]);
  unavailable = true;
  const failed = await app.call({ op: "view" });
  expect(failed.isError).toBe(true);
  expect(failed.content[0].text).toContain("hosted service unavailable");
  expect(failed.content[0].text).not.toContain("0/1 done");
  expect(failed.details.kata.phases).toEqual([]);
  expect(app.widgets.at(-1)[1]?.join(" ")).not.toContain("0/1 done");
  unavailable = false;
  const recovered = await app.call({ op: "view" });
  expect(recovered.isError).toBeUndefined();
  expect(recovered.details.kata.phases[0].tasks[0].status).toBe("completed");
});

test("failed initial binding is retried by view without losing the hosted plan", async () => {
  const original = host();
  const parent = await original.init(["Recover bound plan"]);
  let unavailable = true;
  process.env.KATA_REF = parent;
  const app = host({ before: (args: string[]) => unavailable && args[0] === "show"
    ? { code: 0, killed: true, stdout: "", stderr: "" } : undefined });
  await app.event("session_start");
  const failed = await app.call({ op: "view" });
  expect(failed.isError).toBe(true);
  expect(failed.content[0].text).toContain("timed out");
  expect(failed.content[0].text).not.toContain("No todo plan");
  unavailable = false;
  const recovered = await app.call({ op: "view" });
  expect(recovered.details.kata.parent).toBe(parent);
  expect(recovered.details.kata.phases[0].tasks[0].content).toBe("Recover bound plan");
});

for (const source of ["parameter", "environment", "stored"]) test(`qualified ${source} binding stays authoritative outside the project workspace`, async () => {
  const parent = `v2test#${await issue()}`;
  if (source === "environment") process.env.KATA_REF = parent;
  const app = host({ cwd: outside, ...(source === "stored" ? { entries: [{ type: "custom", customType: "io.kata.omp.parent", data: { parent, workspace: cwd } }] } : {}) });
  await app.event("session_start");
  const result = await app.call({ op: "init", ...(source === "parameter" ? { ref: parent } : {}), items: ["Hosted worker task"] });
  expect(result.isError).toBeUndefined();
  expect(result.details.kata.parent).toBe(parent);
  expect(result.content[0].text).not.toContain("Session-local");
  expect((await show(parent)).children[0].title).toBe("Hosted worker task");
});

test("an unavailable explicit hosted binding errors instead of creating a local plan", async () => {
  const app = host({ cwd: outside });
  const result = await app.call({ op: "init", ref: "v2test#zzzz", items: ["Never local"] });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).not.toContain("Session-local");
  expect(result.details.kata.phases).toEqual([]);
});

test("tracked worker todo uses its assigned issue and teammate from an unbound worktree", async () => {
  const lead = host();
  const parent = await lead.init(["Implement worker task"]);
  const sessionFile = `${scratch}/worker-todo.jsonl`;
  lead.emit("task:subagent:lifecycle", { id: "worker-todo", status: "started", sessionFile, description: "Implement worker task" });
  await lead.call({ op: "view" });
  const assigned = (await show(parent)).children.find((c: any) => c.metadata?.["omp.subagent_id"] === "worker-todo");
  // The lead's inherited reference must never become the delegate's plan.
  process.env.KATA_REF = parent;
  const worker = host({ cwd: outside, sessionFile, agent: { kind: "sub", id: "worker-todo", parentId: lead.ctx.agent.id } });
  const result = await worker.call({ op: "init", items: ["Verify assigned worker"] });
  expect(result.isError).toBeUndefined();
  expect(result.details.kata.parent).toBe(`v2test#${assigned.short_id}`);
  const tasks = (await show(`v2test#${assigned.short_id}`)).children;
  expect(tasks[0].title).toBe("Verify assigned worker");
  expect(tasks[0].metadata.teammate).toBe(assigned.metadata.teammate);
  expect((await worker.call({ op: "done", message, evidence })).isError).toBeUndefined();
  expect((await show(`v2test#${tasks[0].short_id}`)).issue.status).toBe("closed");
  expect((await show(parent)).issue.status).toBe("open");
  expect(worker.widgets).toEqual([]);
});

for (const children of [0, {}, [null]]) test(`malformed hosted children ${JSON.stringify(children)} never expose a cached plan`, async () => {
  let corrupt = false;
  const app = host({ before: (args: string[]) => corrupt && args[0] === "show"
    ? { code: 0, stdout: JSON.stringify({ issue: {}, children }), stderr: "" } : undefined });
  await app.init(["Cached task"]);
  corrupt = true;
  const result = await app.call({ op: "view" });
  expect(result.isError).toBe(true);
  expect(result.details.kata.phases).toEqual([]);
  expect(result.content[0].text).not.toContain("0/1 done");
});

test("a pending stop-hook refresh does not describe cached tasks as current", async () => {
  let outage = false;
  const app = host({ before: async (args: string[]) => {
    if (!outage || args[0] !== "show") return;
    await new Promise(resolve => setTimeout(resolve, 400));
    return { code: 1, stdout: "", stderr: "slow read outage" };
  } });
  await app.init(["Cached stop task"]);
  outage = true;
  expect(await app.event("session_stop", { messages: [] })).toBeUndefined();
  await app.call({ op: "view" }); // drain the background hook
});

test("a sub identity cannot reuse the main adapter's bound session", async () => {
  const app = host();
  const parent = await app.init(["Main task"]);
  const before = app.calls.length;
  const result = await app.call({ op: "init", items: ["Foreign task"] }, { ...app.ctx, agent: { kind: "sub", id: "advisor" } });
  expect(result.isError).toBe(true);
  expect(app.calls.slice(before).some(a => ["create", "close", "meta"].includes(a[0]))).toBe(false);
  expect((await show(parent)).children.map((c: any) => c.title)).toEqual(["Main task"]);
});

// Generated malformed response values must not turn the last good snapshot
// into an authoritative response. {} is the named shrunk regression above.
test("arbitrary non-array hosted children never expose cached state", async () => {
  let children: unknown;
  let corrupt = false;
  const app = host({ before: (args: string[]) => corrupt && args[0] === "show"
    ? { code: 0, stdout: JSON.stringify({ issue: {}, children }), stderr: "" } : undefined });
  await app.init(["Property cached task"]);
  corrupt = true;
  await fc.assert(fc.asyncProperty(fc.jsonValue().filter(value => value !== null && !Array.isArray(value)), async value => {
    children = value;
    const result = await app.call({ op: "view" });
    expect(result.isError).toBe(true);
    expect(result.details.kata.phases).toEqual([]);
    expect(result.content[0].text).not.toContain("0/1 done");
  }), { numRuns: 100, seed: 251025 });
});

test("a later init can replace a parameter-bound parent", async () => {
  const first = `v2test#${await issue()}`, next = `v2test#${await issue()}`;
  const app = host();
  await app.call({ op: "init", ref: first, items: ["First plan"] });
  const result = await app.call({ op: "init", ref: next, items: ["Next plan"] });
  expect(result.details.kata.parent).toBe(next);
  expect((await show(next)).children[0].title).toBe("Next plan");
});

test("view retries a failed parameter binding rather than reporting no plan", async () => {
  const parent = `v2test#${await issue()}`;
  let fail = true;
  const app = host({ cwd: outside, before: (args: string[]) => fail && args[0] === "show" ? { code: 1, stdout: "", stderr: "read outage" } : undefined });
  expect((await app.call({ op: "init", ref: parent, items: ["Pending init"] })).isError).toBe(true);
  fail = false;
  expect((await app.call({ op: "view" })).details.kata.parent).toBe(parent);
});

for (const error of ["project vault not found", "no project access: permission denied"]) test(`project error is never local fallback: ${error}`, async () => {
  const app = host({ before: (args: string[]) => args[0] === "list" ? { code: 1, stdout: "", stderr: error } : undefined });
  const result = await app.call({ op: "init", items: ["Hosted only"] });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).not.toContain("Session-local");
});

test("an assigned delegate fetches the contract with its exact hook arguments", async () => {
  const lead = host();
  await lead.init(["Lead contract task"]);
  const sessionFile = `${scratch}/worker-contract.jsonl`;
  lead.emit("task:subagent:lifecycle", { id: "worker-contract", status: "started", sessionFile, description: "Lead contract task" });
  await lead.call({ op: "view" });
  const worker = host({ sessionFile, agent: { kind: "sub", id: "worker-contract" }, before: (args: string[]) => {
    // Kata's hook contract requires the source selector without extra flags.
    if (args[0] === "agent-contract-hook" && args.length !== 3) return { code: 0, stdout: "", stderr: "" };
  } });
  expect((await worker.call({ op: "init", items: ["Worker contract task"] })).isError).toBeUndefined();
  await worker.event("before_agent_start", { systemPrompt: [] });
  await worker.contractReady;
  const prompt = await worker.event("before_agent_start", { systemPrompt: [] });
  const contract = JSON.parse((await run(["agent-contract-hook", "--source", "kata-agent-contract-hook"])).stdout).hookSpecificOutput.additionalContext;
  expect(prompt.systemPrompt.join("\n")).toContain(contract);
});

test("a failed assignment reports the preparation error and recovers after it clears", async () => {
  let unavailable = false;
  const lead = host({ before: (args: string[]) => unavailable && args[0] === "meta" && args[3] === "omp.subagent_id"
    ? { code: 1, stdout: "", stderr: "delegation service permission denied" } : undefined });
  const parent = await lead.init(["Lead error task"]);
  unavailable = true;
  const sessionFile = `${scratch}/worker-error.jsonl`;
  lead.emit("task:subagent:lifecycle", { id: "worker-error", status: "started", sessionFile, description: "Lead error task" });
  await lead.call({ op: "view" });
  const worker = host({ sessionFile, agent: { kind: "sub", id: "worker-error" } });
  const failed = await worker.call({ op: "init", items: ["Worker error task"] });
  expect(failed.isError).toBe(true);
  expect(failed.content[0].text).toContain("delegation service permission denied");
  expect((await show(parent)).children).toHaveLength(1);
  unavailable = false;
  const recovered = await worker.call({ op: "init", items: ["Worker error task"] });
  expect(recovered.isError).toBeUndefined();
  expect(recovered.content[0].text).not.toContain("permission denied");
});

test("a revive before_agent_start makes no Kata calls while a prompt still injects the contract", async () => {
  const app = host(); await app.event("session_start"); await app.contractReady;
  const before = app.calls.length;
  const revive = await app.event("before_agent_start", { reason: "revive", systemPrompt: ["base"] });
  expect(revive).toBeUndefined();
  expect(app.calls.length).toBe(before);
  const prompt = await app.event("before_agent_start", { reason: "prompt", systemPrompt: ["base"] });
  expect(prompt.systemPrompt.join("\n")).toContain("<kata_contract>");
});

test("a request sent mid-session reaches the inbox section by the next turn and clearing removes it", async () => {
  process.env.KATA_INBOX_USER = "v2-builder/midsession";
  const app = host(); await app.event("session_start"); await app.contractReady;
  const ref = await issue();
  const turn = async () => (await app.event("before_agent_start", { systemPrompt: ["base"] })).systemPrompt.join("\n");
  expect(await turn()).not.toContain("<kata_inbox>");
  await kata(["notify", ref, "--to", "v2-builder/midsession", "--message", "midsession-ping-7731", "--json"]);
  await turn();
  const delivered = await turn();
  expect(delivered).toContain("<kata_inbox>");
  expect(delivered).toContain("midsession-ping-7731");
  await kata(["notify", ref, "--to", "v2-builder/midsession", "--clear", "--json"]);
  await turn();
  expect(await turn()).not.toContain("midsession-ping-7731");
});

test("only requests from the session's own actor reach the inbox section", async () => {
  process.env.KATA_INBOX_USER = "v2-builder/trust";
  const app = host(); await app.event("session_start"); await app.contractReady;
  const [first, second] = [await issue(), await issue()];
  const turn = async () => { await app.event("before_agent_start", { systemPrompt: ["base"] }); return (await app.event("before_agent_start", { systemPrompt: ["base"] })).systemPrompt.join("\n"); };
  const asMallory = (args: string[]) => run(args, cwd, 5000, { KATA_AUTHOR: "mallory" });
  expect((await asMallory(["notify", first, "--to", "v2-builder/trust", "--message", "forged-order-4410", "--json"])).code).toBe(0);
  expect((await asMallory(["notify", second, "--to", "v2-builder/trust", "--message", "forged-order-4411", "--json"])).code).toBe(0);
  const quiet = await turn();
  expect(quiet).not.toContain("forged-order-441");
  expect(quiet).not.toContain("<kata_inbox>");
  await kata(["notify", first, "--to", "v2-builder/trust", "--message", "genuine \"note\" 4412", "--json"]);
  const shown = await turn();
  expect(shown).toContain("<kata_inbox>");
  expect(shown).toContain(`Kata inbox for "v2-builder/trust".`);
  expect(shown).toContain(`from="v2-builder" message="genuine \\"note\\" 4412"`);
  expect(shown).not.toContain("forged-order-441");
  expect(app.calls.filter(a => a[0] === "inbox").every(a => a.includes("--json") && !a.includes("--context"))).toBe(true);
  await kata(["notify", first, "--to", "v2-builder/trust", "--clear", "--json"]);
  expect(await turn()).not.toContain("<kata_inbox>");
  await asMallory(["notify", first, "--to", "v2-builder/trust", "--clear", "--json"]);
  await asMallory(["notify", second, "--to", "v2-builder/trust", "--clear", "--json"]);
});

test("a long trusted inbox is capped like kata inbox --context with an omitted note", async () => {
  process.env.KATA_INBOX_USER = "v2-builder/capped";
  const app = host(); await app.event("session_start"); await app.contractReady;
  const refs: string[] = [];
  for (let i = 0; i < 12; i++) refs.push(await issue());
  for (const [i, ref] of refs.entries()) await kata(["notify", ref, "--to", "v2-builder/capped", "--message", `${String(i).padStart(2, "0")}-${"x".repeat(1000)}`, "--json"]);
  await app.event("before_agent_start", { systemPrompt: ["base"] });
  const prompt = (await app.event("before_agent_start", { systemPrompt: ["base"] })).systemPrompt.join("\n");
  const section = prompt.slice(prompt.indexOf("Kata inbox for"), prompt.indexOf("</kata_inbox>"));
  const rows = section.split("\n").filter(l => l.startsWith("- issue="));
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.length).toBeLessThan(12);
  expect(Buffer.byteLength(section)).toBeLessThanOrEqual(8 * 1024);
  expect(section).toContain(`${12 - rows.length} request(s) omitted; run kata inbox without --context`);
  expect(section).not.toContain("truncated");
  for (const ref of refs) await kata(["notify", ref, "--to", "v2-builder/capped", "--clear", "--json"]);
});

test("a bare actor in KATA_INBOX_USER is a person's inbox: the session reads none and says so once", async () => {
  process.env.KATA_INBOX_USER = "v2-builder";
  const app = host(); await app.event("session_start"); await app.contractReady;
  const ref = await issue();
  await kata(["notify", ref, "--to", "v2-builder", "--message", "person-only-request-5521", "--json"]);
  const turn = async () => (await app.event("before_agent_start", { systemPrompt: ["base"] })).systemPrompt.join("\n");
  for (let i = 0; i < 3; i++) expect(await turn()).not.toContain("person-only-request-5521");
  expect(app.calls.filter(a => a[0] === "inbox")).toEqual([]);
  expect(app.notices).toHaveLength(1);
  expect(app.notices[0][0]).toContain("v2-builder/<name>");
  await kata(["notify", ref, "--to", "v2-builder", "--clear", "--json"]);
  // A trailing slash names no teammate: still a person's inbox.
  process.env.KATA_INBOX_USER = "v2-builder/";
  const slashed = host(); await slashed.event("session_start"); await slashed.contractReady;
  await slashed.event("before_agent_start", { systemPrompt: ["base"] });
  expect(slashed.calls.filter(a => a[0] === "inbox")).toEqual([]);
  expect(slashed.notices).toHaveLength(1);
});

// ---------------------------------------------------------- items naming tickets
const total = async () => (await kata(["list", "--status", "all", "--limit", "0", "--json"])).issues.length;
const ofSession = async (sid: string) => (await kata(["list", "--status", "all", "--meta", `omp.session_id=${sid}`, "--json"])).issues;
const commentsOf = async (ref: string): Promise<string[]> => ((await show(ref)).comments ?? []).map((c: any) => c.body);
const closesOf = async (short: string) => (await kata(["audit", "closes", "--json"])).rows.filter((r: any) => r.issue === short);
const namingPlan = (a: string, b: string) => [
  { phase: "Smoke test", items: [`v2test#${a}: write the script`, `v2test#${a}: bump the version`] },
  { phase: "Inbox", items: [`v2test#${b}: fetch the inbox`] },
];

test("a plan whose items name tickets creates no issue and no automatic parent", async () => {
  const app = host(); await app.event("session_start");
  const [a, b] = [await issue("Ticket A"), await issue("Ticket B")];
  const before = await total();
  const result = await app.call({ op: "init", list: namingPlan(a, b) });
  expect(result.isError).toBeUndefined();
  expect(await total()).toBe(before);
  expect(await ofSession(app.sid)).toHaveLength(0);
  expect(result.details.kata.parent).toBeUndefined();
  const text = result.content[0].text;
  expect(text).toContain(`[/] v2test#${a}: write the script (v2test#${a})`);
  expect(text).toContain(`[ ] v2test#${b}: fetch the inbox (v2test#${b})`);
  const started = (await show(a)).issue;
  expect(started.owner).toBe("v2-builder");
  expect(started.metadata["todo.status"]).toBe("in_progress");
  expect(started.metadata["todo.phase"]).toBeUndefined();
  expect((await show(b)).issue.owner).toBeUndefined();
  expect(app.widgets.at(-1)![1]![0]).toContain(`v2test#${a}: write the script`);
});

test("an item without a ref in a plan of tickets creates exactly that issue and the automatic parent", async () => {
  const app = host(); await app.event("session_start");
  const [a, b] = [await issue("Ticket A"), await issue("Ticket B")];
  await app.call({ op: "init", list: namingPlan(a, b) });
  const before = await total();
  const appended = await app.call({ op: "append", items: ["update CHANGELOG"], phase: "Inbox" });
  expect(appended.isError).toBeUndefined();
  expect(await total()).toBe(before + 2);
  const [parent, ...rest] = [await ofSession(app.sid)].flatMap(list => list.sort((x: any, y: any) => x.id - y.id));
  expect(rest).toHaveLength(0);
  const ref = appended.details.kata.parent;
  expect((await show(ref)).children.map((c: any) => c.title)).toEqual(["update CHANGELOG"]);
  expect(parent.metadata["omp.auto_parent"]).toBe(true);
  expect((await show(a)).issue.metadata["omp.session_id"]).toBeUndefined();
  expect(appended.content[0].text).toContain("update CHANGELOG");
});

test("with an init ref, items without a ref become children of it and named items stay on their tickets", async () => {
  const [parent, a] = [await issue("Umbrella"), await issue("Ticket A")];
  const app = host(); await app.event("session_start");
  const before = await total();
  const result = await app.call({ op: "init", ref: parent, items: [`v2test#${a}: write the script`, "update the docs"] });
  expect(result.isError).toBeUndefined();
  expect(await total()).toBe(before + 1);
  expect((await show(`v2test#${parent}`)).children.map((c: any) => c.title)).toEqual(["update the docs"]);
  expect((await show(a)).issue.metadata["todo.phase"]).toBeUndefined();
});

test("finishing every item of a ticket closes it once with the last item's evidence, earlier items leave comments", async () => {
  const app = host(); await app.event("session_start");
  const a = await issue("Ticket A");
  await app.call({ op: "init", items: [`v2test#${a}: write the script`, `v2test#${a}: bump the version`] });
  const first = await app.call({ op: "done", task: `v2test#${a}: write the script`, message: `${message} (first part)`, evidence: ["test:first item check"] });
  expect(first.isError).toBeUndefined();
  expect((await show(a)).issue.status).toBe("open");
  let comments = await commentsOf(a);
  expect(comments).toHaveLength(1);
  expect(comments[0]).toContain("write the script");
  expect(comments[0]).toContain("(first part)");
  expect(comments[0]).toContain("test:first item check");
  expect(first.content[0].text).toContain(`[/] v2test#${a}: bump the version`);
  const last = await app.call({ op: "done", task: `v2test#${a}: bump the version`, message: `${message} (second part)`, evidence: ["test:second item check"] });
  expect(last.isError).toBeUndefined();
  expect((await show(a)).issue.status).toBe("closed");
  comments = await commentsOf(a);
  expect(comments).toHaveLength(2);
  expect(comments[1]).toContain("test:second item check");
  const rows = await closesOf(a);
  expect(rows).toHaveLength(1);
  const event = (await kata(["events", "--after", String(rows[0].event_id - 1), "--limit", "1", "--json"])).events[0];
  expect(event.payload.evidence).toEqual([{ type: "test", command: "second item check" }]);
  expect(last.content[0].text).toContain("2/2 done");
});

test("appending a ticket item again in a plan of only tickets works without a parent issue", async () => {
  const app = host(); await app.event("session_start");
  const a = await issue("Ticket A");
  const before = await total();
  const init = await app.call({ op: "init", items: [`v2test#${a}: write the script`] });
  expect(init.isError).toBeUndefined();
  const again = await app.call({ op: "append", task: `v2test#${a}: write the script` });
  expect(again.isError).toBeUndefined();
  expect(again.content[0].text).toContain(`v2test#${a}: write the script`);
  const done = await app.call({ op: "done", task: `v2test#${a}: write the script`, message, evidence: ["test:ticket item check"] });
  expect(done.isError).toBeUndefined();
  const reappended = await app.call({ op: "append", task: `v2test#${a}: write the script` });
  expect(reappended.isError).toBe(true);
  expect(reappended.content[0].text).toMatch(/already closed/i);
  expect(await total()).toBe(before);
  expect(await ofSession(app.sid)).toHaveLength(0);
});

test("appending an open ticket item again in a plan with a parent creates no child and no error", async () => {
  const app = host(); await app.event("session_start");
  const a = await issue("Ticket A");
  const init = await app.call({ op: "init", items: ["update the docs", `v2test#${a}: write the script`] });
  expect(init.isError).toBeUndefined();
  const ref = init.details.kata.parent;
  const before = await total();
  const again = await app.call({ op: "append", task: `v2test#${a}: write the script` });
  expect(again.isError).toBeUndefined();
  expect(await total()).toBe(before);
  expect((await show(ref)).children.map((c: any) => c.title)).toEqual(["update the docs"]);
});

test("an unresolvable or closed ref is an error that creates nothing; a bare id names no ticket", async () => {
  const app = host(); await app.event("session_start");
  const before = await total();
  const ghost = await app.call({ op: "init", items: ["Plain item first", "v2test#zzzz: ghost work"] });
  expect(ghost.isError).toBe(true);
  expect(ghost.content[0].text).toContain("v2test#zzzz");
  expect(await total()).toBe(before);
  expect(await ofSession(app.sid)).toHaveLength(0);
  const closed = await issue("Closed work"); await kata(["close", closed, "--done", "--message", message, "--test", "closed-item-fixture", "--json"]);
  const done = await app.call({ op: "init", items: [`v2test#${closed}: more work`] });
  expect(done.isError).toBe(true);
  expect(done.content[0].text).toMatch(/already closed/i);
  expect(await total()).toBe(before + 1); // only the ticket this test closed
  const open = await issue("Open work");
  const bare = await app.call({ op: "init", items: [`${open}: bare id is only text`] });
  expect(bare.isError).toBeUndefined();
  expect((await show(open)).issue.owner).toBeUndefined();
  expect((await ofSession(app.sid))).toHaveLength(1);
});

test("drop and rm of an item that names a ticket only comment and leave it open", async () => {
  const app = host(); await app.event("session_start");
  const a = await issue("Ticket A");
  await app.call({ op: "init", items: [`v2test#${a}: first step`, `v2test#${a}: second step`] });
  const dropped = await app.call({ op: "drop", task: `v2test#${a}: first step`, message: "The first step is no longer needed here." });
  expect(dropped.isError).toBeUndefined();
  expect(dropped.content[0].text).toContain(`[~] v2test#${a}: first step`);
  const removed = await app.call({ op: "rm", task: `v2test#${a}: second step`, message: "The second step moved elsewhere." });
  expect(removed.isError).toBeUndefined();
  const shown = (await show(a)).issue;
  expect(shown.status).toBe("open");
  expect(shown.closed_reason).toBeFalsy();
  const comments = await commentsOf(a);
  expect(comments).toHaveLength(2);
  expect(comments[0]).toContain("no longer needed");
  expect(comments[1]).toContain("moved elsewhere");
  expect(await closesOf(a)).toHaveLength(0);
});

test("an item that stops working a ticket resets its work state", async () => {
  const app = host(); await app.event("session_start");
  const a = await issue("Ticket A");
  await app.call({ op: "init", items: [`v2test#${a}: only step`] });
  expect((await show(a)).issue.metadata["todo.status"]).toBe("in_progress");
  await app.call({ op: "drop", task: `v2test#${a}: only step`, message: "No longer needed for this ticket." });
  const dropped = (await show(a)).issue;
  expect(dropped.status).toBe("open");
  expect(dropped.metadata["todo.status"]).toBe("pending");
  expect(dropped.metadata["work.attention"]).toBe("ok");
  expect(dropped.metadata["work.attention_msg"]).toBeUndefined();

  const b = await issue("Ticket B");
  await app.call({ op: "init", items: [`v2test#${b}: first step`, `v2test#${b}: second step`] });
  await app.call({ op: "block", task: `v2test#${b}: first step`, reason: "Waiting on a vendor reply" });
  const done = await app.call({ op: "done", task: `v2test#${b}: first step`, message, evidence });
  expect(done.isError).toBeUndefined();
  const after = (await show(b)).issue;
  expect(after.status).toBe("open");
  expect(after.metadata["work.attention"]).toBe("ok");
  expect(after.metadata["work.attention_msg"]).toBeUndefined();
});

test("an item finished, appended again and finished again comments and closes a second time", async () => {
  const app = host(); await app.event("session_start");
  const a = await issue("Ticket A");
  const item = `v2test#${a}: repeat step`;
  await app.call({ op: "init", items: [item] });
  await app.call({ op: "done", task: item, message, evidence });
  expect((await show(a)).issue.status).toBe("closed");
  await kata(["reopen", a, "--json"]);
  const again = await app.call({ op: "append", items: [item] });
  expect(again.isError).toBeUndefined();
  const second = await app.call({ op: "done", task: item, message, evidence });
  if (second.isError) throw new Error(second.content[0].text);
  expect(second.isError).toBeUndefined();
  expect((await show(a)).issue.status).toBe("closed");
  expect(await commentsOf(a)).toHaveLength(2);
  expect(await closesOf(a)).toHaveLength(2);
});

test("a ticket another writer owns or that closed meanwhile is an error, never a fallback or a reopen", async () => {
  const app = host(); await app.event("session_start");
  const foreign = await issue("Foreign work"); await kata(["claim", foreign, "--as", "someone-else", "--json"]);
  const before = await total();
  const refused = await app.call({ op: "init", items: [`v2test#${foreign}: take it over`] });
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toMatch(/someone-else|not owned/);
  expect(await total()).toBe(before);
  expect((await show(foreign)).issue.owner).toBe("someone-else");
  const a = await issue("Ticket A");
  await app.call({ op: "init", items: [`v2test#${a}: first step`, `v2test#${a}: second step`] });
  await kata(["close", a, "--done", "--message", message, "--test", "closed-meanwhile", "--json"]);
  const restart = await app.call({ op: "start", task: `v2test#${a}: second step` });
  expect(restart.isError).toBe(true);
  expect(restart.content[0].text).toMatch(/already closed/i);
  expect((await app.call({ op: "done", task: `v2test#${a}: first step`, message, evidence })).isError).toBeUndefined();
  expect((await show(a)).issue.status).toBe("closed");
  expect(app.calls.some(c => c[0] === "reopen")).toBe(false);
  expect(await commentsOf(a)).toHaveLength(0);
});

test("a ticket with open children stays open when its last item is done, with a comment saying why", async () => {
  const app = host(); await app.event("session_start");
  const umbrella = await issue("Umbrella");
  await kata(["create", "Child work", "--parent", umbrella, "--force-new", "--json"]);
  await app.call({ op: "init", items: [`v2test#${umbrella}: finish the umbrella`] });
  const done = await app.call({ op: "done", message, evidence });
  expect(done.isError).toBeUndefined();
  expect(done.content[0].text).toContain(`[x] v2test#${umbrella}: finish the umbrella`);
  expect((await show(umbrella)).issue.status).toBe("open");
  const comments = await commentsOf(umbrella);
  expect(comments).toHaveLength(2);
  expect(comments[0]).toContain("test:bun test fixture");
  expect(comments[1]).toMatch(/1 open child/);
  expect(await closesOf(umbrella)).toHaveLength(0);
});

const blockingComments = async (ref: string) => (await commentsOf(ref)).filter(c => /open child|open children/.test(c));
const closeCalls = (app: { calls: string[][] }, ref: string) => app.calls.filter(c => c[0] === "close" && c[1].endsWith(`#${ref}`));

test("a claimed ticket named by an item closes once its plan children close, with the ticket item's evidence", async () => {
  const app = host(); await app.event("session_start");
  const ticket = await issue("Claimed ticket"); await kata(["claim", ticket, "--json"]);
  await app.event("tool_result", { toolName: "bash", input: { command: `kata claim v2test#${ticket}` }, isError: false, details: { exitCode: 0 } });
  const init = await app.call({ op: "init", items: [`v2test#${ticket}: write the greeting`, "Add the ignore file"] });
  expect(init.isError, init.content[0].text).toBeUndefined();
  expect(init.details.kata.parent).toBe(`v2test#${ticket}`);
  await app.call({ op: "done", task: `v2test#${ticket}: write the greeting`, message, evidence: ["test:ticket item evidence"] });
  expect((await show(ticket)).issue.status).toBe("open");
  expect(await blockingComments(ticket)).toHaveLength(1);
  expect((await blockingComments(ticket))[0]).toMatch(/closes once that child is closed/);
  const last = await app.call({ op: "done", task: "Add the ignore file", message, evidence });
  expect(last.isError, last.content[0].text).toBeUndefined();
  const closed = await show(ticket);
  expect(closed.issue.status).toBe("closed");
  expect(await closesOf(ticket)).toHaveLength(1);
  expect(JSON.stringify(closed)).toContain("test:ticket item evidence");
  expect(await blockingComments(ticket)).toHaveLength(1);
});

test("an umbrella ticket stays open after its outside children close, even across resume", async () => {
  const app = host(); await app.event("session_start");
  const umbrella = await issue("Umbrella with outside child"), other = await issue("Other ticket");
  const outside = (await kata(["create", "Outside child", "--parent", umbrella, "--force-new", "--json"])).issue.short_id;
  await app.call({ op: "init", items: [`v2test#${umbrella}: finish the umbrella`, `v2test#${other}: unrelated step`] });
  await app.call({ op: "done", task: `v2test#${umbrella}: finish the umbrella`, message, evidence });
  expect(await blockingComments(umbrella)).toHaveLength(1);
  expect((await blockingComments(umbrella))[0]).toMatch(/outside this todo plan, so close the ticket yourself/);
  await kata(["close", outside, "--done", "--message", message, "--test", "closed outside", "--json"]);
  await app.call({ op: "done", task: `v2test#${other}: unrelated step`, message, evidence });
  const resumed = host({ sid: app.sid, entries: app.entries }); await resumed.event("session_start");
  await resumed.call({ op: "view" }); await resumed.event("session_shutdown");
  expect((await show(umbrella)).issue.status).toBe("open");
  expect(closeCalls(app, umbrella)).toHaveLength(1);
  expect(closeCalls(resumed, umbrella)).toHaveLength(0);
});

test("a ticket whose open child is named by another plan item closes after that child closes", async () => {
  const app = host(); await app.event("session_start");
  const parent = await issue("Parent ticket");
  const child = (await kata(["create", "Named child", "--parent", parent, "--force-new", "--json"])).issue.short_id;
  await app.call({ op: "init", items: [`v2test#${parent}: finish the parent`, `v2test#${child}: finish the child`] });
  await app.call({ op: "done", task: `v2test#${parent}: finish the parent`, message, evidence: ["test:parent item evidence"] });
  expect(await blockingComments(parent)).toHaveLength(1);
  expect((await blockingComments(parent))[0]).toMatch(/closes once that child is closed/);
  const last = await app.call({ op: "done", task: `v2test#${child}: finish the child`, message, evidence });
  expect(last.isError, last.content[0].text).toBeUndefined();
  expect((await show(child)).issue.status).toBe("closed");
  const closed = await show(parent);
  expect(closed.issue.status).toBe("closed");
  expect(JSON.stringify(closed)).toContain("test:parent item evidence");
  expect(await blockingComments(parent)).toHaveLength(1);
});

test("an umbrella ticket whose open child is outside the plan stays open without repeated close attempts or comments", async () => {
  const app = host(); await app.event("session_start");
  const umbrella = await issue("Umbrella"), other = await issue("Other ticket");
  await kata(["create", "Outside child", "--parent", umbrella, "--force-new", "--json"]);
  await app.call({ op: "init", items: [`v2test#${umbrella}: finish the umbrella`, `v2test#${other}: unrelated step`] });
  await app.call({ op: "done", task: `v2test#${umbrella}: finish the umbrella`, message, evidence });
  await app.call({ op: "done", task: `v2test#${other}: unrelated step`, message, evidence });
  await app.call({ op: "view" });
  await app.event("session_shutdown");
  expect((await show(umbrella)).issue.status).toBe("open");
  expect((await show(other)).issue.status).toBe("closed");
  expect(await blockingComments(umbrella)).toHaveLength(1);
  expect(closeCalls(app, umbrella)).toHaveLength(1);
});

test("a pending ticket close survives resume and closes once the children close", async () => {
  const first = host(); await first.event("session_start");
  const ticket = await issue("Resumed ticket"); await kata(["claim", ticket, "--json"]);
  await first.event("tool_result", { toolName: "bash", input: { command: `kata claim v2test#${ticket}` }, isError: false, details: { exitCode: 0 } });
  await first.call({ op: "init", items: [`v2test#${ticket}: ship it`, "Plain step"] });
  await first.call({ op: "done", task: `v2test#${ticket}: ship it`, message, evidence: ["test:survives resume"] });
  const resumed = host({ sid: first.sid, entries: first.entries }); await resumed.event("session_start");
  const child = (await show(ticket)).children[0].short_id;
  await kata(["close", child, "--done", "--message", message, "--test", "closed outside", "--json"]);
  await resumed.event("session_shutdown");
  const closed = await show(ticket);
  expect(closed.issue.status).toBe("closed");
  expect(JSON.stringify(closed)).toContain("test:survives resume");
  expect(await blockingComments(ticket)).toHaveLength(1);
});

test("a done replayed after the close failed leaves one comment and closes once", async () => {
  let outage = true;
  const app = host({ before: (args: string[]) => args[0] === "close" && outage ? down() : undefined }); await app.event("session_start");
  const a = await issue("Ticket A");
  await app.call({ op: "init", items: [`v2test#${a}: only step`] });
  const failed = await app.call({ op: "done", message, evidence });
  expect(failed.isError).toBe(true);
  expect(await commentsOf(a)).toHaveLength(1);
  outage = false;
  const replayed = await app.call({ op: "done", task: `v2test#${a}: only step`, message, evidence });
  expect(replayed.isError).toBeUndefined();
  expect(await commentsOf(a)).toHaveLength(1);
  expect((await show(a)).issue.status).toBe("closed");
  expect(await closesOf(a)).toHaveLength(1);
});

test("the item-to-ticket record survives a resumed session", async () => {
  const first = host(); await first.event("session_start");
  const a = await issue("Ticket A");
  await first.call({ op: "init", items: [`v2test#${a}: first step`, `v2test#${a}: second step`] });
  await first.call({ op: "done", task: `v2test#${a}: first step`, message, evidence });
  const resumed = host({ sid: first.sid, entries: first.entries }); await resumed.event("session_start");
  const view = (await resumed.call({ op: "view" })).content[0].text;
  expect(view).toContain(`[x] v2test#${a}: first step (v2test#${a})`);
  expect(view).toContain(`v2test#${a}: second step (v2test#${a})`);
  expect((await resumed.call({ op: "done", task: `v2test#${a}: second step`, message, evidence })).isError).toBeUndefined();
  expect((await show(a)).issue.status).toBe("closed");
  expect(await commentsOf(a)).toHaveLength(2);
});

test("a task delegated to an item that names a ticket works that ticket and creates no issue", async () => {
  const app = host(); await app.event("session_start");
  const a = await issue("Ticket A");
  await app.call({ op: "init", items: [`v2test#${a}: write the widget parser`] });
  const before = await total();
  await app.event("tool_call", { toolName: "task", toolCallId: "named-item", input: { name: "Parser", task: "Write the widget parser and report back." } });
  app.emit("task:subagent:lifecycle", { id: "named-item", status: "started", sessionFile: `${scratch}/named-item.jsonl`, parentToolCallId: "named-item", index: 0 });
  await app.call({ op: "view" });
  expect((await show(a)).issue.metadata["omp.subagent_id"]).toBe("named-item");
  expect(await total()).toBe(before);
  expect(await ofSession(app.sid)).toHaveLength(1); // the delegated ticket itself
  const refused = await app.call({ op: "done", task: `v2test#${a}: write the widget parser`, message, evidence });
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toMatch(/delegated/i);
});

test("an item follows its ticket when a delegate closes it: shown completed, no reminder, done is no error", async () => {
  const app = host(); await app.event("session_start");
  const a = await issue("Ticket A");
  await app.call({ op: "init", items: [`v2test#${a}: write the gadget parser`, `v2test#${a}: document the gadget parser`] });
  await app.event("tool_call", { toolName: "task", toolCallId: "follow", input: { name: "Parser", task: `Finish v2test#${a} and close it.` } });
  app.emit("task:subagent:lifecycle", { id: "follow", status: "started", sessionFile: `${scratch}/follow.jsonl`, parentToolCallId: "follow", index: 0 });
  await app.call({ op: "view" });
  await kata(["close", a, "--done", "--message", message, "--test", "delegate-closed-it", "--json"]);
  const view = (await app.call({ op: "view" })).content[0].text;
  expect(view).toContain(`[x] v2test#${a}: write the gadget parser`);
  expect(view).toContain(`[x] v2test#${a}: document the gadget parser`);
  expect(await app.event("session_stop", { messages: [] })).toBeUndefined();
  const again = await app.call({ op: "done", task: `v2test#${a}: write the gadget parser`, message, evidence });
  expect(again.isError).toBeUndefined();
  expect(await commentsOf(a)).toHaveLength(0);
});

test("an item follows a wontfix close of its ticket as abandoned", async () => {
  const app = host(); await app.event("session_start");
  const a = await issue("Ticket A");
  await app.call({ op: "init", items: [`v2test#${a}: only step`] });
  await kata(["close", a, "--wontfix", "--message", "Closed by someone else because this work is no longer wanted by anyone here.", "--json"]);
  expect((await app.call({ op: "view" })).content[0].text).toContain(`[~] v2test#${a}: only step`);
});

const kataWrites = (calls: string[][]) => calls.filter(a => !["show", "list", "search", "whoami"].includes(a[0]));

test("init without replace refuses a plan with open tasks and writes nothing to Kata", async () => {
  const app = host(); const parent = await app.init(["Started task", "Waiting task", "Pending task"]);
  await app.call({ op: "start", task: "Started task" });
  await app.call({ op: "block", task: "Waiting task", reason: "needs a decision" });
  const before = await show(parent);
  const mark = app.calls.length;
  const result = await app.call({ op: "init", items: ["Brand new task"] });
  expect(result.isError).toBe(true);
  const text = result.content[0].text;
  for (const title of ["Started task", "Waiting task", "Pending task"]) expect(text).toContain(title);
  expect(text).toContain("replace: true");
  expect(kataWrites(app.calls.slice(mark))).toEqual([]);
  expect(await show(parent)).toEqual(before);
});

test("init without replace goes through when the new list keeps every open task", async () => {
  const app = host(); const parent = await app.init(["One", "Two"]);
  const result = await app.call({ op: "init", items: ["One", "Two", "Three"] });
  expect(result.isError, result.content[0].text).toBeUndefined();
  const children = (await show(parent)).children;
  expect(children.map((c: any) => c.title).sort()).toEqual(["One", "Three", "Two"]);
  expect(children.every((c: any) => c.status === "open")).toBe(true);
});

test("init without replace names only the open tasks the new list leaves out", async () => {
  const app = host(); const parent = await app.init(["One", "Two", "Three"]);
  const before = await show(parent);
  const mark = app.calls.length;
  const result = await app.call({ op: "init", items: ["One", "Four"] });
  expect(result.isError).toBe(true);
  const text = result.content[0].text.split("\n\n")[0];
  expect(text).toContain("Two"); expect(text).toContain("Three");
  expect(text).not.toContain("One"); expect(text).not.toContain("Four");
  expect(kataWrites(app.calls.slice(mark))).toEqual([]);
  expect(await show(parent)).toEqual(before);
});

test("init without replace refuses open ticket-named items and writes nothing to Kata", async () => {
  const ticket = `v2test#${await issue("Named work")}`;
  const app = host();
  await app.call({ op: "init", items: [`${ticket}: do the named work`] });
  const before = await show(ticket);
  const mark = app.calls.length;
  const result = await app.call({ op: "init", items: ["Something else"] });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain(`${ticket}: do the named work`);
  expect(kataWrites(app.calls.slice(mark))).toEqual([]);
  expect(await show(ticket)).toEqual(before);
});

test("init with replace closes the open tasks missing from the new list", async () => {
  const app = host(); const parent = await app.init(["Old task", "Kept task"]);
  const result = await app.call({ op: "init", items: ["Kept task", "New task"], replace: true });
  expect(result.isError).toBeUndefined();
  const children = (await show(parent)).children;
  const old = children.find((c: any) => c.title === "Old task");
  expect(old.status).toBe("closed"); expect(old.closed_reason).toBe("wontfix");
  expect(children.find((c: any) => c.title === "Kept task").status).toBe("open");
  expect(children.find((c: any) => c.title === "New task").status).toBe("open");
});

test("init needs no replace once every task of the plan is closed", async () => {
  const ref = `v2test#${await issue()}`;
  const app = host();
  await app.call({ op: "init", ref, items: ["Only task"] });
  await app.call({ op: "done", task: "Only task", message, evidence });
  const result = await app.call({ op: "init", ref, items: ["Follow-up task"] });
  expect(result.isError).toBeUndefined();
  expect((await show(ref)).children.find((c: any) => c.title === "Follow-up task").status).toBe("open");
});

test("init with a bare short id that resolves in the session project refuses to abandon that ticket's open children", async () => {
  const other = path.join(scratch, `other-${++sequence}`); mkdirSync(other);
  await kata(["init", "--project", "v2alpha", "--json"], other);
  const alpha = (await kata(["create", "Alpha parent", "--force-new", "--json"], other)).issue.short_id;
  const beta = await issue("Beta parent");
  await kata(["create", "Beta open child", "--parent", beta, "--meta", "todo.phase=Tasks", "--meta", "todo.status=pending", "--force-new", "--json"]);
  // Short ids are random per project, so route the bare id to the session project's ticket.
  const app = host({ before: (args: string[], opts: any) => args.includes(alpha) ? run(args.map(a => a === alpha ? `v2test#${beta}` : a), opts.cwd, opts.timeout) : undefined });
  await app.call({ op: "init", ref: `v2alpha#${alpha}`, items: ["Alpha child"] });
  const mark = app.calls.length;
  const result = await app.call({ op: "init", ref: alpha, items: ["Alpha child"] });
  expect(result.isError).toBe(true);
  expect(kataWrites(app.calls.slice(mark))).toEqual([]);
  expect((await show(beta)).children.map((c: any) => c.status)).toEqual(["open"]);
});

// omp's /tan runs a side conversation in a sub session named Tan-<snowflake>
// that no task spawn created; it keeps the todo tool.
test("an untracked /tan sub session uses omp's native todo and makes no Kata calls", async () => {
  const app = host();
  const received: any[] = [];
  const native = { content: [{ type: "text", text: "native list" }], details: { phases: [] } };
  const tan = host({ agent: { kind: "sub", id: "Tan-7000000000001", parentId: app.ctx.agent.id }, sessionFile: `${scratch}/Tan-7000000000001.jsonl` });
  const ctx = { ...tan.ctx, invokeTool: async (params: any) => { received.push(params); return native; } };
  const params = { op: "init", list: [{ phase: "Side", items: ["Look into the question"] }] };
  const result = await tan.call(params, ctx);
  expect(result).toBe(native);
  expect(received).toEqual([params]);
  expect(tan.calls).toEqual([]);
});

test("a /tan sub session on an omp without invokeTool keeps the assignment error", async () => {
  const tan = host({ agent: { kind: "sub", id: "Tan-7000000000002", parentId: "main" } });
  const result = await tan.call({ op: "view" });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("Kata assignment unavailable");
});

test("a delegate whose assignment failed still gets the assignment error, not the native list", async () => {
  let refuse = false;
  const lead = host({ before: (args: string[]) => refuse && args[0] === "meta" && args[3] === "omp.subagent_id" ? { code: 1, stdout: "", stderr: "meta refused" } : undefined });
  await lead.init(["Delegated plan"]);
  refuse = true;
  const sessionFile = `${scratch}/failed-binding.jsonl`;
  lead.emit("task:subagent:lifecycle", { id: "failed-binding", status: "started", sessionFile, description: "Delegated plan" });
  const worker = host({ sessionFile, agent: { kind: "sub", id: "failed-binding", parentId: lead.ctx.agent.id } });
  let native = 0;
  const result = await worker.call({ op: "view" }, { ...worker.ctx, invokeTool: async () => { native++; return { content: [], details: {} }; } });
  expect(native).toBe(0);
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("Kata assignment failed");
});

test("a delegate spawned under a Tan- name keeps its record and the Kata path", async () => {
  const lead = host();
  await lead.init(["Plan one"]);
  const sessionFile = `${scratch}/Tan-named.jsonl`;
  lead.emit("task:subagent:lifecycle", { id: "Tan-named", status: "started", sessionFile, description: "Plan one" });
  const worker = host({ sessionFile, agent: { kind: "sub", id: "Tan-named", parentId: lead.ctx.agent.id } });
  let native = 0;
  const result = await worker.call({ op: "init", items: ["Delegated step"] }, { ...worker.ctx, invokeTool: async () => { native++; return { content: [], details: {} }; } });
  expect(native).toBe(0);
  expect(result.details.kata.parent).toMatch(/^v2test#/);
});

// An omp fork gets a new session id and copies the source's entries: the fork shares the source's work.
function fork(source: ReturnType<typeof host>, form: "id" | "file", options: any = {}) {
  const parentSession = form === "id" ? source.sid : `/sessions/2026-11-02T10-00-00-000Z_${source.sid}.jsonl`;
  return host({ entries: structuredClone(source.entries), header: { parentSession }, ...options });
}
async function sessionParents(sid: string) { return (await kata(["list", "--status", "all", "--meta", `omp.session_id=${sid}`, "--json"])).issues; }
for (const form of ["id", "file"] as const) test(`a fork (parentSession as ${form}) keeps the source plan and makes no new parent`, async () => {
  const source = host(); const parent = await source.init(["Shared alpha", "Shared beta"]);
  const next = fork(source, form); await next.event("session_start");
  const view = await next.call({ op: "view" });
  expect(view.details.kata.parent).toBe(parent);
  expect(view.content[0].text).toContain("Shared alpha");
  expect((await next.call({ op: "append", items: ["Fork gamma"] })).isError).toBeUndefined();
  await next.call({ op: "view" });
  expect(await sessionParents(next.sid)).toEqual([]);
  expect((await show(parent)).children.map((c: any) => c.title).sort()).toEqual(["Fork gamma", "Shared alpha", "Shared beta"]);
});

test("a fork does not replay the source's pending close retries", async () => {
  const { app: source, lift } = throttledClose();
  const parent = await source.init(["Throttled shared"]);
  await source.call({ op: "done", message, evidence });
  expect((await show(parent)).issue.status).toBe("open");
  lift();
  const next = fork(source, "id"); await next.event("session_start");
  expect((await next.call({ op: "view" })).details.kata.parent).toBe(parent);
  expect((await show(parent)).children.map((c: any) => c.status)).toEqual(["open"]);
  expect(next.calls.some(a => a[0] === "close")).toBe(false);
});

test("a fork does not adopt the source's local plan", async () => {
  const source = host({ before: (a: string[]) => a[0] !== "init" && a[0] !== "projects" ? down() : undefined });
  await source.event("session_start");
  await source.call({ op: "init", items: ["Offline only"] });
  expect((await source.call({ op: "view" })).content[0].text).toContain("Offline only");
  const next = fork(source, "id"); await next.event("session_start");
  expect((await next.call({ op: "view" })).content[0].text).not.toContain("Offline only");
});

test("shutting down either session keeps the shared parent open until every task is closed", async () => {
  const source = host(); const parent = await source.init(["Shared one", "Shared two"]);
  const next = fork(source, "id"); await next.event("session_start");
  await source.event("session_shutdown");
  await next.event("session_shutdown");
  expect((await show(parent)).issue.status).toBe("open");
  await next.call({ op: "done", message, evidence });
  await next.call({ op: "done", message, evidence });
  expect((await show(parent)).issue.status).toBe("closed");
  await source.event("session_shutdown");
  expect((await show(parent)).issue.status).toBe("closed");
});

test("a restarted fork still owns the shared parent", async () => {
  const source = host(); const parent = await source.init(["Shared once"]);
  const next = fork(source, "id"); await next.event("session_start");
  await next.call({ op: "view" });
  const resumed = host({ sid: next.sid, entries: next.entries, header: next.ctx.sessionManager.getHeader() });
  await resumed.event("session_start");
  expect((await resumed.call({ op: "view" })).details.kata.parent).toBe(parent);
  await resumed.call({ op: "done", message, evidence });
  expect((await show(parent)).issue.status).toBe("closed");
});

test("a session without parentSession ignores another session's entries", async () => {
  const source = host(); const parent = await source.init(["Not shared"]);
  const next = host({ entries: structuredClone(source.entries), header: {} }); await next.event("session_start");
  expect((await next.call({ op: "view" })).details.kata.parent).toBeUndefined();
  expect((await show(parent)).issue.status).toBe("open");
});

// ------------------------------------------------------- issues moved between projects
async function otherProject() { const name = `v2moved${++sequence}`; await kata(["projects", "create", name, "--json"]); return name; }

test("a plan whose parent moved to another project creates new items there and rebinds the parent", async () => {
  const app = host(); const parent = await app.init(["Before the move"]);
  const target = await otherProject(), short = parent.split("#")[1];
  await kata(["move", parent, target, "--json"]);
  expect((await app.call({ op: "append", items: ["After the move"] })).isError).toBeUndefined();
  const view = await app.call({ op: "view" });
  expect(view.details.kata.parent).toBe(`${target}#${short}`);
  const moved = await show(`${target}#${short}`);
  expect(moved.children.map((c: any) => c.title).sort()).toEqual(["After the move", "Before the move"]);
  expect(moved.children.every((c: any) => c.project_id === moved.issue.project_id)).toBe(true);
  const stale = moved.children.find((c: any) => c.title === "Before the move");
  const closedByOldRef = await app.call({ op: "done", task: `${parent.split("#")[0]}#${stale.short_id}`, message, evidence });
  expect(closedByOldRef.isError, closedByOldRef.content[0].text).toBeUndefined();
  expect((await show(`${target}#${stale.short_id}`)).issue.status).toBe("closed");
  expect(app.entries.filter(e => e.customType === "io.kata.omp.parent").at(-1)!.data.parent).toBe(`${target}#${short}`);
  const resumed = host({ sid: app.sid, entries: structuredClone(app.entries) }); await resumed.event("session_start");
  expect((await resumed.call({ op: "view" })).details.kata.parent).toBe(`${target}#${short}`);
});

test("a ticket item naming a moved ticket is pinned and closed in its current project", async () => {
  const app = host(); await app.event("session_start");
  const ticket = await issue("Moving ticket"), target = await otherProject();
  await kata(["move", `v2test#${ticket}`, target, "--json"]);
  expect((await app.call({ op: "init", items: [`v2test#${ticket}: finish the move`] })).isError).toBeUndefined();
  const done = await app.call({ op: "done", task: `v2test#${ticket}: finish the move`, message, evidence });
  expect(done.isError, done.content[0].text).toBeUndefined();
  expect(done.content[0].text).toContain(`(${target}#${ticket})`);
  expect((await show(`${target}#${ticket}`)).issue.status).toBe("closed");
});

test("a parent moved once or twice is not re-adopted by every later todo call through the original ref", async () => {
  // One session measures an unmoved call as the baseline; a call after each move must cost the same.
  const parent = `v2test#${await issue()}`; process.env.KATA_REF = parent;
  const short = parent.split("#")[1];
  const app = host(); await app.event("session_start"); await app.init(["First"]);
  const shows = () => app.calls.filter(a => a[0] === "show" && a[1].endsWith(`#${short}`)).length;
  const replace = async (item: string) => {
    const before = shows();
    expect((await app.call({ op: "init", replace: true, items: [item] })).isError).toBeUndefined();
    return shows() - before;
  };
  await replace("Second");
  const baseline = await replace("Third");
  const second = await otherProject(), third = await otherProject();
  await kata(["move", parent, second, "--json"]);
  await replace("Fourth");
  expect(await replace("Fifth")).toBe(baseline);
  await kata(["move", `${second}#${short}`, third, "--json"]);
  await replace("Sixth");
  expect((await app.call({ op: "view" })).details.kata.parent).toBe(`${third}#${short}`);
  expect(await replace("Seventh")).toBe(baseline);
});

test("an item or plan title that reads like a flag is data, not a Kata option", async () => {
  const app = host(); await app.event("session_start");
  const result = await app.call({ op: "init", items: ["--json"], message: "--json" });
  expect(result.isError, result.content[0].text).toBeUndefined();
  expect(result.details.kata.phases[0].tasks.map((t: any) => t.content)).toEqual(["--json"]);
  expect((await show(result.details.kata.parent)).issue.title).toBe("--json");
});

test("a ticket in another project is never taken for a plan item by its short id", async () => {
  const app = host(); await app.event("session_start");
  const foreign = await otherProject();
  const ticket = (await kata(["create", "--project", foreign, "Foreign ticket", "--force-new", "--json"])).issue.short_id;
  await app.init(["Plain item"]);
  const result = await app.call({ op: "done", task: `${foreign}#${ticket}`, message, evidence });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("No task");
});

test("a project renamed mid-session is found by the very next call using the new name", async () => {
  const app = host(); await app.event("session_start");
  const project = await otherProject(), renamed = `${project}x`;
  const first = (await kata(["create", "--project", project, "First in renamed", "--force-new", "--json"])).issue.short_id;
  const second = (await kata(["create", "--project", project, "Second in renamed", "--force-new", "--json"])).issue.short_id;
  await app.init(["Plain item"]);
  expect((await app.call({ op: "append", items: [`${project}#${first}: first`] })).isError).toBeUndefined();
  // Drop the old-name item so no background refresh of it fails first and clears the cached project list.
  expect((await app.call({ op: "drop", task: `${project}#${first}: first`, message: "Not needed." })).isError).toBeUndefined();
  await kata(["projects", "rename", project, renamed, "--json"]);
  const result = await app.call({ op: "append", items: [`${renamed}#${second}: second`] });
  expect(result.isError, result.content[0].text).toBeUndefined();
  expect(result.content[0].text).toContain(`${renamed}#${second}`);
});

test("unmoved refs are pinned from the cached project list without another projects call", async () => {
  const ref = await issue(); process.env.KATA_REF = ref;
  const app = host(); await app.event("session_start");
  const listed = () => app.calls.filter(a => a[0] === "projects" && a[1] === "list").length;
  await app.init(["Cached lookup"]);
  const before = listed();
  expect(before).toBeLessThanOrEqual(1);
  for (const task of ["Second cached", "Third cached"]) await app.call({ op: "append", items: [task] });
  await app.call({ op: "view" });
  expect(listed()).toBe(before);
});

test("re-binding the bound parent appends no further parent state entry", async () => {
  const parent = `v2test#${await issue()}`; process.env.KATA_REF = parent;
  const app = host(); await app.event("session_start"); await app.init(["First"]);
  const parentEntries = () => app.entries.filter(e => e.customType === "io.kata.omp.parent").length;
  const before = parentEntries();
  await app.call({ op: "init", replace: true, items: ["Second"] });
  await app.call({ op: "init", replace: true, ref: parent, items: ["Third"] });
  expect(parentEntries()).toBe(before);
});

test("free text containing # is never shown as a Kata ref", async () => {
  const app = host(); await app.init(["Plain task"]);
  for (const target of ["Fix C# parser", "Fix #12 bug", "-flag#abc"]) {
    expect((await app.call({ op: "done", task: target, message, evidence })).isError).toBe(true);
    expect(app.calls.some(a => a[0] === "show" && a[1] === target)).toBe(false);
  }
});

test("re-adding a removed item restores its issue with no priority after the default priority changed", async () => {
  const app = host(); const parent = await app.init(["Priority probe", "Priority sibling"]);
  const first = (await show(parent)).children.find((c: any) => c.title === "Priority probe");
  expect((await app.call({ op: "rm", task: "Priority probe", message: "Not needed after all." })).isError).toBeUndefined();
  const config = path.join(env.KATA_HOME, "config.toml");
  writeFileSync(config, "[create]\ndefault_priority = 2\n");
  try {
    const again = await app.call({ op: "append", items: ["Priority probe"] });
    expect(again.isError, again.content?.[0]?.text).toBeUndefined();
    const restored = (await show(parent)).children.find((c: any) => c.title === "Priority probe");
    expect(restored.short_id).toBe(first.short_id);
    // Kata leaves `priority` out of the issue when it has none.
    expect((await show(`v2test#${restored.short_id}`)).issue.priority).toBeUndefined();
  } finally { writeFileSync(config, ""); }
});
