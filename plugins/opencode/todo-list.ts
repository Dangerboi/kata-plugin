// Generated from core/todo-list.ts; edit there.
// Pure diffs between a whole todo list and the Kata plan: no Kata, no host, no I/O.
import { proofProblem, OPEN, type Status, type Task } from "./model";

export const LIST_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
export type ListStatus = (typeof LIST_STATUSES)[number];
export type ListItem = { content: string; status: ListStatus; message?: string; evidence?: string[]; reason?: string; blocker?: string };
// `ref` tells apart plan tasks that share a content (the same title in two phases): ops then name the task by ref.
export type PlanItem = { content: string; status: Status; blocker?: string; ref?: string };
export type ListOp =
	| { op: "append"; items: string[] }
	| { op: "start"; task: string }
	| { op: "done"; task: string; message: string; evidence: string[] }
	| { op: "drop"; task: string; message: string }
	| { op: "block"; task: string; reason: string }
	| { op: "unblock"; task: string };
type ListView = { content: string; status: ListStatus; blocker?: string };

const LISTED: Record<Status, ListStatus> = { pending: "pending", in_progress: "in_progress", blocked: "in_progress", completed: "completed", abandoned: "cancelled" };

// The plan task a list item stands for. Core identity is phase+content, so one content can have several tasks: they are one
// list item. Open copies stand in front of closed ones; among open ones an in_progress copy, then a paused one, then a
// pending one, so the item never reads as pending while a copy is in progress.
function representative<T extends PlanItem>(copies: readonly T[]): T {
	const open = copies.filter(t => OPEN.has(t.status));
	if (open.length) return open.find(t => t.status === "in_progress") ?? open.find(t => t.status === "blocked") ?? open[0];
	return copies.find(t => t.status === "completed") ?? copies[0];
}

function groupsOf<T extends PlanItem>(plan: readonly T[]): Map<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const t of plan) {
		const copies = groups.get(t.content);
		if (copies) copies.push(t); else groups.set(t.content, [t]);
	}
	return groups;
}

export function listOf(plan: readonly PlanItem[]): ListView[] {
	return [...groupsOf(plan).values()].map(representative).map(t => t.status === "blocked" ? { content: t.content, status: "in_progress", blocker: t.blocker || "blocked" } : { content: t.content, status: LISTED[t.status] });
}
// What a refused or failed call ends with: the plan as the list to send back.
export const planTail = (plan: readonly PlanItem[]) => `The current Kata plan is below. Send it again with your changes applied on top:\n${JSON.stringify({ todos: listOf(plan) })}`;

const proofMissing = (item: ListItem): string | undefined => {
	const problem = proofProblem(item);
	if (problem) return `"${item.content}" cannot be completed without ${problem}`;
};

