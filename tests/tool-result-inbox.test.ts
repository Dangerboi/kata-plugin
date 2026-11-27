import { expect, spyOn, test } from "bun:test";
import { eventually, holdKata } from "./kata-fixture";
import { v2Fixture } from "./v2-fixture";
import { ompHost, clearTranscriptEnv } from "./omp-host";

const { scratch, cwd, run, kata, issue, host, unique } = v2Fixture();

test("result polling coalesces a held read, filters foreign requests, and delivers once", async () => {
  process.env.KATA_INBOX_USER = "v2-builder/poll-result";
  process.env.KATA_INBOX_POLL_SECONDS = "0";
  process.env.KATA_OMP_LIVE_INBOX = "0";
  let armed = false;
  const held = holdKata(args => armed && args[0] === "inbox", () => ({ code: 0, stdout: JSON.stringify({ requests: [
    { ref: "v2test#own", from: "v2-builder", message: "own <message>" },
    { ref: "v2test#foreign", from: "other", message: "foreign-message" },
  ] }), stderr: "" }));
  const app = host({ before: held.before });
  await app.event("session_start");
  await app.event("before_agent_start", { systemPrompt: ["base"] });
  armed = true;
  const event = { toolName: "read", content: [{ type: "text", text: "original" }], isError: false };
  try {
    expect(await app.event("tool_result", event)).toBeUndefined();
    await held.entered;
    expect(await Promise.all([app.event("tool_result", event), app.event("tool_result", event)])).toEqual([undefined, undefined]);
    expect(held.held).toBe(1);
  } finally { armed = false; held.release(); }
  await Bun.sleep(100);
  expect(await app.event("tool_result", { ...event, toolName: "task" })).toBeUndefined();
  expect(await app.event("tool_result", { ...event, parentToolCallId: "script" })).toBeUndefined();
  let delivered: any;
  await eventually(async () => { delivered = await app.event("tool_result", event); return JSON.stringify(delivered ?? {}).includes("own &lt;message&gt;"); }, true);
  expect(JSON.stringify(delivered)).not.toContain("foreign-message");
  expect(await app.event("tool_result", event)).toBeUndefined();
});

test("prompt delivery, invalid interval fallback, failure, and A to B to A changes", async () => {
  process.env.KATA_INBOX_USER = "v2-builder/timed-result";
  process.env.KATA_OMP_LIVE_INBOX = "0";
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
    expect(reads).toBe(first);
    fail = true; clock += 1;
    expect(await app.event("tool_result", event)).toBeUndefined();
    await waitFor(() => reads === first + 1);
    fail = false; text = "B-message"; clock += 14999;
    expect(await app.event("tool_result", event)).toBeUndefined();
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
  const lead = host(); await lead.event("session_start");
  const advisor = { ...lead.ctx, agent: { kind: "sub", id: "Advisor" } };
  const event = { toolName: "read", content: [{ type: "text", text: "original" }], isError: false };
  expect(await lead.event("tool_result", event)).toBeUndefined();
  expect(await lead.event("tool_result", event, advisor)).toBeUndefined();
  expect(lead.calls.filter((a: string[]) => a[0] === "inbox")).toHaveLength(0);
});

test("a main session with a live follower does not poll on results", async () => {
  process.env.KATA_INBOX_USER = "v2-builder/live-result";
  process.env.KATA_INBOX_POLL_SECONDS = "0";
  delete process.env.KATA_OMP_LIVE_INBOX;
  const sid = `live-result-${unique()}`;
  const app = ompHost({ run: (args, opts) => run(args, opts.cwd, opts.timeout), cwd, sid, sessionFile: `${scratch}/${sid}.jsonl`, sendUserMessage: () => {}, afterEvent: clearTranscriptEnv });
  try {
    await app.event("session_start");
    await eventually(async () => app.calls.some(a => a[0] === "inbox"), true);
    const reads = app.calls.filter(a => a[0] === "inbox").length;
    expect(await app.event("tool_result", { toolName: "read", content: [], isError: false })).toBeUndefined();
    expect(app.calls.filter(a => a[0] === "inbox")).toHaveLength(reads);
  } finally { await app.event("session_shutdown"); }
});

test("a cleared request shown by a prompt is announced on the next result", async () => {
  process.env.KATA_INBOX_USER = "v2-builder/review-withdraw";
  process.env.KATA_INBOX_POLL_SECONDS = "0";
  process.env.KATA_OMP_LIVE_INBOX = "0";
  const app = host(); await app.event("session_start");
  const ref = await issue("withdraw across prompt");
  await kata(["notify", ref, "--to", "v2-builder/review-withdraw", "--message", "withdraw-me", "--json"]);
  expect(JSON.stringify(await app.event("before_agent_start", { systemPrompt: ["base"] }))).toContain("withdraw-me");
  await kata(["notify", ref, "--to", "v2-builder/review-withdraw", "--clear", "--json"]);
  expect(JSON.stringify(await app.event("before_agent_start", { systemPrompt: ["base"] }) ?? {})).not.toContain("withdraw-me");
  const event = { toolName: "read", content: [{ type: "text", text: "original" }], isError: false };
  expect(JSON.stringify((await app.event("tool_result", event)) ?? {})).toContain("inbox is now empty");
  expect(await app.event("tool_result", event)).toBeUndefined();
});
