import fc from "fast-check";
import { expect, test } from "bun:test";
import { later } from "./kata-fixture";
import { v2Fixture } from "./v2-fixture";

// The omp adapter against a real Kata: hosted bindings and refreshes, the contract hook and the inbox section.
const { scratch, cwd, outside, run, kata, show, issue, host, evidence, message } = v2Fixture();

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
