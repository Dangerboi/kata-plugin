import { afterEach, expect, test } from "bun:test";
import { inboxChildren, settle, until } from "./kata-fixture";
import { piFixture } from "./pi-fixture";

const { cwd, host, issue, kata, nativeKey, globalRegistry, asChild, down } = piFixture({ adopt: true });
const apps: any[] = [];
const children = () => inboxChildren(cwd);
async function open(address: string, options: any = {}) {
  process.env.KATA_INBOX_USER = address;
  const app = await host(options); apps.push(app);
  await app.event("session_start", { reason: "startup" });
  return app;
}
afterEach(async () => {
  for (const app of apps.splice(0)) await app.event("session_shutdown", { reason: "quit" });
  expect(await until(() => children().length === 0)).toBe(true);
});

test("a trusted request wakes Pi with a custom steer message", async () => {
  const address = "pi-builder/live-main", app = await open(address);
  const ref = await issue("Live Pi request");
  expect(await until(() => children().length === 1)).toBe(true);
  await kata(["notify", ref, "--to", address, "--message", "live-ping", "--json"]);
  expect(await until(() => app.messages.length === 1)).toBe(true);
  expect(app.messages[0][0]).toMatchObject({ customType: "kata.inbox", display: true });
  expect(app.messages[0][0].content).toContain("live-ping");
  expect(app.messages[0][1]).toEqual({ triggerTurn: true, deliverAs: "steer" });
});

test("shutdown stops the follower", async () => {
  const app = await open("pi-builder/live-shutdown");
  expect(await until(() => children().length === 1)).toBe(true);
  await app.event("session_shutdown", { reason: "quit" });
  expect(await until(() => children().length === 0)).toBe(true);
});

for (const mode of ["print", "json", "rpc", "opt-out"]) test(`${mode} ${mode === "rpc" ? "starts a follower" : "keeps per-prompt reads"}`, async () => {
  if (mode === "opt-out") process.env.KATA_PI_LIVE_INBOX = "0";
  const options = mode === "opt-out" ? {} : { mode, ...(mode === "rpc" ? {} : { hasUI: false }) };
  const app = await open(`pi-builder/live-${mode}`, options);
  if (mode === "rpc") expect(await until(() => children().length === 1)).toBe(true);
  else {
    await app.event("before_agent_start", { systemPromptOptions: { sections: {} } });
    expect(await until(() => app.calls.some((a: string[]) => a[0] === "inbox"))).toBe(true);
    await settle();
    expect(children()).toHaveLength(0);
  }
});

test("a native contract active at startup prevents a follower", async () => {
  globalRegistry[nativeKey].adapters.set("native", { options: { scope: "user", contract: true } });
  await open("pi-builder/live-native-first");
  await settle();
  expect(children()).toHaveLength(0);
});

test("a child that cannot reach its parent workspace falls back to a live main session", async () => {
  asChild(JSON.stringify({ pid: process.pid, sessionId: "parent", workspace: cwd, teammate: "" }));
  let failed = false;
  await open("pi-builder/live-fallback", { before: (args: string[]) => {
    if (!failed && args[0] === "list") { failed = true; return down(); }
  } });
  expect(failed).toBe(true);
  expect(await until(() => children().length === 1)).toBe(true);
});

test("a late native adapter suppresses delivery and stops the follower at the next prompt", async () => {
  const address = "pi-builder/live-native-delivery", app = await open(address);
  expect(await until(() => children().length === 1)).toBe(true);
  const ref = await issue("Native delivery suppression");
  let checks = 0;
  globalRegistry[nativeKey].adapters.set("native", { options: { scope: "user", get contract() { checks++; return true; } } });
  await kata(["notify", ref, "--to", address, "--message", "suppressed", "--json"]);
  expect(await until(() => checks > 0)).toBe(true);
  expect(app.messages).toEqual([]);
  expect(children()).toHaveLength(1);
  await app.event("before_agent_start", { systemPromptOptions: { sections: {} } });
  expect(await until(() => children().length === 0)).toBe(true);
});
