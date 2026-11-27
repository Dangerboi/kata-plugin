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
  expect(first.systemPrompt.join("\n")).not.toContain("Current plan");
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
  const ref = await issue();
  await kata(["notify", ref, "--to", "v2-builder/prompt-test", "--message", "prompt-inbox-fixture", "--json"]);
  await prompt(app);
  const first = await prompt(app);
  expect(first.message.content).toContain("prompt-inbox-fixture");
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

test("resuming while the inbox read is slow does not clear outstanding requests", async () => {
  process.env.KATA_INBOX_USER = "v2-builder/review95";
  process.env.KATA_OMP_LIVE_INBOX = "0";
  const a = host(); await a.event("session_start"); await a.contractReady;
  const one = await issue("first request"), two = await issue("second request");
  await kata(["notify", one, "--to", "v2-builder/review95", "--message", "first request remains", "--json"]);
  await kata(["notify", two, "--to", "v2-builder/review95", "--message", "second request remains", "--json"]);
  await prompt(a); const prior = await prompt(a);
  expect(prior.message.content).toContain("first request remains");
  commit(a, prior);
  const entries = structuredClone(a.ctx.sessionManager.getBranch());
  await a.event("session_shutdown");
  const readFinished = Promise.withResolvers<void>();
  const held = holdKata(args => args[0] === "inbox", async (args, opts) => {
    const result = await run(args, opts.cwd, opts.timeout);
    readFinished.resolve();
    return result;
  });
  const b = host({ sid: a.sid, entries, before: held.before });
  await b.event("session_start");
  try {
    await held.entered;
    expect((await prompt(b))?.message?.content ?? "").not.toContain("inbox is now empty");
    held.release();
    await readFinished.promise;
    expect((await prompt(b))?.message?.content ?? "").not.toContain("inbox is now empty");
    await kata(["notify", one, "--to", "v2-builder/review95", "--clear", "--json"]);
    await kata(["notify", two, "--to", "v2-builder/review95", "--clear", "--json"]);
    await eventually(async () => (await prompt(b))?.message?.content?.includes("inbox is now empty") ?? false, true);
  }
  finally { held.release(); await b.event("session_shutdown"); }
});


test("a failed inbox read preserves the prior snapshot until an authoritative empty read", async () => {
  process.env.KATA_INBOX_USER = "v2-builder/failure95";
  process.env.KATA_OMP_LIVE_INBOX = "0";
  const ref = await issue("failed read");
  await kata(["notify", ref, "--to", "v2-builder/failure95", "--message", "still pending", "--json"]);
  const a = host(); await a.event("session_start"); await a.contractReady;
  await prompt(a); const prior = await prompt(a); commit(a, prior);
  const entries = structuredClone(a.ctx.sessionManager.getBranch());
  await a.event("session_shutdown");
  let failing = true;
  const b = host({ sid: a.sid, entries: structuredClone(entries), before: (args: string[]) => args[0] === "inbox" && failing ? { code: 1, stdout: "", stderr: "offline" } : undefined });
  await b.event("session_start");
  try {
    expect((await prompt(b))?.message?.content ?? "").not.toContain("inbox is now empty");
    await kata(["notify", ref, "--to", "v2-builder/failure95", "--clear", "--json"]);
    failing = false;
    await prompt(b);
    const clear = await prompt(b);
    expect(clear?.message?.content).toContain("inbox is now empty");
    commit(b, clear);
    expect((await prompt(b))?.message).toBeUndefined();
  } finally { await b.event("session_shutdown"); }
  // Removing the session inbox address is authoritative, unlike a failed read.
  delete process.env.KATA_INBOX_USER;
  const c = host({ sid: a.sid, entries: structuredClone(entries) });
  await c.event("session_start");
  try { expect((await prompt(c))?.message?.content).toContain("inbox is now empty"); }
  finally { await c.event("session_shutdown"); delete process.env.KATA_OMP_LIVE_INBOX; }
});

