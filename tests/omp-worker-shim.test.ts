import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BroadcastChannel } from "node:worker_threads";
import { v2Fixture } from "./v2-fixture";
import { daemonUnavailable } from "./kata-errors";

const { binary, scratch, cwd, env, host } = v2Fixture();

test("a prewarmed worker adopts the main thread's shim and its own identity", async () => {
  const app = host({ sid: "worker-shim-lead" });
  const id = "Worker.Shim", sessionFile = `${scratch}/worker-shim.jsonl`;
  writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "worker-shim-session" }) + "\n");
  const worker = new Worker(new URL("./omp-worker-delegate.ts", import.meta.url), { workerData: { binary, env, cwd, sessionFile, id, parentId: app.ctx.agent.id, identityProbe: true } } as any);
  const messages: any[] = [];
  worker.addEventListener("message", e => messages.push(e.data));
  const wait = async (predicate: () => boolean) => { for (const end = Date.now() + 15000; !predicate() && Date.now() < end;) await Bun.sleep(20); expect(predicate()).toBe(true); };
  try {
    await wait(() => messages.includes("ready"));
    await app.event("session_start");
    await app.init(["Worker shim task", "Lead task"]);
    app.emit("task:subagent:lifecycle", { id, agent: "task", status: "started", sessionFile, description: "Worker shim task" });
    worker.postMessage("go");
    await wait(() => messages.some(v => typeof v === "object" && v?.dir));
    const result = messages.find(v => typeof v === "object" && v?.dir);
    expect(result.dir).toBe(process.env.KATA_OMP_SHIM_DIR);
    expect(result.content).toContain("KATA_AUTHOR='v2-builder'");
    expect(result.content).toMatch(/KATA_INBOX_USER='v2-builder\/[^']+'/);
  } finally { worker.terminate(); }
}, 30000);

test("failed and slow worker actor reads warn and return within the budget", async () => {
  const gate = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
  let mode: "normal" | "fail" | "slow" = "normal";
  const app = host({ sid: "worker-slow-lead", before: async (args: string[]) => {
    if (args[0] !== "status") return;
    if (mode === "fail") return daemonUnavailable();
    if (mode === "slow") { started.resolve(); await gate.promise; }
  } });
  const id = "Worker.Slow", sessionFile = `${scratch}/worker-slow.jsonl`;
  writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "worker-shim-session" }) + "\n");
  const worker = new Worker(new URL("./omp-worker-delegate.ts", import.meta.url), { workerData: { binary, env, cwd, sessionFile, id, parentId: app.ctx.agent.id, identityProbe: true, repeatProbe: true } } as any);
  const channel = new BroadcastChannel("kata-plugin:omp-delegates:1");
  const replies: any[] = []; channel.onmessage = event => { if (event.data?.kind === "record") replies.push(event.data); };
  const messages: any[] = []; worker.addEventListener("message", e => messages.push(e.data));
  const wait = async (predicate: () => boolean) => { for (const end = Date.now() + 15000; !predicate() && Date.now() < end;) await Bun.sleep(20); expect(predicate()).toBe(true); };
  const completed = () => messages.filter(v => v && typeof v === "object" && "blocked" in v).length;
  let release: ReturnType<typeof setTimeout> | undefined;
  try {
    await wait(() => messages.includes("ready")); await app.event("session_start"); await app.init(["Worker slow task", "Lead task"]);
    // A registered untracked delegate uses its lead's current workspace for actor lookup.
    app.emit("task:subagent:lifecycle", { id, agent: "task", status: "started", sessionFile, description: "Untracked work" });
    worker.postMessage("go"); await wait(() => completed() === 1);
    const fresh = join(cwd, "worker-fresh"); mkdirSync(fresh); app.ctx.cwd = fresh;
    replies.length = 0; mode = "fail"; worker.postMessage("go");
    await wait(() => completed() === 2);
    expect(replies.at(-1)?.actor).toBeUndefined();
    expect(app.notices.filter((n: any) => /identity could not be published/.test(n[0])).length).toBe(1);
    replies.length = 0; mode = "slow"; worker.postMessage("go");
    await Promise.race([started.promise, Bun.sleep(7000).then(() => { throw new Error("worker actor lookup did not start"); })]);
    release = setTimeout(() => gate.resolve(), 4000);
    const begin = Date.now();
    await wait(() => replies.length > 0);
    expect(Date.now() - begin).toBeLessThan(2000);
    expect(replies[0].actor).toBeUndefined();
    expect(app.notices.filter((n: any) => /identity could not be published/.test(n[0])).length).toBe(1);
  } finally { clearTimeout(release); gate.resolve(); channel.close(); worker.terminate(); }
}, 30000);
