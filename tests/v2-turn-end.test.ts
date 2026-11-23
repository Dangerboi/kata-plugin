import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { eventually, finishes, holdKata } from "./kata-fixture";
import { v2Fixture } from "./v2-fixture";

// The omp adapter against a real Kata: turn-end waits for delegate hand-backs, parent evidence and failed claims, driven by omp's native todo.
const { scratch, cwd, run, kata, show, issue, unique, host, message, ran, closesOf, sessionParents } = v2Fixture();

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
  const report = yielded ? JSON.stringify({ spring: "replaced" }, null, 2) : "The gizmo needs a new spring; I left it open.";
  await eventually(async () => {
    const comments = (await show(`v2test#${(await show(parent)).children[0].short_id}`)).comments.map((c: any) => c.body);
    return comments.filter((b: string) => b.startsWith("Report from subagent"));
  }, [`Report from subagent ${id} (it left no comment of its own):\n\n${report}`]);
});

test("a missed delegate exit found at a prompt does not wait for the settlement", async () => {
  let recent: any[] = [], slow = false;
  const held = holdKata(args => slow && ["show", "label", "close", "comment"].includes(args[0]));
  const app = host({ snapshot: () => ({ running: [], recent }), before: held.before });
  try {
    await app.event("session_start"); const parent = await app.init(["Wait for slow settlement"]);
    app.emit("task:subagent:lifecycle", { id: "slow-exit", agent: "task", status: "started", sessionFile: `${scratch}/slow-exit.jsonl`, description: "Wait for slow settlement" });
    await app.call({ op: "view" });
    await ran(app, "slow-exit", `${scratch}/slow-exit.jsonl`);
    recent = [{ id: "slow-exit", type: "task", status: "cancelled" }]; slow = true;
    await app.event("before_agent_start", { systemPrompt: ["base"] });
    await held.entered;
    held.release();
    await eventually(async () => {
      const task = (await show(parent)).children.find((c: any) => c.title === "Wait for slow settlement");
      return task ? (await show(`v2test#${task.short_id}`)).labels.some((l: any) => l.label === "needs-review") : false;
    }, true);
  } finally { held.release(); }
});

// Kata is held until the test lets it answer, so a turn that ends meanwhile did not wait for it. The hooks race real
// Kata processes, which fake timers cannot order.
test("a lead turn with no exited delegate ends within the short bound even when Kata is slow", async () => {
  let slow = false;
  const held = holdKata(() => slow);
  const app = host({ before: held.before });
  await app.event("session_start"); await app.init(["Slow Kata, nothing exited"]);
  app.emit("task:subagent:lifecycle", { id: "still-running", agent: "task", status: "started", sessionFile: `${scratch}/still-running.jsonl`, description: "Slow Kata, nothing exited" });
  await app.call({ op: "view" });
  slow = true;
  try {
    expect(await finishes(app.event("session_stop", { messages: [] }))).toBe(true);
    expect(held.held).toBeGreaterThan(0);
  } finally { slow = false; held.release(); }
  await app.call({ op: "view" }); // drain the background hook
});

