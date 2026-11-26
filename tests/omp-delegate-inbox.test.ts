import { expect, test } from "bun:test";
import { v2Fixture } from "./v2-fixture";

// An omp delegate runs in the lead's process but reads its own session inbox, <actor>/<teammate>, never the lead's.
const { scratch, kata, issue, host } = v2Fixture();

async function team(ids: string[]) {
  const lead = host(); await lead.event("session_start"); await lead.init(["Implement widget"]);
  const workers = ids.map(id => {
    const sessionFile = `${scratch}/${id}.jsonl`;
    lead.emit("task:subagent:lifecycle", { id, agent: "scout", status: "started", sessionFile, description: `Survey ${id}` });
    return { id, sessionFile };
  });
  await lead.call({ op: "view" });
  return { lead, workers: workers.map(w => host({ sessionFile: w.sessionFile, agent: { kind: "sub", id: w.id, parentId: lead.ctx.agent.id } })) };
}
const prompt = async (app: ReturnType<typeof host>) => ((await app.event("before_agent_start", { systemPrompt: ["base"] }))?.systemPrompt ?? []).join("\n");
const turn = async (app: ReturnType<typeof host>) => { await prompt(app); return prompt(app); };
const addressOf = (text: string) => /Your Kata inbox is (\S+?);/.exec(text)?.[1];
const notify = async (ref: string, to: string, text: string) => { await kata(["notify", ref, "--to", to, "--message", text, "--json"]); };

test("a delegate's inbox holds what was sent to its own address, not the lead's or a sibling's", async () => {
  process.env.KATA_INBOX_USER = "v2-builder/lead-box";
  const { lead, workers: [a, b] } = await team(["inbox-a", "inbox-b"]);
  await lead.contractReady;
  const ref = await issue();
  const addressA = addressOf(await prompt(a)), addressB = addressOf(await prompt(b));
  expect(addressA).toMatch(/^v2-builder\/.+/);
  expect(addressB).toMatch(/^v2-builder\/.+/);
  expect(addressA).not.toBe(addressB);
  expect(addressA).not.toBe("v2-builder/lead-box");
  await notify(ref, addressA!, "for-delegate-a-6021");
  await notify(ref, "v2-builder/lead-box", "for-the-lead-6022");
  const [seenA, seenB, seenLead] = [await turn(a), await turn(b), await turn(lead)];
  expect(seenA).toContain("<kata_inbox>");
  expect(seenA).toContain("for-delegate-a-6021");
  expect(seenA).not.toContain("for-the-lead-6022");
  expect(seenB).not.toContain("for-delegate-a-6021");
  expect(seenB).not.toContain("for-the-lead-6022");
  expect(seenLead).toContain("for-the-lead-6022");
  expect(seenLead).not.toContain("for-delegate-a-6021");
  expect(a.calls.filter(c => c[0] === "inbox").every(c => c[2] === addressA)).toBe(true);
  await kata(["notify", ref, "--to", addressA!, "--clear", "--json"]);
  await kata(["notify", ref, "--to", "v2-builder/lead-box", "--clear", "--json"]);
});

test("a lead and a delegate preparing their prompts together each get their own inbox", async () => {
  process.env.KATA_INBOX_USER = "v2-builder/lead-race";
  const { lead, workers: [worker] } = await team(["race-a"]);
  await lead.contractReady;
  const ref = await issue();
  const address = addressOf(await prompt(worker))!;
  await notify(ref, address, "delegate-race-7031");
  await notify(ref, "v2-builder/lead-race", "lead-race-7032");
  for (let round = 0; round < 3; round++) {
    const [fromLead, fromWorker] = await Promise.all([prompt(lead), prompt(worker)]);
    if (round === 0) continue;
    expect(fromLead).toContain("lead-race-7032");
    expect(fromLead).not.toContain("delegate-race-7031");
    expect(fromWorker).toContain("delegate-race-7031");
    expect(fromWorker).not.toContain("lead-race-7032");
  }
  await kata(["notify", ref, "--to", address, "--clear", "--json"]);
  await kata(["notify", ref, "--to", "v2-builder/lead-race", "--clear", "--json"]);
});

for (const [name, setting] of [["unset", undefined], ["a bare actor", "v2-builder"]] as const) test(`with KATA_INBOX_USER ${name}, a delegate has no inbox and is told of none`, async () => {
  if (setting) process.env.KATA_INBOX_USER = setting; else delete process.env.KATA_INBOX_USER;
  const { workers: [worker] } = await team(["no-inbox"]);
  const ref = await issue();
  await notify(ref, "v2-builder", "person-only-8041");
  const seen = await turn(worker);
  expect(seen).toContain("you have no Kata issue");
  expect(seen).not.toContain("Your Kata inbox");
  expect(seen).not.toContain("<kata_inbox>");
  expect(worker.calls.filter(c => c[0] === "inbox")).toEqual([]);
  await kata(["notify", ref, "--to", "v2-builder", "--clear", "--json"]);
});

test("an assigned delegate's note names its inbox and it reads that address", async () => {
  process.env.KATA_INBOX_USER = "v2-builder/lead-assigned";
  const lead = host(); await lead.event("session_start");
  await lead.init(["Implement widget", "Write widget tests"]);
  await lead.event("tool_call", { toolName: "task", toolCallId: "assigned-box", input: { name: "Widget", task: 'Complete "Write widget tests"' } });
  const sessionFile = `${scratch}/assigned-box.jsonl`;
  lead.emit("task:subagent:lifecycle", { id: "assigned-box", status: "started", sessionFile, parentToolCallId: "assigned-box", index: 0 });
  const worker = host({ sessionFile, agent: { kind: "sub", id: "assigned-box", parentId: lead.ctx.agent.id } });
  const first = await prompt(worker);
  const teammate = /your teammate is ([^.\s]+)\./.exec(first)?.[1];
  expect(teammate).toBeTruthy();
  expect(first).toContain(`Your Kata inbox is v2-builder/${teammate};`);
  const ref = await issue();
  await notify(ref, `v2-builder/${teammate}`, "assigned-ping-9051");
  expect(await turn(worker)).toContain("assigned-ping-9051");
  await kata(["notify", ref, "--to", `v2-builder/${teammate}`, "--clear", "--json"]);
});
