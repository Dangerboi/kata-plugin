import { expect, test } from "bun:test";
import { v2Fixture } from "./v2-fixture";
import { eventually, holdKata } from "./kata-fixture";

const { host, issue, kata, run } = v2Fixture();
const prompt = (app: ReturnType<typeof host>) => app.event("before_agent_start", { systemPrompt: ["base"] });
const commit = (app: ReturnType<typeof host>, result: any) => {
  if (result?.message) app.ctx.sessionManager.getBranch().push({ type: "custom_message", ...result.message });
};

test("plan updates leave the system prompt stable and are delivered from committed branch state", async () => {
  const app = host(); await app.event("session_start"); await app.contractReady;
  await app.init(["Implement fixture", "Verify fixture"]);
  const first = await prompt(app);
  expect(first.message.content).toContain("Current plan");
  expect(first.message.attribution).toBe("agent");
  expect(first.systemPrompt.join("\n")).not.toContain("Current plan");
  expect(first.systemPrompt.join("\n")).toContain("Your todo list is mirrored into Kata");
  // A discarded hook result must not count as delivered.
  expect((await prompt(app)).message).toEqual(first.message);
  commit(app, first);
  expect((await prompt(app)).message).toBeUndefined();
  await app.done("Implement fixture");
  const next = await prompt(app);
  expect(next.systemPrompt).toEqual(first.systemPrompt);
  expect(next.message.content).toContain("Current plan");
  expect(next.message.content).not.toEqual(first.message.content);
  commit(app, next);
  expect((await prompt(app)).message).toBeUndefined();
  app.ctx.sessionManager.getBranch().push({ type: "compaction" });
  expect((await prompt(app)).message.content).toEqual(next.message.content);
  await app.event("session_shutdown");
});

test("inbox updates and clearing are sent once, and branch changes replay them", async () => {
  process.env.KATA_INBOX_USER = "v2-builder/prompt-test";
  process.env.KATA_OMP_LIVE_INBOX = "0";
  const app = host(); await app.event("session_start"); await app.contractReady;
  await app.init(["Inbox plan fixture", "Verify inbox fixture"]);
  const initialPlan = await prompt(app); commit(app, initialPlan);
  const ref = await issue(), other = await issue();
  await kata(["notify", ref, "--to", "v2-builder/prompt-test", "--message", "prompt-inbox-fixture", "--json"]);
  await kata(["notify", other, "--to", "v2-builder/prompt-test", "--message", "second-inbox-fixture", "--json"]);
  await prompt(app);
  const first = await prompt(app);
  expect(first.message.content).toContain("prompt-inbox-fixture");
  expect(first.message.content).toContain("second-inbox-fixture");
  expect(first.message.content).not.toContain("Current plan");
  expect(first.systemPrompt.join("\n")).not.toContain("prompt-inbox-fixture");
  commit(app, first);
  expect((await prompt(app)).message).toBeUndefined();
  await app.done("Inbox plan fixture");
  const changedPlan = await prompt(app);
  expect(changedPlan.message.content).toContain("Current plan");
  expect(changedPlan.message.content).not.toContain("prompt-inbox-fixture");
  commit(app, changedPlan);
  expect((await prompt(app)).message).toBeUndefined();
  await kata(["notify", ref, "--to", "v2-builder/prompt-test", "--clear", "--json"]);
  await prompt(app);
  const partial = await prompt(app);
  expect(partial.message.content).not.toContain("prompt-inbox-fixture");
  expect(partial.message.content).toContain("second-inbox-fixture");
  commit(app, partial);
  await kata(["notify", other, "--to", "v2-builder/prompt-test", "--clear", "--json"]);
  await prompt(app);
  const cleared = await prompt(app);
  expect(cleared.message.content).toContain("inbox is now empty");
  expect(cleared.message.content).not.toContain("Current plan");
  commit(app, cleared);
  expect((await prompt(app)).message).toBeUndefined();
  app.ctx.sessionManager.getBranch().pop();
  expect((await prompt(app)).message.content).toContain("inbox is now empty");
  commit(app, cleared);
  await app.backend("native");
  const planCleared = await prompt(app);
  expect(planCleared.message.content).toContain("plan has been cleared");
  commit(app, planCleared);
  expect((await prompt(app)).message).toBeUndefined();
  await app.event("session_shutdown");
  delete process.env.KATA_OMP_LIVE_INBOX;
  delete process.env.KATA_INBOX_USER;
});

