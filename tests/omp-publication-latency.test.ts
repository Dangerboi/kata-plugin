import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { realKata } from "./kata-fixture";
import { ompHost } from "./omp-host";

const { cwd, run } = realKata({ prefix: "omp-publication-latency", author: "actor-a", project: "ompshell" });

test("bash and first prompt bound a stalled actor lookup", async () => {
 {
  const kind = "lead";
  const gate = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
  let slow = false;
  const app = ompHost({ cwd, sid: `latency-${kind}`, run: async args => {
    if (slow && args[0] === "status") { started.resolve(); await gate.promise; }
    return run(args);
  } });
  await app.event("session_start"); await app.init(["Latency fixture"]);
  const other = join(cwd, `slow-${kind}`); mkdirSync(other);
  const context = app.ctx;
  context.cwd = other; slow = true;
  const release = setTimeout(() => gate.resolve(), 3000);
  try {
    await app.event("session_branch");
    const begin = Date.now();
    const pending = app.event("tool_call", { toolName: "bash", input: { command: "ls" } }, context);
    await Promise.race([started.promise, Bun.sleep(2500).then(() => { throw new Error("actor lookup did not start"); })]);
    const result = await pending, elapsed = Date.now() - begin;
    expect(result?.block).toBeUndefined(); expect(elapsed).toBeLessThan(2000);
  } finally { clearTimeout(release); gate.resolve(); }
 }
 {
  const gate = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
  let slow = false;
  const app = ompHost({ cwd, sid: "latency-prompt", run: async args => {
    if (slow && args[0] === "status") { started.resolve(); await gate.promise; }
    return run(args);
  } });
  await app.event("session_start"); await app.init(["Prompt latency fixture"]);
  const other = join(cwd, "slow-prompt"); mkdirSync(other); app.ctx.cwd = other; slow = true;
  const release = setTimeout(() => gate.resolve(), 4000);
  try {
    await app.event("session_branch");
    await Promise.race([started.promise, Bun.sleep(2500).then(() => { throw new Error("actor lookup did not start"); })]);
    const begin = Date.now(); await app.event("before_agent_start", { reason: "prompt", systemPrompt: [] });
    expect(Date.now() - begin).toBeLessThan(2000);
  } finally { clearTimeout(release); gate.resolve(); }
 }
}, 30000);
