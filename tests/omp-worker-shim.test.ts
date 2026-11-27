import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { v2Fixture } from "./v2-fixture";

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
