import { setSystemTime } from "bun:test";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
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

/**
 * Points this process at one fixture's throwaway store and puts its Kata binary first on PATH as `kata`.
 * The omp adapter spawns its own transcript closes itself, outside the fake host's exec, using the
 * process environment and the default executable name. Returns the restore function.
 */
export function adoptIsolatedKata(binary: string, home: string): () => void {
  assertIsolated({ ...process.env, KATA_HOME: home });
  const bin = path.join(path.dirname(home), "bin");
  mkdirSync(bin, { recursive: true });
  if (!existsSync(path.join(bin, "kata"))) symlinkSync(binary, path.join(bin, "kata"));
  const saved = { PATH: process.env.PATH, KATA_HOME: process.env.KATA_HOME };
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ""}`;
  process.env.KATA_HOME = home;
  return () => {
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
  };
}

/** A retry deadline passes while `fn` runs, without sleeping: a throttled close is due again. */
export async function later<T>(fn: () => Promise<T>): Promise<T> {
	setSystemTime(new Date(Date.now() + 120_000));
	try { return await fn(); } finally { setSystemTime(); }
}
