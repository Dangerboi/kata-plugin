// Generated from core/delegates.ts; edit there.
import { closedTaskStatus, digest, heldBySession, heldMessage, itemTicket, missionCloseArgs, missionKey, OPEN, projectOf, qualifiedRefs, tasksOf, TITLE_MAX, TODO_WORDING, type Binding, type KataIssue, type KataShow, type Plan, type Task, type ToolWording } from "./model";
import { isKataCode, isUnusable, type Job, type Kata } from "./kata-cli";

// The delegate lifecycle, shared by every host: an omp or OpenCode lead and the pi child (see GLOSSARY.md: Delegate,
// Assignment, Untracked delegate, Mission, Hand back, Report). Adapters translate host events into DelegateEvents;
// everything Kata-side that follows (what a spawn works, the assignment's writes, settling, rollback, hand back, missions)
// lives here.

// ------------------------------------------------------------------ what a spawn works

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The open tasks a text names: title (case-insensitive, whole words; a one- or
// two-word title only quoted or as the whole text), qualified ref, short id
// after a marker, since a bare id can be an ordinary word ("test"), or for a
// ticket item its ticket's qualified ref, unless that ticket is the plan
// `parent`, which is no work target. A title inside a longer title the text
// names yields to the longer one; a task named only by a ref shadows nothing.
export function namedTasks(tasks: Task[], text: string, parent?: string): Task[] {
	const titled = (title: string) => {
		const phrase = escape(title.trim());
		if (text.trim().toLowerCase() === title.trim().toLowerCase()) return true;
		if (new RegExp(`["'\`\u201c\u2018]\\s*${phrase}\\s*["'\`\u201d\u2019]`, "i").test(text)) return true;
		return title.trim().split(/\s+/).length >= 3 && new RegExp(`(?<![\\w])${phrase}(?![\\w])`, "i").test(text);
	};
	const cited = (ref: string) => new RegExp(`(?<![\\w./#-])${escape(ref)}(?![\\w-])`).test(text);
	const named = tasks.filter(t => OPEN.has(t.status) && (titled(t.content) || cited(t.ref) || (!!t.ticket && t.ticket !== parent && cited(t.ticket)) ||
		new RegExp(`(?:\\b(?:issue|kata|ref|task)\\b\\s*[:=]?\\s*|(?<![\\w.-])#)${escape(t.ref.split("#").pop()!)}(?![\\w-])`, "i").test(text)));
	const byTitle = named.filter(t => titled(t.content));
	return named.filter(t => !byTitle.some(other => other !== t && other.content.length > t.content.length && other.content.toLowerCase().includes(t.content.toLowerCase())));
}

// Everything a delegation prompt names: plan tasks, and qualified refs that are
// no plan item (the plan parent itself is no work target). Only refs of the
// registered `projects` are tickets; any other look-alike is text.
export function namedTargets(tasks: Task[], text: string, projects: ReadonlySet<string>, parent?: string): { tasks: Task[]; tickets: string[] } {
	const known = new Set(tasks.map(t => t.ref));
	return { tasks: namedTasks(tasks, text, parent), tickets: qualifiedRefs(text, projects).filter(ref => !known.has(ref) && ref !== parent) };
}

// Why a spawn cannot be delegated as it is. `targets`: the tickets and plan items it named, when it named more than one.
export class Refusal extends Error {
	constructor(message: string, readonly targets?: string[]) { super(message); }
}

// What a spawn works. No `ref`: nothing, so its delegate is untracked. `ticket`: `ref` is a ticket (one outside the plan, or
// a ticket item's), which its delegate closes whole. `title` names that work: the plan item's text without a ticket prefix,
// or the title of a ticket outside the plan.
export type Reservation = { ref?: string; ticket?: boolean; title?: string };
// `wait`: the spawn names a task of a local plan, which has no issue until the plan is replayed.
type Resolved = Reservation & { wait?: true };

// How a refusal calls a spawn that no check() numbered.
const THE_TASK = "The task";

// The one decision of what a spawn's text works in a plan, for check() and for a delegate that starts with nothing reserved.
// Nothing is guessed: a text that names no task or ticket works nothing, and so does one that names a blocked item. A text
// that names several targets, a task or ticket in `taken` (refs other spawns and delegates hold), a task another delegate or
// session holds, or a ticket other open items name is refused. `spawn` is how a refusal calls the spawn; its advice is in
// the words of the host's todo tool.
export function resolve(text: string, plan: Pick<Plan, "tasks" | "parent" | "local">, taken: ReadonlySet<string>, projects: ReadonlySet<string>, spawn = THE_TASK, wording: ToolWording = TODO_WORDING): Resolved {
	const { tasks: named, tickets: others } = namedTargets(plan.tasks, text, projects, plan.parent);
	const targets = [...new Set([...named.map(t => t.ticket ?? t.ref), ...others])];
	if (targets.length > 1) throw new Refusal(`${spawn} names more than one ticket or plan item (${targets.join(", ")}). Name one ticket per task and split the work across tasks.`, targets);
	const ticket = others[0] ?? named[0]?.ticket;
	if (!ticket) {
		// At most one plain task is named here (two would be two targets).
		const task = named[0];
		if (!task) return {};
		if (taken.has(task.ref) || task.delegated) throw new Refusal(`Plan task ${task.ref} is already delegated.`);
		if (task.holder) throw new Refusal(`${heldMessage(task.ref, task.holder)}; take it over first (${wording.takeOverFirst}).`);
		if (task.status === "blocked") return {};
		return plan.local ? { wait: true } : { ref: task.ref, title: task.content };
	}
	if (taken.has(ticket)) throw new Refusal(`Ticket ${ticket} is already delegated.`);
	// Items naming one ticket share its ref, so the delegated one is the item whose text the prompt quotes,
	// or the one item named (by title or by the ticket's ref).
	const item = named.find(t => text.toLowerCase().includes(t.content.toLowerCase())) ?? (named.length === 1 ? named[0] : undefined);
	// The delegate closes the whole ticket, which would strand the lead's other open items on it.
	const siblings = plan.tasks.filter(t => t !== item && t.ticket === ticket && OPEN.has(t.status));
	if (siblings.length) throw new Refusal(`${spawn} would delegate ${ticket}, but other open plan items name it (${siblings.map(t => `"${t.content}"`).join(", ")}). A delegate closes its whole ticket. Delegate the ticket only when no other open item names it, or plan the work as child issues (${wording.planUnder(ticket)}) and delegate one of those.`);
	if (item?.status === "blocked") return {};
	return { ref: ticket, ticket: true, title: item && (itemTicket(item.content)?.action ?? item.content) };
}

// ------------------------------------------------------------------ interface

// Metadata keys that mark an issue as held by a delegate. pi also honours omp's key,
// since both adapters can run side by side; omp reads no pi names.
const delegateKeys = (namespace: string): readonly string[] => namespace === "pi" ? ["pi.subagent_id", "omp.subagent_id"] : [`${namespace}.subagent_id`];
export const heldByDelegate = (namespace: string, metadata: Record<string, unknown> | undefined): boolean => delegateKeys(namespace).some(key => !!metadata?.[key]);

// A delegate's teammate. The salt (a session id) keeps reused agent names distinct across sessions.
export function teammateFor(id: string, salt?: string): string {
	const base = id.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^[^a-z0-9]+/, "") || "agent";
	return `${base.slice(0, 57)}-${digest(salt ? `${salt}:${id}` : id).slice(0, 6)}`;
}

