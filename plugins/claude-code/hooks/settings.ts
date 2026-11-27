import type { EngineInterface } from "claude-code";
import { refGuardMode } from "../core/kata-cli";

// The host's name: the core's namespace (what it writes to Kata and to the saved entries) and the agent a close's transcript is for.
export const NAMESPACE = "claude";

// What the adapter reads from the host: plugin options first (plugin.json userConfig), then the environment.
// `$.env.get` takes literal names only, so every variable the core or the adapter reads is spelled out here once; the
// values are read when the runtime starts and live in an in-memory map the core's Platform reads synchronously.
export async function readEnv($: EngineInterface): Promise<Map<string, string>> {
	const found = new Map<string, string>();
	const note = (name: string, value: string | undefined) => {
		if (value !== undefined && value !== "") found.set(name, value);
	};
	note("KATA_REF", await $.env.get("KATA_REF"));
	note("KATA_DEFAULT_PROJECT", await $.env.get("KATA_DEFAULT_PROJECT"));
	note("KATA_AUTHOR", await $.env.get("KATA_AUTHOR"));
	note("KATA_TEAMMATE", await $.env.get("KATA_TEAMMATE"));
	note("KATA_INBOX_USER", await $.env.get("KATA_INBOX_USER"));
	note("KATA_HOME", await $.env.get("KATA_HOME"));
	note("KATA_ATTENTION_HOST", await $.env.get("KATA_ATTENTION_HOST"));
	note("KATA_CLOSE_TRANSCRIPT_ENABLED", await $.env.get("KATA_CLOSE_TRANSCRIPT_ENABLED"));
	note("KATA_REF_GUARD", await $.env.get("KATA_REF_GUARD"));
	note("HOME", await $.env.get("HOME"));
	note("USER", await $.env.get("USER"));
	note("KATA_CLAUDE_EXECUTABLE", await $.env.get("KATA_CLAUDE_EXECUTABLE"));
	note("KATA_CLAUDE_DEBUG", await $.env.get("KATA_CLAUDE_DEBUG"));
	note("KATA_CLAUDE_LIVE_INBOX", await $.env.get("KATA_CLAUDE_LIVE_INBOX"));
	return found;
}

export interface Settings {
	executable: string;
	debugFile?: string;
	// Add the contract and inbox sections to prompts. Off by default: `kata agent-hook install claude` owns them.
	contract: boolean;
	// Follow the session inbox live. Off: the inbox is read once per prompt, as for a subagent.
	liveInbox: boolean;
	// The option can turn the guard off; the environment also selects warnings.
	refGuard: "block" | "warn" | "off";
}

export const EXECUTABLE_VARS = ["KATA_CLAUDE_EXECUTABLE"];

export function resolveSettings(options: Record<string, unknown> | undefined, env: Map<string, string>): Settings {
	const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
	const refGuard = options?.refGuard === false ? "off" : refGuardMode(env.get("KATA_REF_GUARD"));
	return {
		executable: text(options?.kataExecutable) ?? env.get("KATA_CLAUDE_EXECUTABLE") ?? "kata",
		debugFile: text(options?.debugFile) ?? env.get("KATA_CLAUDE_DEBUG"),
		contract: options?.contract === true,
		liveInbox: options?.liveInbox !== false && env.get("KATA_CLAUDE_LIVE_INBOX") !== "0",
		refGuard
	};
}