export function diffTodoList(plan: readonly PlanItem[], accepted: ReadonlySet<string>, incoming: readonly ListItem[]): { ops: ListOp[] } | { refusal: string; problems: string[] } {
	const problems: string[] = [];
	const known = groupsOf(plan);
	const seen = new Set<string>();
	const appended: string[] = [], closes: ListOp[] = [], unblocks: ListOp[] = [], blocks: ListOp[] = [], starts: ListOp[] = [];

	// Names the ops for these copies out of all the plan tasks of the content. Core cannot resolve a shared content, so each
	// copy is named by its ref. Copies that share one ref (ticket items expose the ticket's ref) cannot be told apart by either,
	// so a list that needs an op for them is refused.
	const names = (item: ListItem, copies: readonly PlanItem[], all: readonly PlanItem[]): string[] => {
		if (all.length > 1 && copies.some(c => c.ref && all.filter(t => t.ref === c.ref).length > 1)) {
			const problem = `"${item.content}" appears in more than one phase naming the same ticket, so todowrite cannot change it: ask the user to remove the duplicate item (for example from the session that made it), then send the list again`;
			if (!problems.includes(problem)) problems.push(problem);
			return [];
		}
		return [...new Set(copies.map(c => all.length > 1 && c.ref ? c.ref : c.content))];
	};
	const finish = (item: ListItem, copies: readonly PlanItem[], all: readonly PlanItem[]) => {
		const missing = proofMissing(item);
		if (missing) problems.push(missing);
		else for (const task of names(item, copies, all)) closes.push({ op: "done", task, message: item.message!, evidence: item.evidence!.filter(e => e.trim()) });
	};
	const cancel = (item: ListItem, copies: readonly PlanItem[], all: readonly PlanItem[]) => {
		if (!item.reason?.trim()) problems.push(`"${item.content}" cannot be cancelled without a reason`);
		else for (const task of names(item, copies, all)) closes.push({ op: "drop", task, message: item.reason });
	};

	for (const item of incoming) {
		if (!item.content.trim()) { problems.push("an item has blank content"); continue; }
		if (seen.has(item.content)) { problems.push(`"${item.content}" appears more than once`); continue; }
		seen.add(item.content);
		const blocker = item.blocker?.trim() ? item.blocker : undefined;
		const all = known.get(item.content);

		if (!all) {
			if (item.status === "cancelled") { problems.push(`"${item.content}" is new and cannot be cancelled: leave it out instead`); continue; }
			appended.push(item.content);
			const fresh = [{ content: item.content, status: "pending" as Status }];
			if (item.status === "completed") finish(item, fresh, fresh);
			else if (blocker) blocks.push({ op: "block", task: item.content, reason: blocker });
			else if (item.status === "in_progress") starts.push({ op: "start", task: item.content });
			continue;
		}

		// The item is compared with the copy that stands for it (see representative); its ops reach every open copy, except
		// copies that share a ref, which todowrite cannot name (see names).
		const current = representative(all);
		if (!OPEN.has(current.status)) {
			// Copies closed both ways read back as completed, but dropping an item with a completed copy leaves exactly that mix,
			// so either closed status is the same item.
			const mixed = all.some(t => t.status === "completed") && all.some(t => t.status === "abandoned");
			if (mixed && (item.status === "completed" || item.status === "cancelled")) continue;
			if (item.status !== LISTED[current.status]) problems.push(`"${item.content}" is already ${LISTED[current.status]} in Kata and cannot be sent as ${item.status}`);
			continue;
		}
		const copies = all.filter(t => OPEN.has(t.status));
		if (item.status === "completed") { finish(item, copies, all); continue; }
		if (item.status === "cancelled") { cancel(item, copies, all); continue; }

		const ofStatus = (...statuses: Status[]) => copies.filter(t => statuses.includes(t.status));
		if (current.status === "blocked") {
			if (item.status === "in_progress") {
				if (!blocker) {
					for (const task of names(item, ofStatus("blocked"), all)) unblocks.push({ op: "unblock", task });
					for (const task of names(item, ofStatus("blocked", "pending"), all)) starts.push({ op: "start", task });
				}
			} else if (!blocker) for (const task of names(item, ofStatus("blocked"), all)) unblocks.push({ op: "unblock", task });
		} else if (blocker) {
			for (const task of names(item, ofStatus("pending", "in_progress"), all)) blocks.push({ op: "block", task, reason: blocker });
		} else if (current.status === "pending") {
			if (item.status === "in_progress") for (const task of names(item, copies, all)) starts.push({ op: "start", task });
		} else if (item.status === "pending") {
			problems.push(`"${item.content}" is in progress and cannot go back to pending: to pause it, keep it in_progress and set blocker`);
		}
	}

	const reported = new Set<string>();
	for (const t of plan) {
		if (seen.has(t.content) || reported.has(t.content) || !OPEN.has(t.status)) continue;
		reported.add(t.content);
		problems.push(accepted.has(t.content)
			? `"${t.content}" is missing from the list: keep it, or mark it cancelled with a reason`
			: `"${t.content}" was added to the Kata plan outside this session and is requested work: send it back unchanged`);
	}

	if (problems.length) {
		const refusal = ["Refused: this list disagrees with the Kata plan. Nothing was changed.", ...problems.map(p => `- ${p}`), planTail(plan)].join("\n");
		return { refusal, problems };
	}
	return { ops: [...(appended.length ? [{ op: "append", items: appended } as ListOp] : []), ...closes, ...unblocks, ...blocks, ...starts] };
}

// ------------------------------------------------------------------------------------------------ omp's native list

export type NativeStatus = "pending" | "in_progress" | "completed" | "abandoned";
export type NativePhase = { name: string; tasks: { content: string; status: NativeStatus }[] };
export type NativeItem = { phase: string; content: string; status: NativeStatus };
// What the Kata plan must do to follow omp's list, in the order to do it: removals and settlements first (so two tasks are never
// started at once), then new tasks, then starts.
export type NativeStep =
	// `cleared`: Kata already has the task closed (the agent closed it before marking it done): drops a stale `needs-review` label.
	| { step: "rm" | "drop" | "pause" | "start" | "cleared"; task: Task }
	// `lastOfTicket`: the task is an item naming a ticket, and no other item of that ticket is still open (omp lists it open, never listed it, or is not led).
	| { step: "flag"; task: Task; lastOfTicket: boolean }
	// A task omp's list has and the plan lacks, or a closed one omp's list wants open again (named by the plan's phase).
	// `start`: omp's list has it in progress, so it is started once appended.
	| { step: "append"; phase: string; content: string; start?: boolean };

const nativeOpen = (status: NativeStatus | undefined) => status === "pending" || status === "in_progress";

