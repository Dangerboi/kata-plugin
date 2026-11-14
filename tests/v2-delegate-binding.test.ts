import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { later } from "./kata-fixture";
import { siblingThrottle } from "./kata-errors";
import { v2Fixture } from "./v2-fixture";

// The omp adapter against a real Kata: binding task delegations to plan items, untracked delegates and hand-backs.
const { scratch, outside, kata, show, issue, host, down, evidence, message, ran, closeSessions, total, commentsOf, sessionParents } = v2Fixture();

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
