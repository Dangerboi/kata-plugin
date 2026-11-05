import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Value } from "typebox/value";
import { assertIsolated } from "./isolation";
import { isolatedKata, later } from "./kata-fixture";
import { daemonUnavailable, siblingThrottle } from "./kata-errors";
import piKata, { launchesPi } from "../plugins/pi/kata";
assertIsolated();
const binary = process.env.KATA_TEST_EXECUTABLE!;
if (!binary || !path.isAbsolute(binary)) throw new Error("Set KATA_TEST_EXECUTABLE to the guarded Kata binary.");
const scratch = mkdtempSync(path.join(process.env.KATA_TEST_ROOT!, "pi-"));
const cwd = path.join(scratch, "workspace"), outside = path.join(scratch, "outside");
mkdirSync(cwd); mkdirSync(outside);
const env = { ...process.env, KATA_HOME: path.join(scratch, "home"), KATA_AUTHOR: "pi-builder" };
for (const key of ["KATA_SERVER", "KATA_DAEMON", "KATA_AUTH_TOKEN", "KATA_REF", "KATA_TEAMMATE", "KATA_INBOX_USER", "KATA_PI_PARENT"]) delete env[key];
const run = isolatedKata(binary, env, cwd);
async function kata(args: string[], workspace = cwd): Promise<any> {
  const out = await run(args, workspace);
  if (out.code) throw new Error(out.stderr);
  return JSON.parse(out.stdout);
}
const show = (ref: string) => kata(["show", ref, "--json"]);
let sequence = 0;
const down = daemonUnavailable;
const evidence = ["test:bun test pi fixture"];
const message = "Implemented the stock pi fixture and verified it with the isolated integration suite.";
const nativeKey = Symbol.for("kata.pi.native.v1");
const globalRegistry = globalThis as any;
const previousRegistry = globalRegistry[nativeKey];
async function host(options: any = {}) {
  const sid = options.sid || `pi-${++sequence}`;
  const contractReady = Promise.withResolvers<void>(), inboxReady = Promise.withResolvers<void>();
  let tool: any;
  const handlers = new Map<string, any>(), commands = new Map<string, any>();
  const entries: any[] = options.entries || [], calls: string[][] = [], notices: any[] = [], widgets: any[] = [], messages: any[] = [], models: any[] = [], thinking: any[] = [];
  const ctx: any = {
    cwd: options.cwd || cwd, hasUI: options.hasUI ?? true, mode: options.mode || "tui",
    sessionManager: { getSessionId: () => sid, getBranch: () => entries },
    model: options.model, modelRegistry: options.modelRegistry,
    ui: { notify: (...args: any[]) => notices.push(args), setWidget: (...args: any[]) => widgets.push(args) },
  };
  const api: any = {
    ...(options.omp ? { zod: {} } : {}),
    registerTool: (value: any) => tool = value,
    getSessionName: () => undefined,
    registerCommand: (name: string, value: any) => commands.set(name, value),
    appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
    sendMessage: (...args: any[]) => messages.push(args),
    setModel: async (model: any) => { models.push(model); return true; },
    getThinkingLevel: () => options.thinking,
    setThinkingLevel: (level: any) => thinking.push(level),
    on: (name: string, callback: any) => handlers.set(name, [...(handlers.get(name) || []), callback]),
    async exec(file: string, args: string[], opts: any) {
      calls.push(args);
      if (options.exec) return options.exec(file, args, opts);
      const result = await options.before?.(args, opts) ?? await run(args, opts.cwd, opts.timeout);
      if (args[0] === "agent-contract-hook") contractReady.resolve();
      if (args[0] === "inbox") inboxReady.resolve();
      return result;
    },
  };
  const native = async () => {
    const source=readFileSync(path.join(cwd,".pi/extensions/kata.js"), "utf8");
    const url=`data:text/javascript;base64,${Buffer.from(source + `\n// test session ${sid}`).toString("base64")}`;
    (await import(url)).default(api);
  };
  if (options.nativeOrder === "native-first") await native();
  await piKata(api);
  if (options.nativeOrder === "plugin-first") await native();
  return { ctx, sid, tool, entries, calls, notices, widgets, messages, handlers, commands, models, thinking,
    contextReady: Promise.all([contractReady.promise, inboxReady.promise]),
    event: async (name: string, data: any = {}) => { let result; for (const callback of handlers.get(name) || []) { const next=await callback(data,ctx); if(next!==undefined) result=next; } return result; },
    call: (params: any) => tool.execute("fixture", params, undefined, undefined, ctx),
    command: (args: string) => commands.get("todo").handler(args, ctx),
    async init(items = ["Implement pi fixture", "Verify pi fixture"]) {
      const result = await tool.execute("fixture", { op: "init", items }, undefined, undefined, ctx);
      expect(result.isError).toBeUndefined(); return result.details.kata.parent;
    },
  };
}
// `kata agent-hook install pi` (the native pi adapter) exists on kenn-io/kata main
// since #466/#475 but in no release yet (v0.18.0 lacks it). Tests that load the
// native adapter run only when the Kata under test has it; they never fake it.
const nativeHelp = await run(["agent-hook", "install", "--help"]);
const nativeMissing = nativeHelp.code ? "Kata under test lacks `agent-hook install` (unreleased; kenn-io/kata main after #475)" : undefined;
if (nativeMissing) console.warn(`Skipping real native pi adapter tests: ${nativeMissing}`);
beforeAll(async () => {
  const out = await run(["init", "--project", "pitest"]); if (out.code) throw new Error(out.stderr);
  if (nativeMissing) return;
  const native = await run(["agent-hook", "install", "pi", "--scope", "project", "--executable", binary]);
  if (native.code) throw new Error(native.stderr);
});
beforeEach(() => {
  process.env.KATA_AUTHOR = "pi-builder";
  process.env.KATA_PI_EXECUTABLE = binary;
  for (const key of ["KATA_REF", "KATA_TEAMMATE", "KATA_INBOX_USER", "KATA_PI_PARENT", "KATA_TRANSCRIPT_AGENT", "KATA_TRANSCRIPT_SESSION_ID"]) delete process.env[key];
  globalRegistry[nativeKey] = { adapters: new Map() };
});
afterAll(async () => { await run(["daemon", "stop"]); delete process.env.KATA_PI_EXECUTABLE; globalRegistry[nativeKey] = previousRegistry; });

