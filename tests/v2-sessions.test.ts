import { expect, setSystemTime, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { later } from "./kata-fixture";
import { missingExecutable, siblingThrottle } from "./kata-errors";
import { v2Fixture } from "./v2-fixture";

// The omp adapter against a real Kata: session start and end, transcripts, automatic parents and their closes.
const exec = promisify(execFile);
const { binary, scratch, cwd, outside, env, run, kata, show, issue, unique, host, down, evidence, message, throttledClose, ran, closeSessions } = v2Fixture();

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
  // Every project-scoped Kata call pins the plan's workspace, so a worktree or a moved cwd never resolves another project.
  expect(app.calls.filter(a => a[0] !== "version").every(a => a.includes("--workspace"))).toBe(true);
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
  const other = path.join(scratch, `other-${unique()}`); mkdirSync(other);
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
