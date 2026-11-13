import { isUnusable, type Kata } from "./kata-cli";
import { projectOf, qualifiedRef, type Binding, type Change, type KataIssue, type KataShow, type Status, type Task } from "./model";

// Settlement: the closes the plugin still owes a session. Throttled task closes,
// ticket closes waiting on open children, and the automatic parent's close are
// retried by one drain, woken by one timer, and saved in one snapshot.

export const RETRY_MS = 60_000;
const TIMER_MS = RETRY_MS + 100;
// A pending close that keeps failing for a reason other than the throttle is dropped after this many drains.
export const MAX_FAILURES = 3;

export type CloseRequest = { key: string; message: string; evidence: string[] };
export type PendingClose = CloseRequest & { cwd: string };
// `parent`: the plan parent of a plan task's close; none for a ticket item's.
export type TaskClose = { task: Task; to: Status; change: Change; cwd: string; at: number; parent?: string };
export type SettlementSnapshot = {
	autoParents: Binding[];
	retries: [string, TaskClose][];
	pendingCloses?: [string, PendingClose][];
};

export interface SettlementDeps {
	namespace: string;
	kata: Pick<Kata, "run" | "show" | "projects">;
	owned(ref: string, cwd: string, mayClaim?: boolean | "check", allowClosed?: boolean, revision?: number): Promise<KataIssue>;
	clock(): number;
	// Calls `fire` once after `ms` and returns what cancels it.
	timer(fire: () => void, ms: number): () => void;
	// The timer fired: the core runs its drain inside its serial queue.
	due(): void;
	delegatesRunning(): boolean;
	// Whether the session still has an open item naming this ticket.
	itemsOpen(ticket: string): boolean;
	// Re-run a throttled close (the transition or removal), then reload and advance the plan.
	performTask(pending: TaskClose): Promise<void>;
	// Close the ticket with the saved request.
	performTicket(ticket: string, request: PendingClose): Promise<void>;
	// A close was dropped: label the issue needs-review and comment with Kata's error code.
	flag(ref: string, cwd: string, error: unknown): Promise<void>;
	debug(error: unknown): void;
}

export interface Settlement {
	pendTaskClose(task: Task, to: Status, change: Change, cwd: string, parent?: string): string;
	cancelTaskClose(ref: string): void;
	hasTaskClose(ref: string): boolean;
	// Drop the task's pending removal and its failure count; a pending completion stays.
	cancelRemoval(ref: string): void;
	holdTicketClose(ticket: string, request: CloseRequest, cwd: string): void;
	addAutoParent(binding: Binding): void;
	dropAutoParent(parent: string): void;
	// The plan parent was deleted: drop its automatic parent's close and its plan tasks' pending closes.
	dropPlan(parent: string): void;
	// Whether a plan task of this plan parent has a pending close.
	hasPlanCloses(parent: string): boolean;
	// The plan parent moved: its automatic parent's close and its plan tasks' pending closes follow it.
	renamePlan(old: string, current: string): void;
	// Arm the timer (the core's local plan retries on it too).
	schedule(): void;
	// `parents: false` leaves the automatic parents open (the host closes them when the session ends).
	drain(options?: { parents?: boolean }): Promise<void>;
	snapshot(): SettlementSnapshot;
	restore(saved: SettlementSnapshot | undefined): void;
}

const codeOf = (error: unknown) => (error as { code?: string } | undefined)?.code;
// Qualified refs of a ticket's open children.
export const openChildren = (view: KataShow, ticket: string): string[] => (view.children ?? []).filter(c => c.status !== "closed").map(c => qualifiedRef(c, ticket));

function proofArgs(items: any[]): string[] {
	const values = new Set<string>();
	for (const item of items) {
		if (item.type === "attachment") continue; // Kata only accepts attachments linked on the closed issue itself, so a child's never carries over.
		const key: Record<string, string> = { commit: "sha", pr: "url", test: "command", external: "account", "no-change-audit": "rationale", "duplicate-of": "issue_ref", "superseded-by": "issue_ref" };
		const value = item[key[item.type]];
		if (typeof value === "string" && value.trim()) values.add(`${item.type}:${value}`);
		else if (item.type === "reviewed-paths" && Array.isArray(item.paths) && item.paths.length) for (const file of item.paths) { if (typeof file !== "string" || !file.trim()) throw new Error("Malformed Kata evidence"); values.add(`reviewed-paths:${file}`); }
		else throw new Error("Malformed or unknown Kata evidence");
	}
	return [...values].flatMap(value => ["--evidence", value]);
}