export type DelegateOutcome = "completed" | "failed" | "aborted" | "ended";
// started: no decision yet (waiting for a plan that can bind it). assigned: holds its issue. failed: an assignment write
// errored; retried on the delegate's next use. untracked: no assignment (it named nothing, or the rules refused it), the lead
// tracks its work. handed-back: exited with its issue open, which went back to the lead for review. settled: exited, its issue
// closed or restored. recorded: a delegate that exited with no issue (untracked, or never decided) and was settled: its report
// went on its mission or its targets, or it had none to record (see settleUntracked).
export type DelegateState = "started" | "assigned" | "failed" | "untracked" | "handed-back" | "settled" | "recorded";
export const FINAL: ReadonlySet<DelegateState> = new Set(["handed-back", "settled", "recorded"]);
export const isUntracked = (r: DelegateRecord | undefined): r is DelegateRecord & { state: "untracked" | "recorded" } => r?.state === "untracked" || r?.state === "recorded";

// The tickets and plan items a refused spawn named, when it named several (see Refusal).
export type Refused = Pick<Refusal, "targets">;

// The issue's state before the assignment wrote anything; rollback puts it back.
type Restore = { claimed: boolean; meta: Record<string, unknown> };

export interface DelegateRecord {
	id: string;
	// What messages call it, when that is not its id: a pi child's name (see childName in kata-core.ts).
	name?: string;
	// The delegate's own session, the key the delegate side finds its record by.
	sessionId: string;
	leadSessionId: string;
	leadTeammate: string;
	teammate: string;
	// Everything the lead gave the spawn (its task, description and name), read for what it names and kept as its mission's task.
	text: string;
	// The kind of agent the host started it as (omp's agent name, OpenCode's subagent `agent`), when the host says.
	agent?: string;
	parentAgentId?: string;
	// Where the lead's plan lives when the delegate cannot read it from the lead's session (a pi child).
	parent?: string;
	workspace?: string;
	parentLabel?: string;
	state: DelegateState;
	planRef?: string;
	ticket?: boolean;
	ref?: string;
	binding?: Binding;
	error?: string;
	restore?: Restore;
	ranTool?: boolean;
	exited?: DelegateOutcome;
	// Its latest report (its last assistant text, or what it yielded), posted for a delegate that left no comment of its own.
	report?: string;
	// It ran again after an earlier run ended: its report is posted even when it commented before, and a closed issue is no error.
	followUp?: boolean;
	// The mission that records its run, from its create on (an untracked delegate only); a later run's report goes on it.
	mission?: { ref: string; workspace: string };
	// A pi child whose spawn the rules refused: untracked, and its run makes no mission. Its report goes on the targets it named,
	// or nowhere for a conflict.
	refused?: Refused;
}

// A record as the lead's snapshot keeps it. A prompt is only read to decide an assignment, which a restored record never
// does, so it is left out; an ended record also leaves out what its next run starts without.
export type SavedDelegate = Omit<DelegateRecord, "text">;

// What a later run of an ended delegate goes on with: the issue it was assigned, or the mission that records its run. An
// ended record without either has nothing in Kata to resume, so it is not saved and a later run starts a new record.
const resumable = (r: SavedDelegate): boolean => !!((r.ref && r.binding) || r.mission);

export const nameOf = (r: Pick<DelegateRecord, "id" | "name">) => r.name || r.id;

export type DelegateEvent =
	// A run of the delegate began. Its first makes its record; `call` and `index` say which spawn of which checked call it is
	// (see Delegates.check), and what that spawn reserved is the record's. `untracked`: it is never matched and works no issue.
	// A later one (a follow-up, a revival, a resumed child) goes on with the record there is: its issue when that is still open
	// (a closed one is never reopened and only takes the run's report as a comment), or its mission.
	| { type: "started"; id: string; sessionId: string; leadSessionId: string; leadTeammate: string; teammate: string; text: string; agent?: string;
		name?: string; parentAgentId?: string; parent?: string; workspace?: string; parentLabel?: string; call?: string; index?: number; untracked?: boolean; refused?: Refused }
	// The delegate ran a tool: blocks rollback at exit.
	| { type: "ranTool"; id: string }
	// Its next prompt or todo call: retries a failed assignment.
	| { type: "nextUse"; id: string }
	// What it reported last, superseding an earlier report.
	| { type: "reported"; id: string; text: string }
	| { type: "exited"; id: string; outcome: DelegateOutcome };
