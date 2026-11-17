import type { Hook } from "claude-code";
import { contextOf, enter, runtime, waitFor } from "./lead";
import { registerTodoCommand } from "./ui";

// Awaited before the first prompt: binds the session's plan (a resumed session's saved work resumes with it) and prunes.
export const onStart: Hook<"session.start"> = async ($, e, next) => {
	try {
		await enter($);
	} catch (error) {
		runtime()?.debug(error);
	}
	await registerTodoCommand($);
	return next(e);
};

// /resume, /branch and /clear fire no `session.start`, but this settings event does (unless a managed-settings guard skips
// it: then the next hook finds the new session id, `enter`). A fork shares its source's plan.
export const onSessionSwitch: Hook<"classic.SessionStart"> = async ($, e, next) => {
	try {
		await enter($, { fork: e.source === "fork" });
	} catch (error) {
		runtime()?.debug(error);
	}
	return next(e);
};

// The whole chain of session.end hooks has 1.5 s. The core's shutdown gets at most SHUTDOWN_MS of what the chain has left,
// less SAVE_RESERVE_MS kept for saving the record; what it did not finish stays in the record, and the session's resume finishes it.
const SHUTDOWN_MS = 1200;
const SAVE_RESERVE_MS = 300;

// A /clear or /resume goes on in the same process: nothing ends here, the core's next switch ends the session it leaves.
export const onEnd: Hook<"session.end"> = async ($, e, next) => {
	const rt = runtime();
	if (!rt) return next(e);
	if (e.reason === "clear" || e.reason === "resume") {
		await rt.bound?.writer.settled();
		return next(e);
	}
	const latest = rt.latest;
	if (latest) {
		const budget = Math.min(SHUTDOWN_MS, Math.max(0, next.budget.remainingMs - SAVE_RESERVE_MS));
		await waitFor($, rt, rt.core.session.shutdown(contextOf($, rt, latest.held)), budget);
		// Read after the shutdown: a switch still queued ahead of it moves `bound` (and ends the session it leaves). The core's
		// debts are its bound session's; the latest session, when the core never switched to it, owes nothing the core knows of.
		const bound = rt.bound;
		if (bound) await bound.writer.end(rt.core.session.owes()).catch(rt.debug);
		if (latest.held !== bound) await latest.held.writer.end(false).catch(rt.debug);
	}
	return next(e);
};
