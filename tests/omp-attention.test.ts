import { afterEach, beforeAll, expect, jest, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { realKata } from "./kata-fixture";
import { ompHost } from "./omp-host";
const { binary, scratch, cwd, env, run, text, kata } = realKata({ prefix: "omp-attention", author: "v2-builder", project: "omptest", adopt: true });
mkdirSync(path.join(cwd, "sub"));
const issue = async () => {
  const ref = `omptest#${(await kata(["create", "OMP attention lead", "--force-new", "--json"])).issue.short_id}`;
  await text(["claim", ref]); return ref;
};
let sequence = 0;
const apps: ReturnType<typeof ompHost>[] = [];
function host(before?: Parameters<typeof ompHost>[0]["before"], dir = cwd) {
  const app = ompHost({ cwd: dir, sid: `attention-${++sequence}`, before, run: (args, opts) => run(args, opts.cwd, opts.timeout) });
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

function heldBind() {
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  const app = host(async args => { if (args[0] === "show") { entered.resolve(); await resume.promise; } });
  return { app, entered, resume };
}

test("shutdown queued during startup ends the pending baseline and releases its marker", async () => {
  process.env.KATA_REF = await issue();
  const { app, entered, resume } = heldBind();
  const start = app.event("session_start"); await entered.promise;
  const stop = app.event("session_shutdown"); resume.resolve(); await Promise.all([start, stop]);
  expect(app.calls.filter(a => a[1] === "attention-native").map(a => a[3])).toEqual(["start", "end"]);
  expect(process.env.KATA_ATTENTION_HOST).toBeUndefined();
});

test("switch selects the previous baseline after pending startup", async () => {
  process.env.KATA_REF = await issue();
  const { app, entered, resume } = heldBind();
  const start = app.event("session_start"); await entered.promise;
  const next = { ...app.ctx, sessionManager: { ...app.ctx.sessionManager, getSessionId: () => "attention-switched" } };
  const switching = app.event("session_switch", {}, next); resume.resolve(); await Promise.all([start, switching]);
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
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  const app = host(async args => { if (args[0] === "list") { entered.resolve(); await resume.promise; } });
  const start = app.event("session_start");
  try {
    await entered.promise;
    expect(await Promise.race([start.then(() => true), new Promise(r => setTimeout(() => r(false), 1000))])).toBe(true);
    expect(app.calls.some(a => a[0] === "daemon" && a[1] === "locate")).toBe(false);
    expect(process.env.KATA_ATTENTION_HOST).toBeUndefined();
  } finally { resume.resolve(); await start; }
});

test("a hung attention start holds explicit-ref startup for the attention bound only", async () => {
  process.env.KATA_REF = await issue();
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  const app = host(async args => { if (args[1] === "attention-native" && args[3] === "start") { entered.resolve(); await resume.promise; } });
  jest.useFakeTimers();
  let returned = false;
  const start = app.event("session_start").then(() => { returned = true; });
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  try {
    await entered.promise;
    jest.advanceTimersByTime(9_999); await settle();
    expect(returned).toBe(false);
    jest.advanceTimersByTime(1); await settle();
    expect(returned).toBe(true);
    expect(process.env.KATA_ATTENTION_HOST).toBeUndefined();
  } finally { jest.useRealTimers(); resume.resolve(); await start; }
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
