import { closeEnv, type ExecResult } from "./kata-cli";
import { execKata, nodePlatform } from "./node-host";
import { NAMESPACE } from "./saved";
import type { Settings } from "./settings";

export type KataExec = (sessionID: string, file: string, args: string[], options: { cwd: string; timeout: number }) => Promise<ExecResult>;

// The server hosts every session, so the transcript identity goes in this call's environment, never in process.env.
export function createKataExec(settings: Settings): KataExec {
	return (sessionID, file, args, options) => execKata(file, args, { ...options, env: { ...settings.kataEnv, ...closeEnv(nodePlatform.env, args, NAMESPACE, sessionID) } });
}
