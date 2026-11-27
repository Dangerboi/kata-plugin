import { expect, setSystemTime, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { eventually, finishes, holdKata, later } from "./kata-fixture";
import { missingExecutable, siblingThrottle } from "./kata-errors";
import { v2Fixture } from "./v2-fixture";

// The omp adapter against a real Kata: session start and end, transcripts, automatic parents and their closes,
// driven by omp's native todo through the fake host.
const exec = promisify(execFile);
const { binary, scratch, cwd, outside, env, run, kata, show, events, issue, unique, host, down, hostTimers, throttledClose, ran, closeSessions, closesOf, sessionParents, message } = v2Fixture();

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
});

// A host whose spawn fails reports a bare failure with no output; the paired close, spawned by the adapter, must read the same.
// The close the adapter makes itself is the automatic parent's, once the agent has closed every task.
for (const [name, bareResult, pairedBin] of [
  ["missing", () => { throw missingExecutable(); }, (dir: string) => dir],
  ["not executable", () => ({ code: 1, stdout: "", stderr: "" }), (dir: string) => { writeFileSync(path.join(dir, "kata"), "#!/bin/sh\n", { mode: 0o644 }); return dir; }],
] as const) {
  test(`an automatic parent's close whose Kata executable is ${name} is an outage whether or not the transcript pair is set`, async () => {
    const outcome = async (withPair: boolean) => {
      const saved = process.env.PATH, bin = mkdtempSync(path.join(scratch, "nowhere-"));
      // Without the pair the close goes through the host's exec; with it, the adapter spawns Kata itself.
      const app = host({ sid: `${name}-${withPair}`, transcript: withPair, before: (args: string[]) => args[0] === "close" ? bareResult() : undefined });
      await app.event("session_start");
      const parent = await app.init(["only step"]);
      // The agent's own close of the task runs in its shell, which this host does not intercept.
      await app.close("only step");
      // The parent's close is spawned by the adapter itself, so PATH must lead to the broken executable.
      if (withPair) process.env.PATH = pairedBin(bin);
      try {
        const done = await app.call({ op: "done", task: "only step" });
        expect(done.isError, done.content?.[0]?.text).toBeUndefined();
        await app.event("session_stop");
        return { status: (await show(parent)).issue.status, notices: app.notices.map(n => [n[1], String(n[0]).replace(/:?\s*(Executable not found[^\n]*|spawn kata \w+)|v2test#\w+/g, "")]) };
      } finally { process.env.PATH = saved; }
    };
    const bare = await outcome(false);
    expect(bare.status).toBe("open");
    expect(await outcome(true)).toEqual(bare);
  });
}

test("the plugin's close of an automatic parent records the omp session as its transcript with no transcript config", async () => {
  const app = host({ sid: "transcript-recorded", transcript: true });
  await app.event("session_start");
  const parent = await app.init(["only step"]);
  const done = await app.done("only step");
  expect(done.isError, done.content?.[0]?.text).toBeUndefined();
  await app.event("session_stop");
  await eventually(async () => (await show(parent)).issue.status, "closed");
  expect(app.calls.some(c => c[0] === "close")).toBe(false);
  const closes = (await events()).filter((e: any) => e.type === "issue.closed" && e.payload?.transcript?.session_id === "transcript-recorded");
  expect(closes.length).toBeGreaterThan(0);
  expect(closes[0].payload.transcript).toMatchObject({ agent: "omp", session_id: "transcript-recorded" });
});

test("the plugin's close of an automatic parent records no transcript when KATA_CLOSE_TRANSCRIPT_ENABLED is false before the session starts", async () => {
  process.env.KATA_CLOSE_TRANSCRIPT_ENABLED = "false";
  const app = host({ sid: "transcript-off", transcript: true });
  await app.event("session_start");
  expect(process.env.KATA_CLOSE_TRANSCRIPT_ENABLED).toBe("false");
  const parent = await app.init(["only step"]);
  const done = await app.done("only step");
  expect(done.isError, done.content?.[0]?.text).toBeUndefined();
  await app.event("session_stop");
  await eventually(async () => (await show(parent)).issue.status, "closed");
  expect(await closeSessions(parent)).toEqual([undefined]);
});

test("an unreachable Kata keeps the native list working, makes no Kata mutations and warns once", async () => {
  const app = host({ cwd: outside, before: down }); await app.event("session_start");
  expect((await app.call({ op: "init", items: ["Implement fixture", "Verify fixture"] })).isError).toBeUndefined();
  expect((await app.call({ op: "done", task: "Implement fixture" })).isError).toBeUndefined();
  expect(app.list().flatMap(p => p.tasks.map(t => [t.content, t.status]))).toEqual([["Implement fixture", "completed"], ["Verify fixture", "in_progress"]]);
  expect(app.calls.some(a => ["create", "claim", "meta", "close"].includes(a[0]))).toBe(false);
  expect(app.mirrorFailures().map(args => String(args[0]))).toEqual([expect.stringContaining("Kata is unreachable")]);
  expect(app.notices).toHaveLength(1);
});

test("KATA_REF beats stored session binding and is qualified", async () => {
  const old = await issue(), next = await issue(); process.env.KATA_REF = next;
  const app = host({ entries: [{ type: "custom", customType: "io.kata.omp.parent", data: { parent: old } }] });
  await app.event("session_start");
  expect((await app.call({ op: "init", items: ["Explicit work"] })).isError).toBeUndefined();
  const view = await show(`v2test#${next}`);
  expect(view.children.map((c: any) => c.title)).toEqual(["Explicit work"]);
  expect((await show(old)).children ?? []).toEqual([]);
});

test("auto parents carry typed identity and close exactly once from child evidence", async () => {
  const app = host(); await app.event("session_start"); const ref = await app.init();
  expect(ref).toMatch(/^v2test#/);
  expect((await show(ref)).issue.metadata["omp.auto_parent"]).toBe(true);
  expect((await show(ref)).issue.metadata["omp.session_id"]).toBe(app.sid);
  for (const task of ["Implement fixture", "Verify fixture"]) expect((await app.done(task)).isError).toBeUndefined();
  await app.event("session_stop");
  await eventually(async () => (await show(ref)).issue.status, "closed");
  await app.call({ op: "view" }); await app.event("session_stop");
  const closes = await closesOf(ref);
  expect(closes).toHaveLength(1);
  expect(closes[0].payload.evidence).toEqual([{ type: "test", command: "bun test fixture" }]);
  // Every project-scoped Kata call pins the plan's workspace, so a worktree or a moved cwd never resolves another project. Session start also fetches the agent contract, which names no project.
  expect(app.calls.filter(a => !["version", "agent-contract-hook"].includes(a[0])).every(a => a.includes("--workspace"))).toBe(true);
});

test("a session with no id never creates an unknown automatic parent", async () => {
  const app = host({ sid: null });
  expect((await app.call({ op: "init", items: ["No session identity"] })).isError).toBeUndefined();
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
  // Kata does not answer until the test lets it: the hooks must return on their own bound, not on Kata's answer.
  const held = holdKata(() => true, () => ({ code: 1, stderr: "offline", stdout: "" }));
  const slow = host({ before: held.before });
  try {
    expect(await finishes((async () => { await slow.event("session_start"); await slow.event("before_agent_start", { systemPrompt: ["base"] }); })())).toBe(true);
    expect(held.held).toBeGreaterThan(0);
    expect(slow.notices).toEqual([]);
  } finally { held.release(); }
});

test("external closes reconcile an auto parent, including non-todo children", async () => {
  const app = host(); await app.event("session_start"); const ref = await app.init(["External task"]);
  const extra = await issue("External verification child", { parent: ref });
  expect((await app.done("External task")).isError).toBeUndefined();
  await app.event("session_stop");
  expect((await show(ref)).issue.status).toBe("open");
  await kata(["close", extra, "--done", "--message", "Externally verified this additional child with an independent test run.", "--test", "external verifier", "--json"]);
  await app.event("session_stop"); await eventually(async () => (await show(ref)).issue.status, "closed");
});

test("a delegate bound to an existing plan item gets a teammate, the verbatim contract and closes it itself", async () => {
  const parent = host(); await parent.event("session_start"); const ref = await parent.init(["Await delegated work", "Keep leading while delegated"]);
  const sessionFile = `${scratch}/delegate-one.jsonl`;
  parent.emit("task:subagent:lifecycle", { id: "Build.Widget", agent: "task", status: "started", sessionFile, description: "Await delegated work" });
  const child = host({ agent: { kind: "sub", id: "Build.Widget", parentId: parent.ctx.agent.id }, sessionFile });
  await child.event("session_start");
  // Startup hooks return on their short bound, which can be before the contract has answered: await the actual
  // contract request before asserting the next prompt contains its completed cache.
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
  expect((await parent.done("Keep leading while delegated")).isError).toBeUndefined();
  await parent.event("session_stop");
  expect((await show(ref)).issue.status).toBe("open"); // Native agent still running.
  parent.emit("task:subagent:lifecycle", { id: "Build.Widget", status: "completed", sessionFile });
  await parent.call({ op: "view" }); await parent.event("session_stop");
  await eventually(async () => (await show(ref)).issue.status, "closed");
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
  expect((await close()).input.command).toStartWith("env KATA_TRANSCRIPT_AGENT='omp' KATA_TRANSCRIPT_SESSION_ID='delegate-header-id' KATA_CLOSE_TRANSCRIPT_ENABLED='true' kata ");
  await child.event("session_shutdown");
});

test("a delegate's shell close made before its session file has a header records no session, not the lead's", async () => {
  // The lead's pair is exported and recording is on: a close run with the lead's environment would record the lead.
  process.env.KATA_CLOSE_TRANSCRIPT_ENABLED = "true";
  const parent = host({ sid: "headerless-lead", transcript: true }); await parent.event("session_start");
  const ref = await parent.init(["Headerless delegated work", "Keep leading"]);
  const sessionFile = `${scratch}/delegate-headerless.jsonl`;
  writeFileSync(sessionFile, "");
  parent.emit("task:subagent:lifecycle", { id: "Headerless.Delegate", agent: "task", status: "started", sessionFile, description: "Headerless delegated work" });
  const child = host({ agent: { kind: "sub", id: "Headerless.Delegate", parentId: parent.ctx.agent.id }, sessionFile, transcript: true });
  await child.event("session_start"); await child.contractReady;
  await child.event("before_agent_start", { systemPrompt: ["child base"] });
  await parent.call({ op: "view" });
  const tracked = (await show(ref)).children.find((c: any) => c.metadata?.["omp.subagent_id"] === "Headerless.Delegate");
  const rewritten = await child.event("tool_call", { toolName: "bash", input: { command: `kata close v2test#${tracked.short_id} --done --message '${message}' --test 'headerless fixture'` } });
  // Run the rewritten command where the lead's pair is exported, as it is in the lead's process.
  const leadEnv = { ...env, KATA_TRANSCRIPT_AGENT: "omp", KATA_TRANSCRIPT_SESSION_ID: "headerless-lead", KATA_CLOSE_TRANSCRIPT_ENABLED: "true" };
  await exec("/bin/sh", ["-c", rewritten.input.command.replace(/^(env [^\n]*? )?kata /, (_: string, prefix?: string) => `${prefix ?? ""}'${binary}' `)], { env: leadEnv, cwd });
  expect((await show(`v2test#${tracked.short_id}`)).issue.status).toBe("closed");
  expect(await closeSessions(tracked.short_id)).toEqual([undefined]);
  await child.event("session_shutdown");
});

test("finished unclosed delegates remain open needs-review, with no parent proof fallback", async () => {
  const app = host(); await app.event("session_start"); const parent = await app.init(["Await unverified delegate", "Lead keeps working"]);
  const sessionFile = `${scratch}/delegate-unclosed.jsonl`;
  app.emit("task:subagent:lifecycle", { id: "unclosed", agent: "task", status: "started", sessionFile, description: "Await unverified delegate" });
  await app.call({ op: "view" });
  await ran(app, "unclosed", sessionFile);
  app.emit("task:subagent:lifecycle", { id: "unclosed", status: "completed", sessionFile });
  await app.done("Lead keeps working"); await app.event("session_stop");
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
  await app.done("Lead keeps working"); await app.event("session_stop");
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

test("omp refuses a write or commit that names a ref of the plan, for the lead and a subagent, until KATA_REF_GUARD is off", async () => {
  const app = host(); await app.event("session_start");
  const ref = await app.init(["Guarded plan task"]);
  const write = (who: typeof app, content: string) => who.event("tool_call", { toolName: "write", input: { path: `${cwd}/notes.ts`, content } });
  const refused = await write(app, `// tracked as ${ref}`);
  expect(refused).toMatchObject({ block: true });
  expect(refused.reason).toContain(ref);
  expect(refused.reason).toContain("KATA_REF_GUARD=off");
  expect(await write(app, "// tracked as README.md#tasks")).toBeUndefined();
  expect(await app.event("tool_call", { toolName: "write", input: { path: `${outside}/notes.ts`, content: ref } })).toBeUndefined();
  expect(await app.event("tool_call", { toolName: "bash", input: { command: `git commit -m "fix ${ref}"` } })).toMatchObject({ block: true });
  expect(await app.event("tool_call", { toolName: "bash", input: { command: `kata comment ${ref} -m "note ${ref}"` } })).toBeUndefined();
  const child = { ...app.ctx, agent: { kind: "sub", id: "guard-child", parentId: app.ctx.agent.id } };
  expect(await app.event("tool_call", { toolName: "write", input: { path: `${cwd}/child.ts`, content: `// ${ref}` } }, child)).toMatchObject({ block: true });
  // What the file already holds is not added; a new folder under a symlinked cwd and a path in the home folder are judged by where they land.
  writeFileSync(`${cwd}/held.md`, `see ${ref} here\n`);
  expect(await app.event("tool_call", { toolName: "write", input: { path: `${cwd}/held.md`, content: `see ${ref} here, and more\n` } })).toBeUndefined();
  expect(await app.event("tool_call", { toolName: "edit", input: { path: `${cwd}/held.md`, old_string: `see ${ref}`, new_string: `read ${ref}` } })).toBeUndefined();
  const link = `${scratch}/cwd-link`; symlinkSync(cwd, link);
  expect(await app.event("tool_call", { toolName: "write", input: { path: `${link}/new/dir/x.ts`, content: `// ${ref}` } })).toMatchObject({ block: true });
  expect(await app.event("tool_call", { toolName: "write", input: { path: "~/kata-guard-notes.md", content: `// ${ref}` } })).toBeUndefined();
  process.env.KATA_REF_GUARD = "off";
  try { expect(await write(app, `// tracked as ${ref}`)).toBeUndefined(); }
  finally { delete process.env.KATA_REF_GUARD; }
});

test("omp keeps the refs a shell claim named across /tree and qualifies a bare claimed id", async () => {
  const app = host(); await app.event("session_start");
  const short = await issue(), ref = `v2test#${short}`;
  const write = (content: string) => app.event("tool_call", { toolName: "write", input: { path: `${cwd}/claimed.ts`, content } });
  // The unexecuted claim is recorded; a bare id is recorded with the project it resolves in.
  await app.event("tool_result", { toolName: "bash", input: { command: `kata claim ${short} && echo claimed` }, isError: false, details: { exitCode: 0 } });
  expect(await write(`// ${short} on its own`)).toMatchObject({ block: true });
  await eventually(async () => !!(await write(`// ${ref}`))?.block, true);
  await app.event("session_tree");
  expect(await write(`// ${ref}`)).toMatchObject({ block: true });
  // A fork shares its source's claims; any other new session starts with none.
  await app.switchSession("claims-fork", { fork: true });
  expect(await write(`// ${ref}`)).toMatchObject({ block: true });
  await app.switchSession("claims-new");
  expect(await write(`// ${ref} and ${short}`)).toBeUndefined();
});

test("a claimed bare id is known at once, though Kata is slow to resolve it, and the hook does not wait", async () => {
  let slow = false;
  const held = holdKata(() => slow, () => ({ code: 1, stderr: "offline", stdout: "" }));
  const app = host({ before: held.before }); await app.event("session_start");
  const short = await issue();
  slow = true;
  try {
    expect(await finishes(app.event("tool_result", { toolName: "bash", input: { command: `kata claim ${short} && echo claimed` }, isError: false, details: { exitCode: 0 } }), 1000)).toBe(true);
    expect(await app.event("tool_call", { toolName: "write", input: { path: `${cwd}/slow.ts`, content: `// ${short}` } })).toMatchObject({ block: true });
  } finally { held.release(); }
});

test("pinned plan survives cwd changes and ignores another session's saved binding", async () => {
  const app = host(); await app.event("session_start"); const parent = await app.init(["Pinned task"]);
  app.ctx.cwd = outside;
  expect((await app.call({ op: "append", items: ["Another pinned task"] })).isError).toBeUndefined();
  expect((await show(parent)).children).toHaveLength(2);
  const next = host({ entries: app.entries }); await next.event("session_start");
  const own = await next.init(["Own task"]);
  expect(own).not.toBe(parent);
  expect((await show(parent)).children).toHaveLength(2);
});

test("new work reopens an auto parent; all-wontfix parents require review", async () => {
  const app = host(); await app.event("session_start"); const parent = await app.init(["Initial work"]);
  await app.done("Initial work"); await app.event("session_stop");
  await eventually(async () => (await show(parent)).issue.status, "closed");
  await app.call({ op: "append", items: ["Additional work"] });
  expect((await show(parent)).issue.status).toBe("open");
  const dropped = host(); await dropped.event("session_start"); const retired = await dropped.init(["x"]);
  await dropped.call({ op: "drop", task: "x" }); await dropped.event("session_stop");
  const view = await show(retired);
  expect(view.issue.status).toBe("open");
  expect(view.labels.some((l: any) => l.label === "needs-review")).toBe(true);
});

test("a flagged automatic parent is not re-audited until its revision changes", async () => {
  const app = host(); await app.event("session_start"); const parent = await app.init(["x"]);
  await app.call({ op: "drop", task: "x" });
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
  const app = host({ before: (a: string[]) => a[0] === "close" && a.includes(parent) ? siblingThrottle() : undefined });
  const timers = hostTimers(app);
  await app.event("session_start");
  parent = await app.init(["Throttled parent"]);
  await app.done("Throttled parent"); await app.event("session_stop");
  // The turn's settle waits a bounded time and finishes in the background: the throttled close sets its retry timer when it lands.
  await eventually(async () => timers.size, 1);
  const view = await show(parent);
  expect(view.issue.status).toBe("open");
  expect(view.labels.some((l: any) => l.label === "needs-review")).toBe(false);
});

test("a throttled automatic-parent close is retried by the host timer", async () => {
  const { app, timers, closing, lift } = throttledClose();
  await app.event("session_start");
  const parent = await app.init(["Throttled task"]);
  await app.done("Throttled task"); await app.event("session_stop");
  await eventually(async () => timers.size, 1);
  expect((await show(parent)).issue.status).toBe("open");
  lift();
  await later(async () => { for (const timer of [...timers]) timer.run(); await closing; });
  await app.event("session_stop");
  await eventually(async () => (await show(parent)).issue.status, "closed");
});
test("binding another session cancels the pending retry through the host", async () => {
  const { app, timers } = throttledClose();
  await app.event("session_start");
  await app.init(["Throttled task"]);
  await app.done("Throttled task"); await app.event("session_stop");
  expect(timers.size).toBe(1);
  const other = { ...app.ctx, sessionManager: { getSessionId: () => `${app.sid}-other`, getBranch: () => [] } };
  await app.event("session_branch", {}, other);
  expect(timers.size).toBe(0);
});

test("a sibling throttle on the automatic parent's close is retried by a resumed session", async () => {
  let throttled = false;
  const app = host({ before: (a: string[]) => {
    if (!throttled && a[0] === "close") { throttled = true; return siblingThrottle(); }
  } });
  await app.event("session_start");
  const parent = await app.init(["Throttled task"]);
  const result = await app.done("Throttled task");
  expect(result.isError).toBeUndefined();
  await app.event("session_stop");
  expect(throttled).toBe(true);
  expect((await show(parent)).issue.status).toBe("open");
  await later(async () => { const resumed = host({ cwd: outside, sid: app.sid, entries: app.entries }); await resumed.event("session_start"); await resumed.event("session_stop"); });
  expect((await show(parent)).issue.status).toBe("closed");
});

test("membership changes during evidence retrieval prevent auto-parent close", async () => {
  let mutate = false;
  let parent: string;
  const app = host({ before: async (a: string[]) => {
    if (mutate && a[0] === "events") { mutate = false; await kata(["create", "Concurrent child", "--parent", parent, "--force-new", "--json"]); }
  } });
  await app.event("session_start");
  parent = await app.init(["Initial closed child"]); mutate = true;
  await app.done("Initial closed child"); await app.event("session_stop");
  expect((await show(parent)).issue.status).toBe("open");
});

test("cross-project adoption pins new children to the claimed project", async () => {
  const other = path.join(scratch, `other-${unique()}`); mkdirSync(other);
  await kata(["init", "--project", "v2other", "--json"], other);
  const foreign = await issue("Cross-project claimed issue", { owner: "v2-builder", workspace: other });
  const app = host(); await app.event("session_start"); const original = await app.init(["Original task"]);
  await app.event("tool_result", { toolName: "bash", input: { command: `kata --workspace '${other}' claim ${foreign}` }, isError: false });
  expect((await app.call({ op: "append", items: ["Claimed-project task"] })).isError).toBeUndefined();
  const view = await show(`v2other#${foreign}`);
  const child = view.children.find((c: any) => c.title === "Claimed-project task");
  expect(child.project_id).toBe(view.issue.project_id);
  expect((await show(original)).issue.status).toBe("open");
});

test("typed automatic parent can be recovered after losing the session entry", async () => {
  const app = host(); await app.event("session_start"); const parent = await app.init(["Durable existing task"]);
  const recovered = host({ sid: app.sid }); await recovered.event("session_start");
  expect((await recovered.call({ op: "init", items: ["Durable existing task", "Recovered task"] })).isError).toBeUndefined();
  expect((await show(parent)).children.map((c: any) => c.title).sort()).toEqual(["Durable existing task", "Recovered task"]);
  expect(await sessionParents(app.sid)).toHaveLength(1);
});


test("only shell claims proved by the command status adopt owned issues", async () => {
  for (const [template, adopts] of [
    ["true && kata claim REF", true], ["true; kata claim REF", true], ["kata claim REF && true", true],
    ["kata claim REF; true", false], ["kata claim REF || true", false], ["true || kata claim REF", false],
    ["kata claim REF | cat", false], ["kata claim REF &", false], ["(kata claim REF)", false],
  ] as const) {
    const ref = await issue(); await kata(["claim", ref, "--json"]);
    const app = host({ sid: unique() }); await app.event("session_start");
    const command = template.replace("REF", ref);
    await exec("/bin/bash", ["-c", command.replace("kata", `\"${binary}\"`)], { cwd, env });
    await app.event("tool_result", { toolName: "bash", input: { command }, isError: false });
    await app.call({ op: "init", items: ["Check shell claim"] });
    expect((await show(ref)).children?.some((c: any) => c.title === "Check shell claim") ?? false, template).toBe(adopts);
  }
});

test("proven claims adopt in order and invalid refs never reach show", async () => {
  const first = await issue(), second = await issue();
  await kata(["claim", first, "--json"]); await kata(["claim", second, "--json"]);
  const app = host({ sid: unique() }); await app.event("session_start");
  const command = `kata claim --ttl 2h ${first} && kata claim ${second}`;
  await exec("/bin/bash", ["-c", command.replaceAll("kata", `\"${binary}\"`)], { cwd, env });
  await app.event("tool_result", { toolName: "bash", input: { command }, isError: false });
  await app.call({ op: "init", items: ["Last claim wins"] });
  expect((await show(second)).children.some((c: any) => c.title === "Last claim wins")).toBe(true);
  const calls = app.calls.length;
  for (const ref of ["$ID", "2h"]) await app.event("tool_result", { toolName: "bash", input: { command: `kata claim ${ref}` }, isError: false });
  expect(app.calls.slice(calls).filter(c => c[0] === "show")).toEqual([]);
});
