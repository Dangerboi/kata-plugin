import { execFile } from "node:child_process";
import { appendFileSync, realpathSync } from "node:fs";
import { closeEnv, transcriptEnv, type ExecResult, type Platform } from "./kata-cli";

// The Node implementations of what the core takes from its host. Only adapters that run on Node import this module:
// the core itself never does.

export const nodePlatform: Platform = {
	env: { get: name => process.env[name], set(name, value) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } },
	cwd: () => process.cwd(),
	pid: process.pid,
	setTimer(fire, ms) { const handle = setTimeout(fire, ms); handle.unref?.(); return handle; },
	clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
	realpath: realpathSync,
	appendFile: appendFileSync,
};

// `closeEnv` with the transcript switch read from this process's environment.
export const closeEnvHere = (args: readonly string[], agent: string, sessionId: string | undefined) => closeEnv(args, agent, sessionId, process.env.KATA_CLOSE_TRANSCRIPT_ENABLED);

// Every later close from this process and what it spawns (the bash tool, delegates, harnesses launched from bash) then records this session.
export function exportTranscriptSession(agent: string, sessionId: string | undefined): void {
	if (sessionId) Object.assign(process.env, transcriptEnv(agent, sessionId, process.env.KATA_CLOSE_TRANSCRIPT_ENABLED));
}

// Runs Kata without a shell, for an adapter whose host cannot put an environment on the call. Like pi.exec, a non-zero exit
// or any spawn failure other than a missing executable is a result, a timeout or abort reports `killed`, and ENOENT rejects.
export function execKata(file: string, args: string[], options: { cwd: string; timeout: number; signal?: AbortSignal; env?: Record<string, string> }): Promise<Required<ExecResult>> {
	return new Promise((resolve, reject) => {
		execFile(file, args, { cwd: options.cwd, timeout: options.timeout, signal: options.signal, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...options.env } },
			(error, stdout, stderr) => {
				if (!error) return resolve({ code: 0, stdout, stderr, killed: false });
				const failure = error as NodeJS.ErrnoException & { killed?: boolean };
				if (failure.code === "ENOENT") return reject(error);
				resolve({ code: typeof failure.code === "number" ? failure.code : 1, stdout, stderr, killed: failure.name === "AbortError" || !!failure.killed });
			});
	});
}
