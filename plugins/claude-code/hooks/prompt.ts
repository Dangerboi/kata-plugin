import type { Hook } from "claude-code";
import { turnEnded } from "./inbox";
import { tagged, type PromptSections } from "../core/kata-core";
import { delegateTurn } from "./delegates";
import { contextOf, enter, runtime, type Runtime } from "./lead";

// What each turn carries and how a turn ends.

// A section goes out when it differs from what the last prompt carried.
function fresh(rt: Runtime, sections: PromptSections): string[] {
	const out: string[] = [];
	for (const name of ["contract", "inbox", "todo"] as const) {
		const text = sections[name];
		if (!text || rt.sent[name] === text) continue;
		rt.sent[name] = text;
		out.push(tagged(name, text));
	}
	return out;
}

// The user's prompt gets the plan (and, when the option is on, the contract and inbox) as hidden context after it.
// What a thread was sent is fixed, so a section the model already holds is not repeated; compaction forgets them.
export const onPrompt: Hook<"prompt.submit"> = async ($, e, next) => {
	let context: string[] = [];
	try {
		const { rt, ctx } = await enter($);
		if (e.origin.kind === "composer" && !e.isMeta) rt.core.session.input();
		const { sections } = await rt.core.session.beforePrompt(ctx, { context: rt.settings.contract });
		context = fresh(rt, sections);
	} catch {
		/* The prompt goes without. */
	}
	return next(context.length ? { ...e, context: [...(e.context ?? []), ...context] } : e);
};

export const onCompact: Hook<"session.compact"> = async ($, e, next) => {
	const rt = runtime();
	if (rt) rt.sent = {};
	return next(e);
};

// The lead's turn ended: due closes are retried and exited delegates handed back.
export const onTurnComplete: Hook<"turn.complete"> = async ($, e, next) => {
	turnEnded(e);
	const done = await next(e);
	if (e.agentId !== undefined) {
		await delegateTurn($, e);
		return done;
	}
	const rt = runtime();
	if (e.agentId === undefined && rt?.writer) {
		try {
			await rt.core.session.settle(contextOf($, rt), next.signal);
		} catch {
			/* Settling is retried at the next turn. */
		}
	}
	return done;
};

// The end-of-turn Stop of a settings hook: open tasks come back as a reminder that keeps the model working. Skipped by Claude
// Code where a managed-settings guard loads; the turn's settle above still runs there.
export const onStop: Hook<"classic.Stop"> = async ($, e, next) => {
	if (e.agent_id === undefined) {
		try {
			const { rt, ctx } = await enter($);
			const reminder = await rt.core.session.stop(ctx, [{ role: "assistant", content: e.last_assistant_message ?? "" }], next.signal);
			if (reminder) return { block: reminder };
		} catch {
			/* No reminder. */
		}
	}
	return next(e);
};