test("a lead turn with an exited delegate waits for its slow hand back before the turn ends", async () => {
  let recent: any[] = [], slow = false, labelled = false;
  const held = holdKata(args => slow && args[0] === "label", async (args, opts) => {
    const out = await run(args, opts.cwd, opts.timeout);
    labelled = out.code === 0;
    return out;
  });
  const app = host({ snapshot: () => ({ running: [], recent }), before: held.before });
  await app.event("session_start"); const parent = await app.init(["Slow hand back at turn end"]);
  app.emit("task:subagent:lifecycle", { id: "slow-hand-back", agent: "task", status: "started", sessionFile: `${scratch}/slow-hand-back.jsonl`, description: "Slow hand back at turn end" });
  await app.call({ op: "view" });
  await ran(app, "slow-hand-back", `${scratch}/slow-hand-back.jsonl`);
  recent = [{ id: "slow-hand-back", type: "task", status: "cancelled" }]; slow = true;
  const stop = app.event("session_stop", { messages: [] });
  try {
    await held.entered;
    // The hand back's first write is held. A turn that waited only the short bound would end well inside this wait.
    expect(await finishes(stop, 750)).toBe(false);
  } finally { held.release(); }
  await stop;
  expect(labelled).toBe(true);
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
  let recent: any[] = [], slow = false, fired = false, labels = 0;
  // The second label write is the late exit's hand back; it is held, so the turn end can only have waited for it.
  const held = holdKata(args => slow && args[0] === "label" && ++labels === 2);
  const app = host({ snapshot: () => ({ running: [], recent }), before: async (args: string[], opts: any) => {
    if (!slow) return undefined;
    // The first hand back's first write: the cleanup pass already holds its list, so the second exit is not on it.
    if (args[0] === "label" && !fired) { fired = true; app.emit("task:subagent:lifecycle", { id: "late-exit", status: "completed", sessionFile: `${scratch}/late-exit.jsonl` }); }
    return held.before(args, opts);
  } });
  await app.event("session_start"); const parent = await app.init(["Early exit at turn end", "Late exit at turn end"]);
  for (const [id, description] of [["early-exit", "Early exit at turn end"], ["late-exit", "Late exit at turn end"]]) {
    app.emit("task:subagent:lifecycle", { id, agent: "task", status: "started", sessionFile: `${scratch}/${id}.jsonl`, description });
    await app.call({ op: "view" });
    await ran(app, id, `${scratch}/${id}.jsonl`);
  }
  recent = [{ id: "early-exit", type: "task", status: "cancelled" }]; slow = true;
  const stop = app.event("session_stop", { messages: [] });
  try {
    await held.entered;
    expect(await finishes(stop, 750)).toBe(false);
  } finally { held.release(); }
  await stop;
  expect(fired).toBe(true);
  const children = (await show(parent)).children;
  for (const title of ["Early exit at turn end", "Late exit at turn end"]) {
    const task = children.find((c: any) => c.title === title);
    expect((await show(`v2test#${task.short_id}`)).labels.some((l: any) => l.label === "needs-review")).toBe(true);
  }
});

test("an aborted turn-end wait returns at once and the hand back keeps running", async () => {
  let recent: any[] = [], slow = false;
  const held = holdKata(args => slow && args[0] === "label");
  const app = host({ snapshot: () => ({ running: [], recent }), before: held.before });
  await app.event("session_start"); const parent = await app.init(["Aborted hand back", "Lead keeps working"]);
  app.emit("task:subagent:lifecycle", { id: "aborted-wait", agent: "task", status: "started", sessionFile: `${scratch}/aborted-wait.jsonl`, description: "Aborted hand back" });
  await app.call({ op: "view" });
  await ran(app, "aborted-wait", `${scratch}/aborted-wait.jsonl`);
  recent = [{ id: "aborted-wait", type: "task", status: "cancelled" }]; slow = true;
  const controller = new AbortController();
  const stop = app.event("session_stop", { messages: [], signal: controller.signal });
  try {
    // The turn end is waiting on the hand back, whose first write is held: only the abort can end the wait.
    await held.entered;
    controller.abort();
    expect(await finishes(stop)).toBe(true);
  } finally { held.release(); }
  // The omp adapter adds no reminder to a turn end.
  expect(await stop).toBeUndefined();
  // The hand back keeps running in the background; the next turn end waits for it.
  await app.event("session_stop", { messages: [] });
  const task = (await show(parent)).children.find((c: any) => c.title === "Aborted hand back");
  expect((await show(`v2test#${task.short_id}`)).labels.some((l: any) => l.label === "needs-review")).toBe(true);
});

test("relative lifecycle session paths join the child's absolute session path", async () => {
  const app = host(); await app.event("session_start"); await app.init(["Relative child path"]);
  app.emit("task:subagent:lifecycle", { id: "relative-child", agent: "task", status: "started", sessionFile: "../relative-session.jsonl", description: "Relative child path" });
  const child = host({ agent: { kind: "sub", id: "relative-child", parentId: app.ctx.agent.id }, sessionFile: path.join(scratch, "relative-session.jsonl") });
  await child.event("session_start");
  const result = await child.event("before_agent_start", { systemPrompt: ["base"] });
  expect(result.systemPrompt.join("\n")).toContain("<kata_binding>");
  expect(result.systemPrompt.join("\n")).toContain("Your Kata issue is");
  expect(result.systemPrompt.join("\n")).toContain("relative-child");
});