test("compaction retaining a prior message still clears the inbox and plan", async () => {
  process.env.KATA_INBOX_USER = "v2-builder/retained95";
  process.env.KATA_OMP_LIVE_INBOX = "0";
  const app = host(); await app.event("session_start"); await app.contractReady;
  try {
    await app.init(["Retained plan item", "Verify retained item"]);
    const a = await issue("request A"), b = await issue("request B");
    await kata(["notify", a, "--to", "v2-builder/retained95", "--message", "request-a", "--json"]);
    await kata(["notify", b, "--to", "v2-builder/retained95", "--message", "request-b", "--json"]);
    await prompt(app); const first = await prompt(app);
    expect(first.message.content).toContain("request-a"); expect(first.message.content).toContain("request-b"); commit(app, first);
    await kata(["notify", a, "--to", "v2-builder/retained95", "--clear", "--json"]);
    await prompt(app); const second = await prompt(app);
    expect(second.message.content).not.toContain("request-a"); expect(second.message.content).toContain("request-b"); commit(app, second);
    app.ctx.sessionManager.getBranch().at(-1).id = "retained";
    await kata(["notify", b, "--to", "v2-builder/retained95", "--clear", "--json"]);
    await app.backend("native");
    await prompt(app); await prompt(app);
    // omp can retain this message in model context across compaction.
    app.ctx.sessionManager.getBranch().push({ type: "compaction", firstKeptEntryId: "retained" });
    const after = await prompt(app);
    expect(after?.message?.content).toContain("inbox is now empty");
    expect(after?.message?.content).toContain("plan has been cleared");
  } finally { await app.event("session_shutdown"); }
});

for (const boundary of ["compaction", "reset_boundary"]) test(`a plan update after ${boundary} preserves an inbox whose read is pending`, async () => {
  process.env.KATA_INBOX_USER = "v2-builder/compact-pending";
  process.env.KATA_OMP_LIVE_INBOX = "0";
  const a = host(); await a.event("session_start"); await a.contractReady;
  await a.init(["Pending inbox plan", "Verify pending inbox"]);
  const ref = await issue("pending inbox");
  await kata(["notify", ref, "--to", "v2-builder/compact-pending", "--message", "pending request", "--json"]);
  await prompt(a); const prior = await prompt(a); commit(a, prior);
  const branch = a.ctx.sessionManager.getBranch();
  branch.at(-1).id = "retained-pending";
  branch.push({ type: boundary, ...(boundary === "compaction" ? { firstKeptEntryId: "retained-pending" } : {}) });
  const entries = structuredClone(branch);
  await a.event("session_shutdown");
  const held = holdKata(args => args[0] === "inbox");
  const b = host({ sid: a.sid, entries, before: held.before });
  await b.event("session_start");
  try {
    await held.entered;
    await b.backend("native");
    const update = await prompt(b);
    expect(update.message.content).toContain("pending request");
    expect(update.message.content).toContain("plan has been cleared");
    expect(update.message.content).not.toContain("inbox is now empty");
    commit(b, update);
    await kata(["notify", ref, "--to", "v2-builder/compact-pending", "--clear", "--json"]);
    held.release();
    await eventually(async () => (await prompt(b))?.message?.content?.includes("inbox is now empty") ?? false, true);
  } finally { held.release(); await b.event("session_shutdown"); }
});

test("clearing context replays the plan and inbox once across either boundary order", async () => {
  process.env.KATA_INBOX_USER = "v2-builder/r4-reset";
  process.env.KATA_OMP_LIVE_INBOX = "0";
  const app = host(); await app.event("session_start"); await app.contractReady;
  try {
    await app.init(["keep first", "keep second", "keep third"]);
    const a = await issue("reset A"), b = await issue("reset B");
    await kata(["notify", a, "--to", "v2-builder/r4-reset", "--message", "reset request A", "--json"]);
    await kata(["notify", b, "--to", "v2-builder/r4-reset", "--message", "reset request B", "--json"]);
    await prompt(app); const before = await prompt(app);
    expect(before.message.content).toContain("Current plan");
    expect(before.message.content).toContain("reset request A"); expect(before.message.content).toContain("reset request B");
    commit(app, before);
    const branch = app.ctx.sessionManager.getBranch();
    for (const boundaries of [["reset_boundary"], ["compaction", "reset_boundary"], ["reset_boundary", "compaction"]]) {
      branch.at(-1).id = "kept-before-boundary";
      for (const type of boundaries) branch.push({ type, ...(type === "compaction" ? { firstKeptEntryId: "kept-before-boundary" } : {}) });
      await app.event("session_clear");
      const after = await prompt(app);
      expect(after.message?.content).toContain("Current plan");
      expect(after.message?.content).toContain("reset request A"); expect(after.message?.content).toContain("reset request B");
      commit(app, after);
      expect((await prompt(app)).message).toBeUndefined();
    }
  } finally { await app.event("session_shutdown"); }
});
