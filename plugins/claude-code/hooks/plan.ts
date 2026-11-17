import type { PlanView } from "../core/kata-core";
import type { EngineInterface, KataTodoCard } from "claude-code";

// What the lead's plan leaves in `$.state` for the band and the todo cards. A render hook reads it with `planOf` and `cardOf`
// and never runs Kata.

const plan = { plugin: "kata-cc", key: "plan" } as const;
const cards = { plugin: "kata-cc", key: "cards" } as const;
const cardIds = { plugin: "kata-cc", key: "cardIds" } as const;

// Cards kept for the transcript's todo results; an older one is replaced by the null the render hook passes over.
const KEPT_CARDS = 40;

export function planOf($: EngineInterface) {
	return $.state.get(plan);
}

export function cardOf($: EngineInterface, id: string) {
	return $.state.get({ ...cards, id });
}

// The context's `ui` for the core: it pushes the plan to `setWidget` whenever it changes (a todo call, /todo, a delegate
// closing its task, a replayed local plan) and warnings to `notify`. Nothing here may fail the call that caused it.
export function planUi($: EngineInterface) {
	return {
		setWidget(_key: string, content: unknown) {
			const shown = content === undefined ? null : Array.isArray(content) ? { phases: [], error: String(content[0] ?? "") } : (content as PlanView);
			try {
				$.state.set(plan, shown).catch(() => undefined);
			} catch {
				/* The band keeps its last plan. */
			}
		},
		notify(message: string) {
			try {
				$.ui.toast(message);
			} catch {
				/* A session with no surface has nobody to tell. */
			}
		}
	};
}

// Card updates run one at a time: each reads the id list, changes it and writes it back, so two calls finishing together
// would lose an id (and leave its card behind for good).
let queue: Promise<unknown> = Promise.resolve();

// The checklist card of a finished `todo` call: the plan as the call left it, read from what the core just pushed.
// `notice` is what the result said before the plan (a pending close, a deleted parent).
export function rememberCard($: EngineInterface, id: string, text: string, notice?: string) {
	const run = queue.then(() => write($, id, text, notice));
	queue = run.catch(() => undefined);
	return run;
}

async function write($: EngineInterface, id: string, text: string, notice: string | undefined) {
	const view = (await planOf($)).value ?? undefined;
	const card: KataTodoCard = { text, ...(notice ? { notice } : {}), ...(view?.phases.some(p => p.tasks.length) ? { view } : {}) };
	await $.state.set({ ...cards, id }, card);
	const ids = [...((await $.state.get(cardIds)).value ?? []).filter(known => known !== id), id];
	for (const old of ids.splice(0, Math.max(0, ids.length - KEPT_CARDS))) await $.state.set({ ...cards, id: old }, null);
	await $.state.set(cardIds, ids);
}
