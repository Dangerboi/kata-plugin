import { afterEach, expect, test } from "bun:test";
import { realKata, until } from "./kata-fixture";
import { ompHost, setPluginSettings } from "./omp-host";

const store = realKata({ prefix: "review97", author: "v2-builder", project: "omp-v2-live", adopt: true });
const apps: ReturnType<typeof ompHost>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.event("session_shutdown"); setPluginSettings(() => ({})); delete process.env.KATA_INBOX_USER; });

for (const [initial, next] of [[false, true], [true, false]] as const) test(`branch applies liveInbox ${initial} -> ${next}`, async () => {
  let liveInbox = initial;
  let reads = 0;
  setPluginSettings(() => { reads++; return { defaultProject: "", liveInbox, refGuard: "off" }; });
  process.env.KATA_INBOX_USER = `v2-builder/branch-${initial}`;
  const sent: string[] = [];
  const app = ompHost({ cwd: store.cwd, sid: `branch-${initial}`, run: (args, opts) => store.run(args, opts.cwd, opts.timeout), sendUserMessage: (text) => { sent.push(text); } });
  apps.push(app);
  await app.event("session_start");
  if (initial) expect(await until(() => app.calls.some(a => a[0] === "inbox"))).toBe(true);
  const refs = await Promise.all([store.issue("Branch selected"), store.issue("Branch other 1"), store.issue("Branch other 2")]);
  if (!initial) await store.kata(["notify", refs[1], "--to", process.env.KATA_INBOX_USER!, "--message", "already-present", "--json"]);
  liveInbox = next;
  app.ctx.sessionManager.switchTo(`branch-new-${initial}`, {});
  const started = performance.now();
  await app.event("session_branch");
  console.log(`branch ${initial}->${next} elapsed ${(performance.now()-started).toFixed(1)}ms; settings reads ${reads}; unselected issues: ${refs.length-1}`);
  await store.kata(["notify", refs[0], "--to", process.env.KATA_INBOX_USER!, "--message", "branch-message", "--json"]);
  const delivered = await until(() => sent.some(text => text.includes("branch-message")));
  expect(delivered).toBe(next);
  if (next) expect(sent.some(text => text.includes("already-present"))).toBe(false);
  else {
    const section = ((await app.event("before_agent_start", { systemPrompt: ["base"] }))?.systemPrompt ?? []).join("\n");
    expect(section).toContain("branch-message");
  }
});


test("an unchanged live setting keeps the existing follower on branch", async () => {
  setPluginSettings(() => ({ liveInbox: true }));
  process.env.KATA_INBOX_USER = "v2-builder/branch-unchanged";
  const app = ompHost({ cwd: store.cwd, sid: "branch-unchanged", run: (args, opts) => store.run(args, opts.cwd, opts.timeout), sendUserMessage: () => {} });
  apps.push(app);
  const children = () => Bun.spawnSync(["pgrep", "-f", `events --tail --json --workspace ${store.cwd}`]).stdout.toString().trim().split("\n").filter(Boolean);
  await app.event("session_start");
  expect(await until(() => children().length === 1)).toBe(true);
  const first = children()[0];
  app.ctx.sessionManager.switchTo("branch-same", {});
  await app.event("session_branch", { reason: "btw" });
  expect(children()).toEqual([first]);
});
