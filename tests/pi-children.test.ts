import { expect, test } from "bun:test";
import path from "node:path";
import { later } from "./kata-fixture";
import { siblingThrottle } from "./kata-errors";
import { launchesPi } from "../plugins/pi/kata";
import { piFixture } from "./pi-fixture";

// Child sessions: binding to a plan task or ticket, naming, reports, hand-back, models, throttled closes and automatic parents.
const { cwd, outside, env, run, kata, show, host, down, evidence, message, unique } = await piFixture();

test("pi child named binding owns its issue and closes with its teammate", async () => {
  const parent = await host(); await parent.event("session_start", { reason: "startup" });
  const ref = await parent.init(["Delegated pi work", "Remaining lead work"]);
  const marker = JSON.parse(process.env.KATA_PI_PARENT!);
  process.env.KATA_PI_PARENT = JSON.stringify({ ...marker, pid: process.pid + 1 });
  process.env.KATA_REF = ref; // Stale inherited lead routing must be removed.
  const child = await host(); await child.event("session_start", { reason: "startup" });
  expect(process.env.KATA_REF).toBeUndefined();
  const prompt: any = { prompt: "Complete Delegated pi work", systemPromptOptions: { sections: {} } };
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

test("a pi child that leaves its issue open without a comment gets its last assistant text posted as its report, under its task's name", async () => {
  const parent = await host(); await parent.event("session_start", { reason: "startup" });
  await parent.init(["Reported pi work", "Lead pi work"]);
  const marker = JSON.parse(process.env.KATA_PI_PARENT!);
  process.env.KATA_PI_PARENT = JSON.stringify({ ...marker, pid: process.pid + 1 });
  try {
    const child = await host(); await child.event("session_start", { reason: "startup" });
    await child.event("before_agent_start", { prompt: "Complete Reported pi work", systemPromptOptions: { sections: {} } });
    const record = delegateRecord(child);
    expect(record.name).toBe("reported-pi-work");
    expect(record.teammate).toMatch(/^reported-pi-work-[0-9a-f]{6}$/);
    await child.event("tool_call", { toolName: "read", input: { path: "README.md" } });
    child.entries.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Half done: the parser is written, its tests are not." }] } });
    // A run that failed on a provider error ends on an assistant message without text.
    child.entries.push({ type: "message", message: { role: "assistant", content: [], stopReason: "error" } });
    await child.event("session_shutdown", { reason: "quit" });
    const comments = (await show(record.ref)).comments.map((c: any) => [c.teammate, c.body]);
    expect(comments).toContainEqual([record.teammate, "Report from subagent reported-pi-work (it left no comment of its own):\n\nHalf done: the parser is written, its tests are not."]);
    expect(comments).toContainEqual([record.teammate, "Subagent reported-pi-work ended without closing its Kata issue. Review the work and supply evidence before closing."]);
  } finally { delete process.env.KATA_TEAMMATE; delete process.env.KATA_INBOX_USER; delete process.env.KATA_PI_PARENT; }
});

for (const named of ["session", "none"]) test(`a pi child is named by ${named === "session" ? "its --name over its task" : "the end of its session id when it matched nothing"}`, async () => {
  const parent = await host(); await parent.event("session_start", { reason: "startup" });
  await parent.init(["Named pi work", "Other lead work"]);
  const marker = JSON.parse(process.env.KATA_PI_PARENT!);
  process.env.KATA_PI_PARENT = JSON.stringify({ ...marker, pid: process.pid + 1 });
  try {
    const child = await host(named === "session" ? { sessionName: "Slug Writer" } : { sid: "01a1bfd7-4b80-77d7-9ce3-18e7ceff1c15" });
    await child.event("session_start", { reason: "startup" });
    const prompt = { prompt: named === "session" ? "Complete Named pi work" : "Survey the unrelated build system", systemPromptOptions: { sections: {} as any } };
    await child.event("before_agent_start", prompt);
    const record = delegateRecord(child);
    const name = named === "session" ? "Slug Writer" : "pi-ff1c15";
    expect(record.name).toBe(name);
    expect(record.teammate).toMatch(new RegExp(`^${name.toLowerCase().replace(" ", "-")}-[0-9a-f]{6}$`));
    expect(prompt.systemPromptOptions.sections.kata_binding).toStartWith(`You are subagent ${name}.`);
  } finally { delete process.env.KATA_TEAMMATE; delete process.env.KATA_INBOX_USER; delete process.env.KATA_PI_PARENT; }
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

test("retaining main KATA_REF preserves explicit binding precedence", async () => {
  const first=(await kata(["create","Pinned Pi explicit parent","--force-new","--json"])).issue.short_id;
  const second=(await kata(["create","Different Pi requested parent","--force-new","--json"])).issue.short_id;
  process.env.KATA_REF=first;
  const app=await host(); await app.event("session_start",{reason:"startup"});
  expect(process.env.KATA_REF).toBe(first);
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

test("a child whose prompt only describes a plan task is untracked and binds nothing", async () => {
  const parent = await host(); await parent.event("session_start", { reason: "startup" });
  const ref = await parent.init(piPlan);
  const child = await childOf(parent);
  const prompt: any = { prompt: "You are a test writer. Write a unittest suite in tests/test_textstats.py covering word_count and top_words including empty input.", systemPromptOptions: { sections: {} } };
  await child.event("before_agent_start", prompt);
  const children = (await show(ref)).children;
  expect(children).toHaveLength(3);
  expect(children.every((c: any) => c.metadata["pi.subagent_id"] === undefined)).toBe(true);
  expect(prompt.systemPromptOptions.sections.kata_binding).toContain("you have no Kata issue");
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

// A child that ends on a report: what it said last, then its shutdown.
async function endWithReport(child: any, text: string) {
  child.entries.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
  await child.event("session_shutdown", { reason: "quit" });
  leaveChild();
}
const missionsUnder = async (ref: string) => (await show(ref)).children.filter((c: any) => c.metadata?.["pi.mission"] === "true");
const reportsOn = async (ref: string) => ((await show(ref)).comments ?? []).filter((c: any) => c.body.startsWith("Report from subagent")).map((c: any) => [c.teammate, c.body]);

test("an untracked child that ends with a report leaves a closed mission under the lead's parent", async () => {
  const parent = await host(); await parent.event("session_start", { reason: "startup" });
  const ref = await parent.init(["Implement mission fixture"]);
  const child = await childOf(parent);
  await child.event("before_agent_start", { prompt: "Survey the unrelated build system", systemPromptOptions: { sections: {} } });
  const record = delegateRecord(child);
  await endWithReport(child, "The build system is plain make.");
  const [mission] = await missionsUnder(ref);
  expect(mission).toMatchObject({ status: "closed", closed_reason: "audit-no-change", metadata: { "pi.mission_subagent_id": child.sid } });
  expect(await reportsOn(`pitest#${mission.short_id}`)).toEqual([[record.teammate, `Report from subagent ${record.name}:\n\nThe build system is plain make.`]]);
});

test("a child naming two plan items gets its report on each, closes neither, and leaves no mission", async () => {
  const parent = await host(); await parent.event("session_start", { reason: "startup" });
  const ref = await parent.init(["Build the left widget", "Build the right widget"]);
  const child = await childOf(parent);
  const prompt: any = { prompt: 'Do "Build the left widget" and "Build the right widget"', systemPromptOptions: { sections: {} } };
  await child.event("before_agent_start", prompt);
  expect(prompt.systemPromptOptions.sections.kata_binding).toContain("you have no Kata issue");
  const record = delegateRecord(child);
  await endWithReport(child, "Both widgets are sketched; neither is tested.");
  const tasks = (await show(ref)).children;
  expect(tasks.map((c: any) => c.status)).toEqual(["open", "open"]);
  for (const task of tasks) expect((await reportsOn(`pitest#${task.short_id}`)).map(([teammate, body]: string[]) => [teammate, body.endsWith("Both widgets are sketched; neither is tested.")])).toEqual([[record.teammate, true]]);
  expect(await missionsUnder(ref)).toEqual([]);
});

test("a child refused a plan task another delegate holds records nothing", async () => {
  const parent = await host(); await parent.event("session_start", { reason: "startup" });
  const ref = await parent.init(["Held conflict task"]);
  const held = (await show(ref)).children[0];
  await kata(["meta", "set", held.short_id, "omp.subagent_id", "omp-worker", "--json"]);
  const child = await childOf(parent);
  await child.event("before_agent_start", { prompt: "Complete Held conflict task", systemPromptOptions: { sections: {} } });
  await endWithReport(child, "I could not take the held task.");
  expect(await missionsUnder(ref)).toEqual([]);
  expect(await reportsOn(`pitest#${held.short_id}`)).toEqual([]);
});

test("a lead with no plan closes, when it ends, the parent its untracked child made for its mission", async () => {
  const parent = await host(); await parent.event("session_start", { reason: "startup" });
  const child = await childOf(parent);
  await child.event("before_agent_start", { prompt: "Survey the unrelated build system", systemPromptOptions: { sections: {} } });
  await endWithReport(child, "The build system is plain make.");
  const [made] = (await kata(["list", "--status", "all", "--meta", `pi.session_id=${parent.sid}`, "--label", "pi-session", "--json"])).issues;
  expect((await missionsUnder(made.qualified_id)).map((c: any) => c.status)).toEqual(["closed"]);
  await parent.event("session_shutdown", { reason: "quit" });
  expect((await show(made.qualified_id)).issue).toMatchObject({ status: "closed", closed_reason: "audit-no-change" });
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

test("a child that closed its plan task leaves it closed and returned to the lead, with no child marker", async () => {
  const parent = await host(); await parent.event("session_start", { reason: "startup" });
  const ref = await parent.init(["Implement closed fixture", "Write closed fixture tests"]);
  const child = await childOf(parent);
  await child.event("before_agent_start", { prompt: "Write closed fixture tests", systemPromptOptions: { sections: {} } });
  await child.event("tool_call", { toolName: "bash", input: { command: "ls" } });
  const task = (await show(ref)).children.find((c: any) => c.title === "Write closed fixture tests"), taskRef = `pitest#${task.short_id}`;
  expect((await show(taskRef)).issue.metadata["pi.subagent_id"]).toBe(child.sid);
  await kata(["close", taskRef, "--done", "--message", "Closed by the child itself with verified behaviour.", "--test", "pi fixture", "--teammate", delegateRecord(child).teammate, "--json"]);
  await child.event("session_shutdown");
  leaveChild();
  const view = await show(taskRef);
  expect(view.issue.status).toBe("closed");
  expect(view.labels.some((l: any) => l.label === "needs-review")).toBe(false);
  expect(view.issue.metadata["pi.subagent_id"]).toBeUndefined();
  expect(view.issue.metadata.teammate).toBeUndefined();
  expect(view.issue.metadata["todo.status"]).toBe("completed");
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
  const sessionId = `replay-lead-${unique()}`;
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

test("after a person deletes the lead's automatic parent, launching a pi child creates a new one the child joins", async () => {
  const lead = await host(); await lead.event("session_start", { reason: "startup" });
  const old = await lead.init(["Lead work before the deletion"]);
  await kata(["delete", old, "--force", "--confirm", `DELETE ${old}`, "--json"]);
  await lead.event("tool_call", { toolName: "bash", input: { command: "pi -p 'write tests'" } });
  const ref = JSON.parse(process.env.KATA_PI_PARENT!).ref;
  expect(ref).toMatch(/^pitest#/);
  expect(ref).not.toBe(old);
  const child = await childOf(lead);
  await child.event("before_agent_start", { prompt: "An independent child task after a deletion", systemPromptOptions: { sections: {} } });
  expect(delegateRecord(child)).toBeDefined();
  leaveChild();
});

test("Pi child creates a new automatic parent when the lead's was deleted before the child started", async () => {
  const lead = await host(); await lead.event("session_start", { reason: "startup" });
  const old = await lead.init(["Lead work before an early child"]);
  await kata(["delete", old, "--force", "--confirm", `DELETE ${old}`, "--json"]);
  process.env.KATA_PI_PARENT = JSON.stringify({ pid: process.pid + 1, sessionId: lead.sid, workspace: cwd, teammate: "lead" });
  const child = await host();
  await child.event("session_start", { reason: "startup" });
  await child.event("before_agent_start", { prompt: "An independent early child task", systemPromptOptions: { sections: {} } });
  expect(delegateRecord(child)).toBeDefined();
  const parents = (await kata(["list", "--status", "all", "--meta", `pi.session_id=${lead.sid}`, "--label", "pi-session", "--json"])).issues;
  expect(parents).toHaveLength(1);
  expect(parents[0].qualified_id).not.toBe(old);
  expect(parents[0].metadata["pi.auto_parent"]).toBe(true);
  leaveChild();
});