test("a delegate's first prompt waits for a slow binding instead of dropping it", async () => {
  // The delegate's binding write is held while its first prompt starts.
  const held = holdKata(args => args[0] === "meta" && args[3] === "omp.subagent_id");
  const app = host({ before: held.before });
  await app.event("session_start"); await app.init(["Slow delegate binding"]);
  app.emit("task:subagent:lifecycle", { id: "slow-child", agent: "task", status: "started", sessionFile: `${scratch}/slow-child.jsonl`, description: "Slow delegate binding" });
  const child = host({ agent: { kind: "sub", id: "slow-child", parentId: app.ctx.agent.id }, sessionFile: `${scratch}/slow-child.jsonl` });
  await held.entered;
  await child.event("session_start");
  const prompt = child.event("before_agent_start", { systemPrompt: ["base"] });
  held.release();
  const result = await prompt;
  expect(result.systemPrompt.join("\n")).toContain("<kata_binding>");
  expect(result.systemPrompt.join("\n")).toContain("Your Kata issue is");
});

test("/todo ref naming the auto parent revokes and persists automatic close authority", async () => {
  const app = host(); await app.event("session_start"); const parent = await app.init(["Explicitly retained task"]);
  expect(app.entries.filter(e => e.customType === "io.kata.omp.parent").at(-1).data.auto).toBe(true);
  await app.event("input", { text: `/todo ref ${parent}`, source: "interactive" });
  expect(app.entries.filter(e => e.customType === "io.kata.omp.parent").at(-1).data.auto).toBe(false);
  expect((await app.done("Explicitly retained task")).isError).toBeUndefined();
  await app.event("session_stop", { messages: [] });
  expect((await show(parent)).issue.status).toBe("open");
  const restored = host({ sid: app.sid, entries: app.entries }); await restored.event("session_start");
  await restored.event("session_stop", { messages: [] });
  expect((await show(parent)).issue.status).toBe("open");
});

test("Kata rejects incompatible parent evidence without dropping it from the union", async () => {
  const app = host(); const parent = await app.init(["Typed union task"]);
  const audit = await issue("No-change verification", { parent });
  await kata(["close", audit, "--audit-no-change", "--message", "Audited the current implementation and verified no additional changes were required.", "--reviewed", "README.md", "--evidence", "no-change-audit:Existing behavior already satisfies the specification", "--json"]);
  await app.done("Typed union task");
  await app.event("session_stop", { messages: [] });
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
  expect((await app.done("Attachment and test evidence")).isError).toBeUndefined();
  await app.event("session_stop", { messages: [] });
  expect((await show(parent)).issue.status).toBe("closed");
  const [close] = await closesOf(parent);
  expect(close.payload.evidence).toEqual([{ type: "test", command: "bun test fixture" }]);
});

test("auto parent whose children carry only attachment evidence stays open for review", async () => {
  const app = host({ before: withAttachment(false) }); const parent = await app.init(["Attachment only evidence"]);
  await app.done("Attachment only evidence");
  await app.event("session_stop", { messages: [] });
  expect(app.calls.some(a => a[0] === "close" && a[1] === parent)).toBe(false);
  const view = await show(parent);
  expect(view.issue.status).toBe("open");
  expect(view.labels.some((l: any) => l.label === "needs-review")).toBe(true);
});

test("advisor tool calls cannot steal the main session's spawn coordinator", async () => {
  const app = host(); await app.event("session_start"); const parent = await app.init(["Advisor-safe delegation"]);
  await app.event("tool_call", { toolName: "bash", input: { command: "echo advisor" } }, { ...app.ctx, agent: { kind: "sub", id: "advisor" } });
  app.emit("task:subagent:lifecycle", { id: "after-advisor", agent: "task", status: "started", sessionFile: `${scratch}/after-advisor.jsonl`, description: "Advisor-safe delegation" });
  await eventually(async () => (await show(parent)).children.some((c: any) => c.metadata?.["omp.subagent_id"] === "after-advisor"), true);
});

