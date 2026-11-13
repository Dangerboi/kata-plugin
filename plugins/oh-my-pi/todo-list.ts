// Pure diff between the whole todo list a model sends and the Kata plan: no Kata, no host, no I/O.
import type { Status } from "./model";

export type ListStatus = "pending" | "in_progress" | "completed" | "cancelled";
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
export type ListView = { content: string; status: ListStatus; blocker?: string };

const LISTED: Record<Status, ListStatus> = { pending: "pending", in_progress: "in_progress", blocked: "in_progress", completed: "completed", abandoned: "cancelled" };

// The plan task a list item stands for. Core identity is phase+content, so one content can have several tasks: they are one
// list item. Open copies stand in front of closed ones; among open ones an in_progress copy, then a paused one, then a
// pending one, so the item never reads as pending while a copy is in progress.
function representative(copies: readonly PlanItem[]): PlanItem {
	const open = copies.filter(t => t.status !== "completed" && t.status !== "abandoned");
	if (open.length) return open.find(t => t.status === "in_progress") ?? open.find(t => t.status === "blocked") ?? open[0];
	return copies.find(t => t.status === "completed") ?? copies[0];
}

function groupsOf(plan: readonly PlanItem[]): Map<string, PlanItem[]> {
	const groups = new Map<string, PlanItem[]>();
	for (const t of plan) {
		const copies = groups.get(t.content);
		if (copies) copies.push(t); else groups.set(t.content, [t]);
	}
	return groups;
}

export function listOf(plan: readonly PlanItem[]): ListView[] {
	return [...groupsOf(plan).values()].map(representative).map(t => t.status === "blocked" ? { content: t.content, status: "in_progress", blocker: t.blocker || "blocked" } : { content: t.content, status: LISTED[t.status] });
}

const proofMissing = (item: ListItem): string | undefined => {
	const long = (item.message || "").replace(/\s+/g, " ").trim().length >= 40;
	const evidence = !!item.evidence?.some(e => e.trim());
	if (!long && !evidence) return `"${item.content}" cannot be completed without a message (40+ characters saying what changed and how it was verified) and evidence`;
	if (!long) return `"${item.content}" cannot be completed without a message of 40+ characters saying what changed and how it was verified`;
	if (!evidence) return `"${item.content}" cannot be completed without evidence`;
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
		if (current.status === "completed" || current.status === "abandoned") {
			// Copies closed both ways read back as completed, but dropping an item with a completed copy leaves exactly that mix,
			// so either closed status is the same item.
			const mixed = all.some(t => t.status === "completed") && all.some(t => t.status === "abandoned");
			if (mixed && (item.status === "completed" || item.status === "cancelled")) continue;
			if (item.status !== LISTED[current.status]) problems.push(`"${item.content}" is already ${LISTED[current.status]} in Kata and cannot be sent as ${item.status}`);
			continue;
		}
		const copies = all.filter(t => t.status !== "completed" && t.status !== "abandoned");
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
		if (seen.has(t.content) || reported.has(t.content) || t.status === "completed" || t.status === "abandoned") continue;
		reported.add(t.content);
		problems.push(accepted.has(t.content)
			? `"${t.content}" is missing from the list: keep it, or mark it cancelled with a reason`
			: `"${t.content}" was added to the Kata plan outside this session and is requested work: send it back unchanged`);
	}

	if (problems.length) {
		const refusal = [
			"Refused: this list disagrees with the Kata plan. Nothing was changed.",
			...problems.map(p => `- ${p}`),
			"The current Kata plan is below. Send it again with your changes applied on top:",
			JSON.stringify({ todos: listOf(plan) }),
		].join("\n");
		return { refusal, problems };
	}
	// Closes run before starts: append, done/drop, unblock, block, start.
	return { ops: [...(appended.length ? [{ op: "append", items: appended } as ListOp] : []), ...closes, ...unblocks, ...blocks, ...starts] };
}
