import { afterEach, beforeAll, expect, jest, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { eventually, finishes, holdKata, memoryDelegateStore, realKata, unique } from "./kata-fixture";
import { ompHost } from "./omp-host";
import { nodePlatform, spawnDetached } from "../core/node-host";
import { createKataCore } from "../core/kata-core";
const store = realKata({ prefix: "omp-attention", author: "v2-builder", project: "omptest", adopt: true });
const { binary, scratch, cwd, env, run, text, kata } = store;
mkdirSync(path.join(cwd, "sub"));
const issue = async () => {
  const ref = `omptest#${await store.issue("OMP attention lead")}`;
  await text(["claim", ref]); return ref;
};
const apps: ReturnType<typeof ompHost>[] = [];
function host(before?: Parameters<typeof ompHost>[0]["before"], dir = cwd) {
  const app = ompHost({ cwd: dir, sid: `attention-${unique()}`, before, run: (args, opts) => run(args, opts.cwd, opts.timeout, opts.env) });
  apps.push(app); return app;
}
beforeAll(async () => { await text(["agent-hook", "install", "pi", "--scope", "project", "--executable", binary]); });
afterEach(async () => { for (const app of apps.splice(0)) await app.event("session_shutdown"); });

// Removing the producer, or restoring the foreground startup race, fails this assertion at handler return.
test("OMP publishes the native marker before session_start returns", async () => {
  const ref = await issue(); process.env.KATA_REF = ref;
  const app = host(async args => { if (args[1] === "attention-native" && args[3] === "start") await new Promise(r => setTimeout(r, 400)); }); await app.event("session_start");
  const route = await kata(["daemon", "locate", "--json"]);
  expect(process.env.KATA_ATTENTION_HOST).toBeDefined();
  expect(JSON.parse(process.env.KATA_ATTENTION_HOST!)).toEqual({ pid: process.pid, identity: JSON.stringify({ ref, daemon: route.request_base_url || route.address, cwd }) });
  await app.event("session_shutdown"); expect(process.env.KATA_ATTENTION_HOST).toBeUndefined();
});

// The same host's context under another session id, as a switch or fork delivers it; the entries (the saved plan parent) carry over.
function switched(app: ReturnType<typeof host>, id: string, parentSession?: string) {
  const sm = app.ctx.sessionManager;
  return { ...app.ctx, sessionManager: { getSessionFile: () => sm.getSessionFile(), getEntries: () => sm.getEntries(), getBranch: () => sm.getBranch(), getHeader: () => parentSession ? { parentSession } : sm.getHeader(), getSessionId: () => id } };
}

function heldBind() {
  const held = holdKata(args => args[0] === "show");
  return { app: host(held.before), held };
}

test("shutdown queued during startup ends the pending baseline and releases its marker", async () => {
  process.env.KATA_REF = await issue();
  const { app, held } = heldBind();
  const start = app.event("session_start"); await held.entered;
  const stop = app.event("session_shutdown"); held.release(); await Promise.all([start, stop]);
  expect(app.calls.filter(a => a[1] === "attention-native").map(a => a[3])).toEqual(["start", "end"]);
  expect(process.env.KATA_ATTENTION_HOST).toBeUndefined();
});

test("switch selects the previous baseline after pending startup", async () => {
  process.env.KATA_REF = await issue();
  const { app, held } = heldBind();
  const start = app.event("session_start"); await held.entered;
  const switching = app.event("session_switch", {}, switched(app, "attention-switched")); held.release(); await Promise.all([start, switching]);
  expect(app.calls.filter(a => a[1] === "attention-native").map(a => a[3])).toEqual(["start", "end", "start"]);
});

test("failed start or locate publishes no marker", async () => {
  for (const failure of ["start", "locate"]) {
    process.env.KATA_REF = await issue();
    const app = host(args => (failure === "start" ? args[1] === "attention-native" && args[3] === "start" : args[0] === "daemon" && args[1] === "locate") ? { code: 1, stdout: "", stderr: "fixture failure" } : undefined);
    await app.event("session_start"); expect(process.env.KATA_ATTENTION_HOST).toBeUndefined();
    await app.event("session_shutdown");
  }
});

test("failed end releases our marker and preserves a replacement marker", async () => {
  process.env.KATA_REF = await issue();
  const app = host(args => args[1] === "attention-native" && args[3] === "end" ? { code: 1, stdout: "", stderr: "fixture failure" } : undefined);
  await app.event("session_start"); expect(process.env.KATA_ATTENTION_HOST).toBeDefined();
  await app.event("session_shutdown"); expect(process.env.KATA_ATTENTION_HOST).toBeUndefined();
  const other = host(); await other.event("session_start"); process.env.KATA_ATTENTION_HOST = "foreign";
  await other.event("session_shutdown"); expect(process.env.KATA_ATTENTION_HOST).toBe("foreign");
});

test("no explicit ref keeps bounded startup and makes no daemon locate call", async () => {
  const held = holdKata(args => args[0] === "list");
  const app = host(held.before);
  const start = app.event("session_start");
  try {
    await held.entered;
    expect(await finishes(start, 1000)).toBe(true);
    expect(app.calls.some(a => a[0] === "daemon" && a[1] === "locate")).toBe(false);
    expect(process.env.KATA_ATTENTION_HOST).toBeUndefined();
  } finally { held.release(); await start; }
});

test("a hung attention start holds explicit-ref startup for the attention bound only", async () => {
  process.env.KATA_REF = await issue();
  const held = holdKata(args => args[1] === "attention-native" && args[3] === "start");
  const app = host(held.before);
  jest.useFakeTimers();
  let returned = false;
  const start = app.event("session_start").then(() => { returned = true; });
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  try {
    await held.entered;
    jest.advanceTimersByTime(9_999); await settle();
    expect(returned).toBe(false);
    jest.advanceTimersByTime(1); await settle();
    expect(returned).toBe(true);
    expect(process.env.KATA_ATTENTION_HOST).toBeUndefined();
  } finally { jest.useRealTimers(); held.release(); await start; }
});

// Run the real generated native consumer in another process: its live-parent check excludes its own PID.
const child = path.join(scratch, "native-child.ts");
writeFileSync(child, `import native from ${JSON.stringify(path.join(cwd, ".pi/extensions/kata.js"))};
const handlers = new Map(), calls = [];
native({on:(name, fn)=>handlers.set(name,fn),exec:async(_file,args)=>{calls.push(args);return {code:0,stdout:JSON.stringify({request_base_url:process.env.TEST_DAEMON})};}});
await handlers.get('session_start')({reason:'startup'}, {cwd:process.env.TEST_CWD,sessionManager:{getSessionId:()=> 'native-child'}});
console.log(JSON.stringify(calls));`);
async function nativeCalls(ref: string, dir: string, daemon: string) {
  const proc = Bun.spawn([process.execPath, child], { env: { ...env, KATA_REF: ref, KATA_ATTENTION_HOST: process.env.KATA_ATTENTION_HOST, TEST_CWD: dir, TEST_DAEMON: daemon }, stdout: "pipe", stderr: "pipe" });
  const output = await new Response(proc.stdout).text(); expect(await proc.exited).toBe(0);
  return JSON.parse(output) as string[][];
}
test("native child whitespace and cwd resolution match the producer identity", async () => {
  const ref = await issue();
  for (const space of ["", " ", "\t"]) for (const segment of [".", "sub/.."]) {
    // OMP binds its ref through Kata's strict CLI parser; native Pi trims its inherited ref.
    process.env.KATA_REF = ref;
    const app = host(undefined, `${cwd}/${segment}`); await app.event("session_start");
    const identity = JSON.parse(JSON.parse(process.env.KATA_ATTENTION_HOST!).identity);
    expect(identity.ref).toBe(ref);
    expect(identity.cwd).toBe(cwd);
    expect((await nativeCalls(`${space}${ref}${space}`, `${cwd}/${segment}`, identity.daemon)).some(a => a.includes("attention-native"))).toBe(false);
    await app.event("session_shutdown");
  }
  process.env.KATA_REF = ref;
  const app = host(); await app.event("session_start");
  const { daemon } = JSON.parse(JSON.parse(process.env.KATA_ATTENTION_HOST!).identity);
  for (const [r, dir, d] of [[`${ref}other`, cwd, daemon], [ref, path.join(cwd, "sub"), daemon], [ref, cwd, "http://other.invalid"]]) {
    expect((await nativeCalls(r, dir, d)).some(a => a.includes("attention-native") && a.includes("start"))).toBe(true);
  }
});

// A ticket the lead claims or names mid-session (no KATA_REF): attention starts for it and ends with the session.
const meta = async (ref: string) => (await kata(["show", ref, "--json"])).issue;
const attention = async (ref: string) => { const m = (await meta(ref)).metadata ?? {}; return { state: m["work.attention"], session: m["work.attention_session"], message: m["work.attention_msg"] }; };
const fresh = async () => `omptest#${await store.issue("OMP mid-session attention")}`;
const claimed = async (app: ReturnType<typeof host>, ref: string, waitForAttention = true) => {
  await text(["claim", ref]);
  await app.event("tool_result", { toolName: "bash", input: { command: `kata claim ${ref}`, cwd }, isError: false });
  // The tool-result handler can return while its serialized adoption is still running.
  if (waitForAttention) await eventually(async () => (await attention(ref)).state, "ok");
};

test("a ticket the lead claims mid-session gets attention, and shutdown leaves it for a human", async () => {
  delete process.env.KATA_REF;
  const ref = await fresh(); const app = host(); await app.event("session_start");
  await claimed(app, ref);
  const live = await attention(ref);
  expect(live.state).toBe("ok"); expect(live.session).toBeTruthy();
  await app.event("session_shutdown");
  expect(await attention(ref)).toMatchObject({ state: "needs-human", message: "session ended without hand-off" });
});

test("/todo ref starts attention for the issue it pins", async () => {
  delete process.env.KATA_REF;
  const ref = await fresh(); await text(["claim", ref]);
  const app = host(); await app.event("session_start");
  await app.event("input", { text: `/todo ref ${ref}`, source: "interactive" });
  expect((await attention(ref)).state).toBe("ok");
  await app.event("session_shutdown");
  expect((await attention(ref)).state).toBe("needs-human");
});

test("a claimed ticket closed before shutdown stays closed and is not flagged", async () => {
  delete process.env.KATA_REF;
  const ref = await fresh(); const app = host(); await app.event("session_start");
  await claimed(app, ref);
  await text(["close", ref, "--done", "--message", "Finished the work before the session ended.", "--commit", "deadbeef"]);
  await app.event("session_shutdown");
  expect((await meta(ref)).status).toBe("closed");
  expect((await attention(ref)).state).not.toBe("needs-human");
});

test("a ticket already flagged needs-human keeps its flag when the lead claims it", async () => {
  delete process.env.KATA_REF;
  const ref = await fresh(); await text(["meta", "set", ref, "work.attention", "needs-human"]);
  const app = host(); await app.event("session_start");
  await claimed(app, ref, false);
  expect(app.calls.some(a => a[1] === "attention-native")).toBe(false);
  expect(await attention(ref)).toMatchObject({ state: "needs-human", session: undefined });
  const stuck = await fresh(); await text(["meta", "set", stuck, "work.attention", "stuck"]);
  await claimed(app, stuck, false);
  expect(app.calls.some(a => a[1] === "attention-native")).toBe(false);
  expect(await attention(stuck)).toMatchObject({ state: "stuck", session: undefined });
});

test("a needs-human a person sets on the attended ticket survives a fork", async () => {
  delete process.env.KATA_REF;
  const ref = await fresh(); const app = host(); await app.event("session_start");
  await claimed(app, ref);
  await text(["meta", "set", ref, "work.attention", "needs-human"]);
  const starts = () => app.calls.filter(a => a[1] === "attention-native" && a[3] === "start").length;
  const before = starts();
  await app.event("session_switch", { reason: "fork" }, switched(app, "attention-person-fork", app.sid));
  expect(starts()).toBe(before);
  expect((await attention(ref)).state).toBe("needs-human");
});

test("a fork whose start fails leaves the ticket ok, and the next claim takes it over", async () => {
  delete process.env.KATA_REF;
  let failing = false;
  const ref = await fresh();
  const app = host(args => failing && args[1] === "attention-native" && args[3] === "start" ? { code: 1, stdout: "", stderr: "fixture failure" } : undefined);
  await app.event("session_start");
  await claimed(app, ref);
  const first = (await attention(ref)).session;
  failing = true;
  await app.event("session_switch", { reason: "fork" }, switched(app, "attention-fail-fork", app.sid));
  expect(await attention(ref)).toMatchObject({ state: "ok", session: first });
  failing = false;
  await claimed(app, ref);
  await eventually(async () => { const value = await attention(ref); return value.state === "ok" && !!value.session && value.session !== first; }, true);
  const taken = await attention(ref);
  expect(taken.state).toBe("ok"); expect(taken.session).not.toBe(first);
  await app.event("session_shutdown");
  expect((await attention(ref)).state).toBe("needs-human");
});

test("a session switch ends the refs the old session started attention for", async () => {
  delete process.env.KATA_REF;
  const ref = await fresh(); const app = host(); await app.event("session_start");
  await claimed(app, ref);
  expect((await attention(ref)).state).toBe("ok");
  await app.event("session_switch", {}, switched(app, "attention-late-switched"));
  expect((await attention(ref)).state).toBe("needs-human");
});

test("a fork whose plan parent is the claimed ticket keeps it ok under the new session", async () => {
  delete process.env.KATA_REF;
  const ref = await fresh(); const app = host(); await app.event("session_start");
  await claimed(app, ref);
  const before = (await attention(ref)).session;
  await app.event("session_switch", { reason: "fork" }, switched(app, "attention-fork", app.sid));
  await eventually(async () => { const value = await attention(ref); return value.state === "ok" && !!value.session && value.session !== before; }, true);
  const after = await attention(ref);
  expect(after.state).toBe("ok"); expect(after.session).toBeTruthy(); expect(after.session).not.toBe(before);
  await app.event("session_shutdown");
  expect((await attention(ref)).state).toBe("needs-human");
});

test("a ticket Kata flagged when its session ended stays needs-human when the lead claims it in a new session", async () => {
  delete process.env.KATA_REF;
  const ref = await fresh(); const first = host(); await first.event("session_start");
  await claimed(first, ref); await first.event("session_shutdown");
  const second = host(); await second.event("session_start");
  await second.event("tool_result", { toolName: "bash", input: { command: `kata claim ${ref.split("#")[1]}`, cwd }, isError: false });
  expect(second.calls.some(a => a[1] === "attention-native")).toBe(false);
  expect(await attention(ref)).toMatchObject({ state: "needs-human", message: "session ended without hand-off" });
});

test("kata meta set work.attention ok clears a needs-human flag and starts attention", async () => {
  delete process.env.KATA_REF;
  const ref = await fresh(); await text(["claim", ref]); await text(["meta", "set", ref, "work.attention", "needs-human"]);
  const app = host(); await app.event("session_start");
  await app.event("tool_result", { toolName: "bash", input: { command: `kata claim ${ref}`, cwd }, isError: false });
  expect((await attention(ref)).state).toBe("needs-human");
  await text(["meta", "set", ref, "work.attention", "ok"]);
  await app.event("tool_result", { toolName: "bash", input: { command: `kata meta set ${ref} work.attention ok`, cwd }, isError: false });
  await eventually(async () => !!(await attention(ref)).session, true);
  const live = await attention(ref);
  expect(live.state).toBe("ok"); expect(live.session).toBeTruthy();
  await app.event("session_shutdown");
  expect((await attention(ref)).state).toBe("needs-human");
});

test("two claimed tickets keep attention until shutdown, then both are flagged", async () => {
  delete process.env.KATA_REF;
  const [one, two] = [await fresh(), await fresh()]; const app = host(); await app.event("session_start");
  await claimed(app, one); await claimed(app, two);
  expect((await attention(one)).state).toBe("ok"); expect((await attention(two)).state).toBe("ok");
  await app.event("session_shutdown");
  expect((await attention(one)).state).toBe("needs-human"); expect((await attention(two)).state).toBe("needs-human");
});

test("a start that failed is retried by the next claim", async () => {
  delete process.env.KATA_REF;
  const ref = await fresh(); let failed = false;
  const app = host(args => {
    if (args[1] !== "attention-native" || args[3] !== "start" || failed) return;
    failed = true;
    return { code: 1, stdout: "", stderr: "fixture failure" };
  });
  await app.event("session_start");
  await claimed(app, ref, false);
  await eventually(async () => failed, true);
  expect((await attention(ref)).state).toBeUndefined();
  await claimed(app, ref);
  expect((await attention(ref)).state).toBe("ok");
});

test("shutdown ends every claimed ticket together", async () => {
  delete process.env.KATA_REF;
  let running = 0, most = 0;
  const app = host(async args => {
    if (args[1] !== "attention-native" || args[3] !== "end") return;
    most = Math.max(most, ++running); await new Promise(r => setTimeout(r, 150)); running--;
  });
  await app.event("session_start");
  for (const ref of [await fresh(), await fresh()]) await claimed(app, ref);
  await app.event("session_shutdown");
  expect(most).toBe(2);
});

// The fork's start fails either at the hook or, earlier, when its ownership read of the parent (the fork session's actor lookup) throws.
for (const [how, make] of [["start fails", () => (args: string[]) => args[1] === "attention-native" && args[3] === "start"], ["ownership read fails", () => (args: string[]) => args[0] === "status"]] as const) {
  test(`a fork whose ${how} and never claims again still has the ticket flagged when it ends`, async () => {
    delete process.env.KATA_REF;
    let failing = false; const fails = make(); const ref = await fresh();
    const app = host(args => failing && fails(args) ? { code: 1, stdout: "", stderr: "fixture failure" } : undefined);
    await app.event("session_start"); await claimed(app, ref);
    const first = (await attention(ref)).session;
    failing = true;
    await app.event("session_switch", { reason: "fork" }, switched(app, "attention-fork-never", app.sid));
    expect(await attention(ref)).toMatchObject({ state: "ok", session: first });
    await app.event("session_shutdown");
    expect((await attention(ref)).state).toBe("needs-human");
  });
}

test("switching back after a fork whose start failed keeps the ticket ok", async () => {
  delete process.env.KATA_REF;
  let failing = false; const ref = await fresh();
  const app = host(args => failing && args[1] === "attention-native" && args[3] === "start" ? { code: 1, stdout: "", stderr: "fixture failure" } : undefined);
  await app.event("session_start"); await claimed(app, ref);
  const first = (await attention(ref)).session;
  failing = true;
  await app.event("session_switch", { reason: "fork" }, switched(app, "attention-fork-back", app.sid));
  failing = false;
  await app.event("session_switch", {}, switched(app, app.sid!));
  expect(await attention(ref)).toMatchObject({ state: "ok", session: first });
  await app.event("session_shutdown");
  expect((await attention(ref)).state).toBe("needs-human");
});

test("two failed fork starts in a row still leave the ticket flagged when the last fork ends", async () => {
  delete process.env.KATA_REF;
  let failing = false; const ref = await fresh();
  const app = host(args => failing && args[1] === "attention-native" && args[3] === "start" ? { code: 1, stdout: "", stderr: "fixture failure" } : undefined);
  await app.event("session_start"); await claimed(app, ref);
  failing = true;
  await app.event("session_switch", { reason: "fork" }, switched(app, "attention-fork-one", app.sid!));
  await app.event("session_switch", { reason: "fork" }, switched(app, "attention-fork-two", "attention-fork-one"));
  expect((await attention(ref)).state).toBe("ok");
  await app.event("session_shutdown");
  expect((await attention(ref)).state).toBe("needs-human");
});

test("shutdown ends attention before blocked work exceeds the OMP deadline", async () => {
  process.env.KATA_REF = await issue();
  let block = false;
  const held = holdKata(args => block && args[0] === "show");
  const app = host(held.before);
  await app.event("session_start");
  block = true;
  const stop = app.event("session_shutdown");
  try {
    await held.entered;
    await new Promise(r => setTimeout(r, 2100));
    expect((await attention(process.env.KATA_REF!)).state).toBe("needs-human");
    expect(process.env.KATA_ATTENTION_HOST).toBeUndefined();
  } finally { held.release(); await stop; }
}, 15000);

test("shutdown ends attention before settling a missed delegate exit", async () => {
  const ref = await issue(); process.env.KATA_REF = ref;
  let recent: any[] = [], slow = false;
  const held = holdKata(args => slow && ["show", "label", "comment", "close"].includes(args[0]));
  const app = ompHost({ cwd, sid: `missed-exit-${unique()}`, snapshot: () => ({ running: [], recent }), before: held.before, run: (args, opts) => run(args, opts.cwd, opts.timeout, opts.env) });
  apps.push(app);
  await app.event("session_start");
  const parent = await app.init(["Implement the widget", "Verify the widget"]);
  const id = `child-${unique()}`, sessionFile = `${scratch}/${id}.jsonl`;
  app.emit("task:subagent:lifecycle", { id, agent: "task", status: "started", sessionFile, description: "Implement the widget" });
  await app.call({ op: "view" });
  const child = ompHost({ cwd, sid: `sub-${unique()}`, sessionFile, agent: { kind: "sub", id, parentId: app.ctx.agent.id }, run: (args, opts) => run(args, opts.cwd, opts.timeout, opts.env) });
  await child.event("tool_call", { toolName: "read", input: { path: "README.md" } });
  const task = (await kata(["show", parent, "--json"])).children.find((c: any) => c.title === "Implement the widget");
  expect(task).toBeDefined();
  await eventually(async () => app.entries.some(e => e.data?.delegates?.some((d: any) => d.id === id && d.state === "assigned")), true);
  recent = [{ id, type: "task", status: "completed" }]; slow = true;
  const stop = app.event("session_shutdown");
  try {
    await held.entered;
    await new Promise(r => setTimeout(r, 2100));
    expect(app.calls.some(a => a[1] === "attention-native" && a[3] === "end" && a.includes(ref))).toBe(true);
    expect(process.env.KATA_ATTENTION_HOST).toBeUndefined();
    expect((await attention(ref)).state).toBe("needs-human");
  } finally { held.release(); await stop; }
  await eventually(async () => (await kata(["show", `omptest#${task.short_id}`, "--json"])).labels.some((l: any) => l.label === "needs-review"), true);
}, 15000);


test("core shutdown uses the detached production spawn after its host dies", async () => {
  const ref = await issue(); process.env.KATA_REF = ref;
  const processHost = Bun.spawn(["/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  const session = `dead-host-${unique()}`, entries: any[] = [];
  const ctx = (id: string) => ({ cwd, sessionManager: { getSessionId: () => id, getBranch: () => entries } });
  const hooks: { mode: string; launcher?: string }[] = [];
  const core = createKataCore({
    platform: { ...nodePlatform, pid: processHost.pid },
    exec: (_file, args, opts) => {
      if (args[1] === "attention-native") hooks.push({ mode: args[3], launcher: opts.env?.KATA_SESSION_ID });
      return run(args, opts.cwd, opts.timeout, opts.env);
    },
    detached: spawnDetached,
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    delegateStore: memoryDelegateStore(),
  }, { namespace: "omp", executable: binary, executableVars: [], attentionHarness: "pi" });
  try {
    await core.session.start(ctx(session));
    const first = await attention(ref);
    expect(first.state).toBe("ok");
    await core.session.start(ctx(`${session}-switch`));
    const before = await attention(ref);
    expect(before.state).toBe("ok"); expect(before.session).not.toBe(first.session);
    expect(hooks.map(hook => hook.mode)).toEqual(["start", "end", "start"]);
    expect(new Set(hooks.map(hook => hook.launcher)).size).toBe(1);
    expect(hooks[0].launcher).toBe(`omp-${processHost.pid}-${performance.timeOrigin}`);
    // Adopt two more tickets in the switched session, then end all three through the real detached transport.
    delete process.env.KATA_REF;
    const attended = [await fresh(), await fresh()];
    for (const ticket of attended) {
      await text(["claim", ticket]);
      await core.tools.result(ctx(`${session}-switch`), { toolName: "bash", input: { command: `kata claim ${ticket}`, cwd }, isError: false });
      await eventually(async () => (await attention(ticket)).state, "ok");
    }
    processHost.kill(); await processHost.exited;
    await core.session.shutdown(ctx(`${session}-switch`));
    await eventually(async () => (await attention(ref)).state, "needs-human");
    expect((await attention(ref)).session).toBe(`ended:${before.session}`);
    for (const ticket of attended) await eventually(async () => (await attention(ticket)).state, "needs-human");
  } finally { processHost.kill(); await processHost.exited; }
});

test("attention uses one launcher across session switches", async () => {
  process.env.KATA_REF = await issue();
  const launches: { mode: string; session: string; launcher?: string }[] = [];
  const app = host((args, opts) => {
    if (args[1] === "attention-native") launches.push({ mode: args[3], session: args[5], launcher: opts.env?.KATA_SESSION_ID });
  });
  await app.event("session_start");
  await app.event("session_switch", {}, switched(app, "other-session"));
  await app.event("session_shutdown");
  expect(launches.map(x => x.mode)).toEqual(["start", "end", "start", "end"]);
  expect(new Set(launches.map(x => x.launcher)).size).toBe(1);
  expect(launches[0].launcher).toBe(`omp-${process.pid}-${performance.timeOrigin}`);
  expect(launches.map(x => x.session)).toEqual([app.sid!, app.sid!, "other-session", "other-session"]);
});

test("shutdown spawns attention end before a slow parent-close sweep", async () => {
  delete process.env.KATA_REF;
  let slow = false;
  const held = holdKata(args => slow && args[0] === "close");
  const app = host(held.before);
  await app.event("session_start");
  await app.init(["Complete the parent task"]);
  const ref = await fresh(); await claimed(app, ref);
  await app.done("Complete the parent task");
  slow = true;
  const stop = app.event("session_shutdown");
  try {
    await held.entered;
    await new Promise(r => setTimeout(r, 2100));
    expect((await attention(ref)).state).toBe("needs-human");
  } finally { held.release(); await stop; }
}, 15000);

test("shutdown waits for an in-flight attention start before ending it", async () => {
  process.env.KATA_REF = await issue();
  const ref = process.env.KATA_REF;
  const held = holdKata(args => args[1] === "attention-native" && args[3] === "start");
  const app = host(held.before);
  const start = app.event("session_start");
  await held.entered;
  const stop = app.event("session_shutdown");
  try {
    await new Promise(r => setTimeout(r, 200));
    held.release();
    await Promise.all([start, stop]);
    await eventually(async () => (await attention(ref)).state, "needs-human");
  } finally { held.release(); await Promise.all([start, stop]); }
});

test("reused host pid and session in a new process cannot be ended by the old launcher", async () => {
  const ref = await issue(), session = `generation-${unique()}`, pid = 424242;
  const child = path.join(scratch, `generation-${unique()}.ts`);
  writeFileSync(child, `import { createKataCore } from ${JSON.stringify(path.resolve("core/kata-core.ts"))};
import { nodePlatform, execKata } from ${JSON.stringify(path.resolve("core/node-host.ts"))};
const entries = [], ctx = { cwd: process.env.TEST_CWD, sessionManager: { getSessionId: () => process.env.TEST_SESSION, getBranch: () => entries } };
const core = createKataCore({ platform: { ...nodePlatform, pid: Number(process.env.TEST_HOST_PID) },
  exec: (file, args, opts) => { if (args[1] === 'attention-native') console.log(opts.env.KATA_SESSION_ID); return execKata(file, args, opts); },
  appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
  delegateStore: { of: () => undefined, records: () => [], get: () => undefined, put: () => {} } },
  { namespace: 'omp', executable: process.env.TEST_BINARY, executableVars: [], attentionHarness: 'pi' });
await core.session.start(ctx);`);
  const launch = async () => {
    const proc = Bun.spawn([process.execPath, child], { env: { ...env, KATA_REF: ref, TEST_CWD: cwd, TEST_SESSION: session, TEST_HOST_PID: String(pid), TEST_BINARY: binary }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, status] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
    const launcher = stdout.trim(); expect(launcher).toContain(`omp-${pid}-`);
    return launcher;
  };
  const first = await launch();
  const firstOwner = (await attention(ref)).session;
  const second = await launch();
  const secondOwner = (await attention(ref)).session;
  expect(second).not.toBe(first); expect(secondOwner).not.toBe(firstOwner);
  const end = ["agent-hook", "attention-native", "pi", "end", "--session", session, "--host-pid", String(pid), "--ref", ref];
  await text(end, cwd, { KATA_SESSION_ID: first });
  expect(await attention(ref)).toMatchObject({ state: "ok", session: secondOwner });
  await text(end, cwd, { KATA_SESSION_ID: second });
});
