import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { eventually, later } from "./kata-fixture";
import { siblingThrottle } from "./kata-errors";
import { v2Fixture } from "./v2-fixture";

// The omp adapter against a real Kata, with omp's native todo: binding task delegations to plan items, untracked delegates and hand-backs.
// Lead tasks finish through `app.done` (a Kata close, then the native done); a delegate's own list reaches Kata through the delegate mirror.
const exec = promisify(execFile);
const { binary, cwd, env, scratch, outside, kata, show, issue, host, down, message, ran, closeSessions, total, commentsOf, sessionParents, closesOf } = v2Fixture();
const boundTo = async (ref: string, title: string) => (await show(ref)).children.find((c: any) => c.title === title)?.metadata?.["omp.subagent_id"];
const issueBoundTo = async (ref: string) => (await show(ref)).issue.metadata?.["omp.subagent_id"];
const missionOf = async (ref: string) => (await show(ref)).children.find((c: any) => c.metadata?.["omp.mission"] === "true");
const needsReview = async (ref: string) => (await show(ref)).labels.some((l: any) => l.label === "needs-review");

test("batch delegates bind named plan tasks by spawn index without duplicates", async () => {
  const app = host(); await app.event("session_start");
  const ref = await app.init(["Build alpha", "Build beta"]);
  const tasks = (await show(ref)).children;
  await app.event("tool_call", { toolName: "task", toolCallId: "batch-binding", input: { tasks: [{ task: 'Finish "Build beta"' }, { task: 'Finish "Build alpha"' }] } });
  for (const [index, id] of ["batch-beta", "batch-alpha"].entries()) app.emit("task:subagent:lifecycle", { id, status: "started", sessionFile: `${scratch}/${id}.jsonl`, parentToolCallId: "batch-binding", index });
  await eventually(async () => (await show(ref)).children.map((c: any) => c.metadata?.["omp.subagent_id"]).sort(), ["batch-alpha", "batch-beta"]);
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

test("a task prompt naming a plan item by ref binds it though the text describes another item", async () => {
  const app = host(); await app.event("session_start");
  const ref = await app.init(["Implement widget", "Write widget tests"]);
  const children0 = (await show(ref)).children;
  const target = children0.find((c: any) => c.title === "Implement widget"), other = children0.find((c: any) => c.title === "Write widget tests");
  await app.event("tool_call", { toolName: "task", toolCallId: "ref-wins", input: { name: "WriteTests", task: `Write the widget tests; the work is v2test#${target.short_id}.` } });
  app.emit("task:subagent:lifecycle", { id: "ref-wins", status: "started", sessionFile: `${scratch}/ref-wins.jsonl`, parentToolCallId: "ref-wins", index: 0 });
  await eventually(() => issueBoundTo(`v2test#${target.short_id}`), "ref-wins");
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
  await eventually(async () => (await show(ref)).children[0].metadata?.["omp.subagent_id"], "short-id");
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
  await eventually(() => issueBoundTo(`v2test#${ticket}`), `ticket-${planned}`);
  const bound = (await show(`v2test#${ticket}`)).issue;
  expect(bound.metadata["omp.subagent_id"]).toBe(`ticket-${planned}`);
  expect(bound.owner).toBe("v2-builder");
  const owned = await sessionParents(app.sid);
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

test("a task prompt naming a ticket while Kata is unusable is not blocked", async () => {
  let broken = false;
  const app = host({ before: () => broken ? down() : undefined }); await app.event("session_start"); await app.init(["Implement widget"]);
  const named = await issue("Named while Kata is down");
  broken = true;
  expect(await app.event("tool_call", { toolName: "task", toolCallId: "kata-down", input: { task: `Do v2test#${named} now` } })).toBeUndefined();
});

test("a file anchor is plain text in a task prompt; a ref in a registered project must resolve", async () => {
  const app = host(); await app.event("session_start"); await app.init(["Implement widget"]);
  const spawn = (text: string, id: string) => app.event("tool_call", { toolName: "task", toolCallId: id, input: { task: text } });
  expect(await spawn("Fix the link in README.md#tasks", "one-anchor")).toBeUndefined();
  expect(await spawn("Fix README.md#tasks and CHANGELOG.md#added", "two-anchors")).toBeUndefined();
  expect(await spawn("See ghostproject#zzzz for background", "unregistered-project")).toBeUndefined();
  expect(await spawn("Do v2test#zzzz and README.md#tasks", "registered-missing")).toMatchObject({ block: true });
});

test("a local plan survives extension recreation through session entries", async () => {
  const app = host({ cwd: outside, before: down }); await app.event("session_start");
  expect((await app.call({ op: "init", items: ["Durable local first", "Durable local second"] })).isError).toBeUndefined();
  const entries = JSON.parse(JSON.stringify(app.entries));
  const promptOf = async (a: ReturnType<typeof host>) => ((await a.event("before_agent_start", { systemPrompt: ["base"] }))?.systemPrompt ?? []).join("\n");
  const resumed = host({ cwd: outside, before: down, sid: app.sid, entries }); await resumed.event("session_start");
  const prompt = await promptOf(resumed);
  expect(prompt).toContain("Durable local first");
  expect(prompt).toContain("Durable local second");
  const other = host({ cwd: outside, before: down, entries }); await other.event("session_start");
  expect(await promptOf(other)).not.toContain("Durable local first");
});

test("queued close survives extension recreation and retries only after its deadline", async () => {
  const app = host({ before: (a: string[]) => a[0] === "close" ? siblingThrottle() : undefined });
  await app.event("session_start");
  const parent = await app.init(["Durable queued close"]);
  const task = `v2test#${(await show(parent)).children[0].short_id}`;
  // Drop asks the mirror to close the still-open task, so the throttle queues a task close with a deadline.
  expect((await app.call({ op: "drop", task: "Durable queued close" })).isError).toBeUndefined();
  const entries = JSON.parse(JSON.stringify(app.entries));
  const snapshot = entries.filter((entry: any) => entry.data?.retries).at(-1);
  expect(snapshot?.data.retries.some(([ref]: [string, unknown]) => ref === task)).toBe(true);
  expect((await show(task)).issue.status).toBe("open");
  const resumed = host({ sid: app.sid, entries }); await resumed.event("session_start");
  expect(resumed.calls.some(a => a[0] === "close" && a.includes(task))).toBe(false);
  expect((await show(task)).issue.status).toBe("open");
  await later(async () => { const restarted = host({ sid: app.sid, entries }); await restarted.event("session_start"); await restarted.call({ op: "view" }); });
  expect((await show(task)).issue.status).toBe("closed");
  expect(await closesOf(task)).toHaveLength(1);
});

// The 2026-10-19 eval: omp sent todo init and the tests delegation in one batch.
const evalPlan = ["Implement word_count and top_words in textstats", "Write unittest suite covering word_count, top_words, and empty input", "Run the suite with python3 -m unittest", "Commit the work"];
test("a delegation spawned in the same batch as todo init binds its plan task", async () => {
  const app = host(); await app.event("session_start");
  const hook = app.event("tool_call", { toolName: "task", toolCallId: "eval-batch", input: { context: "Add word_count and top_words to textstats.",
    tasks: [{ name: "WriteTests", agent: "task", task: `Do "${evalPlan[1]}" in tests/ per the contract above` }] } });
  const ref = await app.init(evalPlan);
  await hook;
  app.emit("task:subagent:lifecycle", { id: "WriteTests", agent: "task", status: "started", sessionFile: `${scratch}/eval-batch.jsonl`, parentToolCallId: "eval-batch", index: 0 });
  await eventually(() => boundTo(ref, evalPlan[1]), "WriteTests");
  let children = (await show(ref)).children;
  expect(children).toHaveLength(4);
  expect(children.find((c: any) => c.title === evalPlan[1]).metadata["omp.subagent_id"]).toBe("WriteTests");
  expect(children.find((c: any) => c.title === evalPlan[0]).metadata["omp.subagent_id"]).toBeUndefined();
  // The delegated task never occupies the lead's slot: the lead finishes its own task and starts the next one itself.
  expect((await app.done(evalPlan[0])).isError).toBeUndefined();
  expect((await app.call({ op: "start", task: evalPlan[2] })).isError).toBeUndefined();
  children = (await show(ref)).children;
  expect(children.find((c: any) => c.title === evalPlan[2]).metadata["todo.status"]).toBe("in_progress");
  expect(children.find((c: any) => c.title === evalPlan[1]).metadata["omp.subagent_id"]).toBe("WriteTests");
});

test("an unrelated delegation never takes the lead's active task and creates nothing", async () => {
  const app = host(); await app.event("session_start");
  const ref = await app.init(["Implement widget", "Write widget tests"]);
  await app.event("tool_call", { toolName: "task", toolCallId: "probe", input: { agent: "scout", task: "Reply with exactly: SUBAGENT-OK" } });
  const sessionFile = `${scratch}/probe-agent.jsonl`;
  app.emit("task:subagent:lifecycle", { id: "probe-agent", status: "started", sessionFile, parentToolCallId: "probe", index: 0 });
  await app.call({ op: "view" });
  await eventually(async () => (await show(ref)).children.find((c: any) => c.title === "Implement widget").metadata?.["todo.status"], "in_progress");
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
  expect((await app.done("Implement widget")).isError).toBeUndefined();
  expect((await show(ref)).issue.status).toBe("open");
  expect((await app.done("Write widget tests")).isError).toBeUndefined();
  // The automatic parent closes when the turn settles, not on the lead's native done.
  await app.event("session_stop");
  await eventually(async () => (await show(ref)).issue.status, "closed");
});

test("an untracked scout's run is recorded as a closed mission with its agent and its last report", async () => {
  const app = host(); await app.event("session_start");
  const ref = await app.init(["Implement gadget"]);
  await app.event("tool_call", { toolName: "task", toolCallId: "survey", input: { tasks: [{ name: "Survey", agent: "scout", task: "Survey the repository layout and report the top-level directories." }] } });
  const sessionFile = `${scratch}/survey.jsonl`;
  app.emit("task:subagent:lifecycle", { id: "Survey", agent: "scout", status: "started", sessionFile, parentToolCallId: "survey", index: 0 });
  await app.call({ op: "view" });
  app.emit("task:subagent:event", { id: "Survey", event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Top level: core, docs, plugins." }] } } });
  app.emit("task:subagent:lifecycle", { id: "Survey", agent: "scout", status: "completed", sessionFile });
  await eventually(async () => (await missionOf(ref))?.status, "closed");
  const mission = (await show(ref)).children.find((c: any) => c.metadata["omp.mission"] === "true");
  expect(mission).toMatchObject({ status: "closed", closed_reason: "audit-no-change", metadata: { "omp.mission_subagent_id": "Survey", "omp.mission_agent": "scout" } });
  expect(mission.title).toBe("Subagent Survey: Survey the repository layout and report the top-level directories.");
  expect(await commentsOf(`v2test#${mission.short_id}`)).toEqual(["Report from subagent Survey:\n\nTop level: core, docs, plugins."]);
});

test("a cancelled subagent lifecycle ends its delegate as aborted, like a cancelled job", async () => {
  const app = host(); await app.event("session_start");
  const ref = await app.init(["Implement widget"]);
  const target = (await show(ref)).children[0], key = `v2test#${target.short_id}`;
  await app.event("tool_call", { toolName: "task", toolCallId: "cancelled", input: { name: "Widget", task: `Implement the widget; the work is ${key}.` } });
  const sessionFile = `${scratch}/cancelled.jsonl`;
  app.emit("task:subagent:lifecycle", { id: "cancelled", status: "started", sessionFile, parentToolCallId: "cancelled", index: 0 });
  await eventually(() => issueBoundTo(key), "cancelled");
  expect((await show(key)).issue.metadata["omp.subagent_id"]).toBe("cancelled");
  app.emit("task:subagent:lifecycle", { id: "cancelled", status: "cancelled", sessionFile });
  await eventually(() => issueBoundTo(key), undefined);
  // The delegate never ran a tool, so its assignment is rolled back.
  expect((await show(key)).issue.metadata["omp.subagent_id"]).toBeUndefined();
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

test("an untracked delegate's todo is omp's own: it keeps its list and makes no Kata calls", async () => {
  const { worker } = await untrackedDelegate("untracked-native");
  const result = await worker.call({ op: "init", list: [{ phase: "Scout", items: ["Read the tree"] }] });
  expect(result.isError).toBeUndefined();
  expect(worker.list()).toEqual([{ name: "Scout", tasks: [{ content: "Read the tree", status: "in_progress" }] }]);
  expect(worker.calls.some(a => ["create", "meta", "claim", "close", "comment"].includes(a[0]))).toBe(false);
});

test("another lead's spawn keeps a running untracked delegate's identity", async () => {
  const { worker } = await untrackedDelegate("untracked-survives");
  const other = host(); await other.event("session_start"); await other.init(["Unrelated plan"]);
  other.emit("task:subagent:lifecycle", { id: "other-child", agent: "scout", status: "started", sessionFile: `${scratch}/other-child.jsonl`, description: "Unrelated work" });
  await other.call({ op: "view" });
  await worker.event("session_start");
  const prompt = ((await worker.event("before_agent_start", { systemPrompt: ["base"] }))?.systemPrompt ?? []).join("\n");
  expect(prompt).toContain("you have no Kata issue");
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
  expect((await lead.call({ op: "init", items: ["Draft the local notes", "Review the local notes"] })).isError).toBeUndefined();
  const sessionFile = `${scratch}/local-match.jsonl`;
  lead.emit("task:subagent:lifecycle", { id: "local-match", status: "started", sessionFile, description: "Draft the local notes" });
  await lead.call({ op: "view" });
  const worker = host({ cwd: outside, sessionFile, agent: { kind: "sub", id: "local-match", parentId: lead.ctx.agent.id } });
  const prompt = ((await worker.event("before_agent_start", { systemPrompt: ["base"] }))?.systemPrompt ?? []).join("\n");
  expect(prompt).not.toContain("you have no Kata issue");
  expect((await worker.call({ op: "view" })).isError).toBeUndefined();
});

test("a finished delegate that leaves its plan task open hands it back for review", async () => {
  process.env.KATA_TEAMMATE = "lead-mate";
  const app = host(); await app.event("session_start");
  const ref = await app.init(["Implement widget", "Write widget tests"]);
  await app.event("tool_call", { toolName: "task", toolCallId: "handback", input: { name: "WriteTests", task: 'Complete "Write widget tests"' } });
  const sessionFile = `${scratch}/handback.jsonl`;
  app.emit("task:subagent:lifecycle", { id: "handback", status: "started", sessionFile, parentToolCallId: "handback", index: 0 });
  await eventually(() => boundTo(ref, "Write widget tests"), "handback");
  const task = (await show(ref)).children.find((c: any) => c.title === "Write widget tests");
  expect(task.metadata["omp.subagent_id"]).toBe("handback");
  expect((await app.call({ op: "done", task: "Write widget tests" })).isError).toBe(true);
  await ran(app, "handback", sessionFile);
  app.emit("task:subagent:lifecycle", { id: "handback", status: "completed", sessionFile });
  await eventually(async () => needsReview(`v2test#${(await show(ref)).children.find((c: any) => c.title === "Write widget tests").short_id}`), true);
  const settled = await show(`v2test#${task.short_id}`);
  expect(settled.labels.some((l: any) => l.label === "needs-review")).toBe(true);
  expect(settled.issue.metadata.teammate).toBe("lead-mate");
  expect(settled.issue.metadata["todo.status"]).toBe("pending");
  expect((await kata(["inbox", "--for", "v2-builder/lead-mate", "--json"])).requests.some((r: any) => r.ref.endsWith(task.short_id))).toBe(true);
  expect((await app.done("Write widget tests")).isError).toBeUndefined();
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
  await eventually(async () => needsReview(`v2test#${(await show(ref)).children.find((c: any) => c.title === "Delegated plan task").short_id}`), true);
  const task = (await show(ref)).children.find((c: any) => c.title === "Delegated plan task");
  const settled = await show(`v2test#${task.short_id}`);
  expect(settled.labels.some((l: any) => l.label === "needs-review")).toBe(true);
  expect(settled.issue.metadata.teammate).toBe("lead-mate");
  expect((await kata(["inbox", "--for", "v2-builder/lead-mate", "--json"])).requests.some((r: any) => r.ref.endsWith(task.short_id))).toBe(true);
  expect((await app.done("Delegated plan task")).isError).toBeUndefined();
  expect((await app.done("Lead step")).isError).toBeUndefined();
  await app.event("session_stop");
  await eventually(async () => (await show(ref)).issue.status, "closed");
});

// A lead assigns one delegate, whose session header names `<name>-delegate`; with close transcripts on, the delegate plans
// one step and closes it with a shell `kata close`, which the plugin rewrites to carry the delegate's session. The rewritten
// command runs where the lead's pair is exported, as it does in the lead's process. `midCall` runs once, while the delegate's
// close event is in flight. Returns the sessions the step's closes recorded.
async function delegateStepCloseSessions(name: string, midCall?: (delegate: ReturnType<typeof host>) => void) {
  const lead = host({ sid: `${name}-lead`, transcript: true });
  await lead.event("session_start");
  const ref = await lead.init([`Delegated ${name} task`, `Lead ${name} step`]);
  const sessionFile = `${scratch}/delegate-${name}.jsonl`, id = `${name}.Delegate`;
  writeFileSync(sessionFile, `{"type":"session","version":3,"id":"${name}-delegate"}\n`);
  lead.emit("task:subagent:lifecycle", { id, status: "started", sessionFile, description: `Delegated ${name} task` });
  await eventually(async () => (await show(ref)).children.some((c: any) => c.metadata?.["omp.subagent_id"] === id), true);
  const assigned = (await show(ref)).children.find((c: any) => c.metadata?.["omp.subagent_id"] === id);
  const delegate: ReturnType<typeof host> = host({ sessionFile, agent: { kind: "sub", id, parentId: lead.ctx.agent.id }, transcript: true });
  await delegate.event("session_start");
  expect((await delegate.call({ op: "init", items: [`Delegate ${name} step`] })).isError).toBeUndefined();
  const step = (await show(`v2test#${assigned.short_id}`)).children.find((c: any) => c.title === `Delegate ${name} step`);
  midCall?.(delegate);
  const rewritten = await delegate.event("tool_call", { toolName: "bash", input: { command: `kata close v2test#${step.short_id} --done --message '${message}' --test '${name} fixture'` } });
  const leadEnv = { ...env, KATA_TRANSCRIPT_AGENT: "omp", KATA_TRANSCRIPT_SESSION_ID: `${name}-lead`, KATA_CLOSE_TRANSCRIPT_ENABLED: "true" };
  await exec("/bin/sh", ["-c", rewritten.input.command.replace(/^(env [^\n]*? )?kata /, (_: string, prefix?: string) => `${prefix ?? ""}'${binary}' `)], { env: leadEnv, cwd });
  expect((await show(`v2test#${step.short_id}`)).issue.status).toBe("closed");
  return await closeSessions(step.short_id);
}

test("an assigned delegate's shell close of its own step records the delegate's session, not the lead's", async () => {
  expect(await delegateStepCloseSessions("transcript")).toEqual(["transcript-delegate"]);
});

test("a delegate's shell close keeps the delegate's session when another identity reaches its handlers mid-call", async () => {
  // omp's advisor runs as its own sub identity inside the session it advises.
  const advisor = (delegate: ReturnType<typeof host>) => { void delegate.event("tool_call", { toolName: "read", input: { path: "README.md" } }, { ...delegate.ctx, agent: { kind: "sub", id: "Advisor" } }); };
  expect(await delegateStepCloseSessions("swap", advisor)).toEqual(["swap-delegate"]);
});

test("delegate teammates differ across sessions that reuse an agent name", async () => {
  const teammates: string[] = [];
  for (const n of [1, 2]) {
    const app = host(); await app.event("session_start"); const ref = await app.init([`Reused agent name ${n}`]);
    app.emit("task:subagent:lifecycle", { id: "WriteTests", status: "started", sessionFile: `${scratch}/reused-name-${n}.jsonl`, description: `Reused agent name ${n}` });
    await eventually(async () => (await show(ref)).children.some((c: any) => c.metadata?.["omp.subagent_id"] === "WriteTests"), true);
    teammates.push((await show(ref)).children.find((c: any) => c.metadata?.["omp.subagent_id"] === "WriteTests").metadata.teammate);
  }
  expect(teammates[0]).not.toBe(teammates[1]);
});

test("adopting an explicit parent retires an empty automatic parent", async () => {
  const app = host({ before: (args: string[]) => args[0] === "create" && args.includes("--parent") ? { code: 1, stdout: "", stderr: "child create refused" } : undefined });
  await app.event("session_start");
  const auto = await app.init(["Never created"]);
  expect(auto).toMatch(/^v2test#/);
  const explicit = await issue(); await kata(["claim", explicit, "--json"]);
  await app.event("tool_result", { toolName: "bash", input: { command: `kata claim ${explicit}` }, isError: false, details: { exitCode: 0 } });
  const retired = await show(auto);
  expect(retired.issue.status).toBe("closed");
  expect(retired.issue.closed_reason).toBe("superseded");
  expect((await show(explicit)).children ?? []).toHaveLength(0);
});

test("a handed-back plan task can be delegated again", async () => {
  const app = host(); await app.event("session_start");
  const ref = await app.init(["Implement gadget", "Write gadget tests"]);
  for (const [n, state] of [[1, "completed"], [2, "started"]] as const) {
    const id = `regadget-${n}`, sessionFile = `${scratch}/${id}.jsonl`;
    expect(await app.event("tool_call", { toolName: "task", toolCallId: id, input: { name: "WriteTests", task: 'Complete "Write gadget tests"' } })).toBeUndefined();
    app.emit("task:subagent:lifecycle", { id, status: "started", sessionFile, parentToolCallId: id, index: 0 });
    await eventually(() => boundTo(ref, "Write gadget tests"), id);
    if (state === "completed") { app.emit("task:subagent:lifecycle", { id, status: "completed", sessionFile }); await app.call({ op: "view" }); }
  }
  const children = (await show(ref)).children;
  expect(children).toHaveLength(2);
  expect(children.find((c: any) => c.title === "Write gadget tests").metadata["omp.subagent_id"]).toBe("regadget-2");
});

test("after a hand-back, the lead closes its own active task and the handed-back one stays open", async () => {
  const app = host(); await app.event("session_start");
  const ref = await app.init(["Write widget tests", "Implement widget"]);
  await app.event("tool_call", { toolName: "task", toolCallId: "bare-done", input: { task: 'Complete "Write widget tests"' } });
  const sessionFile = `${scratch}/bare-done.jsonl`;
  app.emit("task:subagent:lifecycle", { id: "bare-done", status: "started", sessionFile, parentToolCallId: "bare-done", index: 0 });
  await eventually(() => boundTo(ref, "Write widget tests"), "bare-done");
  expect((await app.call({ op: "start", task: "Implement widget" })).isError).toBeUndefined();
  await ran(app, "bare-done", sessionFile);
  app.emit("task:subagent:lifecycle", { id: "bare-done", status: "completed", sessionFile });
  await app.call({ op: "view" });
  expect((await app.done("Implement widget")).isError).toBeUndefined();
  const children = (await show(ref)).children;
  expect(children.find((c: any) => c.title === "Implement widget").status).toBe("closed");
  expect(children.find((c: any) => c.title === "Write widget tests").status).toBe("open");
});

test("a task call that never spawns releases its plan task", async () => {
  const app = host(); await app.event("session_start"); await app.init(["Write gizmo tests"]);
  const input = { task: 'Complete "Write gizmo tests"' };
  expect(await app.event("tool_call", { toolName: "task", toolCallId: "denied", input })).toBeUndefined();
  await app.event("tool_result", { toolName: "task", toolCallId: "denied", isError: true, input });
  expect(await app.event("tool_call", { toolName: "task", toolCallId: "retry", input })).toBeUndefined();
});

// The lead's plan task a task call named, bound to a delegate whose start is reported after the call returned.
async function lateStart(app: ReturnType<typeof host>, ref: string, id: string, expected: string | undefined) {
  app.emit("task:subagent:lifecycle", { id, status: "started", sessionFile: `${scratch}/${id}.jsonl`, parentToolCallId: id, index: 0 });
  await app.call({ op: "view" });
  await eventually(() => boundTo(ref, "Write sprocket tests"), expected);
  return boundTo(ref, "Write sprocket tests");
}

test("a synchronous task call that settled without a start leaves no assignment for a later start", async () => {
  const app = host(); await app.event("session_start"); const ref = await app.init(["Write sprocket tests"]);
  const input = { task: 'Complete "Write sprocket tests"' };
  await app.event("tool_call", { toolName: "task", toolCallId: "sync-gone", input });
  await app.event("tool_result", { toolName: "task", toolCallId: "sync-gone", isError: false, input, details: { results: [] } });
  expect(await lateStart(app, ref, "sync-gone", undefined)).toBeUndefined();
});

test("a background task call keeps its assignment for a late start until its jobs stop running", async () => {
  let running: any[] = [];
  const app = host({ snapshot: () => ({ running, recent: [] }) }); await app.event("session_start"); const ref = await app.init(["Write sprocket tests", "Write sprocket docs"]);
  const input = { task: 'Complete "Write sprocket tests"' };
  const details = { async: { state: "running", jobId: "job-1", type: "task" }, progress: [{ id: "late-1" }] };
  running = [{ id: "job-1", agentId: "late-1", type: "task", status: "running" }];
  await app.event("tool_call", { toolName: "task", toolCallId: "late-1", input });
  await app.event("tool_result", { toolName: "task", toolCallId: "late-1", isError: false, input, details });
  expect(await lateStart(app, ref, "late-1", "late-1")).toBe("late-1");

  const second = { task: 'Complete "Write sprocket docs"' };
  await app.event("tool_call", { toolName: "task", toolCallId: "late-2", input: second });
  running = [{ id: "job-2", agentId: "late-2", type: "task", status: "running" }];
  await app.event("tool_result", { toolName: "task", toolCallId: "late-2", isError: false, input: second, details: { async: { jobId: "job-2" }, progress: [{ id: "late-2" }] } });
  running = [];
  await app.event("tool_call", { toolName: "read", input: { path: "README.md" } }); // any event reads the snapshot
  app.emit("task:subagent:lifecycle", { id: "late-2", status: "started", sessionFile: `${scratch}/late-2.jsonl`, parentToolCallId: "late-2", index: 0 });
  await app.call({ op: "view" });
  expect((await show(ref)).children.find((c: any) => c.title === "Write sprocket docs").metadata["omp.subagent_id"]).toBeUndefined();
});

// omp reports every later turn of the same agent (a revival, its answer to a message) as `started` again, with the same
// id and session file.
const assistantText = (id: string, text: string) => ({ id, event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } } });

test("a later turn of a delegate that closed its plan task reports on that task and makes no mission", async () => {
  const app = host(); await app.event("session_start");
  const ref = await app.init(["Implement widget", "Write widget tests"]);
  await app.event("tool_call", { toolName: "task", toolCallId: "wake-bound", input: { name: "WriteTests", task: 'Complete "Write widget tests"' } });
  const lifecycle = { id: "wake-bound", sessionFile: `${scratch}/wake-bound.jsonl`, parentToolCallId: "wake-bound", index: 0 };
  app.emit("task:subagent:lifecycle", { ...lifecycle, status: "started" });
  await eventually(() => boundTo(ref, "Write widget tests"), "wake-bound");
  // The assignment's last write: a close before it would fail the assignment.
  await eventually(async () => (await show(ref)).children.find((c: any) => c.title === "Write widget tests").metadata["work.attention"], "ok");
  const task = (await show(ref)).children.find((c: any) => c.title === "Write widget tests"), taskRef = `v2test#${task.short_id}`;
  await kata(["close", taskRef, "--done", "--message", message, "--test", "wake fixture", "--teammate", task.metadata.teammate, "--json"]);
  app.emit("task:subagent:lifecycle", { ...lifecycle, status: "completed" });
  await app.event("session_stop");
  app.emit("task:subagent:lifecycle", { ...lifecycle, status: "started" });
  app.emit("task:subagent:event", assistantText("wake-bound", "The tests also cover empty input."));
  app.emit("task:subagent:lifecycle", { ...lifecycle, status: "completed" });
  await eventually(async () => (await commentsOf(taskRef)).includes("Report from subagent wake-bound (after a follow-up):\n\nThe tests also cover empty input."), true);
  expect(await commentsOf(taskRef)).toContain("Report from subagent wake-bound (after a follow-up):\n\nThe tests also cover empty input.");
  const children = (await show(ref)).children;
  expect(children.filter((c: any) => c.metadata?.["omp.mission"] === "true")).toEqual([]);
  expect(children.find((c: any) => c.short_id === task.short_id).status).toBe("closed");
});

test("a later turn of an untracked delegate adds its report to the mission its first run made", async () => {
  const app = host(); await app.event("session_start");
  const ref = await app.init(["Implement gadget"]);
  await app.event("tool_call", { toolName: "task", toolCallId: "wake-scout", input: { tasks: [{ name: "Scout", agent: "scout", task: "Survey the repository layout and report the top-level directories." }] } });
  const lifecycle = { id: "Scout", agent: "scout", sessionFile: `${scratch}/wake-scout.jsonl`, parentToolCallId: "wake-scout", index: 0 };
  for (const [round, text] of ["Top level: core, docs, plugins.", "Also scripts and tests."].entries()) {
    app.emit("task:subagent:lifecycle", { ...lifecycle, status: "started" });
    app.emit("task:subagent:event", assistantText("Scout", text));
    app.emit("task:subagent:lifecycle", { ...lifecycle, status: "completed" });
    await eventually(async () => { const m = await missionOf(ref); return m ? (await commentsOf(`v2test#${m.short_id}`)).length : 0; }, round + 1);
  }
  const missions = (await show(ref)).children.filter((c: any) => c.metadata["omp.mission"] === "true");
  expect(missions.map((c: any) => c.status)).toEqual(["closed"]);
  expect(await commentsOf(`v2test#${missions[0].short_id}`)).toEqual(["Report from subagent Scout:\n\nTop level: core, docs, plugins.", "Report from subagent Scout (after a follow-up):\n\nAlso scripts and tests."]);
});

test("a background task call keeps the ticket its spawn named reserved after its result, and its late start binds it", async () => {
  let running: any[] = [];
  const app = host({ snapshot: () => ({ running, recent: [] }) }); await app.event("session_start"); await app.init(["Implement widget"]);
  const ticket = await issue("Late ticket"), input = { task: `Finish v2test#${ticket}: make the change and close it.` };
  running = [{ id: "job-late", agentId: "late-ticket", type: "task", status: "running" }];
  await app.event("tool_call", { toolName: "task", toolCallId: "late-ticket", input });
  await app.event("tool_result", { toolName: "task", toolCallId: "late-ticket", isError: false, input, details: { async: { state: "running", jobId: "job-late", type: "task" }, progress: [{ id: "late-ticket" }] } });
  expect(await app.event("tool_call", { toolName: "task", toolCallId: "late-ticket-again", input })).toMatchObject({ block: true, reason: expect.stringMatching(/already delegated/) });
  app.emit("task:subagent:lifecycle", { id: "late-ticket", status: "started", sessionFile: `${scratch}/late-ticket.jsonl`, parentToolCallId: "late-ticket", index: 0 });
  await eventually(() => issueBoundTo(`v2test#${ticket}`), "late-ticket");
  expect((await show(`v2test#${ticket}`)).issue.metadata["omp.subagent_id"]).toBe("late-ticket");
});
