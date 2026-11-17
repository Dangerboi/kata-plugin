import type { Hook } from "claude-code";
import { turnEnded } from "./inbox";
import { tagged, type PromptSections } from "../core/kata-core";
import { delegateTurn } from "./delegates";
import type { Session } from "./host";
import { contextOf, enter, runtime } from "./lead";

type Section = readonly [keyof PromptSections, string];

function unsent(session: Session, sections: PromptSections): Section[] {
	return (["contract", "inbox", "todo"] as const).flatMap(name => {
		const text = sections[name];
		return text && session.sent[name] !== text ? [[name, text] as const] : [];
	});
}

// The user's prompt gets the plan (and, when the option is on, the contract and inbox) as hidden context after it.
// What a thread was sent is fixed, so a section the model already holds is not repeated; compaction forgets them. A section
// counts as sent once the prompt that carries it went through: a dropped prompt leaves it for the next.
export const onPrompt: Hook<"prompt.submit"> = async ($, e, next) => {
	let session: Session | undefined;
	let carried: Section[] = [];
	try {
		const { rt, ctx } = await enter($);
		session = ctx.held;
		if (e.origin.kind === "composer" && !e.isMeta) rt.core.session.input();
		const { sections } = await rt.core.session.beforePrompt(ctx, { context: rt.settings.contract });
		carried = unsent(session, sections);
	} catch (error) {
		runtime()?.debug(error);
	}
	const context = carried.map(([name, text]) => tagged(name, text));
	const done = await next(context.length ? { ...e, context: [...(e.context ?? []), ...context] } : e);
	if (session && !("drop" in done && done.drop)) for (const [name, text] of carried) session.sent[name] = text;
	return done;
};

export const onCompact: Hook<"session.compact"> = async ($, e, next) => {
	const latest = runtime()?.latest;
	if (latest) latest.held.sent = {};
	return next(e);
};

export const onTurnComplete: Hook<"turn.complete"> = async ($, e, next) => {
	turnEnded(e);
	const done = await next(e);
	if (e.agentId !== undefined) {
		await delegateTurn($, e);
		return done;
	}
	const rt = runtime();
	const latest = rt?.latest;
	if (rt?.bound && latest) {
		try {
			await rt.core.session.settle(contextOf($, rt, latest.held), next.signal);
		} catch (error) {
			rt.debug(error);
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
		} catch (error) {
			runtime()?.debug(error);
		}
	}
	return next(e);
};
