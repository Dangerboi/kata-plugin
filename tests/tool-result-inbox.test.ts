import { afterEach, expect, test } from "bun:test";
import { eventually } from "./kata-fixture";
import { v2Fixture } from "./v2-fixture";
import { ompHost, clearTranscriptEnv } from "./omp-host";

const { scratch, cwd, run, kata, issue, host, unique } = v2Fixture();
afterEach(() => { delete process.env.KATA_INBOX_POLL_SECONDS; });

test("a working delegate receives a request sent after its prompt on a tool result", async () => {
  process.env.KATA_INBOX_USER = "v2-builder/lead-result";
  process.env.KATA_INBOX_POLL_SECONDS = "0";
  const lead = host(); await lead.event("session_start"); await lead.init(["Implement widget"]);
  const sessionFile = `${scratch}/result-worker.jsonl`;
  lead.emit("task:subagent:lifecycle", { id: "result-worker", agent: "scout", status: "started", sessionFile, description: "Survey" });
  await lead.call({ op: "view" });
  const worker = host({ sessionFile, agent: { kind: "sub", id: "result-worker", parentId: lead.ctx.agent.id } });
  const prompt = ((await worker.event("before_agent_start", { systemPrompt: ["base"] }))?.systemPrompt ?? []).join("\n");
  const address = /Your Kata inbox is (\S+?);/.exec(prompt)?.[1];
  expect(address).toBeTruthy();
  const ref = await issue();
  await kata(["notify", ref, "--to", address!, "--message", "mid-run-request-96 <unsafe>", "--json"]);
  const result = () => worker.event("tool_result", { toolName: "read", content: [{ type: "text", text: "file contents" }], isError: false });
  let delivered: any;
  await eventually(async () => { delivered = await result(); return JSON.stringify(delivered ?? {}).includes("mid-run-request-96"); }, true);
  expect(delivered.content[0].text).toBe("file contents");
  expect(JSON.stringify(delivered)).toContain("<kata_inbox>");
  expect(JSON.stringify(delivered)).toContain("&lt;unsafe&gt;");
  console.log("delivered result:", JSON.stringify(delivered.content));
  expect(await result()).toBeUndefined();
  await kata(["notify", ref, "--to", address!, "--clear", "--json"]);
  let cleared: any;
  await eventually(async () => { cleared = await result(); return JSON.stringify(cleared ?? {}).includes("inbox is now empty"); }, true);
  console.log("cleared result:", JSON.stringify(cleared.content));
  expect(await result()).toBeUndefined();
});


test("result polling coalesces a held read, filters foreign requests, and delivers once", async () => {
  process.env.KATA_INBOX_USER = "v2-builder/poll-result";
  process.env.KATA_INBOX_POLL_SECONDS = "0";
  process.env.KATA_OMP_LIVE_INBOX = "0";
  let armed = false, calls = 0;
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const app = host({ before: async (args: string[]) => {
    if (args[0] !== "inbox" || !armed) return undefined;
    calls++; entered.resolve(); await gate.promise;
    return { code: 0, stdout: JSON.stringify({ requests: [
      { ref: "v2test#own", from: "v2-builder", message: "own <message>" },
      { ref: "v2test#foreign", from: "other", message: "foreign-message" },
    ] }), stderr: "" };
  } });
  await app.event("session_start");
  await app.event("before_agent_start", { systemPrompt: ["base"] });
  armed = true;
  const event = { toolName: "read", content: [{ type: "text", text: "original" }], isError: false };
  try {
    expect(await app.event("tool_result", event)).toBeUndefined();
    await entered.promise;
    expect(await Promise.all([app.event("tool_result", event), app.event("tool_result", event)])).toEqual([undefined, undefined]);
    expect(calls).toBe(1);
  } finally { armed = false; gate.resolve(); }
  await Bun.sleep(100);
  expect(await app.event("tool_result", { ...event, toolName: "task" })).toBeUndefined();
  expect(await app.event("tool_result", { ...event, parentToolCallId: "script" })).toBeUndefined();
  let delivered: any;
  await eventually(async () => { delivered = await app.event("tool_result", event); return JSON.stringify(delivered ?? {}).includes("own &lt;message&gt;"); }, true);
  expect(JSON.stringify(delivered)).not.toContain("foreign-message");
  expect(await app.event("tool_result", event)).toBeUndefined();
});

test("prompt delivery, interval boundary, failure, and A to B to A changes", async () => {
  process.env.KATA_INBOX_USER = "v2-builder/timed-result";
  process.env.KATA_OMP_LIVE_INBOX = "0";
  delete process.env.KATA_INBOX_POLL_SECONDS;
  let clock = 1000, text = "A-message", fail = false, reads = 0;
  const { spyOn } = await import("bun:test");
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

test("poll option, invalid environment, and zero environment precedence", async () => {
  const { createKataCore } = await import("../core/kata-core");
  const { nodePlatform } = await import("../core/node-host");
  const { memoryDelegateStore } = await import("./kata-fixture");
  const { spyOn } = await import("bun:test");
  process.env.KATA_INBOX_USER = "v2-builder/option-result";
  let clock = 1000, reads = 0, completed = 0;
  const spy = spyOn(performance, "now").mockImplementation(() => clock);
  const entries: any[] = [];
  const core = createKataCore({ platform: nodePlatform, delegateStore: memoryDelegateStore(), isMain: () => true,
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    exec: async (_file, args, opts) => { if (args[0] !== "inbox") return run(args, opts.cwd); reads++; try { return await run(args, opts.cwd); } finally { completed++; } },
  }, { namespace: "omp", executable: process.env.KATA_TEST_EXECUTABLE!, executableVars: [], inboxPollMs: 5000 });
  const ctx = { cwd, agent: { kind: "main", id: "option" }, sessionManager: { getSessionId: () => "option", getBranch: () => entries, getHeader: () => ({}) } };
  const waitRead = async (count: number) => {
    const end = Date.now() + 5000;
    while (completed < count && Date.now() < end) await Bun.sleep(10);
    expect(completed).toBe(count);
    await Bun.sleep(10);
  };
  try {
    await core.session.beforePrompt(ctx);
    await waitRead(1);
    const first = reads;
    process.env.KATA_INBOX_POLL_SECONDS = "invalid";
    clock += 4999; core.tools.inbox(ctx); expect(reads).toBe(first);
    clock++; core.tools.inbox(ctx); await waitRead(first + 1);
    process.env.KATA_INBOX_POLL_SECONDS = "0";
    core.tools.inbox(ctx); await waitRead(first + 2);
    core.tools.inbox(ctx); await waitRead(first + 3);
  } finally { spy.mockRestore(); }
});
