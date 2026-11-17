import type { Hook, Next, ToolCallEvent, ToolCallResult } from "claude-code";
import { posixPath } from "../core/posix-path";
import { transcriptCommand } from "../core/shell";
import { runtime } from "./lead";
import { EXECUTABLE_VARS, NAMESPACE } from "./settings";

// Kata commands in Bash calls. A rewrite of the call is the first choice. Auto mode refuses a tool call a hook changed after
// the classifier read it (the model is told so and its repeat of the exact call goes through with the change dropped), so
// there the call is refused with the exact command to run instead: the model's next call already carries the change and
// passes untouched. `refuse`: the call is known to run under auto mode.
export async function runRewritten(e: ToolCallEvent, next: Next<"tool.call">, command: string, why: string, refuse: boolean): Promise<ToolCallResult> {
	remember(command, e.command);
	const exact = { deny: `${why} Run it again exactly like this: ${command}` };
	if (refuse) return exact;
	const done = await next({ ...e, command });
	return done.deny !== undefined && /changed this call's input/i.test(done.deny) ? exact : done;
}

// The command each rewrite started from, by the rewritten text, the latest MAX_REWRITES: the permission check judges a
// rewritten call as the command the model wrote (`onShellCheck`). Keyed by text, so the model's repeat of a refused rewrite is
// found too.
const MAX_REWRITES = 64;
const rewrites = new Map<string, string>();
function remember(command: string, original: string) {
	rewrites.delete(command);
	rewrites.set(command, original);
	if (rewrites.size > MAX_REWRITES) rewrites.delete(rewrites.keys().next().value!);
}

// The lead's Bash: a `kata close` carries the lead's transcript pair, as a close the plugin makes does. A delegate's calls
// are routed in delegates.ts.
export const onLeadShell: Hook<"tool.call"> = async ($, e, next) => {
	const rt = runtime();
	if (e.agentId !== undefined || typeof e.command !== "string" || !rt) return next(e);
	const transcript = { env: rt.platform.env, agent: NAMESPACE, id: await $.session.id() };
	const command = transcriptCommand(posixPath, e.command, rt.settings.executable, EXECUTABLE_VARS, transcript);
	if (command === e.command) return next(e);
	return runRewritten(e, next, command, "A kata close records the session that made it.", false);
};

// What a rewrite adds (`env KATA_TRANSCRIPT_...=…`, `--teammate`) keeps a settings allow rule such as `Bash(kata *)` from
// matching: Claude Code matches no allow rule past an unknown variable's assignment (deny and ask rules see past it). When
// the engine's own rules would put a rewritten call to its decider, the call is allowed if the model's own command is allowed
// outright. An ask from a hook (a PreToolUse guard, another plugin) stands, as does every other verdict: the query runs no
// PreToolUse hook and carries no call id.
export const onShellCheck: Hook<"tool.check"> = async ($, e, next) => {
	const decided = await next(e);
	const input = e.input as Record<string, unknown>;
	const original = typeof input.command === "string" ? rewrites.get(input.command) : undefined;
	if (decided.decision !== "ask" || decided.hook !== undefined || decided.plugin !== undefined || original === undefined) return decided;
	const judged = await $.tool.check({ tool: e.tool, input: { ...input, command: original } });
	return judged.decision === "allow" ? judged : decided;
};
