import { expect, spyOn, test } from "bun:test";
import { eventually, holdKata, settle } from "./kata-fixture";
import { v2Fixture } from "./v2-fixture";

const { kata, issue, host } = v2Fixture();

test("result polling coalesces a held read and skips task and nested results", async () => {
  process.env.KATA_INBOX_USER = "v2-builder/poll-result";
  process.env.KATA_INBOX_POLL_SECONDS = "0";
  let armed = false;
  const returned = Promise.withResolvers<void>();
  const held = holdKata(args => armed && args[0] === "inbox", () => ({ code: 0, stdout: JSON.stringify({ requests: [
    { ref: "v2test#own", from: "v2-builder", message: "own-message" },
  ] }), stderr: "" }));
  const app = host({ before: async (args: string[], opts: any) => {
    const answer = await held.before(args, opts);
    if (armed && args[0] === "inbox") returned.resolve();
    return answer;
  } });
  await app.event("session_start");
  await app.event("before_agent_start", { systemPrompt: ["base"] });
  await settle();
  const readsBefore = app.calls.filter((args: string[]) => args[0] === "inbox").length;
  armed = true;
  const event = { toolName: "read", content: [{ type: "text", text: "original" }], isError: false };
  try {
    expect(await app.event("tool_result", event)).toBeUndefined();
    await held.entered;
    expect(await Promise.all([app.event("tool_result", event), app.event("tool_result", event)])).toEqual([undefined, undefined]);
  } finally { held.release(); }
  await returned.promise;
  await settle();
  expect(app.calls.filter((args: string[]) => args[0] === "inbox")).toHaveLength(readsBefore + 1);
  expect(await app.event("tool_result", { ...event, toolName: "task" })).toBeUndefined();
  expect(await app.event("tool_result", { ...event, parentToolCallId: "script" })).toBeUndefined();
  let delivered: any;
  await eventually(async () => { delivered = await app.event("tool_result", event); return JSON.stringify(delivered ?? {}).includes("own-message"); }, true);
});

test("prompt delivery, invalid interval fallback, failure, and A to B to A changes", async () => {
  process.env.KATA_INBOX_USER = "v2-builder/timed-result";
  process.env.KATA_INBOX_POLL_SECONDS = "invalid";
  let clock = 1000, text = "A-message", fail = false, reads = 0;
  const clockSpy = spyOn(performance, "now").mockImplementation(() => clock);
  const app = host({ before: (args: string[]) => {
    if (args[0] !== "inbox") return undefined;
    reads++;
    return fail ? { code: 1, stdout: "", stderr: "offline" } : { code: 0, stdout: JSON.stringify({ requests: [{ ref: "v2test#clock", from: "v2-builder", message: text }] }), stderr: "" };
  } });
  const event = { toolName: "read", content: [{ type: "text", text: "original" }], isError: false };
  const waitFor = async (condition: () => boolean) => {
    const end = Date.now() + 5000;
    while (!condition() && Date.now() < end) await Bun.sleep(10);
    expect(condition()).toBe(true);
    await Bun.sleep(20);
  };
  try {
    await app.event("session_start");
    const prompt = await app.event("before_agent_start", { systemPrompt: ["base"] });
    expect(JSON.stringify(prompt)).toContain("A-message");
    const first = reads;
    expect(await app.event("tool_result", event)).toBeUndefined();
    clock += 14999;
    expect(await app.event("tool_result", event)).toBeUndefined();
    await Bun.sleep(20);
    expect(reads).toBe(first);
    fail = true; clock += 1;
    expect(await app.event("tool_result", event)).toBeUndefined();
    await waitFor(() => reads === first + 1);
    fail = false; text = "B-message"; clock += 14999;
    expect(await app.event("tool_result", event)).toBeUndefined();
    await Bun.sleep(20);
    expect(reads).toBe(first + 1);
    clock += 1; await app.event("tool_result", event);
    await waitFor(() => reads === first + 2);
    const b = await app.event("tool_result", event);
    expect(JSON.stringify(b)).toContain("B-message");
    text = "A-message"; clock += 15000; await app.event("tool_result", event);
    await waitFor(() => reads === first + 3);
    expect(JSON.stringify(await app.event("tool_result", event))).toContain("A-message");
  } finally { clockSpy.mockRestore(); }
});

test("a personal inbox and an unrecorded advisor do not poll on results", async () => {
  process.env.KATA_INBOX_USER = "v2-builder";
  process.env.KATA_INBOX_POLL_SECONDS = "0";
  const personal = host(); await personal.event("session_start");
  const event = { toolName: "read", content: [{ type: "text", text: "original" }], isError: false };
  expect(await personal.event("tool_result", event)).toBeUndefined();
  await settle();
  expect(personal.calls.filter((a: string[]) => a[0] === "inbox")).toHaveLength(0);

  process.env.KATA_INBOX_USER = "v2-builder/advisor-result";
  let message = "lead-first";
  const lead = host({ before: (args: string[]) => args[0] === "inbox" ?
    { code: 0, stdout: JSON.stringify({ requests: [{ ref: "v2test#advisor", from: "v2-builder", message }] }), stderr: "" } : undefined });
  await lead.event("session_start");
  expect(JSON.stringify(await lead.event("before_agent_start", { systemPrompt: ["base"] }))).toContain("lead-first");
  message = "lead-changed";
  await lead.event("tool_result", event);
  await settle();
  const advisor = { ...lead.ctx, agent: { kind: "sub", id: "Advisor" } };
  expect(await lead.event("tool_result", event, advisor)).toBeUndefined();
  expect(JSON.stringify(await lead.event("tool_result", event))).toContain("lead-changed");
});

test("a cleared request shown by a prompt is announced on the next result", async () => {
  process.env.KATA_INBOX_USER = "v2-builder/review-withdraw";
  process.env.KATA_INBOX_POLL_SECONDS = "0";
  const app = host(); await app.event("session_start");
  await app.contractReady;
  const prompt = () => app.event("before_agent_start", { systemPrompt: ["base"] });
  const ref = await issue("withdraw across prompt");
  await kata(["notify", ref, "--to", "v2-builder/review-withdraw", "--message", "withdraw-me", "--json"]);
  await prompt();
  expect(JSON.stringify(await prompt())).toContain("withdraw-me");
  await kata(["notify", ref, "--to", "v2-builder/review-withdraw", "--clear", "--json"]);
  await prompt();
  expect(JSON.stringify(await prompt() ?? {})).not.toContain("withdraw-me");
  const event = { toolName: "read", content: [{ type: "text", text: "original" }], isError: false };
  expect(JSON.stringify((await app.event("tool_result", event)) ?? {})).toContain("inbox is now empty");
  expect(await app.event("tool_result", event)).toBeUndefined();
});
