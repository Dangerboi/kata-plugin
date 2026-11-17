// Generated from core/settlement.ts; edit there.
import { isUnusable, type Job, type Kata } from "./kata-cli";
import { isMission, missionCloseArgs, projectOf, qualifiedRef, sessionParentKeys, type Binding, type Change, type KataIssue, type KataShow, type Status, type Task } from "./model";

// Settlement: the closes the plugin still owes a session. Throttled task closes,
// ticket closes waiting on open children, and the automatic parent's close (with
// any mission its delegate's settle left open) are retried by one drain, woken by
// one timer, and saved in one snapshot.

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
	kata: Pick<Kata, "run" | "show" | "projects" | "fresh">;
	owned(job: Job, ref: string, cwd: string, mayClaim?: boolean | "check", allowClosed?: boolean, revision?: number): Promise<KataIssue>;
	clock(): number;
	// Calls `fire` once after `ms` and returns what cancels it.
	timer(fire: () => void, ms: number): () => void;
	// The timer fired: the core runs its drain as a job of its serial queue.
	due(): void;
	delegatesRunning(): boolean;
	// Whether the session still has an open item naming this ticket.
	itemsOpen(ticket: string): boolean;
	// Re-run a throttled close (the transition or removal), then reload and advance the plan.
	performTask(job: Job, pending: TaskClose): Promise<void>;
	performTicket(job: Job, ticket: string, request: PendingClose): Promise<void>;
	// A close was dropped: label the issue needs-review and comment with Kata's error code.
	flag(job: Job, ref: string, cwd: string, error: unknown): Promise<void>;
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
	drain(job: Job, options?: { parents?: boolean }): Promise<void>;
	snapshot(): SettlementSnapshot;
	// Whether closes are still owed: a pending close (a task's or a ticket's), or an automatic parent whose close the last
	// audit still means to make, not one it left open on purpose (flagged needs-review, closed, or no longer this session's).
	// A parent not yet audited is owed.
	owes(): boolean;
	restore(saved: SettlementSnapshot | undefined): void;
}

