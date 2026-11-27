import { afterEach, expect, test } from "bun:test";
import { fakeHost, memoryDelegateStore, realKata, until } from "./kata-fixture";
import { createKataCore } from "../core/kata-core";
import { nodePlatform } from "../core/node-host";
import { ompHost, setPluginSettings } from "./omp-host";

const store = realKata({ prefix: "omp-settings-branch", author: "v2-builder", project: "omp-v2-live", adopt: true });
const apps: ReturnType<typeof ompHost>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.event("session_shutdown"); setPluginSettings(() => ({})); delete process.env.KATA_INBOX_USER; });

for (const [initial, next] of [[false, true], [true, false]] as const) test(`branch applies liveInbox ${initial} -> ${next}`, async () => {
  let liveInbox = initial;
  setPluginSettings(() => ({ defaultProject: "", liveInbox, refGuard: "off" }));
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
  await app.event("session_branch");
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
  process.env.KATA_INBOX_USER = "v2-builder/branch-unchanged";
  const host = fakeHost({ cwd: store.cwd, sid: "branch-unchanged", run: (args, opts) => store.run(args, opts.cwd, opts.timeout) });
  let spawns = 0, killed = 0, finish!: () => void;
  const exited = new Promise<void>(resolve => { finish = resolve; });
  const core = createKataCore({
    platform: nodePlatform,
    appendEntry: host.api.appendEntry,
    exec: host.api.exec,
    delegateStore: memoryDelegateStore(),
    liveInbox: {
      spawn: () => { spawns++; return { lines: (async function* () { await exited; })(), exited, kill: () => { killed++; finish(); } }; },
      deliver: () => {},
    },
  }, { namespace: "omp", executable: store.binary, executableVars: ["KATA_OMP_EXECUTABLE"] });
  try {
    await core.session.start(host.ctx);
    expect(await until(() => spawns === 1)).toBe(true);
    await core.session.branch(host.ctx);
    expect(spawns).toBe(1);
    expect(killed).toBe(0);
  } finally { await core.session.shutdown(host.ctx); }
  expect(killed).toBe(1);
});
