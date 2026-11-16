import { closeEnv, execKata, type ExecResult } from "./kata-cli";
import type { Settings } from "./settings";

export type KataExec = (sessionID: string, file: string, args: string[], options: { cwd: string; timeout: number }) => Promise<ExecResult>;

// The server hosts every session, so the transcript identity goes in this call's environment, never in process.env.
export function createKataExec(settings: Settings): KataExec {
	return (sessionID, file, args, options) => execKata(file, args, { ...options, env: { ...settings.kataEnv, ...closeEnv(args, "opencode", sessionID) } });
}
