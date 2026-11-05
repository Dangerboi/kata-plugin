import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertIsolated } from "./isolation";

const exec = promisify(execFile);
export function isolatedKata(binary: string, env: NodeJS.ProcessEnv, cwd: string, defaultTimeout = 5000) {
  return async (args: string[], workspace = cwd, timeout = defaultTimeout, extraEnv: NodeJS.ProcessEnv = {}) => {
    assertIsolated(env);
    try { return { ...await exec(binary, args, { env: { ...env, ...extraEnv }, cwd: workspace, timeout }), code: 0, killed: false }; }
    catch (error: any) { return { stdout: error.stdout || "", stderr: error.stderr || error.message, code: error.code || 1, killed: !!error.killed }; }
  };
}

/** What a fake host's exec must run: the omp adapter may wrap a call as `env K=V... <executable> args...`; like the real `env`, this applies the assignments and drops the wrapper. */
export function unwrapEnv(file: string, args: string[]): { args: string[]; env: NodeJS.ProcessEnv } {
  if (file !== "env") return { args, env: {} };
  const env: NodeJS.ProcessEnv = {};
  let i = 0;
  for (; i < args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[i]); i++) env[args[i].slice(0, args[i].indexOf("="))] = args[i].slice(args[i].indexOf("=") + 1);
  return { args: args.slice(i + 1), env };
}
