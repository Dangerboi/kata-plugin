import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { realKata } from "./kata-fixture";
import { ompHost } from "./omp-host";

const { cwd, run } = realKata({ prefix: "omp-publication-latency", author: "actor-a", project: "ompshell" });

test("bash and first prompt bound a stalled actor lookup", async () => {
  for (const phase of ["bash", "prompt"] as const) {
    const gate = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
    let slow = false;
    const app = ompHost({ cwd, sid: `latency-${phase}`, run: async args => {
      if (slow && args[0] === "status") { started.resolve(); await gate.promise; }
      return run(args);
    } });
    await app.event("session_start"); await app.init(["Latency fixture"]);
    const other = join(cwd, `slow-${phase}`); mkdirSync(other); app.ctx.cwd = other; slow = true;
    const release = setTimeout(() => gate.resolve(), phase === "bash" ? 3000 : 4000);
    try {
      await app.event("session_branch");
      if (phase === "bash") {
        const begin = Date.now();
        const pending = app.event("tool_call", { toolName: "bash", input: { command: "ls" } });
        await Promise.race([started.promise, Bun.sleep(2500).then(() => { throw new Error("actor lookup did not start"); })]);
        const result = await pending;
        expect(result?.block).toBeUndefined(); expect(Date.now() - begin).toBeLessThan(2000);
      } else {
        await Promise.race([started.promise, Bun.sleep(2500).then(() => { throw new Error("actor lookup did not start"); })]);
        const begin = Date.now(); await app.event("before_agent_start", { reason: "prompt", systemPrompt: [] });
        expect(Date.now() - begin).toBeLessThan(2000);
      }
    } finally { clearTimeout(release); gate.resolve(); }
  }
}, 30000);
