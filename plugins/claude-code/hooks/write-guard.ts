import type { Hook } from "claude-code";
import { contextOf, runtime } from "./lead";

// Refuses a Write, an Edit, a NotebookEdit or a Bash `git commit` that puts a Kata ref into the repository (the core decides: see
// `tools.guard`). A lead's or a subagent's call alike; a call before the session is bound runs unchecked.
export const onWriteGuard: Hook<"tool.call"> = async ($, e, next) => {
	const rt = runtime();
	const held = rt?.latest?.held;
	if (!rt || !held) return next(e);
	try {
		const reason = await rt.core.tools.guard(contextOf($, rt, held, e.agentId), { tool: String(e.tool), input: e });
		if (reason) return { deny: reason };
	} catch (error) {
		rt.debug(error);
	}
	return next(e);
};