test("pi plans in the inferred project of an unregistered repo, or the default project with a repo label", async () => {
  const repo = (name: string) => { const dir = path.join(scratch, name); mkdirSync(dir); execFileSync("git", ["init", "-q"], { cwd: dir }); execFileSync("git", ["remote", "add", "origin", `https://github.com/someone/${name}.git`], { cwd: dir }); return dir; };
  const inferred = await host({ cwd: repo("pi-port-inferred") }); await inferred.event("session_start", { reason: "startup" });
  expect(await inferred.init(["Inferred pi task"])).toMatch(/^pi-port-inferred#/);
  expect((await kata(["projects", "list", "--json"])).projects.map((p: any) => p.name)).toContain("pi-port-inferred");
  process.env.KATA_DEFAULT_PROJECT = "pitest";
  try {
    const labeled = await host({ cwd: repo("pi-port-labeled") }); await labeled.event("session_start", { reason: "startup" });
    const ref = await labeled.init(["Labeled pi task"]);
    expect(ref).toMatch(/^pitest#/);
    const labeled2 = (await kata(["list", "--project", "pitest", "--label", "pi-port-labeled", "--status", "all", "--json"])).issues;
    expect(labeled2).toHaveLength(2);
    const view = await labeled.call({ op: "view" });
    expect(view.details.phases).toBeUndefined();
  } finally { delete process.env.KATA_DEFAULT_PROJECT; }
});

test("pi exits before registering anything when loaded under OMP", async () => {
  const app = await host({ omp: true });
  expect(app.tool).toBeUndefined(); expect(app.handlers.size).toBe(0); expect(app.commands.size).toBe(0);
});

test("pi uses a validating TypeBox schema and sequential tool execution", async () => {
  const app = await host();
  expect(Value.Check(app.tool.parameters, { op: "init", items: ["A task"] })).toBe(true);
  expect(Value.Check(app.tool.parameters, { op: "invented" })).toBe(false);
  expect(Value.Check(app.tool.parameters, { op: "done", evidence: "wrong" })).toBe(false);
  expect(Value.Check(app.tool.parameters, { op: "init", list: [{ phase: "Empty", items: [] }] })).toBe(false);
  expect(app.tool.executionMode).toBe("sequential"); expect(app.tool.approval).toBeUndefined();
  expect(app.tool.annotations.readOnlyHint).toBe(false);
});

test("pi plans close from real Kata evidence with a typed pi parent exactly once", async () => {
  const app = await host(); await app.event("session_start", { reason: "startup" });
  const ref = await app.init();
  const parent = (await show(ref)).issue;
  expect(parent.metadata["pi.auto_parent"]).toBe(true);
  expect(parent.metadata["pi.session_id"]).toBe(app.sid);
  expect(parent.metadata["pi.workspace"]).toBe(cwd);
  expect(parent.metadata["omp.auto_parent"]).toBeUndefined();
  expect((await app.call({ op: "done", task: "Implement pi fixture", message: "short", evidence })).isError).toBe(true);
  for (const task of ["Implement pi fixture", "Verify pi fixture"]) expect((await app.call({ op: "done", task, message, evidence })).isError).toBeUndefined();
  await app.event("agent_before_settle", { outcome: "completed", entries: [], context: { contextMessages: [] } });
  await app.event("session_shutdown", { reason: "quit" });
  await app.call({ op: "view" });
  expect((await show(ref)).issue.status).toBe("closed");
  const rows = (await kata(["audit", "closes", "--json"])).rows.filter((r: any) => r.issue === ref.split("#")[1]);
  expect(rows).toHaveLength(1);
  const event = (await kata(["events", "--after", String(rows[0].event_id - 1), "--limit", "1", "--json"])).events[0];
  expect(event.payload.evidence).toEqual([{ type: "test", command: "bun test pi fixture" }]);
});

test("pi uses structured prompt sections, preserves other extensions, and caches fallback context", async () => {
  process.env.KATA_INBOX_USER = "pi-builder/lead";
  const app = await host(); await app.event("session_start", { reason: "startup" }); const ref = await app.init();
  await app.event("before_agent_start", { systemPromptOptions: { sections: {} } });
  await app.contextReady;
  const prompt = { systemPrompt: "immutable host prompt", systemPromptOptions: { sections: { authored: "keep me" } } };
  Object.defineProperty(prompt, "systemPrompt", { value: prompt.systemPrompt, writable: false });
  expect(await app.event("before_agent_start", prompt)).toBeUndefined();
  const sections = prompt.systemPromptOptions.sections as any;
  expect(sections.authored).toBe("keep me"); expect(sections.kata_todo).toContain(ref);
  const contract = JSON.parse((await run(["agent-contract-hook", "--source", "kata-agent-contract-hook"])).stdout).hookSpecificOutput.additionalContext;
  expect(sections.kata_contract).toBe(contract);
  await app.event("before_agent_start", prompt);
  expect(app.calls.filter(a => a[0] === "agent-contract-hook")).toHaveLength(1);
  expect(app.calls.filter(a => a[0] === "inbox")).toHaveLength(3);
});

for (const [scope, workspace, enabled, expected] of [
  ["user", "", true, true], ["project", cwd, true, true],
  ["project", path.dirname(cwd), true, true], ["project", cwd + "-sibling", true, false],
  ["project", outside, true, false], ["project", cwd, false, false],
] as const) test(`native adapter coexistence: ${scope} ${workspace} contract=${enabled}`, async () => {
  globalRegistry[nativeKey].adapters.set("native", { options: { scope, workspace, contract: enabled } });
  const app = await host(); await app.event("session_start", { reason: "startup" }); await app.init(["Native coexistence task"]);
  const prompt = { systemPromptOptions: { sections: { kata_contract: "native contract", kata_inbox: "native inbox" } } };
  await app.event("before_agent_start", prompt);
  expect(app.calls.some(a => a[0] === "agent-contract-hook")).toBe(!expected);
  if (expected) expect(prompt.systemPromptOptions.sections).toMatchObject({ kata_contract: "native contract", kata_inbox: "native inbox" });
  expect((prompt.systemPromptOptions.sections as any).kata_todo).toContain("Native coexistence task");
});

test("native adapter loaded after our factory still prevents duplicate contract fetching", async () => {
  const app = await host(); await app.event("session_start", { reason: "startup" });
  globalRegistry[nativeKey].adapters.set("late", { options: { scope: "user", contract: true } });
  await app.event("before_agent_start", { systemPromptOptions: { sections: {} } });
  expect(app.calls.some(a => a[0] === "agent-contract-hook" || a[0] === "inbox")).toBe(false);
});

test("pi never performs session attention or registers OMP lifecycle handlers", async () => {
  const ref = (await kata(["create", "Explicit pi parent", "--force-new", "--json"])).issue.short_id;
  await kata(["claim", ref, "--json"]); process.env.KATA_REF = ref;
  const app = await host();
  for (const reason of ["startup", "reload", "new", "resume", "fork"]) {
    await app.event("session_start", { reason }); await app.event("session_shutdown", { reason });
  }
  await app.event("session_shutdown", { reason: "quit" }); await app.call({ op: "view" });
  expect(app.calls.some(a => a[0] === "meta" && a[3]?.startsWith("work."))).toBe(false);
  expect(app.calls.some(a => a[0] === "agent-hook")).toBe(false);
  for (const name of ["session_stop", "session_switch", "session_branch", "before_subagent_spawn"]) expect(app.handlers.has(name)).toBe(false);
});

test("pi resumes matching session state and reconciles after tree navigation", async () => {
  const app = await host(); const ref = await app.init(["Task across resume"]);
  const resumed = await host({ sid: app.sid, entries: app.entries });
  await resumed.event("session_start", { reason: "resume" });
  expect((await resumed.call({ op: "view" })).details.kata.parent).toBe(ref);
  const child = (await show(ref)).children[0];
  await kata(["close", child.short_id, "--done", "--message", message, "--test", "external pi verifier", "--json"]);
  await resumed.event("session_tree"); await resumed.call({ op: "view" });
  expect((await show(ref)).issue.status).toBe("closed");
});

test("pi /todo is a registered command and remains observable without UI", async () => {
  const app = await host({ hasUI: false, mode: "print" }); const ref = await app.init(["Command task"]);
  await app.command("");
  expect(app.messages.at(-1)[0]).toMatchObject({ customType: "kata.todo.command", display: true });
  expect(app.messages.at(-1)[0].content).toContain(ref);
  await app.command("done Command task"); expect((await show(ref)).issue.status).toBe("closed");
  expect(app.notices).toEqual([]); expect(app.widgets).toEqual([]);
});

test("pi stop reminder appends a hidden message, preserves entries, and has a finite progress budget", async () => {
  const app = await host(); await app.init(["Finish pending work"]);
  const entries = [{ type: "custom", customType: "authored", data: "keep" }];
  const event = { outcome: "completed", entries, context: { contextMessages: [{ role: "assistant", content: [{ type: "text", text: "Implemented part of it." }] }] } };
  const first = await app.event("agent_before_settle", event);
  expect(first.continue).toBe(true); expect(first.entries[0]).toEqual(entries[0]); expect(entries).toHaveLength(1);
  expect(first.entries[1]).toMatchObject({ type: "custom_message", customType: "kata.todo.reminder", display: false });
  expect(first.entries[1].content).toContain("Finish pending work");
  expect(await app.event("agent_before_settle", event)).toBeUndefined();
  for (let i = 0; i < 3; i++) {
    await app.event("tool_result", { toolName: "read", isError: false });
    expect(!!await app.event("agent_before_settle", event)).toBe(i < 2);
  }
});

for (const mode of ["question", "aborted", "error", "blocked"]) test(`pi stop reminder respects ${mode}`, async () => {
  const app = await host(); await app.init(["Respect the stop boundary"]);
  if (mode === "blocked") await app.call({ op: "block", reason: "Waiting for user input" });
  const result = await app.event("agent_before_settle", { outcome: mode === "error" || mode === "aborted" ? mode : "completed", entries: [], context: { contextMessages: [{ role: "assistant", content: mode === "question" ? "What should I do?" : "Stopping here." }] } });
  expect(result).toBeUndefined();
});

test("pi mutates Bash input in place to use the selected executable without changing identity or quoted data", async () => {
  const app = await host();
  const input = { command: "echo 'kata claim prose'; kata claim pitest#abcd --teammate author; cat <<'END'\nkata close quoted\nEND" };
  const result = await app.event("tool_call", { toolName: "bash", input });
  expect(result).toBeUndefined(); expect(input.command).toContain(`'${binary}' claim pitest#abcd --teammate author`);
  expect(input.command).toContain("echo 'kata claim prose'"); expect(input.command).toContain("\nkata close quoted\n");
});

test("pi adopts a successful Bash claim using isError without OMP exitCode details", async () => {
  const ref = (await kata(["create", "Pi adopted parent", "--force-new", "--json"])).issue.short_id;
  await kata(["claim", ref, "--json"]);
  const app = await host(); await app.event("session_start", { reason: "startup" });
  await app.event("tool_result", { toolName: "bash", input: { command: `kata claim ${ref}` }, isError: false, details: {} });
  expect((await app.call({ op: "view" })).details.kata.parent).toBe(`pitest#${ref}`);
});

test("pi keeps an unreachable Kata local and failures quiet with bounded hooks", async () => {
  const app = await host({ cwd: outside, before: down }); await app.event("session_start", { reason: "startup" });
  await app.init(["Local pi task"]);
  expect((await app.call({ op: "done" })).isError).toBeUndefined();
  const prompt = { systemPromptOptions: { sections: {} } };
  await app.event("before_agent_start", prompt);
  expect(prompt.systemPromptOptions.sections).toEqual({});
  expect(app.calls.some(a => ["create", "claim", "meta", "close"].includes(a[0]))).toBe(false);
  const slow = await host({ before: async () => { await Bun.sleep(600); return { code: 1, stdout: "", stderr: "offline" }; } });
  const start = performance.now(); await slow.event("session_start", { reason: "startup" });
  await slow.event("before_agent_start", { systemPromptOptions: { sections: {} } });
  expect(performance.now() - start).toBeLessThan(600);
  expect(slow.notices).toEqual([]);
});

for (const match of ["named", "active"]) test(`pi child ${match} binding owns its issue and closes with its teammate`, async () => {
  const parent = await host(); await parent.event("session_start", { reason: "startup" });
  const ref = await parent.init(["Delegated pi work", "Remaining lead work"]);
  const marker = JSON.parse(process.env.KATA_PI_PARENT!);
  process.env.KATA_PI_PARENT = JSON.stringify({ ...marker, pid: process.pid + 1 });
  process.env.KATA_REF = ref; // Stale inherited lead routing must be removed.
  const child = await host(); await child.event("session_start", { reason: "startup" });
  expect(process.env.KATA_REF).toBeUndefined();
  const prompt: any = { prompt: match === "named" ? "Complete Delegated pi work" : "Do the current task", systemPromptOptions: { sections: {} } };
  await child.event("before_agent_start", prompt);
  const record = delegateRecord(child);
  expect(record.teammate).not.toBe(marker.teammate);
  expect(prompt.systemPromptOptions.sections.kata_contract).toBeTruthy();
  expect(prompt.systemPromptOptions.sections.kata_binding).toContain(record.ref);
  expect((await show(record.ref)).issue.metadata.teammate).toBe(record.teammate);
  const command = { command: `kata close '${record.ref}' --done --message '${message}' --test 'pi child regression' --teammate wrong` };
  await child.event("tool_call", {toolName:"bash", input:command});
  expect(command.command).toContain(`--teammate '${record.teammate}'`);
  expect(command.command).not.toContain("--teammate wrong");
  expect((await child.event("tool_call", {toolName:"bash", input:{command:"kata --as other list"}})).block).toBe(true);
  const unchanged = (await show(ref)).issue.metadata["work.attention"];
  await kata(["close", record.ref, "--done", "--message", message, "--test", "pi child regression", "--teammate", record.teammate, "--json"]);
  await child.event("session_shutdown", {reason:"quit"});
  expect((await show(record.ref)).issue.status).toBe("closed");
  expect((await show(ref)).issue.metadata["work.attention"]).toBe(unchanged);
  delete process.env.KATA_TEAMMATE; delete process.env.KATA_INBOX_USER; delete process.env.KATA_PI_PARENT;
  expect((await parent.call({op:"done", task:"Remaining lead work", message, evidence})).isError).toBeUndefined();
  expect((await show(ref)).issue.status).toBe("closed");
  expect((await kata(["audit", "closes", "--json"])).rows.filter((r:any) => r.issue === ref.split("#")[1])).toHaveLength(1);
});


for (const order of ["plugin-first", "native-first"]) test.skipIf(!!nativeMissing)(`real native adapter preserves parent attention with ${order}`, async () => {
  const ref = (await kata(["create", "Real native ordering parent", "--force-new", "--json"])).issue.short_id;
  await kata(["claim", ref, "--json"]);
  process.env.KATA_REF = `pitest#${ref}`;
  globalRegistry[nativeKey] = {adapters:new Map(), active:new Map()};
  const nativeCwd = realpathSync(cwd);
  const app = await host({nativeOrder:order, cwd:nativeCwd}); await app.event("session_start", {reason:"startup"});
  expect(globalRegistry[nativeKey].active.get(nativeCwd).ref).toBe(`pitest#${ref}`);
  expect(process.env.KATA_REF).toBeUndefined();
  const baseline = (await show(ref)).issue.metadata;
  expect(baseline["work.attention"]).toBe("ok");
  const marker=JSON.parse(process.env.KATA_PI_PARENT!);
  process.env.KATA_PI_PARENT=JSON.stringify({...marker,pid:process.pid+1});
  globalRegistry[nativeKey]={adapters:new Map(),active:new Map()};
  const child=await host({nativeOrder:order, cwd:nativeCwd}); await child.event("session_start",{reason:"startup"});
  expect(globalRegistry[nativeKey].active.get(nativeCwd).ref).toBe("");
  await child.event("session_shutdown",{reason:"quit"});
  expect((await show(ref)).issue.metadata).toEqual(baseline);
  expect(child.calls.filter(a => a[1] === "attention-native")).toEqual([]);
  globalRegistry[nativeKey]={adapters:new Map(),active:new Map()};
});

const attentionCalls = (app: any) => app.calls.filter((a: string[]) => a[1] === "attention-native").map((a: string[]) => [a[3], a[a.indexOf("--ref") + 1]]);
test.skipIf(!!nativeMissing)("real native adapter sends no attention end for a session without KATA_REF when the plugin loads first", async () => {
  globalRegistry[nativeKey] = { adapters: new Map(), active: new Map() };
  const nativeCwd = realpathSync(cwd);
  const app = await host({ nativeOrder: "plugin-first", cwd: nativeCwd }); await app.event("session_start", { reason: "startup" });
  expect(globalRegistry[nativeKey].active.get(nativeCwd).ref).toBe("");
  await app.event("session_shutdown", { reason: "quit" });
  expect(attentionCalls(app)).toEqual([]);
  globalRegistry[nativeKey] = { adapters: new Map(), active: new Map() };
});

test.skipIf(!!nativeMissing)("real native adapter starts and ends attention once each on the lead's issue with KATA_REF", async () => {
  const ref = (await kata(["create", "Real native attention lead", "--force-new", "--json"])).issue.short_id;
  await kata(["claim", ref, "--json"]);
  process.env.KATA_REF = `pitest#${ref}`;
  globalRegistry[nativeKey] = { adapters: new Map(), active: new Map() };
  const nativeCwd = realpathSync(cwd);
  const app = await host({ nativeOrder: "plugin-first", cwd: nativeCwd }); await app.event("session_start", { reason: "startup" });
  await app.event("session_shutdown", { reason: "quit" });
  expect(attentionCalls(app)).toEqual([["start", `pitest#${ref}`], ["end", `pitest#${ref}`]]);
  globalRegistry[nativeKey] = { adapters: new Map(), active: new Map() };
});

test("pi local plans and queued closes survive a fresh extension instance", async () => {
  const local = await host({cwd:outside, before: down}); await local.event("session_start", {reason:"startup"});
  await local.init(["Durable pi local work"]); await local.call({op:"block", reason:"Wait through restart"});
  const restored = await host({cwd:outside, before: down, sid:local.sid, entries:JSON.parse(JSON.stringify(local.entries))});
  await restored.event("session_start", {reason:"resume"});
  expect((await restored.call({op:"view"})).content[0].text).toContain("Wait through restart");
  const app = await host({before:(a:string[])=>a[0]==="close"?siblingThrottle():undefined});
  const ref = await app.init(["Durable pi close"]); await app.call({op:"done", message, evidence});
  const entries=JSON.parse(JSON.stringify(app.entries));
  await later(async () => { const resumed=await host({sid:app.sid,entries}); await resumed.event("session_start",{reason:"resume"}); await resumed.call({op:"view"}); });
  expect((await show(ref)).issue.status).toBe("closed");
});

test("startup-spawned child establishes the lead session parent without lead work writes", async () => {
  const parent=await host(); await parent.event("session_start",{reason:"startup"});
  const marker=JSON.parse(process.env.KATA_PI_PARENT!); expect(marker.ref).toBeUndefined();
  process.env.KATA_PI_PARENT=JSON.stringify({...marker,pid:process.pid+1});
  const child=await host(); await child.event("session_start",{reason:"startup"});
  await child.event("before_agent_start",{prompt:"Independent startup child",systemPromptOptions:{sections:{}}});
  const record=delegateRecord(child);
  expect(record.state).toBe("untracked");
  const parentRef=(await kata(["list","--status","all","--meta",`pi.session_id=${parent.sid}`,"--label","pi-session","--json"])).issues[0].qualified_id;
  const lead=(await show(parentRef)).issue;
  expect(lead.metadata["pi.session_id"]).toBe(parent.sid);
  expect(lead.metadata["work.attention"]).toBeUndefined();
  expect(child.calls.filter(a=>a[0]==="meta" && a[2]===parentRef && a[3]?.startsWith("work."))).toEqual([]);
  delete process.env.KATA_TEAMMATE; delete process.env.KATA_INBOX_USER; delete process.env.KATA_PI_PARENT;
  expect(await parent.init(["Follow startup child"])).toBe(parentRef);
  expect((await show(parentRef)).children).toHaveLength(1);
});

test("clearing child KATA_REF preserves explicit main binding precedence", async () => {
  const first=(await kata(["create","Pinned Pi explicit parent","--force-new","--json"])).issue.short_id;
  const second=(await kata(["create","Different Pi requested parent","--force-new","--json"])).issue.short_id;
  process.env.KATA_REF=first;
  const app=await host(); await app.event("session_start",{reason:"startup"});
  expect(process.env.KATA_REF).toBeUndefined();
  const result=await app.call({op:"init",ref:second,items:["Remain with explicit binding"]});
  expect(result.isError).toBe(true); expect(result.details.kata.parent).toBe(`pitest#${first}`);
  expect((await show(first)).children ?? []).toHaveLength(0);
  expect((await show(second)).children ?? []).toHaveLength(0);
});

test("saved child resumes its teammate and binding without inherited environment", async () => {
  const parent=await host(); await parent.event("session_start",{reason:"startup"}); await parent.init(["Saved delegate work"]);
  process.env.KATA_PI_PARENT=JSON.stringify({...JSON.parse(process.env.KATA_PI_PARENT!),pid:process.pid+1});
  const child=await host(); await child.event("session_start",{reason:"startup"});
  await child.event("before_agent_start",{prompt:"Saved delegate work",systemPromptOptions:{sections:{}}});
  const record=delegateRecord(child);
  for(const key of ["KATA_TEAMMATE","KATA_INBOX_USER","KATA_PI_PARENT"])delete process.env[key];
  const resumed=await host({sid:child.sid,entries:JSON.parse(JSON.stringify(child.entries))});
  await resumed.event("session_start",{reason:"resume"});
  const event:any={prompt:"Continue saved work",systemPromptOptions:{sections:{}}};
  await resumed.event("before_agent_start",event);
  expect(event.systemPromptOptions.sections.kata_binding).toContain(record.ref);
  expect(process.env.KATA_TEAMMATE).toBe(record.teammate);
  expect(process.env.KATA_INBOX_USER).toBe(`pi-builder/${record.teammate}`);
  expect(JSON.parse(process.env.KATA_PI_PARENT!).ref).toBe(record.ref);
  expect(resumed.calls.some(a=>a[0]==="create")).toBe(false);
});

// Children of the 2026-10-19 eval lead, spawned through bash with the inherited marker.
async function childOf(parent: any, options: any = {}) {
  process.env.KATA_PI_PARENT = JSON.stringify({ ...JSON.parse(process.env.KATA_PI_PARENT!), pid: process.pid + 1 });
  const child = await host(options); await child.event("session_start", { reason: "startup" });
  return child;
}
function leaveChild() { for (const key of ["KATA_TEAMMATE", "KATA_INBOX_USER", "KATA_PI_PARENT"]) delete process.env[key]; }
// The child's delegate record as its session branch last saved it.
function delegateRecord(child: any) { return child.entries.filter((e: any) => e.customType === "io.kata.pi.delegate").at(-1)?.data; }
const piPlan = ["Implement word_count and top_words", "Delegate: subagent writes unittest suite in tests/ for both functions", "Run python3 -m unittest"];

test("a pi main session leaves a plan task held by an omp delegate alone", async () => {
  const parent = await host(); await parent.event("session_start", { reason: "startup" });
  const ref = await parent.init(["Remaining lead work", "Held by omp delegate"]);
  const held = (await show(ref)).children.find((c: any) => c.title === "Held by omp delegate");
  await kata(["meta", "set", held.short_id, "omp.subagent_id", "omp-worker", "--json"]);
  await kata(["meta", "set", held.short_id, "teammate", "omp-worker-abc123", "--json"]);
  const started = await parent.call({ op: "start", task: "Held by omp delegate" });
  expect(started.isError).toBe(true);
  expect(JSON.stringify(started)).toContain("belongs to a delegate");
  const after = (await show(`pitest#${held.short_id}`)).issue;
  expect(after.metadata["todo.status"]).not.toBe("in_progress");
});

test("a grandchild of an untracked child gets its own teammate", async () => {
  const parent = await host(); await parent.event("session_start", { reason: "startup" });
  await parent.init(piPlan);
  const untracked = await childOf(parent);
  await untracked.event("before_agent_start", { prompt: "Unrelated chores nobody planned", systemPromptOptions: { sections: {} } });
  const teammate = process.env.KATA_TEAMMATE;
  expect(teammate).toBeTruthy();
  const grandchild = await childOf(untracked);
  await grandchild.event("before_agent_start", { prompt: "Unrelated chores nobody planned", systemPromptOptions: { sections: {} } });
  expect(process.env.KATA_TEAMMATE).not.toBe(teammate);
  leaveChild();
});

test("a child binds the plan task its prompt describes, not the lead's active task", async () => {
  const parent = await host(); await parent.event("session_start", { reason: "startup" });
  const ref = await parent.init(piPlan);
  const child = await childOf(parent);
  await child.event("before_agent_start", { prompt: "You are a test writer. Write a unittest suite in tests/test_textstats.py covering word_count and top_words including empty input.", systemPromptOptions: { sections: {} } });
  const children = (await show(ref)).children;
  expect(children).toHaveLength(3);
  expect(children.find((c: any) => c.title === piPlan[1]).metadata["pi.subagent_id"]).toBe(child.sid);
  expect(children.find((c: any) => c.title === piPlan[0]).metadata["pi.subagent_id"]).toBeUndefined();
  leaveChild();
});

test("a child prompt naming any open child issue by short id binds it", async () => {
  const parent = await host(); await parent.event("session_start", { reason: "startup" });
  const ref = await parent.init(["Implement named-child fixture"]);
  const named = (await kata(["create", "Write tests for the named-child fixture", "--parent", ref, "--force-new", "--json"])).issue.short_id;
  const child = await childOf(parent);
  await child.event("before_agent_start", { prompt: `read issue ${named} and write the tests`, systemPromptOptions: { sections: {} } });
  expect(delegateRecord(child).ref).toBe(`pitest#${named}`);
  expect((await show(ref)).children).toHaveLength(2);
  leaveChild();
});

test("a child started from a stale parent ref works its plan task in the project the parent moved to", async () => {
  const parent = await host(); await parent.event("session_start", { reason: "startup" });
  const ref = await parent.init(["Lead plan that moves", "Investigate an independent question"]);
  expect(ref).toMatch(/^pitest#/);
  await kata(["projects", "create", "pimoved", "--json"]);
  await kata(["move", ref, "pimoved", "--json"]);
  const child = await childOf(parent);
  await child.event("before_agent_start", { prompt: "Investigate an independent question", systemPromptOptions: { sections: {} } });
  const record = delegateRecord(child);
  expect(record.ref).toMatch(/^pimoved#/);
  expect((await show(ref)).children.map((c: any) => c.short_id)).toContain(record.ref.split("#")[1]);
  leaveChild();
});

test("a child that never runs a tool leaves no issue and restores its plan task", async () => {
  const parent = await host(); await parent.event("session_start", { reason: "startup" });
  const ref = await parent.init(["Implement idle fixture", "Write idle fixture tests"]);
  const bound = await childOf(parent);
  await bound.event("before_agent_start", { prompt: "Write idle fixture tests", systemPromptOptions: { sections: {} } });
  await bound.event("session_shutdown");
  const task = (await show(ref)).children.find((c: any) => c.title === "Write idle fixture tests");
  expect(task.status).toBe("open");
  expect(task.metadata["pi.subagent_id"]).toBeUndefined();
  expect(task.metadata.teammate).toBeUndefined();
  expect(task.metadata["todo.status"]).toBe("pending");
  expect(task.metadata["work.attention"]).toBeUndefined();
  expect((await show(`pitest#${task.short_id}`)).labels ?? []).toHaveLength(0);
  leaveChild();
});

test("a child that matches no plan task or ticket is untracked: no issue, the untracked context, its kata calls rewritten with its teammate", async () => {
  const parent = await host(); await parent.event("session_start", { reason: "startup" });
  const ref = await parent.init(["Implement probe fixture", "Write probe fixture tests"]);
  const probe = await childOf(parent);
  const prompt: any = { prompt: "Reply with exactly: SUBAGENT-OK", systemPromptOptions: { sections: {} } };
  await probe.event("before_agent_start", prompt);
  expect(delegateRecord(probe).state).toBe("untracked");
  expect(prompt.systemPromptOptions.sections.kata_binding).toContain("you have no Kata issue");
  const rewritten = await probe.event("tool_call", { toolName: "bash", input: { command: "kata list" } });
  expect(rewritten?.block).toBeUndefined();
  expect(probe.calls.some(a => a[0] === "create")).toBe(false);
  const todo = await probe.call({ op: "view" });
  expect(todo.isError).toBe(true);
  expect(todo.content[0].text).toContain("no Kata issue");
  await probe.event("session_shutdown");
  expect((await show(ref)).children.map((c: any) => c.title).sort()).toEqual(["Implement probe fixture", "Write probe fixture tests"]);
  expect((await show(ref)).children.some((c: any) => c.metadata?.["pi.subagent_id"])).toBe(false);
  leaveChild();
});

test("a child that worked but left its plan task open hands it back for review", async () => {
  const parent = await host(); await parent.event("session_start", { reason: "startup" });
  const ref = await parent.init(["Implement handback fixture", "Write handback fixture tests"]);
  const child = await childOf(parent);
  await child.event("before_agent_start", { prompt: "Write handback fixture tests", systemPromptOptions: { sections: {} } });
  await child.event("tool_call", { toolName: "bash", input: { command: "ls" } });
  await child.event("session_shutdown");
  leaveChild();
  const task = (await show(ref)).children.find((c: any) => c.title === "Write handback fixture tests");
  const view = await show(`pitest#${task.short_id}`);
  expect(view.labels.some((l: any) => l.label === "needs-review")).toBe(true);
  expect(view.issue.metadata.teammate).toBeUndefined();
  expect(view.issue.metadata["todo.status"]).toBe("pending");
  expect((await kata(["inbox", "--for", "pi-builder", "--json"])).requests.some((r: any) => r.ref.endsWith(task.short_id))).toBe(true);
  expect((await parent.call({ op: "done", task: "Write handback fixture tests", message, evidence })).isError).toBeUndefined();
  const closed = await show(`pitest#${task.short_id}`);
  expect(closed.issue.status).toBe("closed");
  expect(closed.labels.some((l: any) => l.label === "needs-review")).toBe(false);
});

test("children run on the parent's model and thinking level unless given their own", async () => {
  const zai = { provider: "zai", id: "glm-5.3" };
  const parent = await host({ model: zai, thinking: "high" }); await parent.event("session_start", { reason: "startup" });
  await parent.event("tool_call", { toolName: "read", input: { path: "README.md" } });
  expect(JSON.parse(process.env.KATA_PI_PARENT!)).toMatchObject({ provider: "zai", model: "glm-5.3", thinking: "high" });
  const registry = { find: (provider: string, id: string) => provider === "zai" && id === "glm-5.3" ? zai : undefined };
  const child = await childOf(parent, { model: { provider: "openai-codex", id: "gpt-6" }, modelRegistry: registry });
  expect(child.models).toEqual([zai]);
  expect(child.thinking).toEqual(["high"]);
  leaveChild();
  const argv = process.argv; process.argv = [...argv, "--model", "openai-codex/gpt-6"];
  try {
    process.env.KATA_PI_PARENT = JSON.stringify({ pid: process.pid, sessionId: parent.sid, workspace: cwd, teammate: "", provider: "zai", model: "glm-5.3" });
    const flagged = await childOf(parent, { modelRegistry: registry });
    expect(flagged.models).toEqual([]);
  } finally { process.argv = argv; leaveChild(); }
});

test("the lead creates its parent only for commands that launch pi", async () => {
  const app = await host(); await app.event("session_start", { reason: "startup" });
  await app.event("tool_call", { toolName: "bash", input: { command: "find . -name '*.py'" } });
  await app.event("tool_call", { toolName: "read", input: { path: "README.md" } });
  expect(app.calls.some(a => a[0] === "create")).toBe(false);
  await app.event("tool_call", { toolName: "bash", input: { command: "nohup env KATA_TEAMMATE=testwriter pi -p --no-session 'write tests' &" } });
  expect(app.calls.filter(a => a[0] === "create")).toHaveLength(1);
  expect(JSON.parse(process.env.KATA_PI_PARENT!).ref).toMatch(/^pitest#/);
});

test("a child keeps a teammate the lead chose for it", async () => {
  const parent = await host(); await parent.event("session_start", { reason: "startup" });
  await parent.init(["Chosen teammate fixture"]);
  process.env.KATA_TEAMMATE = "testwriter";
  const child = await childOf(parent);
  await child.event("before_agent_start", { prompt: "Chosen teammate fixture", systemPromptOptions: { sections: {} } });
  expect(delegateRecord(child).teammate).toBe("testwriter");
  expect(process.env.KATA_INBOX_USER).toBe("pi-builder/testwriter");
  leaveChild();
});

test("only commands that run pi count as child launches", () => {
  for (const command of ["pi -p x", "nohup env KATA_TEAMMATE=testwriter pi -p --no-session 'w' &", "./pi -p x", "/opt/homebrew/bin/pi -p", "cd w && pi -p y"]) expect(launchesPi(command)).toBe(true);
  for (const command of ["bash -c \"pi -p x\"", "sh -c 'pi -p y'", "zsh -lc 'pi -p z'"]) expect(launchesPi(command)).toBe(true);
  for (const command of ["grep pi file", "rg pi plugins/", "which pi", "echo pi", "ls pi-dir", "pip install x", "grep -rn \"pi config\" .", "echo 'pi now'"]) expect(launchesPi(command)).toBe(false);
});

test("a child reload keeps its binding", async () => {
  const parent = await host(); await parent.event("session_start", { reason: "startup" });
  const ref = await parent.init(["Implement reload fixture", "Write reload fixture tests"]);
  const child = await childOf(parent);
  await child.event("before_agent_start", { prompt: "Write reload fixture tests", systemPromptOptions: { sections: {} } });
  await child.event("session_shutdown", { reason: "reload" });
  const task = (await show(ref)).children.find((c: any) => c.title === "Write reload fixture tests");
  expect(task.metadata["pi.subagent_id"]).toBe(child.sid);
  expect(task.metadata.teammate).toBe(delegateRecord(child).teammate);
  leaveChild();
});

test("an untracked child leaves the lead's marker for the children it starts", async () => {
  const parent = await host(); await parent.event("session_start", { reason: "startup" });
  await parent.init(["Implement marker fixture", "Write marker fixture tests"]);
  const lead = JSON.parse(process.env.KATA_PI_PARENT!);
  const probe = await childOf(parent);
  await probe.event("before_agent_start", { prompt: "Reply with exactly: SUBAGENT-OK", systemPromptOptions: { sections: {} } });
  expect(delegateRecord(probe).state).toBe("untracked");
  expect(JSON.parse(process.env.KATA_PI_PARENT!)).toMatchObject({ sessionId: lead.sessionId, ref: lead.ref });
  leaveChild();
});

test("a resumed assigned child shows the sub-plan it made under its issue in its first prompt", async () => {
  const parent = await host(); await parent.event("session_start", { reason: "startup" });
  await parent.init(["Implement resume fixture", "Write resume fixture tests"]);
  const marker = process.env.KATA_PI_PARENT!;
  const child = await childOf(parent);
  await child.event("before_agent_start", { prompt: "Write resume fixture tests", systemPromptOptions: { sections: {} } });
  await child.call({ op: "init", items: ["Sketch the resume cases"] });
  process.env.KATA_PI_PARENT = JSON.stringify({ ...JSON.parse(marker), pid: process.pid + 1 });
  const resumed = await host({ sid: child.sid, entries: JSON.parse(JSON.stringify(child.entries)) });
  await resumed.event("session_start", { reason: "resume" });
  const event: any = { prompt: "Continue", systemPromptOptions: { sections: {} } };
  await resumed.event("before_agent_start", event);
  expect(event.systemPromptOptions.sections.kata_todo).toContain("Sketch the resume cases");
  leaveChild();
});

test("a child keeps a throttled close across its next prompt and closes when the throttle lifts", async () => {
  const parent = await host(); await parent.event("session_start", { reason: "startup" });
  await parent.init(["Implement throttle fixture", "Write throttle fixture tests"]);
  let throttle = true;
  const child = await childOf(parent, { before: (a: string[]) => a[0] === "close" && throttle ? siblingThrottle() : undefined });
  await child.event("before_agent_start", { prompt: "Write throttle fixture tests", systemPromptOptions: { sections: {} } });
  const ref = await child.init(["Sketch the throttle cases"]);
  expect((await child.call({ op: "done", message, evidence })).isError).toBeUndefined();
  const sub = (await show(ref)).children[0];
  expect(sub.status).toBe("open");
  await child.event("before_agent_start", { prompt: "Carry on", systemPromptOptions: { sections: {} } });
  throttle = false;
  await later(() => child.call({ op: "view" }));
  expect((await show(ref)).children[0].status).toBe("closed");
  leaveChild();
});

test("a child never binds an issue another writer owns", async () => {
  const parent = await host(); await parent.event("session_start", { reason: "startup" });
  const ref = await parent.init(["Implement foreign fixture"]);
  const foreign = (await kata(["create", "Write foreign fixture tests", "--parent", ref, "--force-new", "--json"])).issue.short_id;
  await kata(["claim", foreign, "--as", "someone-else", "--json"]);
  const child = await childOf(parent);
  await child.event("before_agent_start", { prompt: "Write foreign fixture tests", systemPromptOptions: { sections: {} } });
  expect(delegateRecord(child).ref).toBeUndefined();
  expect((await show(`pitest#${foreign}`)).issue.metadata["pi.subagent_id"]).toBeUndefined();
  leaveChild();
});

test("Pi child recovers an automatic parent from a replay create envelope", async () => {
  const sessionId = `replay-lead-${++sequence}`;
  process.env.KATA_PI_PARENT = JSON.stringify({ pid: process.pid + 1, sessionId, workspace: cwd, teammate: "lead" });
  const child = await host({ before: async (args: string[], opts: any) => {
    if (args[0] !== "create" || !args.includes("pi-session")) return;
    // Execute the real idempotent create twice: the second response carries original_event.
    const first = await run(args, opts.cwd); expect(first.code).toBe(0);
    return run(args, opts.cwd);
  } });
  await child.event("session_start", { reason: "startup" });
  const prompt: any = { prompt: "An independent replay child task", systemPromptOptions: { sections: {} } };
  await child.event("before_agent_start", prompt);
  expect(delegateRecord(child)).toBeDefined();
  const parents = (await kata(["list", "--status", "all", "--meta", `pi.session_id=${sessionId}`, "--label", "pi-session", "--json"])).issues;
  expect(parents).toHaveLength(1);
  expect(parents[0].metadata["pi.auto_parent"]).toBe(true);
  leaveChild();
});

test("pi items that name a ticket work and log on it without creating an issue or a parent", async () => {
  const app = await host(); await app.event("session_start", { reason: "startup" });
  const ticket = (await kata(["create", "Existing pi work", "--force-new", "--json"])).issue.short_id;
  const before = (await kata(["list", "--status", "all", "--limit", "0", "--json"])).issues.length;
  const started = await app.call({ op: "init", items: [`pitest#${ticket}: write the first part`, `pitest#${ticket}: write the second part`] });
  expect(started.isError).toBeUndefined();
  expect(started.details.kata.parent).toBeUndefined();
  expect((await kata(["list", "--status", "all", "--limit", "0", "--json"])).issues).toHaveLength(before);
  expect((await show(ticket)).issue.owner).toBe("pi-builder");
  expect((await show(ticket)).issue.metadata["todo.status"]).toBe("in_progress");
  expect((await app.call({ op: "done", task: `pitest#${ticket}: write the first part`, message, evidence })).isError).toBeUndefined();
  expect((await show(ticket)).issue.status).toBe("open");
  const last = await app.call({ op: "done", task: `pitest#${ticket}: write the second part`, message, evidence: ["test:bun test pi last item"] });
  expect(last.isError).toBeUndefined();
  const closed = await show(ticket);
  expect(closed.issue.status).toBe("closed");
  expect(closed.comments).toHaveLength(2);
  const rows = (await kata(["audit", "closes", "--json"])).rows.filter((r: any) => r.issue === ticket);
  expect(rows).toHaveLength(1);
  expect((await kata(["events", "--after", String(rows[0].event_id - 1), "--limit", "1", "--json"])).events[0].payload.evidence).toEqual([{ type: "test", command: "bun test pi last item" }]);
  expect((await kata(["list", "--status", "all", "--limit", "0", "--json"])).issues).toHaveLength(before);
});

test("pi closes a claimed ticket named by an item once its plan children close", async () => {
  const app = await host(); await app.event("session_start", { reason: "startup" });
  const ticket = (await kata(["create", "Claimed pi ticket", "--force-new", "--json"])).issue.short_id;
  await kata(["claim", ticket, "--json"]);
  await app.event("tool_result", { toolName: "bash", input: { command: `kata claim pitest#${ticket}` }, isError: false, details: {} });
  const started = await app.call({ op: "init", items: [`pitest#${ticket}: write the greeting`, "Add the ignore file"] });
  expect(started.isError, started.content[0].text).toBeUndefined();
  expect(started.details.kata.parent).toBe(`pitest#${ticket}`);
  await app.call({ op: "done", task: `pitest#${ticket}: write the greeting`, message, evidence: ["test:pi ticket item"] });
  expect((await show(ticket)).issue.status).toBe("open");
  expect((await app.call({ op: "done", task: "Add the ignore file", message, evidence })).isError).toBeUndefined();
  const closed = await show(ticket);
  expect(closed.issue.status).toBe("closed");
  expect(closed.comments.filter((c: any) => /open child/.test(c.body))).toHaveLength(1);
  const rows = (await kata(["audit", "closes", "--json"])).rows.filter((r: any) => r.issue === ticket);
  expect(rows).toHaveLength(1);
  expect((await kata(["events", "--after", String(rows[0].event_id - 1), "--limit", "1", "--json"])).events[0].payload.evidence).toEqual([{ type: "test", command: "pi ticket item" }]);
});

test("pi init without replace goes through when the new list keeps every open task", async () => {
  const app = await host(); const parent = await app.init(["Open pi task"]);
  const result = await app.call({ op: "init", items: ["Open pi task", "Added pi task"] });
  expect(result.isError, result.content[0].text).toBeUndefined();
  expect((await show(parent)).children.map((c: any) => c.title).sort()).toEqual(["Added pi task", "Open pi task"]);
});

test("pi accepts replace on todo init and refuses without it while tasks are open", async () => {
  const app = await host(); const parent = await app.init(["Open pi task", "Other pi task"]);
  expect(Value.Check(app.tool.parameters, { op: "init", items: ["Next pi task"], replace: true })).toBe(true);
  const refused = await app.call({ op: "init", items: ["Next pi task"] });
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toContain("Open pi task");
  expect((await show(parent)).children.map((c: any) => c.title).sort()).toEqual(["Open pi task", "Other pi task"]);
  const replaced = await app.call({ op: "init", items: ["Next pi task"], replace: true });
  expect(replaced.isError).toBeUndefined();
  const old = (await show(parent)).children.find((c: any) => c.title === "Open pi task");
  expect(old.closed_reason).toBe("wontfix");
});

test("pi sets its transcript identity on start, a child replaces the inherited one, a shutdown leaves the next session's", async () => {
  delete process.env.KATA_TRANSCRIPT_AGENT; delete process.env.KATA_TRANSCRIPT_SESSION_ID;
  try {
  const lead = await host(); await lead.event("session_start", { reason: "startup" });
  expect([process.env.KATA_TRANSCRIPT_AGENT, process.env.KATA_TRANSCRIPT_SESSION_ID]).toEqual(["pi", lead.sid]);
  const child = await host(); await child.event("session_start", { reason: "startup" });
  expect(process.env.KATA_TRANSCRIPT_SESSION_ID).toBe(child.sid);
  await lead.event("session_shutdown", { reason: "new" });
  expect([process.env.KATA_TRANSCRIPT_AGENT, process.env.KATA_TRANSCRIPT_SESSION_ID]).toEqual(["pi", child.sid]);
  } finally { delete process.env.KATA_TRANSCRIPT_AGENT; delete process.env.KATA_TRANSCRIPT_SESSION_ID; }
});

test("a close driven through pi's real exec records the pi session when close transcripts are on", async () => {
  const { execCommand } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/exec.js");
  writeFileSync(path.join(env.KATA_HOME, "config.toml"), "[close.transcript]\nenabled = true\n");
  const previousHome = process.env.KATA_HOME; process.env.KATA_HOME = env.KATA_HOME;
  try {
    const app = await host({ exec: (file: string, args: string[], opts: any) => execCommand(file, args, opts.cwd, opts) });
    await app.event("session_start", { reason: "startup" });
    await app.init(["Real exec transcript task"]);
    const done = await app.call({ op: "done", task: "Real exec transcript task", message, evidence });
    expect(done.isError, done.content?.[0]?.text).toBeUndefined();
    const closes = (await kata(["events", "--after", "0", "--limit", "500", "--json"])).events.filter((e: any) => e.type === "issue.closed" && e.payload?.transcript?.session_id === app.sid);
    expect(closes.length).toBeGreaterThan(0);
    expect(closes[0].payload.transcript).toMatchObject({ agent: "pi", session_id: app.sid });
  } finally { if (previousHome === undefined) delete process.env.KATA_HOME; else process.env.KATA_HOME = previousHome; }
});

test("a slow shutdown of the old instance does not delete the next session's transcript identity", async () => {
  delete process.env.KATA_TRANSCRIPT_AGENT; delete process.env.KATA_TRANSCRIPT_SESSION_ID;
  try {
    let slow = false, resumed = 0; const release = Promise.withResolvers<void>();
    const lead = await host({ before: async () => { if (slow) { await release.promise; resumed++; } return undefined; } });
    await lead.event("session_start", { reason: "startup" }); await lead.init(["Slow shutdown task"]);
    slow = true;
    const shutdown = lead.event("session_shutdown", { reason: "new" });
    await new Promise(resolve => setTimeout(resolve, 400));
    const next = await host(); await next.event("session_start", { reason: "new" });
    await shutdown;
    release.resolve(); slow = false;
    while (!resumed) await new Promise(resolve => setTimeout(resolve, 20));
    await new Promise(resolve => setTimeout(resolve, 300));
    expect([process.env.KATA_TRANSCRIPT_AGENT, process.env.KATA_TRANSCRIPT_SESSION_ID]).toEqual(["pi", next.sid]);
  } finally { delete process.env.KATA_TRANSCRIPT_AGENT; delete process.env.KATA_TRANSCRIPT_SESSION_ID; }
});
