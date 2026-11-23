import { expect, test } from "bun:test";
import { eventually } from "./kata-fixture";
import { v2Fixture } from "./v2-fixture";

// The omp adapter against a real Kata: hosted parents and delegate mirroring through omp's native todo, the contract hook and the inbox section.
const { scratch, cwd, outside, run, kata, show, issue, host, message } = v2Fixture();

// The delegate's assignment child is written in the background after the lifecycle event.
const assignedChild = async (parent: string, id: string) => {
  await eventually(async () => (await show(parent)).children.some((c: any) => c.metadata?.["omp.subagent_id"] === id), true);
  return (await show(parent)).children.find((c: any) => c.metadata?.["omp.subagent_id"] === id);
};

// A hosted parent comes from KATA_REF, a stored binding or `/todo ref`; the todo calls themselves are omp's native ones.
// Hosted reads routinely take longer than the old one-second process deadline.
test("hosted show lasting over one second still mirrors a native init into the hosted parent", async () => {
  const ref = `v2test#${await issue()}`;
  process.env.KATA_REF = ref;
  const app = host({ before: async (args: string[], opts: any) => {
    if (args[0] !== "show") return;
    if (opts.timeout < 1100) return { code: 0, killed: true, stdout: "", stderr: "" };
  } });
  await app.event("session_start");
  expect((await app.call({ op: "init", items: ["Slow hosted read"] })).isError).toBeUndefined();
  expect((await show(ref)).children[0].title).toBe("Slow hosted read");
});

for (const source of ["/todo ref", "environment", "stored"]) test(`qualified ${source} binding stays authoritative outside the project workspace`, async () => {
  const parent = `v2test#${await issue()}`;
  if (source === "environment") process.env.KATA_REF = parent;
  const app = host({ cwd: outside, ...(source === "stored" ? { entries: [{ type: "custom", customType: "io.kata.omp.parent", data: { parent, workspace: cwd } }] } : {}) });
  await app.event("session_start");
  if (source === "/todo ref") await app.event("input", { text: `/todo ref ${parent}`, source: "interactive" });
  expect((await app.call({ op: "init", items: ["Hosted worker task"] })).isError).toBeUndefined();
  expect(app.mirrorFailures()).toEqual([]);
  expect((await show(parent)).children[0].title).toBe("Hosted worker task");
});

test("tracked worker todo uses its assigned issue and teammate from an unbound worktree", async () => {
  const lead = host();
  await lead.event("session_start");
  const parent = await lead.init(["Implement worker task"]);
  const sessionFile = `${scratch}/worker-todo.jsonl`;
  lead.emit("task:subagent:lifecycle", { id: "worker-todo", status: "started", sessionFile, description: "Implement worker task" });
  const assigned = await assignedChild(parent, "worker-todo");
  // The lead's inherited reference must never become the delegate's plan.
  process.env.KATA_REF = parent;
  const worker = host({ cwd: outside, sessionFile, agent: { kind: "sub", id: "worker-todo", parentId: lead.ctx.agent.id } });
  const result = await worker.call({ op: "init", items: ["Verify assigned worker"] });
  expect(result.isError).toBeUndefined();
  // The delegate's mirror of the native call runs after its tool_result.
  const titles = async () => ((await show(`v2test#${assigned.short_id}`)).children ?? []).map((c: any) => c.title);
  await eventually(titles, ["Verify assigned worker"]);
  const tasks = (await show(`v2test#${assigned.short_id}`)).children;
  expect(tasks[0].metadata.teammate).toBe(assigned.metadata.teammate);
  const taskRef = `v2test#${tasks[0].short_id}`;
  // The delegate's tool_call guard refuses a native done while the task is open in Kata; the delegate closes it, then marks it done.
  expect((await worker.call({ op: "done", task: "Verify assigned worker" })).isError).toBe(true);
  await kata(["close", taskRef, "--done", "--message", message, "--test", "external verification", "--json"]);
  expect((await worker.call({ op: "done", task: "Verify assigned worker" })).isError).toBeUndefined();
  expect((await show(taskRef)).issue.status).toBe("closed");
  expect((await show(parent)).issue.status).toBe("open");
  expect(worker.widgets).toEqual([]);
});

