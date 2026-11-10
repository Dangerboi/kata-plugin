import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import fc from "fast-check";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertIsolated } from "./isolation";
import { adoptIsolatedKata, isolatedKata } from "./kata-fixture";
import { ompHost } from "./omp-host";
assertIsolated();
const binary = process.env.KATA_TEST_EXECUTABLE!;
if (!binary || !path.isAbsolute(binary)) throw new Error("Set KATA_TEST_EXECUTABLE to an absolute Kata binary.");
const scratch = mkdtempSync(path.join(process.env.KATA_TEST_ROOT!, "omp-attention-"));
const cwd = path.join(scratch, "workspace"); mkdirSync(cwd);
const env = { ...process.env, KATA_HOME: path.join(scratch, "home"), KATA_AUTHOR: "v2-builder" };
for (const key of ["KATA_SERVER", "KATA_DAEMON", "KATA_AUTH_TOKEN", "KATA_REF", "KATA_TEAMMATE", "KATA_INBOX_USER", "KATA_PI_PARENT", "KATA_ATTENTION_HOST"]) delete env[key];
const run = isolatedKata(binary, env, cwd);
async function checked(args: string[]) { const out = await run(args); if (out.code) throw new Error(out.stderr); return out.stdout; }
async function kata(args: string[]) { return JSON.parse(await checked(args)); }
const issue = async () => {
  const ref = `omptest#${(await kata(["create", "OMP attention lead", "--force-new", "--json"])).issue.short_id}`;
  await checked(["claim", ref]); return ref;
};
let restore: () => void, sequence = 0;
const apps: ReturnType<typeof ompHost>[] = [];
function host(before?: Parameters<typeof ompHost>[0]["before"], dir = cwd) {
  const app = ompHost({ cwd: dir, sid: `attention-${++sequence}`, before, run: (args, opts) => run(args, opts.cwd, opts.timeout) });
  apps.push(app); return app;
}
beforeAll(async () => {
  await checked(["init", "--project", "omptest"]);
  await checked(["agent-hook", "install", "pi", "--scope", "project", "--executable", binary]);
});
beforeEach(() => {
  restore = adoptIsolatedKata(binary, env.KATA_HOME);
  process.env.KATA_AUTHOR = "v2-builder";
  for (const key of ["KATA_REF", "KATA_TEAMMATE", "KATA_INBOX_USER", "KATA_PI_PARENT", "KATA_ATTENTION_HOST"]) delete process.env[key];
});
afterEach(async () => { for (const app of apps.splice(0)) await app.event("session_shutdown"); delete process.env.KATA_ATTENTION_HOST; restore(); });
afterAll(async () => { await run(["daemon", "stop"]); rmSync(scratch, { recursive: true, force: true }); });

// Removing the producer, or restoring the foreground startup race, fails this assertion at handler return.
test("OMP publishes the native marker before session_start returns", async () => {
  const ref = await issue(); process.env.KATA_REF = ref;
  const app = host(); await app.event("session_start");
  const route = await kata(["daemon", "locate", "--json"]);
  expect(process.env.KATA_ATTENTION_HOST).toBeDefined();
  expect(JSON.parse(process.env.KATA_ATTENTION_HOST!)).toEqual({ pid: process.pid, identity: JSON.stringify({ ref, daemon: route.request_base_url || route.address, cwd }) });
  await app.event("session_shutdown"); expect(process.env.KATA_ATTENTION_HOST).toBeUndefined();
});

test("a cold start longer than five seconds still publishes before the handler returns", async () => {
  process.env.KATA_REF = await issue();
  const app = host(async args => { if (args[1] === "attention-native" && args[3] === "start") await new Promise(r => setTimeout(r, 5100)); });
  await app.event("session_start"); expect(process.env.KATA_ATTENTION_HOST).toBeDefined();
}, 15000);

test("shutdown queued during startup ends the pending baseline and releases its marker", async () => {
  process.env.KATA_REF = await issue();
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  const app = host(async args => { if (args[1] === "attention-native" && args[3] === "start") { entered.resolve(); await resume.promise; } });
  const start = app.event("session_start"); await entered.promise;
  const stop = app.event("session_shutdown"); resume.resolve(); await Promise.all([start, stop]);
  expect(app.calls.filter(a => a[1] === "attention-native").map(a => a[3])).toEqual(["start", "end"]);
  expect(process.env.KATA_ATTENTION_HOST).toBeUndefined();
});

test("switch selects the previous baseline after pending startup", async () => {
  process.env.KATA_REF = await issue();
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  const app = host(async args => { if (args[1] === "attention-native" && args[3] === "start") { entered.resolve(); await resume.promise; } });
  const start = app.event("session_start"); await entered.promise;
  const next = { ...app.ctx, sessionManager: { ...app.ctx.sessionManager, getSessionId: () => "attention-switched" } };
  const switching = app.event("session_switch", {}, next); resume.resolve(); await Promise.all([start, switching]);
  expect(app.calls.filter(a => a[1] === "attention-native").map(a => a[3])).toEqual(["start", "end", "start"]);
});

for (const failure of ["start", "locate"]) test(`failed ${failure} publishes no marker`, async () => {
  process.env.KATA_REF = await issue();
  const app = host(args => (failure === "start" ? args[1] === "attention-native" && args[3] === "start" : args[0] === "daemon" && args[1] === "locate") ? { code: 1, stdout: "", stderr: "fixture failure" } : undefined);
  await app.event("session_start"); expect(process.env.KATA_ATTENTION_HOST).toBeUndefined();
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
test("native children skip matching OMP identity but track a different ref, cwd or daemon", async () => {
  const ref = await issue(); process.env.KATA_REF = ref;
  const app = host(); await app.event("session_start");
  const { daemon } = JSON.parse(JSON.parse(process.env.KATA_ATTENTION_HOST!).identity);
  expect((await nativeCalls(ref, cwd, daemon)).some(a => a.includes("attention-native"))).toBe(false);
  for (const [r, dir, d] of [[`${ref}other`, cwd, daemon], [ref, path.join(cwd, "sub"), daemon], [ref, cwd, "http://other.invalid"]]) {
    expect((await nativeCalls(r, dir, d)).some(a => a.includes("attention-native") && a.includes("start"))).toBe(true);
  }
});

test("producer identity conforms to native whitespace and cwd resolution", async () => {
  const ref = await issue();
  await fc.assert(fc.asyncProperty(fc.constantFrom("", " ", "\t"), fc.constantFrom(".", "sub/.."), async (space, segment) => {
    process.env.KATA_REF = `${space}${ref}${space}`;
    const app = host(undefined, path.resolve(cwd, segment)); await app.event("session_start");
    const identity = JSON.parse(JSON.parse(process.env.KATA_ATTENTION_HOST!).identity);
    expect(identity.ref).toBe(ref);
    expect((await nativeCalls(`${space}${ref}${space}`, cwd, identity.daemon)).some(a => a.includes("attention-native"))).toBe(false);
    await app.event("session_shutdown");
  }), { numRuns: 6 });
});