const codeOf = (error: unknown) => (error as { code?: string } | undefined)?.code;
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
	const keys = sessionParentKeys(namespace);
	const autoParents = new Map<string, Binding>();
	const retries = new Map<string, TaskClose>();
	const pendingCloses = new Map<string, PendingClose>();
	// Drains a pending close has failed (not throttled), in memory only.
	const failures = new Map<string, number>();
	// Audited and flagged at this revision with these children: not audited again until either changes. In memory only.
	const flagged = new Map<string, string>();
	// Automatic parents the last audit finished with: nothing more to close. In memory only; a parent not yet audited is owed.
	const parentDone = new Set<string>();
	const verdictKey = (view: KataShow, revision = view.issue.revision) => `${revision}|${(view.children ?? []).map(c => `${c.uid}:${c.revision}`).sort().join(",")}`;
	let cancelTimer: (() => void) | undefined;

	function schedule() {
		if (cancelTimer) return;
		cancelTimer = deps.timer(() => { cancelTimer = undefined; deps.due(); }, TIMER_MS);
	}
	function clearTimer() { cancelTimer?.(); cancelTimer = undefined; }

	// A failed close counts one drain; the third drops it and flags the issue. Kata being unreachable counts none.
	async function failed(job: Job, key: string, ref: string, cwd: string, error: unknown, drop: () => void) {
		debug(error);
		if (isUnusable(error)) return;
		const count = (failures.get(key) ?? 0) + 1;
		if (count < MAX_FAILURES) { failures.set(key, count); return; }
		failures.delete(key);
		drop();
		await deps.flag(job, ref, cwd, error).catch(debug);
	}

	function dropTask(ref: string) { retries.delete(ref); failures.delete(`task:${ref}`); }

	async function drainTasks(job: Job) {
		for (const [ref, pending] of retries) {
			if (pending.at > clock()) continue;
			try {
				const current: KataIssue = (await kata.show(job, ref, pending.cwd)).issue;
				if (pending.task.revision === undefined || current.status !== "open" || current.revision !== pending.task.revision) { dropTask(ref); continue; }
				await deps.performTask(job, pending);
				if (retries.get(ref) === pending) retries.delete(ref);
				failures.delete(`task:${ref}`);
			} catch (error) {
				// Throttled again: the close is pending anew, not failed.
				if (retries.get(ref) !== pending) continue;
				await failed(job, `task:${ref}`, pending.task.ref, pending.cwd, error, () => retries.delete(ref));
			}
		}
	}

	async function drainTickets(job: Job) {
		for (const [ticket, pending] of pendingCloses) {
			try {
				const view: KataShow = await kata.show(job, ticket, pending.cwd);
				if (view.issue.status !== "open" || deps.itemsOpen(ticket)) { pendingCloses.delete(ticket); failures.delete(`ticket:${ticket}`); continue; }
				if (openChildren(view, ticket).length) continue;
				await deps.performTicket(job, ticket, pending);
				pendingCloses.delete(ticket); failures.delete(`ticket:${ticket}`);
			} catch (error) {
				if (codeOf(error) === "sibling_throttle") { debug(error); continue; }
				await failed(job, `ticket:${ticket}`, ticket, pending.cwd, error, () => pendingCloses.delete(ticket));
			}
		}
	}

	async function auditAutoParents(job: Job) {
		parentDone.clear();
		for (const binding of autoParents.values()) {
			const { parent, workspace } = binding;
			let decision: KataIssue | undefined, initial: KataShow | undefined;
			try {
				if (deps.delegatesRunning()) return;
				initial = await kata.show(job, parent, workspace);
				if (initial.issue.status === "closed" || initial.issue.metadata?.[keys.auto] !== true || initial.issue.metadata?.[keys.session] !== binding.sessionId) { parentDone.add(parent); continue; }
				// A mission whose delegate's settle never closed it (cut off at shutdown, killed, its close throttled) would hold the
				// parent open for good: the audit closes it once nothing else is open. No revision guard: the close decides nothing, and
				// one that lands after the delegate's own close (a pi child settling in its own process) changes nothing.
				const open = (initial.children ?? []).filter(c => c.status !== "closed");
				if (open.length && open.every(c => isMission(namespace, c))) {
					for (const c of open) await kata.run(job, missionCloseArgs(qualifiedRef(c, parent)), workspace);
					initial = await kata.show(job, parent, workspace);
				}
				const children = initial.children ?? [];
				if (!children.length || children.some(c => c.status !== "closed")) { parentDone.add(parent); continue; }
				if (flagged.get(parent) === verdictKey(initial)) { parentDone.add(parent); continue; }
				decision = await owned(job, parent, workspace, false, false, initial.issue.revision);
				// Retired tasks and missions add no evidence: a mission records a delegate's run and proves no change.
				const proven: KataIssue[] = [];
				let missionCount = 0;
				for (const c of children) if (isMission(namespace, c)) missionCount++; else if (c.closed_reason !== "wontfix") proven.push(c);
				const closedTimes = proven.map(c => Date.parse(c.closed_at ?? ""));
				if (closedTimes.some((time: number) => !Number.isFinite(time))) throw new Error("Kata child close time unavailable");
				const since = closedTimes.length ? new Date(Math.min(...closedTimes)).toISOString() : undefined;
				const evidence: any[] = [];
				const audits = new Map<string, any[]>();
				for (const child of proven) {
					let project = child.qualified_id ? projectOf(child.qualified_id) : undefined;
					if (!project && child.project_id === initial.issue.project_id) project = projectOf(parent);
					project ??= (await kata.projects(job, workspace)).find(p => p.id === child.project_id)?.name;
					if (!project) throw new Error("Kata child project unavailable");
					if (!audits.has(project)) audits.set(project, JSON.parse(await kata.run(job, ["audit", "closes", "--project", project, "--since", since!], workspace)).rows);
					const rows = audits.get(project)!;
					const row = rows.filter((r: any) => r.issue === child.short_id).sort((a: any, b: any) => b.event_id - a.event_id)[0];
					if (!row?.event_id) throw new Error("Kata child close event unavailable");
					const page = JSON.parse(await kata.run(job, ["events", "--project", project, "--after", String(row.event_id - 1), "--limit", "1"], workspace));
					const event = page.events?.[0];
					if (page.reset_required || event?.event_id !== row.event_id || event.type !== "issue.closed" || event.issue_uid !== child.uid || Date.parse(event.payload?.closed_at) !== Date.parse(child.closed_at ?? "") || !Array.isArray(event.payload?.evidence) || !event.payload.evidence.length) throw new Error("Kata current child evidence unavailable");
					evidence.push(...event.payload.evidence);
				}
				// A plan of only missions (and retired tasks) had no work of its own to prove.
				const runsPhrase = `${missionCount} recorded subagent run${missionCount === 1 ? "" : "s"}`;
				let verdict: string[], basis: string;
				if (!proven.length && missionCount) {
					verdict = ["--audit-no-change", "--evidence", `no-change-audit:The plan had no work beyond ${runsPhrase}; any change a run made is the lead's to verify.`];
					basis = `The plan had no work of its own beyond ${runsPhrase}.`;
				} else {
					const proof = proofArgs(evidence);
					if (!proof.length) throw new Error("Kata child close evidence union is empty");
					verdict = ["--done", ...proof];
					basis = "Evidence is the union of their current Kata-recorded close events.";
				}
				// Read again past the operation's earlier reads: the children may have changed while the evidence was gathered.
				const final: KataShow = await kata.show(kata.fresh(job), parent, workspace);
				const finalChildren = final.children ?? [];
				if (final.issue.status === "closed") { parentDone.add(parent); continue; }
				if (deps.delegatesRunning()) continue;
				if (final.issue.revision !== initial.issue.revision || finalChildren.length !== children.length || finalChildren.some(c => c.status !== "closed" || !children.some(old => old.uid === c.uid && old.revision === c.revision))) continue;
				await kata.run(job, ["close", parent, "--if-match", String(final.issue.revision), "--idempotency-key", `${namespace}-parent-close:${parent}:${final.issue.revision}`, "--message", `${namespace.toUpperCase()} session ${binding.sessionId}: all ${finalChildren.length} child issues are closed in Kata and delegated work has settled. ${basis}`, ...verdict], workspace);
				parentDone.add(parent);
			} catch (error) {
				debug(error);
				if (codeOf(error) === "sibling_throttle") { schedule(); continue; }
				try {
					const live = await owned(kata.fresh(job), parent, workspace);
					if (decision && live.revision !== decision.revision) continue;
					await kata.run(job, ["label", "add", parent, "needs-review"], workspace);
					if (initial && !isUnusable(error)) {
						const current: KataShow = await kata.show(job, parent, workspace);
						flagged.set(parent, verdictKey(initial, current.issue.revision));
						// Left open on purpose, flagged for a person: not a close the audit still means to make.
						parentDone.add(parent);
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
			return `Kata deferred closing "${task.content}" under its sibling throttle. It remains open and will retry after ${RETRY_MS / 1000} seconds.`;
		},
		cancelTaskClose: dropTask,
		hasTaskClose: ref => retries.has(ref),
		cancelRemoval(ref) { if (retries.get(ref)?.change.remove === true) dropTask(ref); },
		holdTicketClose(ticket, request, cwd) { pendingCloses.set(ticket, { ...request, cwd }); failures.delete(`ticket:${ticket}`); },
		addAutoParent(binding) { autoParents.set(binding.parent, binding); parentDone.delete(binding.parent); },
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
		async drain(job, { parents = true } = {}) {
			try {
				await drainTasks(job);
				await drainTickets(job);
				if (parents) await auditAutoParents(job);
			} catch (error) { debug(error); }
			if (retries.size) schedule();
		},
		snapshot: () => ({
			autoParents: [...autoParents.values()], retries: [...retries.entries()],
			...(pendingCloses.size ? { pendingCloses: [...pendingCloses.entries()] } : {}),
		}),
		owes: () => retries.size > 0 || pendingCloses.size > 0 || [...autoParents.keys()].some(parent => !parentDone.has(parent)),
		restore(saved) {
			retries.clear(); autoParents.clear(); pendingCloses.clear(); failures.clear(); flagged.clear(); parentDone.clear();
			clearTimer();
			if (!saved) return;
			for (const binding of saved.autoParents ?? []) autoParents.set(binding.parent, binding);
			for (const [ref, pending] of saved.retries ?? []) retries.set(ref, pending);
			for (const [ticket, pending] of saved.pendingCloses ?? []) pendingCloses.set(ticket, pending);
			if (retries.size) schedule();
		},
	};
}
