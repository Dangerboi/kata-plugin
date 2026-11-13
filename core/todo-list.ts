// Pure diff between the whole todo list a model sends and the Kata plan: no Kata, no host, no I/O.
import type { Status } from "./model";

export type ListStatus = "pending" | "in_progress" | "completed" | "cancelled";
export type ListItem = { content: string; status: ListStatus; message?: string; evidence?: string[]; reason?: string; blocker?: string };
export type PlanItem = { content: string; status: Status; blocker?: string };
export type ListOp =
	| { op: "append"; items: string[] }
	| { op: "start"; task: string }
	| { op: "done"; task: string; message: string; evidence: string[] }
	| { op: "drop"; task: string; message: string }
	| { op: "block"; task: string; reason: string }
	| { op: "unblock"; task: string };
export type ListView = { content: string; status: ListStatus; blocker?: string };

const LISTED: Record<Status, ListStatus> = { pending: "pending", in_progress: "in_progress", blocked: "in_progress", completed: "completed", abandoned: "cancelled" };

export function listOf(plan: readonly PlanItem[]): ListView[] {
	return plan.map(t => t.status === "blocked" ? { content: t.content, status: "in_progress", blocker: t.blocker || "blocked" } : { content: t.content, status: LISTED[t.status] });
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
	const known = new Map<string, PlanItem>();
	for (const t of plan) if (!known.has(t.content)) known.set(t.content, t);
	const seen = new Set<string>();
	const appended: string[] = [], closes: ListOp[] = [], unblocks: ListOp[] = [], blocks: ListOp[] = [], starts: ListOp[] = [];

	const finish = (item: ListItem) => {
		const missing = proofMissing(item);
		if (missing) problems.push(missing);
		else closes.push({ op: "done", task: item.content, message: item.message!, evidence: item.evidence!.filter(e => e.trim()) });
	};
	const cancel = (item: ListItem) => {
		if (!item.reason?.trim()) problems.push(`"${item.content}" cannot be cancelled without a reason`);
		else closes.push({ op: "drop", task: item.content, message: item.reason });
	};

	for (const item of incoming) {
		if (!item.content.trim()) { problems.push("an item has blank content"); continue; }
		if (seen.has(item.content)) { problems.push(`"${item.content}" appears more than once`); continue; }
		seen.add(item.content);
		const blocker = item.blocker?.trim() ? item.blocker : undefined;
		const current = known.get(item.content);

		if (!current) {
			if (item.status === "cancelled") { problems.push(`"${item.content}" is new and cannot be cancelled: leave it out instead`); continue; }
			appended.push(item.content);
			if (item.status === "completed") finish(item);
			else if (blocker) blocks.push({ op: "block", task: item.content, reason: blocker });
			else if (item.status === "in_progress") starts.push({ op: "start", task: item.content });
			continue;
		}

		if (current.status === "completed" || current.status === "abandoned") {
			if (item.status !== LISTED[current.status]) problems.push(`"${item.content}" is already ${LISTED[current.status]} in Kata and cannot be sent as ${item.status}`);
			continue;
		}
		if (item.status === "completed") { finish(item); continue; }
		if (item.status === "cancelled") { cancel(item); continue; }

		if (current.status === "blocked") {
			if (item.status === "in_progress") {
				if (!blocker) { unblocks.push({ op: "unblock", task: item.content }); starts.push({ op: "start", task: item.content }); }
			} else if (!blocker) unblocks.push({ op: "unblock", task: item.content });
		} else if (blocker) {
			blocks.push({ op: "block", task: item.content, reason: blocker });
		} else if (current.status === "pending") {
			if (item.status === "in_progress") starts.push({ op: "start", task: item.content });
		} else if (item.status === "pending") {
			problems.push(`"${item.content}" is in progress and cannot go back to pending: to pause it, keep it in_progress and set blocker`);
		}
	}

	for (const t of plan) {
		if (seen.has(t.content) || t.status === "completed" || t.status === "abandoned") continue;
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
