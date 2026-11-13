import { execFile } from "node:child_process";
import type { ExecResult } from "./kata-cli";
import { transcriptEnv, type Settings } from "./settings";

export type KataExec = (sessionID: string | undefined, file: string, args: string[], options: { cwd: string; timeout: number }) => Promise<ExecResult>;

// Runs Kata directly. The server hosts every session, so the transcript identity goes in this call's environment, never in
// process.env. Like the other adapters' exec, a non-zero exit is a result, a timeout reports `killed`, and a missing
// executable rejects.
export function createKataExec(settings: Settings): KataExec {
	return (sessionID, file, args, { cwd, timeout }) => new Promise<ExecResult>((resolve, reject) => {
		const env = { ...process.env, ...settings.kataEnv, ...(sessionID && args[0] === "close" ? transcriptEnv(sessionID) : {}) };
		execFile(file, args, { cwd, timeout, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024, env }, (error, stdout, stderr) => {
			if (!error) return resolve({ code: 0, stdout, stderr, killed: false });
			const failure = error as NodeJS.ErrnoException & { killed?: boolean };
			if (failure.code === "ENOENT") return reject(error);
			resolve({ code: typeof failure.code === "number" ? failure.code : 1, stdout, stderr, killed: !!failure.killed });
		});
	});
}
