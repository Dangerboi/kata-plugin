// Runs on a worker thread: a delegate's own copy of the omp adapter, as omp loads it once enough subagents run at once.
// It starts the delegate's session and runs one tool right away, then reports back.
import { execFile } from "node:child_process";
import { BroadcastChannel, parentPort, workerData } from "node:worker_threads";
import { promisify } from "node:util";
import { assertIsolated } from "./isolation";
import { ompHost } from "./omp-host";

const exec = promisify(execFile);
const { binary, env, cwd, sessionFile, id, parentId } = workerData as { binary: string; env: NodeJS.ProcessEnv; cwd: string; sessionFile: string; id: string; parentId: string };
assertIsolated(env);
const child = ompHost({
  cwd, sessionFile, agent: { kind: "sub", id, parentId },
  async run(args, opts) {
    try { return { ...await exec(binary, args, { env, cwd: opts.cwd, timeout: opts.timeout }), code: 0, killed: false }; }
    catch (error: any) { return { stdout: error.stdout || "", stderr: error.stderr || error.message, code: error.code || 1, killed: !!error.killed }; }
  },
});
// omp's agent loop keeps a real worker alive; the adapter's own channel is unref'd, so hold one open while the tool call waits.
const alive = new BroadcastChannel("omp-worker-delegate:alive");
await child.event("session_start");
await child.event("tool_call", { toolName: "read", input: { path: "README.md" } });
alive.close();
parentPort!.postMessage("ran");
