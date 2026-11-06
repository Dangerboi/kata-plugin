// Runs on a worker thread: a delegate's own copy of the omp adapter, as omp loads it once enough subagents run at once.
// It starts the delegate's session and runs one tool right away, then reports back.
import { BroadcastChannel, parentPort, workerData } from "node:worker_threads";
import { isolatedKata } from "./kata-fixture";
import { ompHost } from "./omp-host";

const { binary, env, cwd, sessionFile, id, parentId } = workerData as { binary: string; env: NodeJS.ProcessEnv; cwd: string; sessionFile: string; id: string; parentId: string };
const run = isolatedKata(binary, env, cwd);
const child = ompHost({ cwd, sessionFile, agent: { kind: "sub", id, parentId }, run: (args, opts) => run(args, opts.cwd, opts.timeout) });
// omp's agent loop keeps a real worker alive; the adapter's own channel is unref'd, so hold one open while the tool call waits.
const alive = new BroadcastChannel("omp-worker-delegate:alive");
await child.event("session_start");
await child.event("tool_call", { toolName: "read", input: { path: "README.md" } });
alive.close();
parentPort!.postMessage("ran");
