import { digest, OPEN, openTaskStatus, qualifiedRef, qualifiedRefs, type Binding, type KataIssue, type Plan, type Task } from "./model";
import { isKataCode, type Kata } from "./kata-cli";

// The delegate lifecycle, shared by the omp lead and the pi child (see GLOSSARY.md: Delegate,
// Assignment, Untracked delegate, Hand back). Adapters translate host events into DelegateEvents;
// everything Kata-side that follows (the assignment's writes, settling, rollback, hand back) lives here.

// ------------------------------------------------------------------ matching

const STOPWORDS = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "do", "for", "from", "in", "into", "is", "it", "its", "of", "on", "or", "per", "the", "then", "this", "that", "to", "with", "you", "your", "above", "below", "all", "any", "please", "task", "plan", "subagent", "agent", "current", "complete", "finish"]);
// Lowercase words with camelCase split and simple suffixes stripped; snake_case
// identifiers stay whole because they usually name the code under change.
export function taskTokens(text: string): string[] {
	const words = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9_]+/);
	const tokens: string[] = [];
	for (let word of words) {
		word = word.replace(/^_+|_+$/g, "");
		if (word.length < 2 || STOPWORDS.has(word)) continue;
		if (word.length > 5 && word.endsWith("ing")) word = word.slice(0, -3);
		else if (word.length > 4 && word.endsWith("ed")) word = word.slice(0, -2);
		else if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) word = word.slice(0, -1);
		if (STOPWORDS.has(word)) continue;
		tokens.push(word);
		if (word.length > 4 && word.endsWith("test")) tokens.push("test"); // unittest, pytest
	}
	return [...new Set(tokens)];
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The open tasks a text names: title (case-insensitive, whole words; a one- or
// two-word title only quoted or as the whole text), qualified ref, or short id
// after a marker, since a bare id can be an ordinary word ("test"). A title
// inside a longer named title yields to the longer one.
export function namedTasks(tasks: Task[], text: string): Task[] {
	const titled = (title: string) => {
		const phrase = escape(title.trim());
		if (text.trim().toLowerCase() === title.trim().toLowerCase()) return true;
		if (new RegExp(`["'\`\u201c\u2018]\\s*${phrase}\\s*["'\`\u201d\u2019]`, "i").test(text)) return true;
		return title.trim().split(/\s+/).length >= 3 && new RegExp(`(?<![\\w])${phrase}(?![\\w])`, "i").test(text);
	};
	const named = tasks.filter(t => OPEN.has(t.status) && (titled(t.content) || new RegExp(`(?<![\\w./#-])${escape(t.ref)}(?![\\w-])`).test(text) ||
		new RegExp(`(?:\\b(?:issue|kata|ref|task)\\b\\s*[:=]?\\s*|(?<![\\w.-])#)${escape(t.ref.split("#").pop()!)}(?![\\w-])`, "i").test(text)));
	return named.filter(t => !named.some(other => other !== t && other.content.length > t.content.length && other.content.toLowerCase().includes(t.content.toLowerCase())));
}

// Everything a delegation prompt names: plan tasks, and qualified refs that are
// no plan item (the plan parent itself is no work target). Only refs of the
// registered `projects` are tickets; any other look-alike is text.
export function namedTargets(tasks: Task[], text: string, projects: ReadonlySet<string>, parent?: string): { tasks: Task[]; tickets: string[] } {
	const known = new Set(tasks.map(t => t.ref));
	return { tasks: namedTasks(tasks, text), tickets: qualifiedRefs(text, projects).filter(ref => !known.has(ref) && ref !== parent) };
}

export type MatchOptions = { unavailable?: ReadonlySet<string>; single?: boolean; label?: string };
// Pick the plan task a delegation serves. A named task wins, and a named task
// that is taken binds nothing else; so does a text naming several tasks, which
// is ambiguous however well one of them overlaps. Then a clear weighted token
// overlap with the short label (omp's task name) wins; then, for a single delegation, the one
// open task the lead marked for delegation ("... (delegated to subagent)") if it
// shares a word with the spawn; then a clear overlap with the full text. Overlap
// counts the task's leading word twice. The lead's active task scores
// at half weight and is the fallback only for an explicit current-task handoff.
export function matchDelegation(tasks: Task[], text: string, { unavailable = new Set(), single = true, label = "" }: MatchOptions = {}): Task | undefined {
	const available = (t: Task) => OPEN.has(t.status) && t.status !== "blocked" && !t.delegated && !unavailable.has(t.ref);
	const full = label ? `${label}\n${text}` : text;
	const named = namedTasks(tasks, full);
	if (named.length > 1) return undefined;
	if (named[0]) return available(named[0]) ? named[0] : undefined;
	const candidates = tasks.filter(available);
	const open = tasks.filter(t => OPEN.has(t.status)).map(t => taskTokens(t.content));
	const df = (token: string) => open.filter(tokens => tokens.includes(token)).length;
	const weight = (token: string) => Math.log((open.length + 1) / Math.max(1, df(token)));
	const overlap = (source: string) => {
		const wanted = new Set(taskTokens(source));
		// Coverage counts against the task and against the source's plan vocabulary.
		const vocabulary = [...wanted].filter(token => df(token) > 0).reduce((sum, token) => sum + weight(token), 0);
		const scored = candidates.map(task => {
			const own = taskTokens(task.content), shared = own.filter(token => wanted.has(token));
			const total = own.reduce((sum, token) => sum + weight(token), 0), common = shared.reduce((sum, token) => sum + weight(token), 0);
			const score = (common + (own[0] && wanted.has(own[0]) ? weight(own[0]) : 0)) * (task.status === "in_progress" ? 0.5 : 1);
			return { task, score, eligible: shared.length >= 2 && common > 0 && Math.max(common / total, common / vocabulary) >= 0.3 };
		}).sort((a, b) => b.score - a.score);
		const [best, runner] = scored;
		return best?.eligible && (!runner || best.score >= runner.score * 1.5) ? best.task : undefined;
	};
	const byLabel = label && overlap(label);
	if (byLabel) return byLabel;
	const wanted = new Set(taskTokens(full));
	const marked = candidates.filter(t => /\b(?:delegat\w*|sub-?agents?)\b/i.test(t.content));
	if (single && marked.length === 1 && taskTokens(marked[0].content).some(token => wanted.has(token))) return marked[0];
	const found = overlap(full);
	if (found) return found;
	const active = candidates.filter(t => t.status === "in_progress");
	if (single && active.length === 1 && /\b(?:current|active|this)\s+(?:task|todo|item|step)\b/i.test(full)) return active[0];
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
// errored; retried on the delegate's next use. untracked: matched nothing, the lead tracks its work. handed-back: exited with
// its issue open, which went back to the lead for review. settled: exited, its issue closed or restored.
export type DelegateState = "started" | "assigned" | "failed" | "untracked" | "handed-back" | "settled";
export const FINAL: ReadonlySet<DelegateState> = new Set(["handed-back", "settled", "untracked"]);

// The issue's state before the assignment wrote anything; rollback puts it back.
export type Restore = { claimed: boolean; meta: Record<string, unknown> };

export interface DelegateRecord {
	id: string;
	// The delegate's own session, the key the delegate side finds its record by.
	sessionId: string;
	leadSessionId: string;
	leadTeammate: string;
	teammate: string;
	text: string;
	label?: string;
	single: boolean;
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
}

// A record as the lead's snapshot keeps it.
export type SavedDelegate = Omit<DelegateRecord, "text">;

// What a task call's spawn was matched to before it started.
export type Reservation = { ref?: string; ticket?: boolean };

export type DelegateEvent =
	| { type: "started"; id: string; sessionId: string; leadSessionId: string; leadTeammate: string; teammate: string; text: string; label?: string; single: boolean;
		parentAgentId?: string; parent?: string; workspace?: string; parentLabel?: string; reserved?: Reservation; untracked?: boolean }
	// The delegate ran a tool: blocks rollback at exit.
	| { type: "ranTool"; id: string }
	// Its next prompt or todo call: retries a failed assignment.
	| { type: "nextUse"; id: string }
	| { type: "exited"; id: string; outcome: DelegateOutcome };

export type DelegateAssignment = { ref: string; workspace: string; teammate: string; binding: Binding };

// Where delegate records live: in memory for omp, in the session branch for a pi child.
export interface DelegateStore {
	// The records of the lead session this store serves.
	records(): DelegateRecord[];
	get(id: string): DelegateRecord | undefined;
	// Called after every change to a record.
	put(record: DelegateRecord): void;
	// The record of the delegate running in this extension context.
	of(ctx: any): DelegateRecord | undefined;
}

export type Who = { teammate: string; delegate?: boolean };

export interface DelegatesEnv {
	namespace: string;
	store: DelegateStore;
	kata: Pick<Kata, "run" | "show" | "projectNames">;
	actor(cwd: string, ref?: string): Promise<string>;
	owned(ref: string, cwd: string, mayClaim?: boolean | "check", allowClosed?: boolean, revision?: number, who?: Who): Promise<KataIssue>;
	work(ref: string, key: string, value: string | boolean | undefined, cwd: string, expected: KataIssue): Promise<KataIssue>;
	serial<T>(fn: () => Promise<T>): Promise<T>;
	plan(): Plan;
	load(cwd: string): Promise<unknown>;
	drain(): Promise<void>;
	cwd(): string;
	debug(error: unknown): void;
}

export type Spawn = { text: string; label?: string };
export type Scope = { parent?: string; workspace?: string; label?: string; leadTeammate?: string; teammate?: string };

export interface Delegates {
	// The one write entry. Runs in the core's serial queue and never throws to the host.
	apply(event: DelegateEvent): Promise<void>;
	// Refuses a spawn that names two tickets or plan items, an already delegated task or an unclaimable ticket (throws);
	// otherwise says what each spawn is matched to. `held` are refs other pending spawns already reserved.
	check(spawns: Spawn[], held?: Iterable<string>, scope?: Scope): Promise<Reservation[]>;
	// The issue the delegate running in `ctx` works, once assigned.
	assignment(ctx: any): DelegateAssignment | undefined;
	// Why `ctx` has no assignment, as the message its todo call reports.
	unassigned(ctx: any): string;
	// Whether a delegate that has not been handed back or settled holds the issue.
	holds(ref: string): boolean;
	// Started and not exited, tracked or not.
	running(): boolean;
	// Exited and not yet handed back or settled.
	cleanupPending(): boolean;
	// The ids of those delegates: a turn end that waits for them stops once a pass leaves the same ones.
	pendingIds(): string[];
	// The unfinished records with something written to Kata, for the lead's snapshot. A prompt is only read to decide an
	// assignment, which a restored record never does, so it is left out.
	saved(leadSessionId: string): SavedDelegate[];
	// Takes back records a past run left unfinished (those not already in memory), as exited so they settle. Whether any were new.
	restore(records: SavedDelegate[]): boolean;
	// Settles every exited delegate not yet settled. Runs inside the serial queue.
	settle(): Promise<void>;
}

export function createDelegates(env: DelegatesEnv): Delegates {
	const ns = env.namespace;
	const keySubagent = `${ns}.subagent_id`, keySession = `${ns}.session_id`;
	const failure = (error: unknown) => error instanceof Error ? error.message : String(error);
	const refOf = (r: DelegateRecord) => r.ref ?? r.planRef;
	const unfinished = () => env.store.records().filter(r => !FINAL.has(r.state));
	const reservedRefs = (except?: DelegateRecord) => new Set(unfinished().filter(r => r !== except).map(refOf).filter((ref): ref is string => !!ref));

	type Source = { all: Task[]; parent?: string; workspace: string; label?: string; auto?: boolean; local: boolean; planned: boolean };
	// The plan the delegate's task is matched against: the lead's own, or (a pi child) the open children of the parent it was told.
	async function source(scope: Scope, loadAlways: boolean): Promise<Source> {
		if (scope.parent) {
			const workspace = scope.workspace!;
			const shown = await env.kata.show(scope.parent, workspace);
			const actor = await env.actor(workspace, scope.parent);
			const lead = scope.leadTeammate ?? "", mate = scope.teammate ?? "";
			const foreign = (c: KataIssue) => heldByDelegate(ns, c.metadata) || (!!c.owner && (c.owner !== actor || ![lead, mate].includes((c.metadata?.teammate as string | undefined) || "")));
			const all: Task[] = (shown.children ?? []).filter(c => c.status === "open").map(c => ({ ref: qualifiedRef(c, scope.parent!), content: c.title,
				phase: (c.metadata?.["todo.phase"] as string | undefined) ?? "", status: openTaskStatus(c.metadata?.["todo.status"]), delegated: foreign(c) }));
			return { all, parent: scope.parent, workspace, label: scope.label, auto: false, local: false, planned: true };
		}
		const first = env.plan();
		const planned = (!!first.parent && !first.local) || first.tasks.some(t => t.ticket);
		if (planned || loadAlways) await env.load(first.workspace || env.cwd());
		const plan = env.plan();
		return { all: plan.tasks, parent: plan.parent, workspace: plan.workspace, label: plan.label, auto: plan.auto, local: !!plan.local, planned };
	}

	async function check(spawns: Spawn[], held: Iterable<string> = [], scope: Scope = {}): Promise<Reservation[]> {
		return env.serial(async () => {
			const src = await source(scope, false);
			const tasks = src.planned ? src.all.filter(t => !src.local || t.ticket) : [];
			const taken = new Set([...held, ...reservedRefs()]);
			const projects = await env.kata.projectNames(src.workspace);
			const as = scope.leadTeammate === undefined ? undefined : { teammate: scope.leadTeammate };
			const reservations: Reservation[] = [];
			for (const [index, spawn] of spawns.entries()) {
				const label = spawn.label ?? "";
				const { tasks: named, tickets: others } = namedTargets(tasks, `${label}\n${spawn.text}`, projects, src.parent);
				const targets = [...new Set([...named.map(t => t.ticket ?? t.ref), ...others])];
				if (targets.length > 1) throw new Error(`Task ${index + 1} names more than one ticket or plan item (${targets.join(", ")}). Name one ticket per task and split the work across tasks.`);
				let ticket: string, item: Task | undefined;
				const direct = others[0] ?? named[0]?.ticket;
				// Items naming one ticket share its ref, so the delegated one is the item whose text the prompt quotes.
				if (direct) { ticket = direct; item = named.find(t => `${label}\n${spawn.text}`.toLowerCase().includes(t.content.toLowerCase())) ?? (named.length === 1 ? named[0] : undefined); }
				else {
					if (named[0] && (taken.has(named[0].ref) || named[0].delegated)) throw new Error(`Plan task ${named[0].ref} is already delegated.`);
					const selected = src.planned ? matchDelegation(tasks, spawn.text, { unavailable: taken, single: spawns.length === 1, label }) : undefined;
					if (!selected?.ticket) {
						if (selected) taken.add(selected.ref);
						reservations.push({ ref: selected?.ref });
						continue;
					}
					ticket = selected.ticket; item = selected;
				}
				if (taken.has(ticket)) throw new Error(`Ticket ${ticket} is already delegated.`);
				// The delegate closes the whole ticket, which would strand the lead's other open items on it.
				const siblings = tasks.filter(t => t !== item && t.ticket === ticket && OPEN.has(t.status));
				if (siblings.length) throw new Error(`Task ${index + 1} would delegate ${ticket}, but other open plan items name it (${siblings.map(t => `"${t.content}"`).join(", ")}). A delegate closes its whole ticket. Delegate the ticket only when no other open item names it, or plan the work as child issues (todo init with ref ${ticket}) and delegate one of those.`);
				try { await env.owned(ticket, src.workspace, "check", false, undefined, as); }
				catch (error) { throw new Error(`Task ${index + 1} names ${ticket}, which cannot be delegated: ${failure(error)}`); }
				taken.add(ticket);
				reservations.push({ ref: ticket, ticket: true });
			}
			return reservations;
		});
	}

	const ompKeys = ns === "omp" ? ["omp.parent_agent_id", "omp.status"] : [];
	function capture(issue: KataIssue): Restore {
		const keys = ["teammate", "todo.status", "work.attention", keySubagent, keySession, ...ompKeys];
		return { claimed: !issue.owner, meta: Object.fromEntries(keys.map(key => [key, issue.metadata?.[key]])) };
	}

	// Decides what the delegate works and writes the assignment. A delegate that matches nothing is untracked;
	// one that cannot be decided yet (no plan, or a local plan) stays started for a later use.
	async function decide(r: DelegateRecord) {
		const scope: Scope = { parent: r.parent, workspace: r.workspace, label: r.parentLabel, leadTeammate: r.leadTeammate, teammate: r.teammate };
		let src: Source | undefined;
		if (!r.ticket && !r.planRef && (r.text || r.label)?.trim()) {
			// todo init and task often share one batch, so the plan may not have existed when the task call was seen.
			src = await source(scope, true);
			const item = matchDelegation(src.all, r.text, { unavailable: reservedRefs(r), single: r.single, label: r.label });
			if (item?.ticket) { r.planRef = item.ticket; r.ticket = true; }
			else if (item) {
				// A local plan cannot bind yet: stay undecided so a later use binds the replayed item.
				if (src.local) return;
				r.planRef = item.ref;
			}
		}
		if (!r.planRef) { r.state = "untracked"; return; }
		src ??= await source(scope, false);
		if (!r.ticket && (!src.parent || src.local)) return;
		const binding: Binding = r.ticket
			? { parent: r.planRef, workspace: src.workspace, sessionId: r.leadSessionId }
			: { parent: src.parent!, workspace: src.workspace, sessionId: r.leadSessionId, auto: src.auto, label: src.label };
		r.binding = binding;
		const ref = r.planRef, cwd = binding.workspace;
		let issue: KataIssue = (await env.kata.show(ref, cwd)).issue;
		r.restore ??= capture(issue);
		// Saved before the first write, so an assignment cut off by a crash is rolled back on resume.
		env.store.put(r);
		if (issue.metadata?.teammate !== r.teammate || issue.owner !== await env.actor(cwd)) {
			issue = await env.owned(ref, cwd, true, false, undefined, { teammate: r.leadTeammate });
			await env.kata.run(["meta", "set", ref, "teammate", r.teammate, "--if-match", String(issue.revision)], cwd);
		}
		if (issue.status !== "open") throw new Error(`Delegated task ${ref} is already closed.`);
		const extras = ns === "omp" ? { "omp.parent_agent_id": r.parentAgentId || "main", "omp.status": "running" } : {};
		for (const [key, value] of Object.entries({ [keySubagent]: r.id, [keySession]: r.leadSessionId, ...extras, "todo.status": "in_progress" })) {
			await env.kata.run(["meta", "set", ref, key, value], cwd);
		}
		issue = await env.owned(ref, cwd, false, false, undefined, { teammate: r.teammate, delegate: true });
		await env.work(ref, "work.attention", "ok", cwd, issue);
		r.ref = ref;
		r.state = "assigned";
	}

	async function assign(r: DelegateRecord) {
		r.error = undefined;
		try { await decide(r); }
		catch (error) { r.state = "failed"; r.error = failure(error); env.debug(error); }
		env.store.put(r);
	}

	// A delegate that exited having run no tool did nothing: put the issue back as it was.
	// `issue` is the current state: each step runs only while it is still undone, so a rollback that failed partway finishes on the next settle.
	async function rollback(r: DelegateRecord, issue: KataIssue, restore: Restore) {
		const ref = refOf(r)!, cwd = r.binding!.workspace;
		const set = (key: string) => restore.meta[key] === undefined ? ["meta", "unset", ref, key] : ["meta", "set", ref, key, String(restore.meta[key])];
		if (issue.metadata?.teammate === r.teammate) {
			const owned = await env.owned(ref, cwd, false, false, undefined, { teammate: r.teammate, delegate: true });
			await env.work(ref, "work.attention", restore.meta["work.attention"] as string | undefined, cwd, owned);
			for (const key of ["todo.status", "teammate"]) await env.kata.run(set(key), cwd);
		}
		if (restore.claimed && issue.owner) await env.kata.run(["unassign", ref], cwd);
		// The subagent id goes last: a partial rollback leaves the task marked delegated, and its absence marks a finished one.
		for (const key of [keySession, ...ompKeys, keySubagent]) await env.kata.run(set(key), cwd);
	}

	// A plan task returns to the lead (pending, the lead's teammate) only while it still carries the delegate's teammate;
	// the subagent id goes last, so a partial failure leaves it marked delegated and a finished hand back no longer carries it.
	async function handBack(r: DelegateRecord, ref: string, cwd: string) {
		const lead = r.leadTeammate;
		const issue: KataIssue = (await env.kata.show(ref, cwd)).issue;
		if (issue.status === "open") {
			if (issue.metadata?.teammate === r.teammate) {
				await env.kata.run(lead ? ["meta", "set", ref, "teammate", lead, "--if-match", String(issue.revision)] : ["meta", "unset", ref, "teammate", "--if-match", String(issue.revision)], cwd);
				await env.kata.run(["meta", "set", ref, "todo.status", "pending"], cwd);
			}
		}
		await env.kata.run(["label", "add", ref, "needs-review"], cwd);
		await env.kata.run(["notify", ref, "--to", `${await env.actor(cwd, ref)}${lead ? `/${lead}` : ""}`, "--message", `Subagent ${r.id} ${r.exited} without closing ${ref}; review it, then close or reassign it.`], cwd);
		if (issue.status === "open" && issue.metadata?.[keySubagent] === r.id) await env.kata.run(["meta", "unset", ref, keySubagent], cwd);
	}

	// One exited delegate: closed issue settles it; a delegate that never acted is rolled back; otherwise the open issue
	// is commented, flagged and handed back. Every step can run again after a failure.
	async function settleOne(r: DelegateRecord) {
		const ref = refOf(r);
		const settled = () => { r.state = "settled"; env.store.put(r); };
		if (!ref || !r.binding) return settled();
		const cwd = r.binding.workspace;
		let issue: KataIssue;
		try { issue = (await env.kata.show(ref, cwd)).issue; }
		catch (error) {
			// A deleted issue has nothing left to hand back.
			if (isKataCode(error, "issue_not_found")) return settled();
			throw error;
		}
		if (issue.status === "closed") return settled();
		// A delegate whose assignment was written ends by dropping its subagent id (rollback and hand back both write it last),
		// so an id that is no longer its own means the cleanup already ran, maybe in another session.
		if (r.state === "assigned" && issue.metadata?.[keySubagent] !== r.id) return settled();
		// A failed or cut-off assignment the issue's holder refused (another delegate holds it) has nothing to hand back.
		if ((r.state === "failed" || r.state === "started") && heldByDelegate(ns, issue.metadata) && issue.metadata?.[keySubagent] !== r.id) return settled();
		// An assignment that never got to a tool did nothing: roll back what it wrote. A started record wrote nothing without a restore
		// point, and nothing of this delegate's once the issue carries neither its teammate nor its subagent id (someone else claimed it since).
		// A cut right after the claim looks the same, so that claim stays, held by the lead's actor and teammate.
		if ((r.state === "assigned" || r.state === "started") && !r.ranTool) {
			const ours = r.state === "assigned" || issue.metadata?.teammate === r.teammate || issue.metadata?.[keySubagent] === r.id;
			if (r.restore && ours) await rollback(r, issue, r.restore);
			return settled();
		}
		// Only observation metadata belongs to the parent; delegate work.* stays untouched.
		if (ns === "omp" && issue.metadata?.["omp.status"] !== r.exited) await env.kata.run(["meta", "set", ref, "omp.status", r.exited!, "--if-match", String(issue.revision)], cwd);
		await env.kata.run(["comment", ref, "--idempotency-key", `${ns}-settle:${r.leadSessionId}:${r.id}:${r.exited}`,
			"--body", `Subagent ${r.id} ${r.exited} without closing its Kata issue. Review the work and supply evidence before closing.`], cwd);
		if (issue.metadata?.teammate === r.teammate) {
			const decision = await env.owned(ref, cwd, false, false, undefined, { teammate: r.teammate, delegate: true });
			const flagged = await env.work(ref, "work.attention", "needs-human", cwd, decision);
			await env.work(ref, "work.attention_msg", `Subagent ${r.id} ${r.exited} without closing its issue; review its report and verification.`, cwd, flagged);
		}
		await handBack(r, ref, cwd);
		r.state = "handed-back"; env.store.put(r);
	}

	async function settle() {
		for (const r of unfinished()) {
			if (!r.exited) continue;
			try { await settleOne(r); } catch (error) { env.debug(error); }
		}
	}

	// What an event changes at once, so a delegate is found by its session before the queued writes run.
	function note(event: DelegateEvent): DelegateRecord | undefined {
		const r = env.store.get(event.id);
		switch (event.type) {
			case "started": {
				let record = r && !FINAL.has(r.state) ? r : undefined;
				if (!record) {
					const { type: _type, reserved, untracked, ...fields } = event;
					record = { ...fields, state: untracked ? "untracked" : "started", planRef: reserved?.ref, ticket: !!reserved?.ticket };
				} else record.sessionId = event.sessionId;
				record.exited = undefined;
				env.store.put(record);
				return record;
			}
			case "ranTool":
				if (r && !r.ranTool) { r.ranTool = true; env.store.put(r); }
				return r;
			case "exited":
				if (r && !r.exited) { r.exited = event.outcome; env.store.put(r); }
				return r;
			case "nextUse":
				if (r?.exited && !FINAL.has(r.state)) { r.exited = undefined; env.store.put(r); }
				return r;
		}
	}

	// Each record's queued assignment (its start or a retry), so its next use waits for that and not for the lead's whole queue.
	const assigning = new Map<string, Promise<void>>();
	function apply(event: DelegateEvent): Promise<void> {
		const r = note(event);
		if (!r || event.type === "ranTool") return Promise.resolve();
		if (event.type === "nextUse") {
			// A queued attempt that leaves a running delegate unassigned gets one retry before this use goes on.
			const queued = assigning.get(r.id);
			if (queued) return queued.then(() => !r.exited && (r.state === "started" || r.state === "failed") ? apply(event) : undefined);
			if (r.state !== "started" && r.state !== "failed") return Promise.resolve();
		}
		const work = env.serial(async () => {
			if (event.type === "exited") await env.drain();
			else if (!r.exited && (r.state === "started" || r.state === "failed")) await assign(r);
		}).catch(env.debug);
		if (event.type !== "exited") {
			assigning.set(r.id, work);
			void work.then(() => { if (assigning.get(r.id) === work) assigning.delete(r.id); });
		}
		return work;
	}

	return {
		apply,
		check,
		assignment(ctx) {
			const r = env.store.of(ctx);
			if (r?.state === "assigned" && r.ref && r.binding) return { ref: r.ref, workspace: r.binding.workspace, teammate: r.teammate, binding: r.binding };
		},
		unassigned(ctx) {
			const r = env.store.of(ctx);
			if (!r) return "Kata assignment unavailable; the lead must assign this delegate an issue before it uses todo.";
			if (r.state === "untracked") return `Subagent ${r.id} matched no plan item or ticket, so it has no Kata issue and no todo list.`;
			return `Kata assignment failed: ${r.error || (r.state === "handed-back" || r.state === "settled" ? "its issue was handed back" : "no issue was assigned")}`;
		},
		holds: ref => unfinished().some(r => refOf(r) === ref),
		running: () => env.store.records().some(r => !r.exited),
		cleanupPending: () => unfinished().some(r => !!r.exited),
		pendingIds: () => unfinished().filter(r => !!r.exited).map(r => r.id),
		saved: leadSessionId => unfinished().filter(r => r.leadSessionId === leadSessionId && r.binding).map(({ text: _text, ...r }) => r),
		restore: records => {
			const fresh = records.filter(r => !env.store.get(r.id));
			for (const r of fresh) env.store.put({ ...r, text: "", exited: r.exited ?? "aborted" });
			return fresh.length > 0;
		},
		settle,
	};
}
