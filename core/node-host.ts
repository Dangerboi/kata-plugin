import { execFile, spawn, type SpawnOptions } from "node:child_process";
import { appendFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { transcriptEnv, type ExecResult, type OwnerGuard, type Platform } from "./kata-cli";

// The Node implementations of what the core takes from its host. Only adapters that run on Node import this module:
// the core itself never does.

export const nodePlatform: Platform = {
	env: { get: name => process.env[name], set(name, value) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } },
	cwd: () => process.cwd(),
	path,
	pid: process.pid,
	setTimer(fire, ms) { const handle = setTimeout(fire, ms); handle.unref?.(); return handle; },
	clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
	realpath: async file => realpathSync(file),
	appendFile: appendFileSync,
	readFile: file => readFile(file, "utf8"),
	home: homedir(),
};

// A session file's identity: resolved against `cwd` with symlinks resolved, a file that does not exist yet through its folder.
// Synchronous, for an adapter that keys records by it; the core's own comparison is `canonicalPath`.
export function sessionKey(file: string, cwd: string): string {
	const absolute = path.resolve(cwd, file);
	try { return realpathSync(absolute); }
	catch { try { return path.join(realpathSync(path.dirname(absolute)), path.basename(absolute)); } catch { return absolute; } }
}

// Every later close from this process and what it spawns (the bash tool, delegates, harnesses launched from bash) then records this session.
export function exportTranscriptSession(agent: string, sessionId: string | undefined): void {
	if (sessionId) Object.assign(process.env, transcriptEnv(nodePlatform.env, agent, sessionId));
}

// Runs Kata without a shell, for an adapter whose host cannot put an environment on the call. Like pi.exec, a non-zero exit
// or any spawn failure other than a missing executable is a result, a timeout or abort reports `killed`, and ENOENT rejects.
export function execKata(file: string, args: string[], options: { cwd: string; timeout: number; env?: Record<string, string> }): Promise<Required<ExecResult>> {
	return new Promise((resolve, reject) => {
		execFile(file, args, { cwd: options.cwd, timeout: options.timeout, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...options.env } },
			(error, stdout, stderr) => {
				if (!error) return resolve({ code: 0, stdout, stderr, killed: false });
				const failure = error as NodeJS.ErrnoException & { killed?: boolean };
				if (failure.code === "ENOENT") return reject(error);
				resolve({ code: typeof failure.code === "number" ? failure.code : 1, stdout, stderr, killed: failure.name === "AbortError" || !!failure.killed });
			});
	});
}

// Run by the host's own runtime when an end has a guard: the end follows only while the issue still has the owner and teammate attention began under.
// A failed read ends nothing, as a failed awaited end would not. A compiled Bun host (omp) runs a script only with BUN_BE_BUN.
const GUARDED = `const { execFileSync } = require("node:child_process");
const [file, guard, args] = process.argv.slice(1).map((value, index) => index ? JSON.parse(value) : value);
delete process.env.BUN_BE_BUN;
try {
	const { issue } = JSON.parse(execFileSync(file, guard.show, { encoding: "utf8", timeout: 5000 }));
	if (issue.owner === guard.owner && (issue.metadata?.teammate || "") === guard.teammate) execFileSync(file, args, { stdio: "ignore", timeout: 5000 });
} catch {}`;

// The detached child's command, as `spawn` takes it.
function spawnArgs(file: string, args: string[], { cwd, env, guard }: { cwd: string; env?: Record<string, string>; guard?: OwnerGuard }): [string, string[], SpawnOptions] {
	const spawned: SpawnOptions = { cwd, env: { ...process.env, ...env }, detached: true, stdio: "ignore" };
	return guard ? [process.execPath, ["-e", GUARDED, file, JSON.stringify(guard), JSON.stringify(args)], { ...spawned, env: { ...spawned.env, BUN_BE_BUN: "1" } }] : [file, args, spawned];
}

// A shutdown hook must survive the host exiting and must never keep it alive.
export function spawnDetached(file: string, args: string[], options: { cwd: string; env?: Record<string, string>; guard?: OwnerGuard }, onError?: (error: unknown) => void): void {
	const report = (error: unknown) => { try { onError?.(error); } catch { /* Shutdown must not throw. */ } };
	try {
		const child = spawn(...spawnArgs(file, args, options));
		child.on("error", report);
		child.unref();
	} catch (error) { report(error); }
}