test("unknown inbox reads preserve the snapshot until an authoritative empty result", async () => {
  process.env.KATA_INBOX_USER = "v2-builder/review95";
  process.env.KATA_OMP_LIVE_INBOX = "0";
  const a = host(); await a.event("session_start"); await a.contractReady;
  await a.init(["Pending inbox plan", "Verify pending inbox"]);
  const ref = await issue("pending request");
  await kata(["notify", ref, "--to", "v2-builder/review95", "--message", "pending request", "--json"]);
  await prompt(a); const prior = await prompt(a);
  expect(prior.message.content).toContain("pending request"); commit(a, prior);
  const entries = structuredClone(a.ctx.sessionManager.getBranch());
  await a.event("session_shutdown");

  let failing = true;
  const failed = host({ sid: a.sid, entries: structuredClone(entries), before: (args: string[]) => args[0] === "inbox" && failing ? { code: 1, stdout: "", stderr: "offline" } : undefined });
  await failed.event("session_start");
  try {
    expect((await prompt(failed))?.message?.content ?? "").not.toContain("inbox is now empty");
    await kata(["notify", ref, "--to", "v2-builder/review95", "--clear", "--json"]);
    failing = false;
    await prompt(failed); const clear = await prompt(failed);
    expect(clear?.message?.content).toContain("inbox is now empty");
    commit(failed, clear);
    expect((await prompt(failed))?.message).toBeUndefined();
  } finally { await failed.event("session_shutdown"); }

  delete process.env.KATA_INBOX_USER;
  const removed = host({ sid: a.sid, entries: structuredClone(entries) });
  await removed.event("session_start");
  try { expect((await prompt(removed))?.message?.content).toContain("inbox is now empty"); }
  finally { await removed.event("session_shutdown"); }

  process.env.KATA_INBOX_USER = "v2-builder/review95";
  await kata(["notify", ref, "--to", "v2-builder/review95", "--message", "pending request", "--json"]);
  const readFinished = Promise.withResolvers<void>();
  const held = holdKata(args => args[0] === "inbox", async (args, opts) => {
    const result = await run(args, opts.cwd, opts.timeout);
    readFinished.resolve();
    return result;
  });
  const resumed = host({ sid: a.sid, entries: [...structuredClone(entries), { type: "compaction" }], before: held.before });
  await resumed.event("session_start");
  try {
    await held.entered;
    await resumed.backend("native");
    const update = await prompt(resumed);
    expect(update.message.content).toContain("pending request");
    expect(update.message.content).toContain("plan has been cleared");
    expect(update.message.content).not.toContain("inbox is now empty");
    commit(resumed, update);
    await kata(["notify", ref, "--to", "v2-builder/review95", "--clear", "--json"]);
    held.release(); await readFinished.promise;
    await eventually(async () => (await prompt(resumed))?.message?.content?.includes("inbox is now empty") ?? false, true);
  } finally { held.release(); await resumed.event("session_shutdown"); }
});

test("reset boundary replays the plan and inbox once", async () => {
  process.env.KATA_INBOX_USER = "v2-builder/r4-reset";
  process.env.KATA_OMP_LIVE_INBOX = "0";
  const app = host(); await app.event("session_start"); await app.contractReady;
  try {
    await app.init(["keep first", "keep second"]);
    const ref = await issue("reset request");
    await kata(["notify", ref, "--to", "v2-builder/r4-reset", "--message", "reset request", "--json"]);
    await prompt(app); const before = await prompt(app);
    expect(before.message.content).toContain("Current plan");
    expect(before.message.content).toContain("reset request");
    commit(app, before);
    app.ctx.sessionManager.getBranch().push({ type: "reset_boundary" });
    const after = await prompt(app);
    expect(after.message.content).toContain("Current plan");
    expect(after.message.content).toContain("reset request");
    commit(app, after);
    expect((await prompt(app)).message).toBeUndefined();
  } finally { await app.event("session_shutdown"); }
});
