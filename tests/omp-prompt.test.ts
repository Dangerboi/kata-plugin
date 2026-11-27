import { expect, test } from "bun:test";
import { v2Fixture } from "./v2-fixture";

const { host, issue, kata } = v2Fixture();
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