// What a host says of a delegate that began: `Delegates.start` adds the lead's teammate and the delegate's own.
type DelegateStart = Omit<Extract<DelegateEvent, { type: "started" }>, "type" | "leadTeammate" | "teammate">;

export type DelegateAssignment = { ref: string; workspace: string; teammate: string; binding: Binding };

// Where delegate records live: in the host's memory for a lead, in the session branch for a pi child.
export interface DelegateStore {
	records(): DelegateRecord[];
	get(id: string): DelegateRecord | undefined;
	put(record: DelegateRecord): void;
	// The record of the delegate running in this extension context.
	of(ctx: any): DelegateRecord | undefined;
}
// A store over records a host keeps in memory, by id; `of` finds the record of the delegate running in a context.
export const recordStore = (records: () => Map<string, DelegateRecord>, of: (ctx: any) => DelegateRecord | undefined): DelegateStore => ({
	records: () => [...records().values()],
	get: id => records().get(id),
	put: record => { records().set(record.id, record); },
	of,
});

// Who an ownership check runs for. `teammate` absent: the session's own. `takeover`: the caller takes a plan task over from the
// session holding it. `ticket`: the issue is a ticket item's ticket, which keeps the actor and teammate rule alone.
export type Who = { teammate?: string; delegate?: boolean; takeover?: boolean; ticket?: boolean };

export interface DelegatesEnv {
	namespace: string;
	wording: ToolWording;
	store: DelegateStore;
	// Saves the lead's snapshot: called after every change to a record, so a cleanup the process never finished survives it.
	persist(job: Job): void;
	kata: Pick<Kata, "run" | "show" | "projectNames">;
	actor(job: Job, cwd: string, ref?: string): Promise<string>;
	owned(job: Job, ref: string, cwd: string, mayClaim?: boolean | "check", allowClosed?: boolean, revision?: number, who?: Who): Promise<KataIssue>;
	work(job: Job, ref: string, key: string, value: string | boolean | undefined, cwd: string, expected: KataIssue): Promise<KataIssue>;
	// Queues `fn` as one job of the core. Called with the job of the code that queues it, a job queued inside a batch joins it.
	serial<T>(fn: (job: Job) => Promise<T>, within: Job): Promise<T>;
	plan(): Plan;
	load(job: Job, cwd: string): Promise<unknown>;
	drain(job: Job): Promise<void>;
	cwd(): string;
	// The lead's own teammate: what its delegates report to.
	teammate(): string;
	// The plan parent an untracked delegate's mission goes under, for a lead's delegate: the plan's own, else the automatic parent
	// made for it (never one beside an explicit parent). Undefined while there is none to have: Kata is unreachable, or a local
	// plan waits for its replay.
	missionParent(job: Job): Promise<Pick<Binding, "parent" | "workspace" | "label"> | undefined>;
	// A keyed `kata create`: a replay returns the issue the first create made, as it is now. Undefined: a person deleted that issue.
	create(job: Job, key: string, args: string[], cwd: string): Promise<{ ref: string; issue: KataIssue } | undefined>;
	// Arms the settlement timer: a settle Kata throttled (a mission's close) runs again on the next drain, turn end or not.
	retryLater(): void;
	debug(error: unknown): void;
}

// `leadSession`: the lead's session id; a plan task another session started is not the lead's to delegate.
type Scope = { parent?: string; workspace?: string; label?: string; leadTeammate?: string; teammate?: string; leadSession?: string };

export interface Delegates {
	// The one write entry. Runs in the core's serial queue and never throws to the host. `within`: the job of the code that
	// reports the event, when it runs in one (a batch it queues into).
	apply(event: DelegateEvent, within: Job): Promise<void>;
	// A delegate began (see DelegateEvent `started`): the event with the lead's teammate and the delegate's own, which a host
	// would otherwise spell for itself. The delegate's teammate is salted by the lead's session (see teammateFor).
	start(host: DelegateStart, within: Job): Promise<void>;
	// Says what each spawn of a call works (see resolve), or throws the Refusal of the first that cannot be delegated; a ticket
	// must also be the lead's to delegate. Any other rejection (Kata unusable) is not a refusal: the spawn runs and its delegate
	// is decided at its start. `call`: the host's id of the call. What its spawns were matched to stays reserved under it,
	// against every other spawn, until each spawn's `started` takes its own or the host releases the call.
	check(texts: string[], call: string | undefined, scope: Scope | undefined, within: Job): Promise<Reservation[]>;
	// The call is over: what its spawns reserved and no delegate took is free again, and a check of it still running reserves nothing.
	release(call: string): void;
	// The issue the delegate running in `ctx` works, once assigned.
	assignment(ctx: any): DelegateAssignment | undefined;
	// Why `ctx` has no assignment, as the message its todo call reports.
	unassigned(ctx: any): string;
	holds(ref: string): boolean;
	// Returns a closed issue a delegate still marks to the lead: its teammate, the delegate's outcome and the item's final status,
	// then the delegate keys last. Each write is skipped when already in place and guarded by the chained revision. `exit` is the
	// exiting delegate's own return; without it the lead recovers an item no unfinished delegate holds.
	returnClosed(job: Job, ref: string, cwd: string, issue: KataIssue, lead: string, exit?: { teammate: string; outcome?: DelegateOutcome }): Promise<void>;
	running(): boolean;
	cleanupPending(): boolean;
	// The ids of those delegates: a turn end that waits for them stops once a pass leaves the same ones.
	pendingIds(): string[];
	// Whether a delegate with something written to Kata is still to settle.
	owes(): boolean;
	// The records the lead's snapshot keeps: the unfinished ones with something written to Kata, and the ended ones a later
	// run can resume (see resumable).
	saved(): SavedDelegate[];
	// Takes back the records a past run of this lead saved, those not already in memory. An ended one is back at once, for a
	// later run to resume. An unfinished one comes back as exited and settles in the background, on the lead's queue, so the
	// caller does not wait for Kata.
	restore(records: SavedDelegate[], within: Job): void;
	settle(job: Job): Promise<void>;
}

