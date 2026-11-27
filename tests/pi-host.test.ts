import { expect, test } from "bun:test";
import fc from "fast-check";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { Value } from "typebox/value";
import { finishes, holdKata } from "./kata-fixture";
import { piFixture } from "./pi-fixture";

// Plan creation and closing, prompt sections, native adapter coexistence and attention, stop reminders and Bash hooks.
const { binary, scratch, cwd, outside, run, show, kata, issue, closesOf, host, asChild, nativeKey, globalRegistry, down, evidence, message } = piFixture();

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

test("pi's tool schema accepts valid todo calls and rejects malformed ones", async () => {
  const app = await host();
  expect(Value.Check(app.tool.parameters, { op: "init", items: ["A task"] })).toBe(true);
  expect(Value.Check(app.tool.parameters, { op: "init", items: ["A task"], replace: true })).toBe(true);
  expect(Value.Check(app.tool.parameters, { op: "invented" })).toBe(false);
  expect(Value.Check(app.tool.parameters, { op: "done", evidence: "wrong" })).toBe(false);
  expect(Value.Check(app.tool.parameters, { op: "init", list: [{ phase: "Empty", items: [] }] })).toBe(false);
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
  const closes = await closesOf(ref);
  expect(closes).toHaveLength(1);
  expect(closes[0].payload.evidence).toEqual([{ type: "test", command: "bun test fixture" }]);
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
  const ref = await issue("Explicit pi parent");
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

test("pi leaves native attention baselines and the main ref to the native adapter", async () => {
  const ref = await issue("Native-owned pi attention");
  // Regression: startup with a user adapter and no baseline used to preseed it.
  await fc.assert(fc.asyncProperty(
    fc.constantFrom("startup", "reload", "new", "resume", "fork"),
    fc.constantFrom("user", "project"),
    fc.constantFrom("absent", "live", "ended"),
    async (reason, scope, previous) => {
      process.env.KATA_REF = ref;
      delete process.env.KATA_PI_PARENT;
      const active = new Map();
      const baseline = { id: "native-session", ref, ended: previous === "ended" };
      if (previous !== "absent") active.set(cwd, baseline);
      globalRegistry[nativeKey] = { adapters: new Map([["native", { options: { scope, workspace: cwd, attention: true, executable: binary } }]]), active };
      const app = await host(); await app.event("session_start", { reason });
      expect(process.env.KATA_REF).toBe(ref);
      expect(active.size).toBe(previous === "absent" ? 0 : 1);
      expect(active.get(cwd)).toBe(previous === "absent" ? undefined : baseline);
      expect(baseline).toEqual({ id: "native-session", ref, ended: previous === "ended" });
      await app.event("session_shutdown", { reason: "quit" });
    },
  ), { numRuns: 12, examples: [["startup", "user", "absent"]] });
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

test("pi refuses a write or commit that names a ref of the plan until KATA_REF_GUARD is off", async () => {
  const app = await host(); await app.event("session_start", { reason: "startup" });
  const ref = await app.init(["Guarded pi task"]);
  const write = (content: string, file = path.join(cwd, "notes.ts")) => app.event("tool_call", { toolName: "write", input: { path: file, content } });
  const refused = await write(`// tracked as ${ref}`);
  expect(refused).toMatchObject({ block: true });
  expect(refused.reason).toContain(ref);
  expect(refused.reason).toContain("KATA_REF_GUARD=off");
  expect(await app.event("tool_call", { toolName: "edit", input: { path: path.join(cwd, "a.ts"), edits: [{ oldText: "x", newText: `// ${ref}` }] } })).toMatchObject({ block: true });
  expect(await app.event("tool_call", { toolName: "bash", input: { command: `git commit -m "fix ${ref}"` } })).toMatchObject({ block: true });
  expect(await write("// tracked as README.md#tasks")).toBeUndefined();
  expect(await write(ref, path.join(outside, "notes.ts"))).toBeUndefined();
  expect(await app.event("tool_call", { toolName: "bash", input: { command: `kata comment ${ref} -m "note ${ref}"` } })).toBeUndefined();
  // A claim of a shell variable names nothing: the literal word is no ref.
  await app.event("tool_result", { toolName: "bash", isError: false, input: { command: 'kata claim "$ref"' }, content: [] });
  expect(await write("echo $ref; echo ${ref}")).toBeUndefined();
  process.env.KATA_REF_GUARD = "0";
  try { expect(await write(`// tracked as ${ref}`)).toBeUndefined(); }
  finally { delete process.env.KATA_REF_GUARD; }
});

test("pi adopts a successful Bash claim using isError without OMP exitCode details", async () => {
  const ref = await issue("Pi adopted parent");
  await kata(["claim", ref, "--json"]);
  const app = await host(); await app.event("session_start", { reason: "startup" });
  await app.event("tool_result", { toolName: "bash", input: { command: `kata claim ${ref}` }, isError: false, details: {} });
  expect((await app.call({ op: "view" })).details.kata.parent).toBe(`pitest#${ref}`);
});

test("pi keeps an unreachable Kata local, shows a contract stub and bounds hooks", async () => {
  const app = await host({ cwd: outside, before: down }); await app.event("session_start", { reason: "startup" });
  await app.init(["Local pi task"]);
  expect((await app.call({ op: "done" })).isError).toBeUndefined();
  const prompt = { systemPromptOptions: { sections: {} } };
  await app.event("before_agent_start", prompt);
  expect(prompt.systemPromptOptions.sections).toEqual({ kata_contract: expect.stringContaining("Kata contract is unavailable (kata version failed: selected daemon is unavailable while connecting). Before using kata, run:") });
  expect(app.calls.some(a => ["create", "claim", "meta", "close"].includes(a[0]))).toBe(false);
  // Kata does not answer until the test lets it: the hooks must return on their own bound, not on Kata's answer.
  const held = holdKata(() => true, () => ({ code: 1, stdout: "", stderr: "offline" }));
  const slow = await host({ before: held.before });
  try {
    expect(await finishes((async () => { await slow.event("session_start", { reason: "startup" }); await slow.event("before_agent_start", { systemPromptOptions: { sections: {} } }); })())).toBe(true);
    expect(held.held).toBeGreaterThan(0);
    expect(slow.notices).toEqual([]);
  } finally { held.release(); }
});

for (const order of ["plugin-first", "native-first"]) test(`real native adapter preserves parent attention with ${order}`, async () => {
  const ref = await issue("Real native ordering parent");
  await kata(["claim", ref, "--json"]);
  process.env.KATA_REF = `pitest#${ref}`;
  globalRegistry[nativeKey] = {adapters:new Map(), active:new Map()};
  const nativeCwd = realpathSync(cwd);
  const app = await host({nativeOrder:order, cwd:nativeCwd}); await app.event("session_start", {reason:"startup"});
  expect(globalRegistry[nativeKey].active.get(nativeCwd).ref).toBe(`pitest#${ref}`);
  expect(process.env.KATA_REF).toBe(`pitest#${ref}`);
  expect(globalRegistry[nativeKey].active.get(nativeCwd).startAttempted).toBe(true);
  const baseline = (await show(ref)).issue.metadata;
  expect(baseline["work.attention"]).toBe("ok");
  asChild();
  globalRegistry[nativeKey]={adapters:new Map(),active:new Map()};
  const child=await host({nativeOrder:order, cwd:nativeCwd}); await child.event("session_start",{reason:"startup"});
  expect(globalRegistry[nativeKey].active.get(nativeCwd).ref).toBe("");
  await child.event("session_shutdown",{reason:"quit"});
  expect((await show(ref)).issue.metadata).toEqual(baseline);
  expect(child.calls.filter(a => a[1] === "attention-native")).toEqual([]);
  globalRegistry[nativeKey]={adapters:new Map(),active:new Map()};
});

const attentionCalls = (app: any) => app.calls.filter((a: string[]) => a[1] === "attention-native").map((a: string[]) => [a[3], a[a.indexOf("--ref") + 1]]);
test("real native adapter sends no attention end for a session without KATA_REF when the plugin loads first", async () => {
  globalRegistry[nativeKey] = { adapters: new Map(), active: new Map() };
  const nativeCwd = realpathSync(cwd);
  const app = await host({ nativeOrder: "plugin-first", cwd: nativeCwd }); await app.event("session_start", { reason: "startup" });
  expect(globalRegistry[nativeKey].active.get(nativeCwd).ref).toBe("");
  await app.event("session_shutdown", { reason: "quit" });
  expect(attentionCalls(app)).toEqual([]);
  globalRegistry[nativeKey] = { adapters: new Map(), active: new Map() };
});

test("real native adapter starts and ends attention once each on the lead's issue with KATA_REF", async () => {
  const ref = await issue("Real native attention lead");
  await kata(["claim", ref, "--json"]);
  process.env.KATA_REF = `pitest#${ref}`;
  globalRegistry[nativeKey] = { adapters: new Map(), active: new Map() };
  const nativeCwd = realpathSync(cwd);
  const app = await host({ nativeOrder: "plugin-first", cwd: nativeCwd }); await app.event("session_start", { reason: "startup" });
  await app.event("session_shutdown", { reason: "quit" });
  expect(attentionCalls(app)).toEqual([["start", `pitest#${ref}`], ["end", `pitest#${ref}`]]);
  globalRegistry[nativeKey] = { adapters: new Map(), active: new Map() };
});
