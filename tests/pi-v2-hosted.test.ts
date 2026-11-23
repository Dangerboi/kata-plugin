import fc from "fast-check";
import { expect, test } from "bun:test";
import { holdKata } from "./kata-fixture";
import { piFixture } from "./pi-fixture";

// The pi adapter's own todo tool against a real Kata: hosted reads and refreshes, view results, explicit parents and
// project errors, the stop reminder during a pending refresh, and blank evidence. omp's native todo has none of these.
const { outside, kata, show, issue, unique, host, evidence, message } = piFixture();
const hostedIssue = async () => `pitest#${await issue(`Explicit parent ${unique()}`)}`;

// Hosted reads routinely take longer than the old one-second process deadline.
test("hosted show lasting over one second completes todo init", async () => {
  const ref = await hostedIssue();
  const app = await host({ before: async (args: string[], opts: any) => {
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
  const app = await host({ before: (args: string[]) => unavailable && args[0] === "show"
    ? { code: 1, stdout: "", stderr: "hosted service unavailable" } : undefined });
  const parent = await app.init(["Externally finished task"]);
  const task = (await show(parent)).children[0];
  await kata(["close", `pitest#${task.short_id}`, "--done", "--message", message, "--test", "external verification", "--json"]);
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
  const original = await host();
  const parent = await original.init(["Recover bound plan"]);
  let unavailable = true;
  process.env.KATA_REF = parent;
  const app = await host({ before: (args: string[]) => unavailable && args[0] === "show"
    ? { code: 0, killed: true, stdout: "", stderr: "" } : undefined });
  await app.event("session_start", { reason: "startup" });
  const failed = await app.call({ op: "view" });
  expect(failed.isError).toBe(true);
  expect(failed.content[0].text).toContain("timed out");
  expect(failed.content[0].text).not.toContain("No todo plan");
  unavailable = false;
  const recovered = await app.call({ op: "view" });
  expect(recovered.details.kata.parent).toBe(parent);
  expect(recovered.details.kata.phases[0].tasks[0].content).toBe("Recover bound plan");
});

test("a qualified parameter binding stays authoritative outside the project workspace", async () => {
  const parent = await hostedIssue();
  const app = await host({ cwd: outside });
  await app.event("session_start", { reason: "startup" });
  const result = await app.call({ op: "init", ref: parent, items: ["Hosted worker task"] });
  expect(result.isError).toBeUndefined();
  expect(result.details.kata.parent).toBe(parent);
  expect(result.content[0].text).not.toContain("Session-local");
  expect((await show(parent)).children[0].title).toBe("Hosted worker task");
});

test("an unavailable explicit hosted binding errors instead of creating a local plan", async () => {
  const app = await host({ cwd: outside });
  const result = await app.call({ op: "init", ref: "pitest#zzzz", items: ["Never local"] });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).not.toContain("Session-local");
  expect(result.details.kata.phases).toEqual([]);
});

test("hosted children [null] never expose a cached plan", async () => {
  let corrupt = false;
  const app = await host({ before: (args: string[]) => corrupt && args[0] === "show"
    ? { code: 0, stdout: JSON.stringify({ issue: {}, children: [null] }), stderr: "" } : undefined });
  await app.init(["Cached task"]);
  corrupt = true;
  const result = await app.call({ op: "view" });
  expect(result.isError).toBe(true);
  expect(result.details.kata.phases).toEqual([]);
  expect(result.content[0].text).not.toContain("0/1 done");
});

test("a pending stop-hook refresh does not describe cached tasks as current", async () => {
  // The stop hook's read of the plan is held until the test lets Kata answer, so it is still pending when the hook returns.
  let outage = false;
  const held = holdKata(args => outage && args[0] === "show", () => ({ code: 1, stdout: "", stderr: "slow read outage" }));
  const app = await host({ before: held.before });
  await app.init(["Cached stop task"]);
  outage = true;
  const settle = { outcome: "completed", entries: [], context: { contextMessages: [{ role: "assistant", content: [{ type: "text", text: "Implemented part of it." }] }] } };
  try { expect(await app.event("agent_before_settle", settle)).toBeUndefined(); }
  finally { held.release(); }
  await app.call({ op: "view" }); // drain the background hook
});

// Generated malformed response values must not turn the last good snapshot into an authoritative response.
// 0 and {} are regressions found earlier; they run first.
test("arbitrary non-array hosted children never expose cached state", async () => {
  let children: unknown;
  let corrupt = false;
  const app = await host({ before: (args: string[]) => corrupt && args[0] === "show"
    ? { code: 0, stdout: JSON.stringify({ issue: {}, children }), stderr: "" } : undefined });
  await app.init(["Property cached task"]);
  corrupt = true;
  await fc.assert(fc.asyncProperty(fc.jsonValue().filter(value => value !== null && !Array.isArray(value)), async value => {
    children = value;
    const result = await app.call({ op: "view" });
    expect(result.isError).toBe(true);
    expect(result.details.kata.phases).toEqual([]);
    expect(result.content[0].text).not.toContain("0/1 done");
  }), { numRuns: 100, seed: 251025, examples: [[0], [{}]] });
});

test("a later init can replace a parameter-bound parent", async () => {
  const first = await hostedIssue(), next = await hostedIssue();
  const app = await host();
  await app.call({ op: "init", ref: first, items: ["First plan"] });
  const result = await app.call({ op: "init", ref: next, items: ["Next plan"] });
  expect(result.details.kata.parent).toBe(next);
  expect((await show(next)).children[0].title).toBe("Next plan");
});

test("view retries a failed parameter binding rather than reporting no plan", async () => {
  const parent = await hostedIssue();
  let fail = true;
  const app = await host({ cwd: outside, before: (args: string[]) => fail && args[0] === "show" ? { code: 1, stdout: "", stderr: "read outage" } : undefined });
  expect((await app.call({ op: "init", ref: parent, items: ["Pending init"] })).isError).toBe(true);
  fail = false;
  expect((await app.call({ op: "view" })).details.kata.parent).toBe(parent);
});

for (const error of ["project vault not found", "no project access: permission denied"]) test(`project error is never local fallback: ${error}`, async () => {
  const app = await host({ before: (args: string[]) => args[0] === "list" ? { code: 1, stdout: "", stderr: error } : undefined });
  const result = await app.call({ op: "init", items: ["Hosted only"] });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).not.toContain("Session-local");
});

test("blank evidence entries are dropped before the close, and evidence that is only blank is refused", async () => {
  const app = await host(); const parent = await app.init(["Blank evidence task", "Only blank evidence task"]);
  const done = await app.call({ op: "done", task: "Blank evidence task", message, evidence: ["", "  ", ...evidence] });
  expect(done.isError).toBeUndefined();
  expect(app.calls.filter(a => a[0] === "close").flat()).not.toContain("");
  expect((await show(parent)).children.find((c: any) => c.title === "Blank evidence task").status).toBe("closed");
  const blank = await app.call({ op: "done", task: "Only blank evidence task", message, evidence: [" "] });
  expect(blank.isError).toBe(true);
  expect(blank.content[0].text).toContain("evidence");
});