test("auto-parent evidence resolves cross-project children in their own projects", async () => {
  const other = path.join(scratch, `evidence-${unique()}`); mkdirSync(other);
  await kata(["init", "--project", "v2evidence", "--json"], other);
  const app = host(); const parent = await app.init(["Local evidence task"]);
  const extra = await issue("Cross-project evidence", { parent, workspace: other });
  await kata(["close", `v2evidence#${extra}`, "--done", "--message", "Verified this cross-project component with its own independent test evidence.", "--test", "cross-project validation", "--json"], other);
  await app.done("Local evidence task");
  await app.event("session_stop", { messages: [] });
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

for (const entry of ["lazy", "phased"]) test(`${entry} failed claim resumes the same parent and closes with accepted evidence`, async () => {
  let rejectClaim = true;
  const app = host({ before: (a: string[]) => a[0] === "claim" && rejectClaim ? { code: 1, stderr: "temporary claim failure", stdout: "" } : undefined });
  await app.event("session_start");
  const initParams = () => entry === "phased" ? { op: "init", list: [{ phase: "Recovery work", items: ["Recovered task"] }] } : { op: "init", items: ["Recovered task"] };
  await app.call(initParams());
  const list = await sessionParents(app.sid);
  const parents = list.filter((i: any) => !i.metadata?.["todo.phase"]);
  expect(parents).toHaveLength(1);
  const parent = parents[0];
  expect(parent.metadata["omp.auto_parent"]).toBeUndefined();
  expect(parent.metadata["omp.session_id"]).toBe(app.sid);
  expect(parent.metadata["omp.workspace"]).toBe(cwd);
  rejectClaim = false;
  const resumed = host({ sid: app.sid }); await resumed.event("session_start");
  const result = await resumed.call(initParams());
  expect(result.isError, result.content[0].text).toBeUndefined();
  const ref = `v2test#${parent.short_id}`;
  await eventually(async () => (await show(ref)).issue.metadata["omp.auto_parent"], true);
  const setup = await show(ref);
  expect(setup.issue.title).toBe(parent.title);
  expect((await resumed.done("Recovered task")).isError).toBeUndefined();
  await resumed.event("session_stop", { messages: [] });
  const closed = await show(ref);
  expect(closed.issue.status).toBe("closed");
  expect(closed.children).toHaveLength(1);
  expect(closed.children[0].status).toBe("closed");
  const finalParents = (await sessionParents(app.sid)).filter((i: any) => !i.metadata?.["todo.phase"]);
  expect(finalParents).toHaveLength(1);
  expect(finalParents[0].short_id).toBe(parent.short_id);
});

for (const match of ["active", "named"]) test(`delegation naming ${match === "active" ? "the lead's active" : "another"} plan task binds it with child-owned closure`, async () => {
  const app = host(); await app.event("session_start");
  const ref = await app.init(["Implement widget", "Write widget tests"]);
  expect((await app.call({ op: "start", task: "Implement widget" })).isError).toBeUndefined();
  const expected = (await show(ref)).children.find((c: any) => c.title === (match === "active" ? "Implement widget" : "Write widget tests"));
  await app.event("tool_call", { toolName: "task", toolCallId: `call-${match}`, input: { agent: "task", task: match === "named" ? 'Complete plan task "Write widget tests" and commit it.' : 'Complete "Implement widget" and commit it.' } });
  const sessionFile = `${scratch}/reuse-${match}.jsonl`;
  app.emit("task:subagent:lifecycle", { id: `reuse-${match}`, status: "started", sessionFile, parentToolCallId: `call-${match}`, index: 0 });
  await eventually(async () => (await show(ref)).children.some((c: any) => c.metadata?.["omp.subagent_id"] === `reuse-${match}`), true);
  const children = (await show(ref)).children;
  expect(children).toHaveLength(2);
  const delegated = children.find((c: any) => c.metadata?.["omp.subagent_id"] === `reuse-${match}`);
  expect(delegated.short_id).toBe(expected.short_id);
  const child = host({ agent: { kind: "sub", id: `reuse-${match}`, parentId: app.ctx.agent.id }, sessionFile });
  await child.event("session_start");
  const prompt = (await child.event("before_agent_start", { systemPrompt: [] })).systemPrompt.join("\n");
  expect(prompt).toContain(`Your Kata issue is v2test#${expected.short_id};`);
  expect(prompt).toContain(`close 'v2test#${expected.short_id}'`);
  // The main cannot finish the delegated task on behalf of a running worker: the guard refuses the native done.
  expect((await app.call({ op: "done", task: expected.title })).isError).toBe(true);
  await kata(["close", expected.short_id, "--teammate", delegated.metadata.teammate, "--done", "--message", message, "--test", `delegate-${match}`, "--json"]);
  app.emit("task:subagent:lifecycle", { id: `reuse-${match}`, status: "completed", sessionFile });
  // Once the delegate has closed it and its hand-back settled, the native done goes through and leaves the issue closed.
  await eventually(async () => (await app.call({ op: "done", task: expected.title })).isError === undefined, true);
  expect((await app.done(match === "active" ? "Write widget tests" : "Implement widget")).isError).toBeUndefined();
  await app.event("session_stop", { messages: [] });
  expect((await show(ref)).issue.status).toBe("closed");
  expect(app.calls.some(a => a[0] === "close" && a[1] === `v2test#${expected.short_id}`)).toBe(false);
});