// The report is for reading on the issue, not a transcript: a long one is cut, and so is a mission's task text.
const REPORT_LIMIT = 4000;
const cut = (text: string) => text.length > REPORT_LIMIT ? `${text.slice(0, REPORT_LIMIT)}\n\n(cut at ${REPORT_LIMIT} characters)` : text;
const REPORT_HEADING = "Report from subagent";
// A delegate's own comment is the better record; its report only stands in for a delegate that left none. A report the
// plugin posted for it earlier carries its teammate too, but is not its own.
export const ownComment = (c: { teammate?: string; body?: string }, teammate: string) => !!teammate && c.teammate === teammate && !(c.body ?? "").startsWith(REPORT_HEADING);

export function createDelegates(env: DelegatesEnv): Delegates {
	const ns = env.namespace;
	const keySubagent = `${ns}.subagent_id`, keySession = `${ns}.session_id`;
	const failure = (error: unknown) => error instanceof Error ? error.message : String(error);
	const refOf = (r: DelegateRecord) => r.ref ?? r.planRef;
	const save = (job: Job, r: DelegateRecord) => { env.store.put(r); env.persist(job); };
	const unfinished = () => env.store.records().filter(r => !FINAL.has(r.state));
	// Running with no decision yet, or with an assignment to retry.
	const undecided = (r: DelegateRecord) => !r.exited && (r.state === "started" || r.state === "failed");
	// Whether the issue is this record's: its subagent id, under its lead's session. A fork's delegate can reuse a source
	// delegate's name, so the id alone is not enough; a session key not yet written (or already rolled back) does not disown it.
	const holding = (r: DelegateRecord, issue: KataIssue) => issue.metadata?.[keySubagent] === r.id && (issue.metadata?.[keySession] ?? r.leadSessionId) === r.leadSessionId;

	// What check() matched each spawn of a call to, by the host's call id, until the spawn's delegate starts or the host
	// releases the call.
	const reservations = new Map<string, (Reservation | undefined)[]>();
	// The check of each call whose result still counts: a release, or a newer check of the same call, ends it.
	const checks = new Map<string, symbol>();
	function take(call: string, index: number): Reservation | undefined {
		const spawns = reservations.get(call), reserved = spawns?.[index];
		if (spawns) spawns[index] = undefined;
		if (spawns?.every(spawn => !spawn)) reservations.delete(call);
		return reserved;
	}
	// The spawn a record began as: a check that finishes after the delegate started leaves its reservation to be taken at decide.
	const spawnOf = new WeakMap<DelegateRecord, { call: string; index: number }>();
	// The refs other spawns and delegates hold: every unfinished record's but `r`'s own, and every reservation but `call`'s.
	const taken = (r?: DelegateRecord, call?: string) => new Set([
		...unfinished().filter(other => other !== r).map(refOf),
		...[...reservations].filter(([id]) => id !== call).flatMap(([, spawns]) => spawns.map(reserved => reserved?.ref)),
	].filter((ref): ref is string => !!ref));

	type Source = Pick<Plan, "tasks" | "parent" | "workspace" | "label" | "auto"> & { local: boolean };
	// The plan a spawn is read against: the lead's own, or (a pi child) the open children of the parent it was told.
	async function source(job: Job, scope: Scope): Promise<Source> {
		if (scope.parent) {
			const workspace = scope.workspace!;
			const shown = await env.kata.show(job, scope.parent, workspace);
			const actor = await env.actor(job, workspace, scope.parent);
			const lead = scope.leadTeammate ?? "", mate = scope.teammate ?? "";
			const foreign = (c: KataIssue) => heldByDelegate(ns, c.metadata) || (!!c.owner && (c.owner !== actor || ![lead, mate].includes((c.metadata?.teammate as string | undefined) || "")));
			// Every open child of the parent can be named; the lead's lineage is the one session it names.
			const tasks = tasksOf((shown.children ?? []).filter(c => c.status === "open"), scope.parent, { delegated: foreign, holder: c => heldBySession(c, scope.leadSession ? [scope.leadSession] : []) });
			return { tasks, parent: scope.parent, workspace, label: scope.label, auto: false, local: false };
		}
		const first = env.plan();
		await env.load(job, first.workspace);
		const plan = env.plan();
		return { tasks: plan.tasks, parent: plan.parent, workspace: plan.workspace, label: plan.label, auto: plan.auto, local: !!plan.local };
	}

	// Makes what a spawn named certain: a ticket must be the lead's to delegate (a ticket keeps the actor and teammate rule
	// alone), and gives its title when the text did not. Throws the Refusal that makes the spawn untracked.
	async function reserve(job: Job, found: Reservation, which: string, workspace: string, leadTeammate: string | undefined): Promise<void> {
		if (!found.ticket) return;
		let ticket: KataIssue;
		try { ticket = await env.owned(job, found.ref!, workspace, "check", false, undefined, { ...(leadTeammate === undefined ? undefined : { teammate: leadTeammate }), ticket: true }); }
		catch (error) {
			// An unusable Kata says nothing about the ticket: it is not a refusal, so the delegate is retried on its next use.
			if (isUnusable(error)) throw error;
			throw new Refusal(`${which} names ${found.ref}, which cannot be delegated: ${failure(error)}`); }
		found.title ??= ticket.title;
	}

	async function check(texts: string[], call: string | undefined, scope: Scope = {}, within: Job): Promise<Reservation[]> {
		const token = Symbol(call);
		if (call !== undefined) checks.set(call, token);
		try {
			return await env.serial(async job => {
				const src = await source(job, scope);
				// A local plan's own tasks have no issue to reserve: a spawn naming one is decided when its delegate starts.
				const plan = src.local ? { ...src, tasks: src.tasks.filter(t => t.ticket) } : src;
				const held = taken(undefined, call);
				const projects = await env.kata.projectNames(job, src.workspace);
				const reserved: Reservation[] = [];
				for (const [index, text] of texts.entries()) {
					const which = `Task ${index + 1}`;
					const found: Reservation = resolve(text, plan, held, projects, which, env.wording);
					await reserve(job, found, which, src.workspace, scope.leadTeammate);
					if (found.ref) held.add(found.ref);
					reserved.push(found);
				}
				if (call !== undefined && checks.get(call) === token) reservations.set(call, [...reserved]);
				return reserved;
			}, within);
		} finally {
			if (call !== undefined && checks.get(call) === token) checks.delete(call);
		}
	}

	const ompKeys = ns === "omp" ? ["omp.parent_agent_id", "omp.status"] : [];
	function capture(issue: KataIssue): Restore {
		const keys = ["teammate", "todo.status", "work.attention", keySubagent, keySession, ...ompKeys];
		return { claimed: !issue.owner, meta: Object.fromEntries(keys.map(key => [key, issue.metadata?.[key]])) };
	}

	// Decides what the delegate works and writes the assignment. A delegate that names nothing, or something the rules
	// refuse, is untracked; one that cannot be decided yet (no plan, or a local plan) stays started for a later use.
	async function decide(job: Job, r: DelegateRecord) {
		const scope: Scope = { parent: r.parent, workspace: r.workspace, label: r.parentLabel, leadTeammate: r.leadTeammate, teammate: r.teammate, leadSession: r.leadSessionId };
		let src: Source | undefined;
		if (!r.planRef) {
			const own = spawnOf.get(r), reserved = own && take(own.call, own.index);
			if (reserved?.ref) { r.planRef = reserved.ref; r.ticket = !!reserved.ticket; }
		}
		if (!r.planRef) {
			if (!r.text.trim()) { r.state = "untracked"; return; }
			// Nothing was reserved: no check() saw the spawn, or the plan it saw named nothing (todo init and task often share
			// one batch, and a background spawn can start after its call was released).
			src = await source(job, scope);
			let found: Resolved;
			try { found = resolve(r.text, src, taken(r), await env.kata.projectNames(job, src.workspace), THE_TASK, env.wording); await reserve(job, found, THE_TASK, src.workspace, r.leadTeammate); }
			catch (error) {
				if (!(error instanceof Refusal)) throw error;
				env.debug(error);
				// A pi child refused here (its first check never ran) is refused as join would have refused it.
				r.state = "untracked";
				if (r.parent) r.refused = { targets: error.targets };
				return;
			}
			// A local plan cannot bind yet: stay undecided so a later use binds the replayed item.
			if (found.wait) return;
			if (!found.ref) { r.state = "untracked"; return; }
			r.planRef = found.ref;
			r.ticket = !!found.ticket;
		}
		src ??= await source(job, scope);
		if (!r.ticket && (!src.parent || src.local)) return;
		const binding: Binding = r.ticket
			? { parent: r.planRef, workspace: src.workspace, sessionId: r.leadSessionId }
			: { parent: src.parent!, workspace: src.workspace, sessionId: r.leadSessionId, auto: src.auto, label: src.label };
		r.binding = binding;
		const ref = r.planRef, cwd = binding.workspace;
		let issue: KataIssue = (await env.kata.show(job, ref, cwd)).issue;
		if (issue.status !== "open" && r.followUp) { r.ref = ref; r.state = "assigned"; return; }
		const before = r.restore ?? capture(issue);
		const retake = issue.metadata?.teammate !== r.teammate || issue.owner !== await env.actor(job, cwd);
		// A ticket keeps the actor and teammate rule alone, as check() decided; a plan task another session holds is refused.
		if (retake) issue = await env.owned(job, ref, cwd, true, false, undefined, { teammate: r.leadTeammate, ticket: r.ticket });
		// The restore point is saved before the delegate's own first write, so an assignment cut off by a crash is rolled back
		// on resume. An assignment the ownership check refused has none: nothing of the delegate's is on the issue.
		r.restore = before;
		save(job, r);
		if (retake) await env.kata.run(job, ["meta", "set", ref, "teammate", r.teammate, "--if-match", String(issue.revision)], cwd);
		if (issue.status !== "open") throw new Error(`Delegated task ${ref} is already closed.`);
		const extras = ns === "omp" ? { "omp.parent_agent_id": r.parentAgentId || "main", "omp.status": "running" } : {};
		for (const [key, value] of Object.entries({ [keySubagent]: r.id, [keySession]: r.leadSessionId, ...extras, "todo.status": "in_progress" })) {
			await env.kata.run(job, ["meta", "set", ref, key, value], cwd);
		}
		issue = await env.owned(job, ref, cwd, false, false, undefined, { teammate: r.teammate, delegate: true });
		await env.work(job, ref, "work.attention", "ok", cwd, issue);
		r.ref = ref;
		r.state = "assigned";
	}

	async function assign(job: Job, r: DelegateRecord) {
		r.error = undefined;
		try { await decide(job, r); }
		catch (error) { r.state = "failed"; r.error = failure(error); env.debug(error); }
		save(job, r);
	}

	// A delegate that exited having run no tool did nothing: put the issue back as it was.
	// `issue` is the current state: each step runs only while it is still undone, so a rollback that failed partway finishes on the next settle.
	async function rollback(job: Job, r: DelegateRecord, issue: KataIssue, restore: Restore) {
		const ref = refOf(r)!, cwd = r.binding!.workspace;
		const set = (key: string) => restore.meta[key] === undefined ? ["meta", "unset", ref, key] : ["meta", "set", ref, key, String(restore.meta[key])];
		if (issue.metadata?.teammate === r.teammate) {
			const owned = await env.owned(job, ref, cwd, false, false, undefined, { teammate: r.teammate, delegate: true });
			await env.work(job, ref, "work.attention", restore.meta["work.attention"] as string | undefined, cwd, owned);
			for (const key of ["todo.status", "teammate"]) await env.kata.run(job, set(key), cwd);
		}
		if (restore.claimed && issue.owner) await env.kata.run(job, ["unassign", ref], cwd);
		// The subagent id goes last: a partial rollback leaves the task marked delegated, and its absence marks a finished one.
		for (const key of [keySession, ...ompKeys, keySubagent]) await env.kata.run(job, set(key), cwd);
	}

	// A plan task returns to the lead (pending, the lead's teammate) only while it still carries the delegate's teammate;
	// the subagent id goes last, so a partial failure leaves it marked delegated and a finished hand back no longer carries it.
	async function handBack(job: Job, r: DelegateRecord, ref: string, cwd: string) {
		const lead = r.leadTeammate;
		const issue: KataIssue = (await env.kata.show(job, ref, cwd)).issue;
		if (issue.status === "open") {
			if (issue.metadata?.teammate === r.teammate) {
				await env.kata.run(job, lead ? ["meta", "set", ref, "teammate", lead, "--if-match", String(issue.revision)] : ["meta", "unset", ref, "teammate", "--if-match", String(issue.revision)], cwd);
				await env.kata.run(job, ["meta", "set", ref, "todo.status", "pending"], cwd);
			}
		}
		await env.kata.run(job, ["label", "add", ref, "needs-review"], cwd);
		await env.kata.run(job, ["notify", ref, "--to", `${await env.actor(job, cwd, ref)}${lead ? `/${lead}` : ""}`, "--message", `Subagent ${nameOf(r)} ${r.exited} without closing ${ref}; review it, then close or reassign it.`], cwd);
		if (issue.status === "open" && holding(r, issue)) await env.kata.run(job, ["meta", "unset", ref, keySubagent], cwd);
	}

	// A closed issue a delegate still marks returns to the lead: the lead's teammate, the delegate's outcome and the item's final
	// status, so the lead can still retire it from a plan. Every write is skipped when in place and guarded by the revision chained
	// from `issue`; the delegate keys go last, so a partial failure leaves the issue marked and a retry finishes it. An exiting
	// delegate moves the teammate only while it is still its own, as hand back does; the lead's recovery takes it whatever it is.
	async function returnClosed(job: Job, ref: string, cwd: string, issue: KataIssue, lead: string, exit?: { teammate: string; outcome?: DelegateOutcome }) {
		const meta = issue.metadata ?? {};
		let revision = issue.revision;
		const write = async (args: string[]) => { await env.kata.run(job, [...args, "--if-match", String(revision)], cwd); revision++; };
		const setMeta = async (key: string, value: string) => { if (meta[key] !== value) await write(["meta", "set", ref, key, value]); };
		const teammate = (meta.teammate as string | undefined) || "";
		if (teammate !== lead && (!exit || teammate === exit.teammate)) await write(lead ? ["meta", "set", ref, "teammate", lead] : ["meta", "unset", ref, "teammate"]);
		const outcome = exit?.outcome;
		if (ns === "omp") {
			if (outcome) await setMeta("omp.status", outcome);
			else if (meta["omp.status"] === "running") await setMeta("omp.status", "ended");
		}
		await setMeta("todo.status", closedTaskStatus(issue.closed_reason));
		for (const key of delegateKeys(ns)) if (meta[key]) await write(["meta", "unset", ref, key]);
	}

	// Posts the delegate's report on `ref` under its teammate; `note` says why it stands in for the delegate's own comment. Kata
	// fingerprints the whole comment, so the key covers the note too: a follow-up may repeat its first report word for word.
	async function commentReport(job: Job, r: DelegateRecord, ref: string, cwd: string, note?: string) {
		await env.kata.run(job, ["comment", ref, "--teammate", r.teammate, "--idempotency-key", `${ns}-report:${r.leadSessionId}:${r.id}:${digest(ref, note ?? "", r.report!)}`,
			"--body", `${REPORT_HEADING} ${nameOf(r)}${note ? ` (${note})` : ""}:\n\n${r.report}`], cwd);
	}

	async function postReport(job: Job, r: DelegateRecord, ref: string, cwd: string, shown: KataShow) {
		if (!r.report) return;
		if (!r.followUp && (shown.comments ?? []).some(c => ownComment(c, r.teammate))) return;
		await commentReport(job, r, ref, cwd, r.followUp ? "after a follow-up" : "it left no comment of its own");
	}

	// The same on an issue the delegate never held (its mission, a target it named): one a person deleted since takes nothing.
	async function reportOn(job: Job, r: DelegateRecord, ref: string, cwd: string, note?: string) {
		try { await commentReport(job, r, ref, cwd, note); }
		catch (error) { if (!isKataCode(error, "issue_not_found")) throw error; }
	}

	// A mission records an untracked delegate's run: a child of the plan parent holding its task, with its report under its
	// teammate, closed as audit-no-change since a report proves no change. It is keyed by the delegate, so a retry after a failed
	// step reaches the same issue, and the close comes last. The record keeps the mission from its create on, so a close Kata
	// refused for now is still owed by a lead that ends or crashes meanwhile. A later run's report goes on the mission its
	// first run made.
	async function recordMission(job: Job, r: DelegateRecord) {
		if (r.mission && r.followUp) return reportOn(job, r, r.mission.ref, r.mission.workspace, "after a follow-up");
		const where = r.parent && r.workspace ? { parent: r.parent, workspace: r.workspace, label: r.parentLabel } : await env.missionParent(job);
		if (!where) throw new Error(`Subagent ${nameOf(r)} has no plan parent for its mission yet.`);
		const task = r.text.split("\n").map(line => line.replace(/^[\s#>*-]+/, "").trim()).find(Boolean);
		const created = await env.create(job, `${ns}-mission:${r.leadSessionId}:${r.id}`, [
			"--parent", where.parent, "--project", projectOf(where.parent), ...(where.label ? ["--label", where.label] : []),
			"--meta", `${missionKey(ns)}=true`, "--meta", `${ns}.mission_subagent_id=${r.id}`, ...(r.agent ? ["--meta", `${ns}.mission_agent=${r.agent}`] : []),
			"--body", `Subagent ${nameOf(r)}${r.agent ? ` (agent ${r.agent})` : ""} ran this task for ${ns} session ${r.leadSessionId} with no plan item or ticket of its own; its report is in the comments.\n\n${cut(r.text)}`,
			"--", `Subagent ${nameOf(r)}${task ? `: ${task}` : ""}`.slice(0, TITLE_MAX)], where.workspace);
		// A person deleted it: there is nothing left to record on.
		if (!created) return;
		const { ref, issue } = created;
		r.mission = { ref, workspace: where.workspace };
		save(job, r);
		await commentReport(job, r, ref, where.workspace);
		if (issue.status === "open") await env.kata.run(job, missionCloseArgs(ref), where.workspace);
	}

	// A delegate that exited with no issue (untracked, or never decided) and a report leaves its run on record: a mission, or for
	// a refused pi child its report on each target it named. One with no report, or refused for a conflict, leaves nothing.
	async function settleUntracked(job: Job, r: DelegateRecord) {
		const targets = r.refused?.targets ?? [];
		if (r.report && !r.refused) await recordMission(job, r);
		else if (r.report) for (const ref of targets) await reportOn(job, r, ref, r.workspace ?? env.cwd(), `its task named ${targets.join(" and ")}, so it worked none of them as its own`);
		r.state = "recorded"; save(job, r);
	}

	// One exited delegate: a closed issue settles it, returned to the lead when the delegate held it; a delegate that never
	// acted is rolled back; otherwise the open issue is commented, flagged and handed back. Every step can run again after a failure.
	async function settleOne(job: Job, r: DelegateRecord) {
		// A delegate that exits before anything decided its target (no plan yet, or Kata could not be read) ran as an untracked one.
		const ref = refOf(r);
		if (r.state === "untracked" || !ref) return settleUntracked(job, r);
		const settled = () => { r.state = "settled"; save(job, r); };
		if (!r.binding) return settled();
		const cwd = r.binding.workspace;
		let shown: KataShow;
		try { shown = await env.kata.show(job, ref, cwd); }
		catch (error) {
			// A deleted issue has nothing left to hand back.
			if (isKataCode(error, "issue_not_found")) return settled();
			throw error;
		}
		const issue = shown.issue;
		// Closed: the delegate holding the issue returns it to the lead; only an assigned delegate reports on it (a failed or
		// cut-off assignment never did).
		if (issue.status === "closed") {
			if (holding(r, issue)) await returnClosed(job, ref, cwd, issue, r.leadTeammate, { teammate: r.teammate, outcome: r.exited });
			if (r.state === "assigned") await postReport(job, r, ref, cwd, shown);
			return settled();
		}
		// A delegate whose assignment was written ends by dropping its subagent id (rollback and hand back both write it last),
		// so an id that is no longer its own means the cleanup already ran, maybe in another session.
		if (r.state === "assigned" && !holding(r, issue)) return settled();
		// A failed or cut-off assignment the issue's holder refused (another delegate holds it) has nothing to hand back.
		if ((r.state === "failed" || r.state === "started") && heldByDelegate(ns, issue.metadata) && !holding(r, issue)) return settled();
		const idle = (r.state === "assigned" || r.state === "started") && !r.ranTool;
		// A failed or cut-off assignment without a restore point never got to its first write: the issue was not this delegate's
		// (another teammate owns it, say), so nothing is handed back.
		const untouched = r.state !== "assigned" && !r.restore;
		if (idle || untouched) {
			// An assignment that never got to a tool did nothing: roll back what it wrote. Nothing of this delegate's is left once
			// the issue carries neither its teammate nor its subagent id (someone else claimed it since). A cut right after the
			// claim looks the same, so that claim stays, held by the lead's actor and teammate.
			const ours = r.state === "assigned" || issue.metadata?.teammate === r.teammate || holding(r, issue);
			// A follow-up's answer is the only copy of its report, so it is posted before the rollback drops the claim.
			if (r.followUp) await postReport(job, r, ref, cwd, shown);
			if (idle && r.restore && ours) await rollback(job, r, issue, r.restore);
			return settled();
		}
		// Only observation metadata belongs to the parent; delegate work.* stays untouched.
		if (ns === "omp" && issue.metadata?.["omp.status"] !== r.exited) await env.kata.run(job, ["meta", "set", ref, "omp.status", r.exited!, "--if-match", String(issue.revision)], cwd);
		await postReport(job, r, ref, cwd, shown);
		await env.kata.run(job, ["comment", ref, "--idempotency-key", `${ns}-settle:${r.leadSessionId}:${r.id}:${r.exited}`,
			"--body", `Subagent ${nameOf(r)} ${r.exited} without closing its Kata issue. Review the work and supply evidence before closing.`], cwd);
		if (issue.metadata?.teammate === r.teammate) {
			const decision = await env.owned(job, ref, cwd, false, false, undefined, { teammate: r.teammate, delegate: true });
			const flagged = await env.work(job, ref, "work.attention", "needs-human", cwd, decision);
			await env.work(job, ref, "work.attention_msg", `Subagent ${nameOf(r)} ${r.exited} without closing its issue; review its report and verification.`, cwd, flagged);
		}
		await handBack(job, r, ref, cwd);
		r.state = "handed-back"; save(job, r);
	}

	async function settle(job: Job) {
		for (const r of unfinished()) {
			if (!r.exited) continue;
			try { await settleOne(job, r); }
			catch (error) { env.debug(error); if (isKataCode(error, "sibling_throttle")) env.retryLater(); }
		}
	}

	type Started = Extract<DelegateEvent, { type: "started" }>;
	function fresh(event: Started): DelegateRecord {
		const { type: _type, call, index, untracked, ...fields } = event;
		const reserved = call === undefined ? undefined : take(call, index ?? 0);
		const r: DelegateRecord = { ...fields, state: untracked || fields.refused ? "untracked" : "started", planRef: reserved?.ref, ticket: !!reserved?.ticket };
		if (call !== undefined) spawnOf.set(r, { call, index: index ?? 0 });
		return r;
	}

	// A run began for a delegate whose record goes on. It runs in the serial queue, after the settle of the earlier exit, so a
	// settle running or queued is not undone half way. An exit that never settled is taken back and the delegate keeps what it
	// holds; an ended record starts again on its issue, or as untracked again with its mission. One the settle left with
	// nothing to resume starts over.
	async function wake(job: Job, event: Started) {
		let r = env.store.get(event.id);
		if (r && !FINAL.has(r.state)) {
			if (r.exited) { r.exited = undefined; save(job, r); }
		} else {
			if (r && resumable(r)) Object.assign(r, { exited: undefined, report: undefined, followUp: true }, r.mission ? { state: "untracked" } : { state: "started", ranTool: false, restore: undefined, error: undefined });
			else r = fresh(event);
			save(job, r);
		}
		if (undecided(r)) await assign(job, r);
	}

	// A record's queued work, dropped once done: each record's assignment (its start or a retry), so its next use waits for that
	// and not for the lead's whole queue; and each record's wake, which every later event of the record waits for, so none is
	// lost to the wake's reset or taken for the earlier run's.
	const assigning = new Map<string, Promise<void>>(), waking = new Map<string, Promise<void>>();
	function track(queued: Map<string, Promise<void>>, id: string, work: Promise<void>): Promise<void> {
		queued.set(id, work);
		void work.then(() => { if (queued.get(id) === work) queued.delete(id); });
		return work;
	}

	function open(job: Job, event: Started): Promise<void> {
		const known = env.store.get(event.id);
		if (known && (!FINAL.has(known.state) || resumable(known))) {
			// At once, so the delegate is found by its session before the queued wake runs.
			if (known.sessionId !== event.sessionId) { known.sessionId = event.sessionId; save(job, known); }
			return track(waking, event.id, env.serial(queued => wake(queued, event), job).catch(env.debug));
		}
		const r = fresh(event);
		save(job, r);
		return track(assigning, r.id, env.serial(async queued => { if (undecided(r)) await assign(queued, r); }, job).catch(env.debug));
	}

	// What an event changes at once, before the queued writes run.
	function note(job: Job, event: Exclude<DelegateEvent, Started>): DelegateRecord | undefined {
		const r = env.store.get(event.id);
		switch (event.type) {
			case "ranTool":
				if (r && !r.ranTool) { r.ranTool = true; save(job, r); }
				return r;
			case "exited":
				if (r && !r.exited) { r.exited = event.outcome; save(job, r); }
				return r;
			case "reported": {
				const report = cut(event.text.trim());
				// Not saved here: omp reports every assistant turn, and each save writes the lead's whole snapshot. The exit
				// saves the final report; a lead that crashes before it resumes with the one its last snapshot holds.
				if (r && report) r.report = report;
				return r;
			}
			case "nextUse":
				if (r?.exited && !FINAL.has(r.state)) { r.exited = undefined; save(job, r); }
				return r;
		}
	}

	function apply(event: DelegateEvent, job: Job): Promise<void> {
		const woken = waking.get(event.id);
		if (woken) return woken.then(() => apply(event, job));
		if (event.type === "started") return open(job, event);
		const r = note(job, event);
		if (!r || event.type === "ranTool" || event.type === "reported") return Promise.resolve();
		if (event.type === "nextUse") {
			// A queued attempt that leaves a running delegate unassigned gets one retry before this use goes on.
			const queued = assigning.get(r.id);
			if (queued) return queued.then(() => undecided(r) ? apply(event, job) : undefined);
			if (r.state !== "started" && r.state !== "failed") return Promise.resolve();
		}
		const work = env.serial(async queued => {
			if (event.type === "exited") await env.drain(queued);
			else if (undecided(r)) await assign(queued, r);
		}, job).catch(env.debug);
		return event.type === "exited" ? work : track(assigning, r.id, work);
	}

	return {
		apply,
		start: (host, within) => apply({ type: "started", leadTeammate: env.teammate(), teammate: teammateFor(host.id, host.leadSessionId), ...host }, within),
		check,
		release: call => { reservations.delete(call); checks.delete(call); },
		assignment(ctx) {
			const r = env.store.of(ctx);
			if (r?.state === "assigned" && r.ref && r.binding) return { ref: r.ref, workspace: r.binding.workspace, teammate: r.teammate, binding: r.binding };
		},
		unassigned(ctx) {
			const r = env.store.of(ctx);
			if (!r) return `Kata assignment unavailable; the lead must assign this delegate an issue before it uses ${env.wording.tool}.`;
			if (isUntracked(r)) return `Subagent ${nameOf(r)} matched no plan item or ticket, so it has no Kata issue and no todo list.`;
			return `Kata assignment failed: ${r.error || (r.state === "handed-back" || r.state === "settled" ? "its issue was handed back" : "no issue was assigned")}`;
		},
		holds: ref => unfinished().some(r => refOf(r) === ref),
		returnClosed,
		running: () => env.store.records().some(r => !r.exited),
		cleanupPending: () => unfinished().some(r => !!r.exited),
		pendingIds: () => unfinished().filter(r => !!r.exited).map(r => r.id),
		owes: () => unfinished().some(r => r.binding || r.mission),
		saved: () => env.store.records().flatMap(({ text: _text, ...r }): SavedDelegate[] => {
			if (!FINAL.has(r.state)) return r.binding || r.mission ? [r] : [];
			const { report: _report, restore: _restore, error: _error, ...ended } = r;
			return resumable(r) ? [ended] : [];
		}),
		restore(records, within) {
			const back = (r: SavedDelegate): DelegateRecord => ({ ...r, text: "", exited: r.exited ?? "aborted" });
			const lost = records.filter(r => !env.store.get(r.id));
			// Not saved again: the snapshot they come from holds them.
			for (const r of lost) if (FINAL.has(r.state)) env.store.put(back(r));
			const unsettled = lost.filter(r => !FINAL.has(r.state));
			if (unsettled.length) void env.serial(async job => {
				for (const r of unsettled) if (!env.store.get(r.id)) save(job, back(r));
				await env.drain(job);
			}, within).catch(env.debug);
		},
		settle,
	};
}
