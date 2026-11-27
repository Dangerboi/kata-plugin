// Runs on a worker thread: a delegate's own copy of the omp adapter, as omp loads it once enough subagents run at once.
// It starts the delegate's session and runs one tool right away, then reports back.
import { BroadcastChannel, parentPort, workerData } from "node:worker_threads";
import { isolatedKata } from "./kata-fixture";
import { ompHost } from "./omp-host";

const { binary, env, cwd, sessionFile, id, parentId, identityProbe } = workerData as { binary: string; env: NodeJS.ProcessEnv; cwd: string; sessionFile: string; id: string; parentId: string; identityProbe?: boolean };
const run = isolatedKata(binary, env, cwd);
const child = ompHost({ cwd, sid: identityProbe ? "worker-shim-session" : undefined, sessionFile, agent: { kind: "sub", id, parentId }, run: (args, opts) => run(args, opts.cwd, opts.timeout) });
// omp's agent loop keeps a real worker alive; the adapter's own channel is unref'd, so hold one open while the tool call waits.
const alive = new BroadcastChannel("omp-worker-delegate:alive");
if (identityProbe) { parentPort!.postMessage("ready"); await new Promise<void>(resolve => parentPort!.once("message", () => resolve())); }
await child.event("session_start");
if (identityProbe) {
  await child.event("before_agent_start", { reason: "prompt", systemPrompt: [] });
  await child.event("tool_call", { toolName: "bash", input: { command: "bash -c kata" } });
  const { readFileSync } = await import("node:fs");
  const dir = process.env.KATA_OMP_SHIM_DIR;
  parentPort!.postMessage({ dir, content: dir ? readFileSync(`${dir}/worker-shim-session.env`, "utf8") : undefined });
} else await child.event("tool_call", { toolName: "read", input: { path: "README.md" } });
alive.close();
parentPort!.postMessage("ran");