// The plan follows what CHANGED in omp's list, not every difference from Kata: a Kata-side change (an agent's `kata close`, a delegate's close,
// a hand-back) stands while omp's status for that task is the one it had at the last mirror.
// `prev`: content -> status of the last list mirrored for the session. `led`: the plan task is this session's to change (not delegated, not
// held by another session); the others are left alone. Tasks are keyed by content: omp keeps one task per content across all phases, so a
// phase change of a known task is ignored.
export function diffNativeList(tasks: readonly Task[], prev: ReadonlyMap<string, NativeStatus>, next: readonly NativeItem[], led: (task: Task) => boolean): NativeStep[] {
	const status = new Map<string, NativeStatus>();
	for (const item of next) if (!status.has(item.content)) status.set(item.content, item.status);
	const copies = groupsOf(tasks);
	const removals: NativeStep[] = [], settles: NativeStep[] = [], adds: NativeStep[] = [], starts: NativeStep[] = [];
	for (const task of tasks) if (OPEN.has(task.status) && !status.has(task.content) && prev.has(task.content) && led(task)) removals.push({ step: "rm", task });
	for (const [content, wanted] of status) {
		const item = next.find(n => n.content === content)!;
		const group = copies.get(content);
		const task = group && representative(group);
		if (!task) { if (nativeOpen(wanted)) adds.push({ step: "append", phase: item.phase, content, start: wanted === "in_progress" }); continue; }
		const before = prev.get(content);
		// Steps on an open task reach every open copy of the content (one title in several phases) that this session leads.
		const mine = (group ?? []).filter(c => OPEN.has(c.status) && led(c));
		if (before === wanted || (!mine.length && !led(task))) continue;
		const open = OPEN.has(task.status);
		if (wanted === "abandoned") { for (const c of mine) settles.push({ step: "drop", task: c }); }
		else if (wanted === "completed") {
			// Another open item of the ticket counts as closed once omp's list has it completed or abandoned, or has just removed it (its
			// removal closes it in Kata this same mirror). One omp never listed, or one this session does not lead, is still open.
			const stillOpen = (other: Task) => OPEN.has(other.status) && other.content !== content
				&& (nativeOpen(status.get(other.content)) || (!status.has(other.content) && (!prev.has(other.content) || !led(other))));
			// Already closed in Kata (the agent closed it before marking it done): only the completed bookkeeping is left, e.g. a stale needs-review.
			if (open) for (const c of mine) settles.push({ step: "flag", task: c, lastOfTicket: !!c.ticket && !tasks.some(o => o.ticket === c.ticket && stillOpen(o)) });
			else if (!task.ticket) settles.push({ step: "cleared", task });
		}
		// A task closed in Kata that omp's list wants open: reopened only when omp had it finished (or never listed it). One omp had open
		// was closed in Kata on purpose.
		else if (!open) {
			// A ticket item still starts, so that the plugin says the ticket is closed and never reopened.
			if (before !== undefined && nativeOpen(before) && !(task.ticket && wanted === "in_progress")) continue;
			if (wanted === "pending") adds.push({ step: "append", phase: task.phase, content }); else starts.push({ step: "start", task });
		}
		// A task Kata has in progress that omp's list just started: its session released it (or never held it), so the start marks it for this one.
		else if (wanted === "in_progress") { for (const c of mine) if (c.status === "pending" || c.released) starts.push({ step: "start", task: c }); }
		else if (before === "in_progress") { for (const c of mine) if (c.status === "in_progress") settles.push({ step: "pause", task: c }); }
	}
	return [...removals, ...settles, ...adds, ...starts];
}

// omp's `todo` tool takes a `task` that may name several tasks in one string; the same split it makes (packages/tui/src/tools/todo.ts
// `todoTaskTargets`, omp 19.1.1): a string naming a task verbatim is one target, else the first delimiter whose parts all name a task wins.
const TASK_LIST_DELIMITERS: readonly { pattern: RegExp; partial: boolean }[] = [
	{ pattern: /\r?\n/, partial: true },
	{ pattern: /;/, partial: true },
	{ pattern: /,/, partial: true },
	{ pattern: /\s+/, partial: false },
	{ pattern: /[\s,;]+/, partial: false },
];
const normalizeTaskPart = (part: string) => {
	const trimmed = part.trim();
	return /^(["'`])(.*)\1$/s.exec(trimmed)?.[2].trim() ?? trimmed;
};
export function nativeTargets(known: ReadonlySet<string>, task: string | readonly string[] | undefined): string[] {
	if (task === undefined || task === "") return [];
	return (typeof task === "string" ? [task] : task).flatMap(content => {
		if (known.has(content)) return [content];
		let partial: string[] | undefined;
		for (const delimiter of TASK_LIST_DELIMITERS) {
			const parts = content.split(delimiter.pattern).map(normalizeTaskPart).filter(part => part.length > 0);
			const named = parts.filter(part => known.has(part)).length;
			if (named > 0 && named === parts.length) return parts;
			if (!partial && delimiter.partial && named > 0 && parts.length > 1) partial = parts;
		}
		return partial ?? [content];
	});
}