export function createSettlement(deps: SettlementDeps): Settlement {
	const { namespace, kata, owned, clock, debug } = deps;
	const autoParents = new Map<string, Binding>();
	const retries = new Map<string, TaskClose>();
	const pendingCloses = new Map<string, PendingClose>();
	// Drains a pending close has failed (not throttled), in memory only.
	const failures = new Map<string, number>();
	// Audited and flagged at this revision with these children: not audited again until either changes. In memory only.
	const flagged = new Map<string, string>();
	const verdictKey = (view: KataShow, revision = view.issue.revision) => `${revision}|${(view.children ?? []).map(c => `${c.uid}:${c.revision}`).sort().join(",")}`;
	let cancelTimer: (() => void) | undefined;

	function schedule() {
		if (cancelTimer) return;
		cancelTimer = deps.timer(() => { cancelTimer = undefined; deps.due(); }, TIMER_MS);
	}
	function clearTimer() { cancelTimer?.(); cancelTimer = undefined; }

	// A failed close counts one drain; the third drops it and flags the issue. Kata being unreachable counts none.
	async function failed(key: string, ref: string, cwd: string, error: unknown, drop: () => void) {
		debug(error);
		if (isUnusable(error)) return;
		const count = (failures.get(key) ?? 0) + 1;
		if (count < MAX_FAILURES) { failures.set(key, count); return; }
		failures.delete(key);
		drop();
		await deps.flag(ref, cwd, error).catch(debug);
	}

	// Drop a pending task close and its failure count.
	function dropTask(ref: string) { retries.delete(ref); failures.delete(`task:${ref}`); }

	async function drainTasks() {
		for (const [ref, pending] of retries) {
			if (pending.at > clock()) continue;
			try {
				const current: KataIssue = (await kata.show(ref, pending.cwd)).issue;
				if (pending.task.revision === undefined || current.status !== "open" || current.revision !== pending.task.revision) { dropTask(ref); continue; }
				await deps.performTask(pending);
				if (retries.get(ref) === pending) retries.delete(ref);
				failures.delete(`task:${ref}`);
			} catch (error) {
				// Throttled again: the close is pending anew, not failed.
				if (retries.get(ref) !== pending) continue;
				await failed(`task:${ref}`, pending.task.ref, pending.cwd, error, () => retries.delete(ref));
			}
		}
	}

	async function drainTickets() {
		for (const [ticket, pending] of pendingCloses) {
			try {
				const view: KataShow = await kata.show(ticket, pending.cwd);
				if (view.issue.status !== "open" || deps.itemsOpen(ticket)) { pendingCloses.delete(ticket); failures.delete(`ticket:${ticket}`); continue; }
				if (openChildren(view, ticket).length) continue;
				await deps.performTicket(ticket, pending);
				pendingCloses.delete(ticket); failures.delete(`ticket:${ticket}`);
			} catch (error) {
				if (codeOf(error) === "sibling_throttle") { debug(error); continue; }
				await failed(`ticket:${ticket}`, ticket, pending.cwd, error, () => pendingCloses.delete(ticket));
			}
		}
	}

	async function auditAutoParents() {
		for (const binding of autoParents.values()) {
			const { parent, workspace } = binding;
			let decision: KataIssue | undefined, initial: KataShow | undefined;
			try {
				if (deps.delegatesRunning()) return;
				initial = await kata.show(parent, workspace);
				const children = initial.children ?? [];
				if (initial.issue.status === "closed" || initial.issue.metadata?.[`${namespace}.auto_parent`] !== true || initial.issue.metadata?.[`${namespace}.session_id`] !== binding.sessionId) continue;
				if (!children.length || children.some(c => c.status !== "closed")) continue;
				if (flagged.get(parent) === verdictKey(initial)) continue;
				decision = await owned(parent, workspace, false, false, initial.issue.revision);
				const closedTimes = children.filter(c => c.closed_reason !== "wontfix").map(c => Date.parse(c.closed_at ?? ""));
				if (closedTimes.some((time: number) => !Number.isFinite(time))) throw new Error("Kata child close time unavailable");
				const since = closedTimes.length ? new Date(Math.min(...closedTimes)).toISOString() : undefined;
				const evidence: any[] = [];
				const audits = new Map<string, any[]>();
				for (const child of children) {
					if (child.closed_reason === "wontfix") continue;
					let project = child.qualified_id ? projectOf(child.qualified_id) : undefined;
					if (!project && child.project_id === initial.issue.project_id) project = projectOf(parent);
					project ??= (await kata.projects(workspace)).find(p => p.id === child.project_id)?.name;
					if (!project) throw new Error("Kata child project unavailable");
					if (!audits.has(project)) audits.set(project, JSON.parse(await kata.run(["audit", "closes", "--project", project, "--since", since!], workspace)).rows);
					const rows = audits.get(project)!;
					const row = rows.filter((r: any) => r.issue === child.short_id).sort((a: any, b: any) => b.event_id - a.event_id)[0];
					if (!row?.event_id) throw new Error("Kata child close event unavailable");
					const page = JSON.parse(await kata.run(["events", "--project", project, "--after", String(row.event_id - 1), "--limit", "1"], workspace));
					const event = page.events?.[0];
					if (page.reset_required || event?.event_id !== row.event_id || event.type !== "issue.closed" || event.issue_uid !== child.uid || Date.parse(event.payload?.closed_at) !== Date.parse(child.closed_at ?? "") || !Array.isArray(event.payload?.evidence) || !event.payload.evidence.length) throw new Error("Kata current child evidence unavailable");
					evidence.push(...event.payload.evidence);
				}
				const proof = proofArgs(evidence);
				if (!proof.length) throw new Error("Kata child close evidence union is empty");
				const final: KataShow = await kata.show(parent, workspace);
				const finalChildren = final.children ?? [];
				if (final.issue.status === "closed" || deps.delegatesRunning()) continue;
				if (final.issue.revision !== initial.issue.revision || finalChildren.length !== children.length || finalChildren.some(c => c.status !== "closed" || !children.some(old => old.uid === c.uid && old.revision === c.revision))) continue;
				await kata.run(["close", parent, "--done", "--if-match", String(final.issue.revision), "--idempotency-key", `${namespace}-parent-close:${parent}:${final.issue.revision}`, "--message", `${namespace.toUpperCase()} session ${binding.sessionId}: all ${finalChildren.length} child issues are closed in Kata and delegated work has settled. Evidence is the union of their current Kata-recorded close events.`, ...proof], workspace);
			} catch (error) {
				debug(error);
				if (codeOf(error) === "sibling_throttle") { schedule(); continue; }
				try {
					const live = await owned(parent, workspace);
					if (decision && live.revision !== decision.revision) continue;
					await kata.run(["label", "add", parent, "needs-review"], workspace);
					if (initial && !isUnusable(error)) {
						const current: KataShow = await kata.show(parent, workspace);
						flagged.set(parent, verdictKey(initial, current.issue.revision));
					}
				} catch (error) { debug(error); }
			}
		}
	}

	return {
		pendTaskClose(task, to, change, cwd, parent) {
			retries.set(task.ref, { task: { ...task }, to, change: { ...change }, cwd, at: clock() + RETRY_MS, ...(parent ? { parent } : {}) });
			failures.delete(`task:${task.ref}`);
			schedule();
			return `Kata deferred closing "${task.content}" under its sibling throttle. It remains open and will retry after 60 seconds.`;
		},
		cancelTaskClose: dropTask,
		hasTaskClose: ref => retries.has(ref),
		cancelRemoval(ref) { if (retries.get(ref)?.change.remove === true) dropTask(ref); },
		holdTicketClose(ticket, request, cwd) { pendingCloses.set(ticket, { ...request, cwd }); failures.delete(`ticket:${ticket}`); },
		addAutoParent(binding) { autoParents.set(binding.parent, binding); },
		dropAutoParent(parent) { autoParents.delete(parent); },
		dropPlan(parent) {
			autoParents.delete(parent);
			for (const [ref, pending] of retries) if (pending.parent === parent) dropTask(ref);
		},
		hasPlanCloses: parent => [...retries.values()].some(pending => pending.parent === parent),
		renamePlan(old, current) {
			const marker = autoParents.get(old);
			autoParents.delete(old);
			if (marker) autoParents.set(current, { ...marker, parent: current });
			for (const pending of retries.values()) if (pending.parent === old) pending.parent = current;
		},
		schedule,
		// Never throws. A running delegate pauses only the automatic-parent audit.
		async drain({ parents = true } = {}) {
			try {
				await drainTasks();
				await drainTickets();
				if (parents) await auditAutoParents();
			} catch (error) { debug(error); }
			if (retries.size) schedule();
		},
		snapshot: () => ({
			autoParents: [...autoParents.values()], retries: [...retries.entries()],
			...(pendingCloses.size ? { pendingCloses: [...pendingCloses.entries()] } : {}),
		}),
		restore(saved) {
			retries.clear(); autoParents.clear(); pendingCloses.clear(); failures.clear(); flagged.clear();
			clearTimer();
			if (!saved) return;
			for (const binding of saved.autoParents ?? []) autoParents.set(binding.parent, binding);
			for (const [ref, pending] of saved.retries ?? []) retries.set(ref, pending);
			for (const [ticket, pending] of saved.pendingCloses ?? []) pendingCloses.set(ticket, pending);
			if (retries.size) schedule();
		},
	};
}