test("a sub identity cannot reuse the main adapter's bound session", async () => {
  const app = host();
  await app.event("session_start");
  const parent = await app.init(["Main task"]);
  const before = app.calls.length;
  const foreign = await app.call({ op: "init", items: ["Foreign task"] }, { ...app.ctx, agent: { kind: "sub", id: "advisor" } });
  expect(app.calls.slice(before).some(a => ["create", "close", "meta"].includes(a[0]))).toBe(false);
  expect((await show(parent)).children.map((c: any) => c.title)).toEqual(["Main task"]);
  // The sub's call works on its own native list; the lead's list is the one Kata mirrors.
  expect(foreign.details.phases?.[0]?.tasks.map((t: any) => t.content)).toEqual(["Foreign task"]);
  expect(app.list().flatMap(p => p.tasks.map(t => t.content))).toEqual(["Main task"]);
});

test("an assigned delegate fetches the contract with its exact hook arguments", async () => {
  const lead = host();
  await lead.event("session_start");
  const leadParent = await lead.init(["Lead contract task"]);
  const sessionFile = `${scratch}/worker-contract.jsonl`;
  lead.emit("task:subagent:lifecycle", { id: "worker-contract", status: "started", sessionFile, description: "Lead contract task" });
  await assignedChild(leadParent, "worker-contract");
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

test("a failed assignment leaves no worker tasks in Kata and recovers once the preparation error clears", async () => {
  let unavailable = false;
  const lead = host({ before: (args: string[]) => unavailable && args[0] === "meta" && args[3] === "omp.subagent_id"
    ? { code: 1, stdout: "", stderr: "delegation service permission denied" } : undefined });
  await lead.event("session_start");
  const parent = await lead.init(["Lead error task"]);
  unavailable = true;
  const sessionFile = `${scratch}/worker-error.jsonl`;
  lead.emit("task:subagent:lifecycle", { id: "worker-error", status: "started", sessionFile, description: "Lead error task" });
  const worker = host({ sessionFile, agent: { kind: "sub", id: "worker-error" } });
  // The native call succeeds in omp; only Kata's mirror of it fails.
  expect((await worker.call({ op: "init", items: ["Worker error task"] })).isError).toBeUndefined();
  expect((await show(parent)).children).toHaveLength(1);
  unavailable = false;
  expect((await worker.call({ op: "append", items: ["Worker error follow-up"] })).isError).toBeUndefined();
  const assigned = await assignedChild(parent, "worker-error");
  await eventually(async () => ((await show(`v2test#${assigned.short_id}`)).children ?? []).some((c: any) => c.title === "Worker error task"), true);
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

test("the inbox trusts Kata's effective actor once the plan has a parent, not the author setting read before it", async () => {
  process.env.KATA_INBOX_USER = "v2-builder/effective";
  const parent = await issue();
  // Kata reports another effective actor than KATA_AUTHOR, as a daemon that authenticates its clients does.
  const app = host({ entries: [{ type: "custom", customType: "io.kata.omp.parent", data: { parent } }],
    before: (a: string[]) => a[0] === "status" ? { code: 0, stdout: JSON.stringify({ actor: "daemon-actor" }), stderr: "" } : undefined });
  await app.event("session_start"); await app.contractReady;
  await app.call({ op: "init", items: ["Inbox actor task"] });
  expect((await show(`v2test#${parent}`)).children.map((c: any) => c.title)).toEqual(["Inbox actor task"]);
  expect((await run(["notify", parent, "--to", "v2-builder/effective", "--message", "effective-actor-5521", "--json"], cwd, 5000, { KATA_AUTHOR: "daemon-actor" })).code).toBe(0);
  await app.event("before_agent_start", { systemPrompt: ["base"] });
  const prompt = (await app.event("before_agent_start", { systemPrompt: ["base"] })).systemPrompt.join("\n");
  expect(prompt).toContain(`from="daemon-actor" message="effective-actor-5521"`);
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
  const prompt: string = (await app.event("before_agent_start", { systemPrompt: ["base"] })).systemPrompt.join("\n");
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
