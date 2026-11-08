import path from "node:path";
import { appendFileSync, realpathSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { decidePlanParent, explicitParent, isExplicitParent, namesPlanParent } from "./plan-parent";
import { createInboxFollower, knownProjectHead, trustedInbox, type InboxFollower, type LiveInbox } from "./inbox";
import { createDelegates, heldByDelegate as heldBy, teammateFor, type DelegateAssignment, type DelegateRecord, type DelegateStore, type Reservation, type SavedDelegate, type Spawn, type Who } from "./delegates";
import { createSettlement, MAX_FAILURES, openChildren, type PendingClose } from "./settlement";
import { createKata, isKataCode, isUnusable, KataError, type Exec } from "./kata-cli";
import { createTicketCompletion } from "./autocomplete";
import { kataCommands, quote, shellOptions } from "./shell";
import { digest, itemTicket, OPEN, openTaskStatus, projectOf, QUALIFIED_REF_ONLY, qualifiedRef, slug, WORKING, type Binding, type Change, type KataIssue, type KataShow, type Plan, type Status, type Task } from "./model";

// Canonical shared source. scripts/vendor-core.ts copies this file into each
// self-contained plugin; host adapters own their event/schema/identity APIs.

export interface CoreHost {
	// `ctx` is the context of the event the call serves, for a host that spawns differently per agent (omp's transcript identity).
	exec: Exec;
	appendEntry(type: string, data: unknown): void;
	getSessionName?(): string | undefined;
	isMain?(ctx: any): boolean;
	allowUI?(ctx: any): boolean;
	// Where delegate records live, found by the delegate's session id.
	delegateStore: DelegateStore;
	// Present: the main session follows its session inbox live (the host spawns the event stream and delivers each request as an aside).
	// Absent: the inbox is read once per turn.
	liveInbox?: LiveInbox;
}
export interface CoreOptions {
	namespace: string;
	executable: string;
	// Environment variable names (without $) a shell command may use for the executable.
	executableVars: readonly string[];
	debugFile?: string;
	explicitRef?(): string | undefined;
	// The harness name Kata's `agent-hook attention-native` is told when the main session starts and ends (the omp adapter has none of its own; pi's is closest). Absent: no attention hook.
	attentionHarness?: string;
	// Start the contract and inbox reads at session start, not at the first prompt (a host whose context another extension may supply waits for the prompt).
	prefetch?: boolean;
}

// Where the session's plan lives: the host hands it to child processes it starts.
export type Lead = { parent?: string; workspace: string; label?: string };
// What a prompt gets from the core, as text: the host formats each section for its prompt.
export type PromptSections = { contract?: string; inbox?: string; todo?: string; assignment?: string };
// A pi child's view of the session that started it.
export type ChildParent = { sessionId: string; ref?: string; workspace: string; label?: string; teammate: string;
	// The teammate of the child that re-exported the lead's marker.
	via?: string };
const CHILD_TEAMMATE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function sessionKey(file: string, cwd: string): string {
	const absolute = path.resolve(cwd, file);
	try { return realpathSync(absolute); }
	catch { try { return path.join(realpathSync(path.dirname(absolute)), path.basename(absolute)); } catch { return absolute; } }
}

// The workspace name Kata would infer, read from the project_not_initialized
// error's structured data: the project it names, else its alias ("local://" and
// ".git" dropped, last segment kept), else the folder.
function inferredName(data: Record<string, unknown> | undefined, cwd: string): string {
	const text = (value: unknown) => typeof value === "string" && value ? value : undefined;
	const alias = text(data?.alias)?.replace(/^local:\/\//, "").replace(/\/+$/, "").split("/").pop();
	return slug((text(data?.project) ?? alias ?? path.basename(path.resolve(cwd))).replace(/\.git$/, ""), true) ?? slug(path.basename(path.resolve(cwd)), true) ?? "workspace";
}

// `<actor>/<teammate>` with both parts non-empty is a session inbox; anything else is a person's.
const isSessionAddress = (address: string) => /^[^/]+\/[^/]/.test(address);

const MARK: Record<Status, string> = { pending: "[ ]", in_progress: "[/]", completed: "[x]", abandoned: "[~]", blocked: "[!]" };
// A plan item's identity: init keeps, refuses and closes by this same key.
const itemKey = (item: { phase: string; content: string }) => `${item.phase}\u0000${item.content}`;

// How long a main session's shutdown waits for Kata: closing an automatic parent takes six or more spawns, and an exit mid-way leaves the parent open.
// omp stops waiting for the handler after 2 s whatever this says (docs/explanation/limits.md, Shutdown budget); pi
// waits for it with no limit of its own, so this only keeps a stuck Kata call from holding pi's exit forever.
const SHUTDOWN_BOUND_MS = 10_000;
// How long a delegate's first prompt waits for its assignment, which it cannot learn later. The lead assigns delegates
// one at a time, about fifteen Kata calls each, so with many at once the last one waits for all the others.
const DELEGATE_BIND_MS = 15_000;
// How long the end of a lead turn waits for exited delegates to be handed back or rolled back. omp gives the stop hook
// 30 s; the cleanups queue behind each other, about ten Kata calls each, so a burst of exits needs a good part of it.
const TURN_SETTLE_MS = 15_000;

// The todo tool's ops and parameter descriptions; each host builds its schema from them.
export const TODO_OPS = ["init", "start", "done", "rm", "drop", "block", "unblock", "append", "view"] as const;
export const TODO_PARAMS = {
	list: "phases for init",
	task: "verbatim task content or Kata ref",
	items: "tasks for flat init or append",
	reason: "blocker note for block",
	ref: "existing Kata issue this plan serves (init)",
	replace: "init: replace a plan that still has open tasks (they close as wontfix); without it init refuses",
	message: "done: what changed and how it was verified (40+ characters); drop/rm: reason; init without ref: title for the automatic parent",
	evidence: "required for done: commit:<sha>, test:<cmd>, pr:<url>, reviewed-paths:<path>",
};

export const DESCRIPTION = `Track multi-step work as a todo list stored in Kata. Tasks are identified by verbatim content (or Kata ref), NEVER generated IDs. Unique, stable task/phase names; lost text: view, NEVER guess.
Before work, init for 3+ steps, requested task sets, or new instructions. MUST list EVERY user item separately; NEVER omit or remember leftovers.
After each change: with no active task the earliest pending starts (phase order). Blocked NEVER starts automatically; unblock returns pending. Mark done immediately; follow phase order.
External waits (user/agent/service): block with a reason; it suppresses the stop reminder and starts the next pending task.
NEVER call todo alone: init with first work; done/start with next action.

Kata specifics:
- An item that works an existing ticket starts with its qualified ref: \`<project>#<short_id>: <action>\` (for example \`myproj#a1b2: write the smoke script\`). It creates no issue: start claims the ticket and marks it in progress, done comments on it, and the last item of a ticket to be done closes it with that item's evidence (a ticket with open children stays open and gets a comment), drop/rm only comment and never close it. A ref that does not resolve, or a closed ticket, is an error. Only that prefix names a ticket; a bare id is text. A plan whose items all name tickets creates no parent issue.
- Every other task is a Kata child issue of one parent issue. On init pass \`ref\` with the Kata issue this plan serves (search first: kata search "<terms>" --agent); an explicit KATA_REF or a delegate's assignment must match it. Without a ref, use that issue, the session's existing parent, or a new parent titled by \`message\`.
- done closes the issue (an item naming a ticket: see above). Kata requires \`evidence\` (commit:<sha>, test:<cmd>, pr:<url>, reviewed-paths:<path>) and a \`message\` of 40+ characters saying what changed and how it was verified. Unverified work: block it instead.
- init whose new list leaves out open tasks changes nothing and returns an error listing the missing ones; pass \`replace: true\` only to deliberately drop them (they close as wontfix).
- drop/rm take the reason in \`message\`.
- drop and rm close those tasks as wontfix (Kata never deletes). Automatic session parents close from their children’s Kata-recorded evidence once all work has settled. Explicit/claimed parents remain yours to close. Folders with no Kata project use KATA_DEFAULT_PROJECT (labeled with the repo) or register their inferred project; the plan is session-local only while Kata is unreachable and replays when it returns.`;

function delegateContext(executable: string, id: string, ref: string, teammate: string, binding: Binding): string {
	const command = `${quote(executable)} --workspace ${quote(binding.workspace)} --project ${quote(projectOf(binding.parent))} --teammate ${quote(teammate)}`;
	return `You are subagent ${id}. Your Kata issue is ${ref}; your teammate is ${teammate}. Keep the existing actor and use this issue instead of inherited KATA_REF. Track attention on your own issue. When verified, YOU must run: ${command} close ${quote(ref)} --done --message '<describe this task and its verification in at least 40 characters>' --evidence '<typed evidence for your actual verification>'. If unfinished, leave it open and explain what remains.`;
}

// A delegate that matched no plan item and named no ticket has no issue. Its
// binding says so instead of sending it to one: the lead tracks the work.
function untrackedDelegateContext(id: string): string {
	return `You are subagent ${id}. The lead session tracks this work and you have no Kata issue. Do not create, claim, close, comment on or edit Kata issues, including one named by an inherited KATA_REF. Reading Kata is fine. Report your results in your reply.`;
}

// Items that name no ticket become children of a parent issue; a plan of only named items needs none.
const needsParent = (contents: string[]) => contents.some(content => !itemTicket(content));
// Kata closes a task as done only with evidence and a 40+ character message.
const hasProof = (change: { message?: string; evidence?: string[] }) => !!change.evidence?.length && (change.message || "").replace(/\s+/g, " ").trim().length >= 40;

function phasesOf(tasks: Task[]): { name: string; tasks: Task[] }[] {
	const phases: { name: string; tasks: Task[] }[] = [];
	for (const task of tasks) {
		let phase = phases.find(p => p.name === task.phase);
		if (!phase) phases.push((phase = { name: task.phase, tasks: [] }));
		phase.tasks.push(task);
	}
	return phases;
}

export function render(plan: Plan): string {
	if (plan.error) return `Kata state unavailable${plan.parent ? ` for ${plan.parent}` : ""}: ${plan.error}. Use todo op=view to refresh.`;
	if (!plan.parent && !plan.local && plan.tasks.length === 0) return "No todo plan. Use todo op=init.";
	if (plan.tasks.length === 0) return `Kata parent ${plan.parent}: no tasks.`;
	const done = plan.tasks.filter(t => t.status === "completed").length;
	const lines = [`${plan.local ? "Session-local plan (Kata is unreachable; it replays into Kata when Kata returns)" : plan.parent ? `Kata parent ${plan.parent}` : "Kata tickets (no parent issue)"}: ${done}/${plan.tasks.length} done`];
	for (const phase of phasesOf(plan.tasks)) {
		lines.push(`${phase.name}:`);
		for (const t of phase.tasks) lines.push(`  ${MARK[t.status]} ${t.content} (${t.ticket ?? t.ref})${t.blocker ? ` — blocked: ${t.blocker}` : ""}`);
	}
	return lines.join("\n");
}

export function createKataCore(host: CoreHost, options: CoreOptions) {
	const namespace = options.namespace;
	const heldByDelegate = (metadata: Record<string, unknown> | undefined) => heldBy(namespace, metadata);
	const STATE_ENTRY = `io.kata.${namespace}.parent`;
	const SNAPSHOT_ENTRY = `io.kata.${namespace}.state`;
	const WIDGET = `${namespace}-kata`;
	const MAX_REMINDERS = 3;
	const main = (ctx: any) => host.isMain?.(ctx) ?? true;
	const sid = (ctx: any): string | undefined => ctx?.sessionManager?.getSessionId?.();
	// The main session's UI, when the host lets it show any.
	const uiOf = (ctx: any) => main(ctx) && host.allowUI?.(ctx) !== false ? ctx?.ui : undefined;
	let plan: Plan = { tasks: [], workspace: path.resolve(process.cwd()) };
	let queue: Promise<unknown> = Promise.resolve();
	// unknown: not probed; workspace: the cwd has its own project; unbound: Kata is
	// up but the cwd is unregistered; bound: a parent is set; down: Kata unusable.
	let scope: "unknown" | "workspace" | "unbound" | "bound" | "down" = "unknown";
	let refusal: Record<string, unknown> | undefined, outage = "", warnedFor: string | undefined;
	let currentId: string | undefined;
	let bound = false;
	let assignedRef: string | undefined;
	// The one place the configured explicit ref is read: the host option, else KATA_REF.
	const configuredRef = () => options.explicitRef?.() ?? process.env.KATA_REF;
	const aliases = new Set<string>(); // refs the plan's parent was rehomed from: they still name it
	let requestedRef: string | undefined;
	let sessionTeammate: string | undefined;
	const ownTeammate = () => sessionTeammate ?? process.env.KATA_TEAMMATE ?? "";
	let boundAgent: string | undefined;
	// An automatic parent a person deleted: todo results say so until a new plan starts. Saved in the session snapshot.
	let deletedParent: string | undefined;
	const agentKey = (ctx: any) => JSON.stringify([ctx?.agent?.kind, ctx?.agent?.id]);
	let currentCtx: any;
	// The context of the todo call a Kata call serves: another identity's event can move currentCtx while the call awaits.
	const callCtx = new AsyncLocalStorage<any>();
	let reminders = 0;
	let progressed = true;
	let cache: { id?: string; contract?: string; inbox?: string; actor?: Promise<string>; pending?: Promise<void>; inboxPending?: Promise<void>; personInbox?: boolean } = {};
	const kata = createKata({ exec: (...args) => host.exec(...args), executable: options.executable, teammate: () => sessionTeammate, ctx: () => callCtx.getStore() ?? currentCtx, session: () => currentId, debug });
	// Throttled closes, ticket closes waiting on children and the automatic parent's close (see settlement.ts).
	// The timer is omp's ctx timer (contained, cleared on session_shutdown) when the host has one; pi has none.
	const settlement = createSettlement({
		namespace, kata, owned,
		clock: () => Date.now(),
		timer(fire, ms) {
			const ctx = currentCtx;
			if (typeof ctx?.setTimeout === "function" && typeof ctx.clearTimer === "function") { const handle = ctx.setTimeout(fire, ms); return () => ctx.clearTimer(handle); }
			const handle = setTimeout(fire, ms);
			handle.unref?.();
			return () => clearTimeout(handle);
		},
		due: () => { void serial(drain).catch(debug); },
		delegatesRunning: () => delegates.running(),
		itemsOpen: ticket => named.some(t => t.ticket === ticket && OPEN.has(t.status)),
		performTask, performTicket: (ticket, request) => owned(ticket, request.cwd, "check").then(decision => closeWith(ticket, decision, request)),
		flag: flagDropped, debug,
	});
	let lastSnapshot: string | undefined;
	// Items that name an existing ticket. They live in the session's snapshot, not
	// in Kata: the ticket can sit under any parent or project, and several items
	// may name one ticket.
	let named: Task[] = [];
	let stamp = 0;
	const nextStamp = () => (stamp = Math.max(Date.now(), stamp + 1));
	// The plan's tasks: Kata children (or the local plan) merged with named items by creation time.
	const withNamed = (base: Task[]) => named.length ? [...base.filter(t => !t.ticket), ...named].sort((a, b) => (a.at || 0) - (b.at || 0)) : base;
	// Every record change is saved with the lead's snapshot, so a cleanup the process never finished survives it.
	const store: DelegateStore = { ...host.delegateStore, put: record => { host.delegateStore.put(record); persist(); } };
	const delegates = createDelegates({
		namespace, store, kata,
		actor: (cwd, ref) => actor(cwd, ref), owned, work, serial, plan: () => plan,
		load: cwd => load(cwd), drain: () => drain(), cwd: () => path.resolve(currentCtx?.cwd ?? process.cwd()), debug,
	});
	function persist() {
		if (!currentId || !main(currentCtx)) return;
		// A record with no binding wrote nothing to Kata, so the snapshot leaves it out (see Delegates.saved).
		const open = delegates.saved(currentId);
		const data = { version: 1, sessionId: currentId,
			plan: structuredClone({ ...plan, tasks: plan.tasks.filter(t => !t.ticket) }), ...settlement.snapshot(),
			...(open.length ? { delegates: structuredClone(open) } : {}),
			...(named.length ? { named: structuredClone(named) } : {}), ...(deletedParent ? { deletedParent } : {}) };
		const encoded = JSON.stringify(data);
		if (encoded === lastSnapshot) return;
		host.appendEntry(SNAPSHOT_ENTRY, data);
		lastSnapshot = encoded;
	}
	function debug(error: unknown) {
		if (!options.debugFile) return;
		try { appendFileSync(options.debugFile, `${new Date().toISOString()} ${String(error)}\n`); } catch { /* Debugging must never interrupt work. */ }
	}
	async function bounded<T>(promise: Promise<T>, ms = 250): Promise<T | undefined> {
		let timer: ReturnType<typeof setTimeout>;
		try { return await Promise.race([promise.catch(error => { debug(error); return undefined; }), new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), ms); })]); }
		finally { clearTimeout(timer!); }
	}

	// Serialize every plan mutation: tool calls, /todo, and session reloads.
	function serial<T>(fn: () => Promise<T>): Promise<T> {
		const run = queue.then(fn);
		queue = run.catch(() => undefined);
		return run;
	}

	async function actor(cwd: string, ref = plan.parent): Promise<string> {
		if (ref) {
			const status = JSON.parse(await kata.run(["status", ref], cwd));
			if (typeof status.actor !== "string" || !status.actor.trim()) throw new Error("Kata status returned no effective actor.");
			return status.actor;
		}
		if (process.env.KATA_AUTHOR || process.env.USER) return (process.env.KATA_AUTHOR || process.env.USER)!;
		const result = await host.exec("git", ["config", "user.name"], { cwd, timeout: 1000 });
		return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : "anonymous";
	}

	// Starting unowned work requires a successful claim. Already-owned tasks
	// require both the actor and teammate, since delegates share an actor.
	// "check" validates assignment without taking ownership.
	async function owned(ref: string, cwd: string, mayClaim: boolean | "check" = false, allowClosed = false, revision?: number, who?: Who): Promise<KataIssue> {
		let issue: KataIssue = (await kata.show(ref, cwd)).issue;
		if (revision !== undefined && issue.revision !== revision) throw new Error(`Kata issue ${ref} changed since the task was selected; no work metadata was written.`);
		if (!who?.delegate && main(currentCtx) && heldByDelegate(issue.metadata)) throw new Error(`Kata issue ${ref} belongs to a delegate; no work metadata was written.`);
		const currentActor = await actor(cwd, ref);
		const teammate = who?.teammate ?? ownTeammate();
		if (issue?.status !== "open" && !(allowClosed && issue?.status === "closed")) throw new Error(`Kata issue ${ref} is closed or unavailable; no work metadata was written.`);
		const assignedTeammate = issue.metadata?.teammate || "";
		if (assignedTeammate !== teammate && (issue.owner || assignedTeammate)) {
			throw new Error(`Kata issue ${ref} belongs to teammate ${assignedTeammate || "(none)"}, not ${teammate || "(none)"}; no work metadata was written.`);
		}
		if (!issue.owner && mayClaim === true) {
			// Never swallow a claim failure, including an ownership race.
			await kata.run(["claim", ref, "--if-unowned"], cwd);
			issue = (await kata.show(ref, cwd)).issue;
			if (issue.status !== "open" || issue.owner !== currentActor) throw new Error(`Kata issue ${ref} is no longer owned by ${currentActor}; no work metadata was written.`);
			if (teammate && !issue.metadata?.teammate) {
				await kata.run(["meta", "set", ref, "teammate", teammate, "--if-absent", "--if-match", String(issue.revision)], cwd);
				issue = (await kata.show(ref, cwd)).issue;
			}
		}
		const unclaimed = mayClaim === "check" && !issue.owner;
		if ((issue.status !== "open" && !(allowClosed && issue.status === "closed")) || (!unclaimed && (issue.owner !== currentActor || (issue.metadata?.teammate || "") !== teammate)) ||
			(!who?.delegate && main(currentCtx) && heldByDelegate(issue.metadata))) {
			throw new Error(`Kata issue ${ref} is not owned by actor ${currentActor} and teammate ${teammate || "(none)"}; no work metadata was written.`);
		}
		if (!Number.isInteger(issue.revision) || issue.revision < 0) throw new Error(`Kata issue ${ref} has no valid metadata revision; no work metadata was written.`);
		return issue;
	}

	// Keep the validated decision through each conditional write. Any intervening
	// assignment or metadata change invalidates its revision, including after close.
	async function work(ref: string, key: string, value: string | boolean | undefined, cwd: string, expected: KataIssue): Promise<KataIssue> {
		const meta = expected.metadata ?? {};
		const exists = Object.hasOwn(meta, key);
		if ((!exists && value === undefined) || meta[key] === value) return expected;
		const args = value === undefined ? ["meta", "unset", ref, key] : ["meta", "set", ref, key, JSON.stringify(value)];
		args.push("--if-match", String(expected.revision));
		if (exists) args.push("--if-value", JSON.stringify(meta[key]), "--json-value");
		else args.push("--if-absent", "--json-value");
		await kata.run(args, cwd);
		const changed = { ...meta };
		if (value === undefined) delete changed[key];
		else changed[key] = value;
		return { ...expected, revision: expected.revision + 1, metadata: changed };
	}

	// -------------------------------------------------------------- plan state

	async function showParent(parent: string, cwd: string): Promise<KataShow> {
		const shown = await kata.show(parent, cwd);
		const children = shown.children ?? [];
		if (!shown.issue || !Array.isArray(children) || children.some(c => !c || typeof c.title !== "string" || typeof c.short_id !== "string")) {
			throw new Error("kata show returned an invalid issue or children response");
		}
		return shown;
	}

	// `kata move` keeps old refs resolving but the issue and its open children now
	// live in another project. Follow the parent: the saved binding, child
	// creation, delegate context and the pi marker all derive the project from it.
	async function rehome(shown: KataShow, old: string, cwd: string): Promise<void> {
		let current: string;
		try { current = await kata.qualify(shown.issue, cwd); }
		catch (error) { debug(error); return; }
		if (current === old || plan.parent !== old) return;
		settlement.renamePlan(old, current);
		plan.parent = current;
		aliases.add(old);
		host.appendEntry(STATE_ENTRY, { parent: current, workspace: plan.workspace, sessionId: plan.sessionId, auto: plan.auto, label: plan.label });
	}

	function tasksOf(children: KataIssue[], parent: string): Task[] {
		return children
			.filter(c => typeof c?.metadata?.["todo.phase"] === "string" && c.metadata["todo.removed"] !== true)
			.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
			.map(c => {
				const meta = c.metadata!;
				let status: Status;
				if (c.status === "closed") status = c.closed_reason === "wontfix" || meta["todo.status"] === "abandoned" ? "abandoned" : "completed";
				else status = openTaskStatus(meta["todo.status"]);
				return {
					ref: qualifiedRef(c, parent),
					content: c.title,
					phase: meta["todo.phase"] as string,
					revision: c.revision,
					at: Date.parse(c.created_at),
					delegated: heldByDelegate(meta) && (meta.teammate || "") !== ownTeammate(),
					review: (c.labels ?? []).some(l => (typeof l === "string" ? l : l?.label) === "needs-review"),
					status,
					blocker: status === "blocked" ? meta["work.attention_msg"] as string | undefined : undefined,
				};
			});
	}

	// An item follows its ticket: closed by anyone (a delegate, the user) it is completed,
	// or abandoned when closed as wontfix. A ticket that cannot be read keeps its item as is.
	async function followTickets(cwd: string) {
		const open = named.filter(t => OPEN.has(t.status));
		for (const ticket of new Set(open.map(t => t.ticket!))) {
			try {
				const shown: KataIssue = (await kata.show(ticket, cwd)).issue;
				if (shown.status !== "closed") continue;
				for (const task of open) if (task.ticket === ticket) { task.status = shown.closed_reason === "wontfix" ? "abandoned" : "completed"; task.blocker = undefined; }
			} catch (error) { debug(error); }
		}
	}

	async function load(cwd: string): Promise<KataIssue[]> {
		if (plan.local) { delete plan.error; plan.tasks = withNamed(plan.tasks); return []; }
		if (!plan.parent) { if (named.length) { delete plan.error; await followTickets(cwd); } plan.tasks = withNamed([]); return []; }
		const ref = plan.parent;
		try {
			const shown = await showParent(ref, cwd);
			await rehome(shown, ref, cwd);
			const children = shown.children ?? [];
			await followTickets(cwd);
			plan.tasks = withNamed(tasksOf(children, plan.parent));
			delete plan.error;
			return children;
		} catch (error) {
			if (isDeletedAutomaticParent(error, ref)) { forget(ref); return load(cwd); }
			plan.error = (error as Error).message;
			throw error;
		}
	}

	// A person deleted the automatic parent (Kata 0.22's TUI does it with X): the plan goes with it, and so do its pending
	// closes. Its tasks stay in Kata untouched, and the next init creates a new parent. An explicit parent must exist.
	const isDeletedAutomaticParent = (error: unknown, ref: string) => plan.auto === true && plan.parent === ref && isKataCode(error, "issue_not_found");
	function forget(parent: string) {
		settlement.dropPlan(parent);
		aliases.clear();
		// A saved binding without a parent: a resumed or forked session does not look for the deleted one again.
		host.appendEntry(STATE_ENTRY, { parent: null, ...(plan.sessionId ? { sessionId: plan.sessionId } : {}) });
		plan = { tasks: withNamed([]), workspace: plan.workspace };
		deletedParent = parent;
	}

	// Prefixes a todo result with the deleted parent's notice until a new plan starts: a new plan parent, whose first result
	// still carries it, or a successful init without one. A restored parent bound again ends it silently.
	function withDeletionNotice(text: string, started = false): string {
		if (!deletedParent) return text;
		const restored = plan.parent === deletedParent;
		const note = `Kata parent ${deletedParent} was deleted, and this session's plan with it. Its tasks stay in Kata as they were.`;
		if (plan.parent || started) deletedParent = undefined;
		return restored ? text : `${note}\n\n${text}`;
	}

	function refresh(ctx: any) {
		const ui = uiOf(ctx);
		if (!ui?.setWidget) return;
		if (plan.error) { ui.setWidget(WIDGET, [render(plan)]); return; }
		if ((!plan.parent && !named.length) || plan.tasks.length === 0) {
			ui.setWidget(WIDGET, undefined);
			return;
		}
		const done = plan.tasks.filter(t => t.status === "completed").length;
		const active = plan.tasks.find(t => t.status === "in_progress");
		const blocked = plan.tasks.filter(t => t.status === "blocked").length;
		const line = `Kata ${plan.parent ?? "tickets"} · ${done}/${plan.tasks.length} done${blocked ? ` · ${blocked} blocked` : ""}${active ? ` · ▶ ${active.content}` : ""}`;
		ui.setWidget(WIDGET, [line]);
	}

	// True while Kata answers. An unregistered cwd is not an outage: it resolves
	// to the default or inferred project. Only an unusable Kata (missing
	// executable, unreachable daemon) is down, and it is probed again next time.
	async function probe(cwd: string): Promise<boolean> {
		if (scope !== "unknown" && scope !== "down") return true;
		try { await kata.run(["list", "--limit", "1"], cwd, { timeout: 15_000 }); scope = "workspace"; refusal = undefined; }
		catch (error) {
			if (isKataCode(error, "project_not_initialized")) { scope = "unbound"; refusal = (error as KataError).info.data ?? {}; }
			else if (isUnusable(error)) { wentDown(error); return false; }
			else throw error; // a missing project or a refused login is an error, never a local plan
		}
		return true;
	}
	function wentDown(error: unknown) {
		scope = "down"; outage = (error as Error)?.message ?? String(error); debug(error);
	}

	// Where a plan created from this cwd lives. Never writes.
	function candidate(cwd: string): { project?: string; label?: string; register?: boolean } {
		if (!refusal) return {};
		const name = inferredName(refusal, cwd);
		const configured = process.env.KATA_DEFAULT_PROJECT?.trim();
		return configured ? { project: configured, label: slug(name) } : { project: name, register: true };
	}

	async function destination(cwd: string) {
		const target = candidate(cwd);
		if (target.register) await kata.createProject(target.project!, cwd);
		return target;
	}

	function goLocal(ctx: any) {
		plan.local = true; delete plan.error;
		settlement.schedule();
		if (warnedFor === (currentId ?? "")) return;
		warnedFor = currentId ?? "";
		uiOf(ctx)?.notify?.(`Kata is unreachable${outage ? ` (${outage})` : ""}. todo keeps a local plan and replays it into Kata when Kata returns.`, "warning");
	}

	async function replayLocal(ctx: any) {
		if (!plan.local || !await probe(ctx.cwd)) return;
		const local = plan.tasks.filter(t => !t.ticket);
		if (!local.length) { delete plan.local; return; }
		plan = { tasks: [], workspace: plan.workspace };
		try {
			const phases = [...new Set(local.map(t => t.phase))].map(phase => ({ phase }));
			await ensureParent({ list: phases }, ctx);
			if (plan.local) { plan = { tasks: withNamed(local), local: true, workspace: plan.workspace }; return; } // Kata went away again
			const cwd = plan.workspace;
			for (const t of local) await create(t.phase, t.content, cwd);
			await load(cwd);
			for (const t of local) {
				const task = plan.tasks.find(x => x.phase === t.phase && x.content === t.content);
				if (!task || t.status === "pending") continue;
				try {
					if (t.status === "completed" && !hasProof(t.proof ?? {})) await transition(task, "blocked", { reason: "Completed while Kata was unreachable; add evidence and close it." }, cwd);
					else await transition(task, t.status, { ...t.proof, reason: t.blocker }, cwd);
				} catch (error) {
					debug(error);
					await transition(task, "blocked", { reason: `Replaying "${t.status}" from the local plan failed: ${(error as Error).message}` }, cwd).catch(debug);
				}
			}
			await advance(cwd).catch(debug);
		} catch (error) {
			// Whatever Kata took stays; the unreplayed plan is retried (creates are idempotent).
			plan = { tasks: withNamed(local), local: true, workspace: plan.workspace };
			settlement.schedule();
			throw error;
		}
	}

	// Automatic parents created for a session; none while the project is not registered yet.
	async function sessionParents(sessionId: string, project: string | undefined, cwd: string): Promise<any[]> {
		try { return JSON.parse(await kata.run(["list", "--status", "all", ...(project ? ["--project", project] : []), "--meta", `${namespace}.session_id=${sessionId}`, "--label", `${namespace}-session`, "--limit", "2"], cwd)).issues ?? []; }
		catch (error) { if (project && isKataCode(error, "project_not_initialized")) return []; throw error; }
	}

	async function sessionBinding(ctx: any): Promise<Binding | undefined> {
		const id = sid(ctx);
		if (!id) return;
		const where = candidate(ctx.cwd);
		const list = await sessionParents(id, where.project, ctx.cwd);
		// Creation records session identity before the guarded claim can finish.
		const candidates = list.filter((issue: any) => (issue.metadata?.[`${namespace}.auto_parent`] === true || issue.metadata?.[`${namespace}.auto_parent`] === undefined) && issue.metadata?.[`${namespace}.session_id`] === id && sessionKey(issue.metadata?.[`${namespace}.workspace`] || ".", ctx.cwd) === sessionKey(ctx.cwd, ctx.cwd));
		if (candidates.length === 1) return { parent: candidates[0].qualified_id, workspace: candidates[0].metadata[`${namespace}.workspace`], sessionId: id, auto: true, label: where.label };
	}

	// omp records the fork source in the session header: its id, or its session file `<timestamp>_<id>.jsonl`.
	function forkSourceId(parentSession: unknown) {
		if (typeof parentSession !== "string" || !parentSession) return undefined;
		const name = path.basename(parentSession);
		return name.endsWith(".jsonl") ? name.slice(name.indexOf("_") + 1, -".jsonl".length) || undefined : parentSession;
	}

	async function bind(ctx: any, replay = true, initRef?: string) {
		let assigned: DelegateAssignment | undefined;
		if (!main(ctx)) { assigned = delegates.assignment(ctx); if (!assigned) return; }
		bound = false;
		boundAgent = agentKey(ctx);
		sessionTeammate = assigned?.teammate;
		assignedRef = assigned?.ref;
		const sources = { cwd: ctx.cwd, assigned, explicit: configuredRef(), initRef };
		const requested = explicitParent(sources)?.parent;
		requestedRef = requested;
		const id = sid(ctx);
		// Only a bind that starts a session this core did not already hold restores delegates: /tree and a branch switch keep the same one.
		const newSession = currentId !== id;
		currentId = id;
		lastSnapshot = undefined;
		currentCtx = ctx;
		plan = { tasks: [], workspace: path.resolve(ctx.cwd) }; named = []; aliases.clear(); deletedParent = undefined;
		scope = "unknown"; refusal = undefined; outage = "";
		const branch: any[] = ctx.sessionManager?.getBranch?.() ?? [];
		const snapshotOf = (owner: unknown) => [...branch].reverse().find((entry: any) => entry?.type === "custom" && entry.customType === SNAPSHOT_ENTRY && entry.data?.version === 1 && entry.data.sessionId === owner)?.data;
		let snapshot = snapshotOf(id);
		// A fork gets a new session id and copies the source's entries. It shares the source's work:
		// adopt its parent and ticket items, but not its retries (the source still owns those closes)
		// nor its local plan (replaying that would make a second automatic parent).
		let source: string | undefined;
		if (!snapshot && id) {
			source = forkSourceId(ctx.sessionManager?.getHeader?.()?.parentSession);
			snapshot = source && snapshotOf(source);
		}
		// A forked session keeps the source id as the parent's owner: the parent's session_id metadata names it.
		const parentOwner = source ?? id;
		settlement.restore(snapshot && !source ? snapshot : undefined);
		// Delegate records are in memory only: a resumed lead takes back the ones a past run left unfinished. A fork leaves them to the source.
		const unsettled: SavedDelegate[] = newSession && !source && Array.isArray(snapshot?.delegates) ? snapshot.delegates : [];
		// They settle in the background on the lead's queue, so the bind does not wait for Kata.
		if (unsettled.length && main(ctx)) void serial(async () => {
			if (delegates.restore(unsettled)) await drain();
		}).catch(debug);
		if (snapshot) {
			if (!source && snapshot.plan?.local && !requested) plan = { ...structuredClone(snapshot.plan), workspace: plan.workspace };
			named = structuredClone(snapshot.named ?? []);
			stamp = Math.max(0, ...named.map(t => t.at || 0));
			plan.tasks = withNamed(plan.tasks);
			// A deletion noticed without a todo result (shutdown, a drain, a pi launch) is still reported after a resume.
			if (typeof snapshot.deletedParent === "string") deletedParent = snapshot.deletedParent;
		}
		let stored: any = snapshot?.plan?.parent ? snapshot.plan : undefined;
		for (const entry of branch) {
			if (entry?.type !== "custom" || entry.customType !== STATE_ENTRY || (entry.data?.sessionId && entry.data.sessionId !== parentOwner)) continue;
			if (typeof entry.data?.parent === "string") stored = entry.data;
			else if (entry.data?.parent === null) stored = undefined;
		}
		if (source && !snapshot) stored = stored && { ...stored, sessionId: parentOwner };
		if (plan.local && !requested) stored = undefined;
		let down = false;
		const choice = await decidePlanParent({
			...sources, stored,
			session: async () => {
				if (!await probe(ctx.cwd)) { down = true; return; }
				// A restored local plan replays into its parent itself; do not rebind over it.
				if (id && !plan.local) return sessionBinding(ctx);
			},
		});
		if (down) { await drain(); bound = true; refresh(ctx); return; }
		const saved = choice.saved;
		if (choice.parent) {
			const workspace = choice.workspace;
			const shown = await kata.pin(choice.parent, workspace)
				.then(async qualified => ({ qualified, issue: (await kata.show(qualified, workspace)).issue }))
				.catch(error => {
					if (isExplicitParent(choice) || choice.saved?.auto !== true || !isKataCode(error, "issue_not_found")) throw error;
					forget(choice.parent!);
				});
			if (shown) {
				const { qualified, issue } = shown;
				const marker = issue.metadata?.[`${namespace}.auto_parent`];
				const owner = saved?.auto && typeof saved.sessionId === "string" && saved.sessionId !== id ? saved.sessionId : id;
				const auto = !isExplicitParent(choice) && saved?.auto !== false && (marker === true || (saved?.auto === true && marker === undefined)) && issue.metadata?.[`${namespace}.session_id`] === owner;
				setParent({ parent: qualified, workspace, sessionId: owner, auto, label: saved?.label });
				await load(workspace);
			}
		}
		if (replay) await drain();
		bound = true;
		refresh(ctx);
	}

	function setParent(binding: Binding) {
		scope = "bound";
		if (!binding.auto) settlement.dropAutoParent(binding.parent);
		if (plan.parent === binding.parent && plan.workspace === binding.workspace && plan.auto === binding.auto && plan.label === binding.label) return;
		if (plan.parent !== binding.parent) aliases.clear();
		plan = { ...binding, tasks: withNamed(plan.parent === binding.parent ? plan.tasks : []) };
		if (binding.auto) settlement.addAutoParent(binding);
		host.appendEntry(STATE_ENTRY, binding);
	}

	async function adopt(ref: string, ctx: any, workspace = ctx.cwd) {
		const parent = await kata.pin(ref, workspace);
		if (plan.auto && plan.parent && plan.parent !== parent) {
			// An automatic parent with no children only marks the session; retire it
			// rather than leave an empty child that can never auto-close.
			const old = plan.parent;
			const shown = await kata.show(old, plan.workspace).catch(error => {
				if (!isDeletedAutomaticParent(error, old)) throw error;
				forget(old);
			});
			if (shown?.issue.status === "open" && !shown.children?.length) {
				const decision = await owned(old, plan.workspace, false, false, shown.issue.revision);
				await kata.run(["close", old, "--if-match", String(decision.revision), "--superseded-by", parent, "--message", `This session adopted ${parent} as its plan parent.`], plan.workspace);
				settlement.dropAutoParent(old);
			}
		}
		if (plan.parent === parent) settlement.dropAutoParent(parent);
		setParent({ parent, workspace: path.resolve(workspace), sessionId: sid(ctx), auto: false });
		await load(workspace);
	}

	// ------------------------------------------------------------- transitions

	async function create(phase: string, content: string, cwd: string): Promise<void> {
		const project = projectOf(plan.parent!);
		const out = JSON.parse(await kata.run([
			"create", "--parent", plan.parent!, "--project", project, "--body", `Todo task in phase "${phase}".`,
			"--meta", `todo.phase=${phase}`, "--meta", "todo.status=pending", ...(plan.label ? ["--label", plan.label] : []),
			"--idempotency-key", `${namespace}-kata:${digest(plan.parent!, phase, content)}`,
			// Sibling tasks often read alike ("write x" / "verify x"); they are
			// deliberate plan items, so skip the look-alike soft-block.
			"--force-new", "--", content,
		], cwd));
		const issue = out?.issue;
		if (typeof issue?.short_id !== "string") throw new Error("kata create returned no short_id");
		// Replays may restore removed work, but never another writer's task.
		const ref = `${project}#${issue.short_id}`;
		if (issue.status === "closed" || issue.metadata?.["todo.removed"] === true) {
			let decision = await owned(ref, cwd, "check", true, issue.revision);
			if (decision.status === "closed") {
				await kata.run(["reopen", ref], cwd);
				decision = await owned(ref, cwd, "check", false, decision.revision + 1);
				decision = await work(ref, "todo.status", "pending", cwd, decision);
			}
			await work(ref, "todo.removed", undefined, cwd, decision);
		}
	}

	async function mark(ref: string, task: Task, from: Status, to: "in_progress" | "pending" | "blocked", change: Change, cwd: string, decision: KataIssue): Promise<KataIssue> {
		if (to === "blocked") {
			const reason = change.reason || "Blocked in the todo plan.";
			decision = await work(ref, "work.attention", "stuck", cwd, decision);
			decision = await work(ref, "work.attention_msg", reason, cwd, decision);
			task.blocker = reason;
		} else if (to === "in_progress" || from === "blocked") {
			decision = await work(ref, "work.attention", "ok", cwd, decision);
			decision = await work(ref, "work.attention_msg", undefined, cwd, decision);
		}
		return work(ref, "todo.status", to, cwd, decision);
	}

	async function transition(task: Task, to: Status, change: Change, cwd: string, validated?: any): Promise<void> {
		const from = task.status;
		if (from === to && to !== "blocked") return;
		if (task.ticket) return transitionNamed(task, to, change, cwd);
		const ref = task.ref;
		if (task.delegated || delegates.holds(ref)) {
			throw new Error(`Kata task ${ref} is delegated. Its subagent must manage and close it; use view to refresh its state.`);
		}
		if (plan.local) {
			task.status = to; task.blocker = to === "blocked" ? change.reason || "Blocked in the local plan." : undefined;
			if (to === "completed" || to === "abandoned") task.proof = { message: change.message, evidence: change.evidence };
			return;
		}
		if (to === "completed") requireProof(task, ref, change);
		let decision = validated ?? await owned(ref, cwd, to === "completed" || to === "abandoned" ? "check" : true, !OPEN.has(from) && to === "in_progress", task.revision);
		if (!OPEN.has(from) && to === "in_progress") {
			if (decision.status !== "closed") throw new Error(`Kata task ${ref} changed before restart.`);
			const revision = decision.revision;
			await kata.run(["reopen", ref], cwd);
			decision = await owned(ref, cwd);
			if (decision.revision !== revision + 1) throw new Error(`Kata task ${ref} changed during restart; no work metadata was written.`);
		}

		switch (to) {
			case "in_progress":
			case "pending":
			case "blocked":
				decision = await mark(ref, task, from, to, change, cwd, decision);
				break;
			case "completed": {
				const message = change.message ? `${change.message} (task: ${task.content}; ${task.ref})` : "";

				const args = ["close", ref, "--done", "--if-match", String(decision.revision), "--message", message];
				for (const e of change.evidence!) args.push("--evidence", e);
				task.revision = decision.revision;
				await closeTask(args, task, to, change, cwd);
				decision = await work(ref, "todo.status", "completed", cwd, { ...decision, status: "closed", revision: decision.revision + 1 });
				// Kata accepted the close with evidence; an earlier review request is settled.
				if (task.review) { await owned(ref, cwd, "check", true, decision.revision); await kata.run(["label", "rm", ref, "needs-review"], cwd); task.review = false; }
				break;
			}
			case "abandoned":
				task.revision = decision.revision;
				await closeTask(["close", ref, "--wontfix", "--if-match", String(decision.revision), "--message", wontfix("Dropped", task, change)], task, to, change, cwd);
				decision = await work(ref, "todo.status", "abandoned", cwd, { ...decision, status: "closed", revision: decision.revision + 1 });
				break;
		}
		task.revision = decision.revision;
		task.status = to;
		if (!change.remove) settlement.cancelTaskClose(ref);
		if (to !== "blocked") task.blocker = undefined;
	}

	function requireProof(task: Task, ref: string, change: Change): void {
		if (!hasProof(change)) {
			throw new Error(`Kata needs evidence and a 40+ character message to close ${ref} ("${task.content}") as done: pass evidence (commit:<sha>, test:<cmd>, pr:<url>, reviewed-paths:<path>) and a message saying what changed and how it was verified. If it is not verified, block it instead.`);
		}
	}

	// ------------------------------------------------- items naming a ticket

	// Kata deduplicates by this key, so a replay never comments twice for one item.
	const noteKey = (task: Task, verb: string) => `${namespace}-item:${digest(currentId ?? "", task.ticket!, task.phase, task.content, String(task.at ?? 0))}:${verb}`;
	const note = (task: Task, verb: string, body: string, cwd: string) => kata.run(["comment", task.ticket!, "--idempotency-key", noteKey(task, verb), "--body", body], cwd);

	// A ticket whose last working item left in_progress/blocked goes back to pending and ok.
	// An unowned-by-us or closed ticket is left alone.
	async function settleTicket(task: Task, cwd: string): Promise<void> {
		const ticket = task.ticket!;
		if (named.some(other => other !== task && other.ticket === ticket && WORKING.has(other.status))) return;
		let decision: KataIssue;
		try { decision = await owned(ticket, cwd, "check"); }
		catch (error) { debug(error); return; }
		await mark(ticket, task, "blocked", "pending", {}, cwd, decision);
	}

	// An item works its ticket: start claims it, done comments and the last done item closes it,
	// drop only comments. A closed ticket is never reopened and never replaced by a new issue.
	async function transitionNamed(task: Task, to: Status, change: Change, cwd: string): Promise<void> {
		const from = task.status, ticket = task.ticket!;
		if (delegates.holds(ticket)) throw new Error(`Kata ticket ${ticket} is delegated. Its subagent must manage and close it; use view to refresh its state.`);
		if (to === "completed") requireProof(task, ticket, change);
		if (to === "abandoned") {
			await note(task, "drop", `Dropped from the todo plan: "${task.content}". Reason: ${change.message || change.reason || "no longer needed"}. The ticket stays open.`, cwd);
			if (WORKING.has(from)) await settleTicket(task, cwd);
		} else {
			const shown: KataIssue = (await kata.show(ticket, cwd)).issue;
			if (shown.status !== "open") {
				if (to !== "pending") throw new Error(`Kata ticket ${ticket} ("${task.content}") is already closed; the plugin never reopens a ticket. Reopen it yourself if the work continues.`);
			} else if (to !== "completed") {
				await mark(ticket, task, from, to as "in_progress" | "pending" | "blocked", change, cwd, await owned(ticket, cwd, true));
			} else {
				const decision = await owned(ticket, cwd, "check");
				await note(task, "done", `Todo item done: "${task.content}"\n${change.message}\nEvidence: ${change.evidence!.join(", ")}`, cwd);
				if (!named.some(other => other !== task && other.ticket === ticket && OPEN.has(other.status))) await closeTicket(task, decision, change, cwd);
				else if (WORKING.has(from)) await settleTicket(task, cwd);
			}
		}
		task.status = to;
		if (to !== "blocked") task.blocker = undefined;
	}

	function addNamed(phase: string, content: string, ticket: string) {
		named.push({ ref: `item:${digest(phase, content)}`, content, phase, status: "pending", ticket, at: nextStamp() });
	}

	// Resolve and check every ticket the new items name before anything is created:
	// an unresolvable, closed, or foreign-owned ticket fails the whole call.
	// Maps `phase\0content` to the ticket's canonical ref.
	async function resolveNamed(items: { phase: string; content: string }[], cwd: string, isNew: (item: { phase: string; content: string }) => boolean): Promise<Map<string, string>> {
		const tickets = new Map<string, string>(), checked = new Map<string, string>();
		for (const item of items) {
			const ref = itemTicket(item.content)?.ref;
			if (!ref || !isNew(item)) continue;
			let ticket = checked.get(ref);
			if (!ticket) {
				let shown: KataIssue;
				try { shown = (await kata.show(ref, cwd)).issue; }
				catch (error) { throw new Error(`Todo item "${item.content}" names ${ref}, which Kata cannot resolve: ${(error as Error).message}. Nothing was created.`); }
				if (shown.status !== "open") throw new Error(`Todo item "${item.content}" names ${ref}, which is already closed; the plugin never reopens a ticket. Nothing was created.`);
				ticket = await kata.qualify(shown, cwd, ref);
				try { await owned(ticket, cwd, "check"); }
				catch (error) { throw new Error(`Todo item "${item.content}" cannot work ${ticket}: ${(error as Error).message} Nothing was created.`); }
				checked.set(ref, ticket);
			}
			tickets.set(itemKey(item), ticket);
		}
		return tickets;
	}

	// The last item of a ticket is done: close it with that item's evidence. Kata
	// refuses a ticket with open children; it stays open and says why once. When
	// every open child is a task of this plan the close is held (see settlement.ts)
	// as they close; an umbrella with children outside the plan stays open.
	async function closeTicket(task: Task, decision: KataIssue, change: Change, cwd: string) {
		const ticket = task.ticket!;
		const request: PendingClose = { key: noteKey(task, "close"), message: `${change.message} (item: ${task.content}; ${ticket})`, evidence: change.evidence!, cwd };
		try { await closeWith(ticket, decision, request); }
		catch (error) {
			if (!isKataCode(error, "parent_has_open_children")) throw error;
			const shown: KataShow = await kata.show(ticket, cwd);
			const open = openChildren(shown, ticket);
			const many = open.length !== 1;
			const ours = open.every(ref => plan.tasks.some(t => (t.ticket ?? t.ref) === ref));
			if (ours) settlement.holdTicketClose(ticket, { ...request, key: noteKey(task, "close-after-children") }, cwd);
			const why = `Every todo item for ${ticket} is done, but ${open.length} open ${many ? "children block" : "child blocks"} closing it, so it stays open.`;
			await note(task, "blocked", ours
				? `${why} It closes once ${many ? "they are" : "that child is"} closed; the plugin retries when ${many ? "they close" : "it closes"} during this session.`
				: `${why} ${many ? "They are" : "It is"} outside this todo plan, so close the ticket yourself once ${many ? "they are" : "it is"} done.`, cwd);
		}
	}

	async function closeWith(ticket: string, decision: KataIssue, request: PendingClose) {
		const args = ["close", ticket, "--done", "--if-match", String(decision.revision), "--idempotency-key", request.key, "--message", request.message];
		for (const e of request.evidence) args.push("--evidence", e);
		await kata.run(args, request.cwd);
		if (decision.metadata?.["todo.status"] !== undefined) {
			await owned(ticket, request.cwd, "check", true).then(closed => work(ticket, "todo.status", "completed", request.cwd, closed)).catch(debug);
		}
	}

	// Kata wants 60+ characters for wontfix; the task and plan context supply
	// that around the caller's reason.
	function wontfix(verb: string, task: Task, change: Change): string {
		const why = change.message || change.reason || "no longer needed";
		return `${verb} from the todo plan under ${plan.parent}: "${task.content}". Reason: ${why}. This task was intentionally retired from the plan without asserting completion.`;
	}

	const leads = (t: Task) => !t.delegated && !delegates.holds(t.ticket ?? t.ref);

	async function remove(task: Task, change: Change, cwd: string): Promise<void> {
		if (task.ticket) {
			const working = WORKING.has(task.status);
			if (OPEN.has(task.status)) await note(task, "rm", `Removed from the todo plan: "${task.content}". Reason: ${change.message || change.reason || "no longer needed"}. The ticket stays open.`, cwd);
			named = named.filter(t => t !== task);
			plan.tasks = plan.tasks.filter(t => t !== task);
			if (working) await settleTicket(task, cwd);
			return;
		}
		if (plan.local) { plan.tasks = plan.tasks.filter(t => t !== task); return; }
		if (OPEN.has(task.status)) {
			await transition(task, "abandoned", { ...change, remove: true }, cwd);
		}
		const decision = await owned(task.ref, cwd, "check", true, task.revision);
		await work(task.ref, "todo.removed", true, cwd, decision);
		settlement.cancelTaskClose(task.ref);
	}

	function nextTask(tasks: Task[]): Task | undefined {
		if (tasks.some(t => t.status === "in_progress" && leads(t))) return;
		return phasesOf(tasks).flatMap(p => p.tasks).find(t => t.status === "pending" && leads(t));
	}

	async function advance(cwd: string): Promise<void> {
		const next = nextTask(plan.tasks);
		if (next) await transition(next, "in_progress", {}, cwd);
	}

	async function resolve(target: string | undefined, phase: string | undefined, fallback: "active" | "none"): Promise<Task[]> {
		if (phase && !target) {
			const tasks = plan.tasks.filter(t => t.phase === phase);
			if (tasks.length === 0) throw new Error(`No phase "${phase}". Phases: ${phasesOf(plan.tasks).map(p => p.name).join(", ") || "none"}`);
			return tasks;
		}
		if (!target) {
			// Never guess between two active tasks: closing one closes it with this evidence.
			const active = plan.tasks.filter(t => t.status === "in_progress" && leads(t));
			if (fallback === "active" && active.length === 1) return active;
			if (fallback === "active" && active.length > 1) throw new Error(`Several tasks are in progress (${active.map(t => `"${t.content}"`).join(", ")}); name the task.`);
			throw new Error("Name the task (verbatim content or Kata ref).");
		}
		if (!plan.local && !plan.tasks.some(t => t.content === target) && /(?:^|#)[0-9a-hjkmnp-tv-z]{26}$/i.test(target)) target = await kata.pin(target, plan.workspace);
		const exact = plan.tasks.filter(t => t.content === target || t.ref === target || t.ref.split("#")[1] === target);
		if (exact.length === 1) return exact;
		if (QUALIFIED_REF_ONLY.test(target) && !exact.length && !plan.local) {
			// A short id is only unique per project: compare the ticket the ref names now, never its short id alone.
			const pinned = await kata.pin(target, plan.workspace).catch(() => undefined);
			const moved = plan.tasks.filter(t => t.ref === pinned);
			if (moved.length === 1) return moved;
		}
		const needle = target.toLowerCase();
		const fuzzy = plan.tasks.filter(t => t.content.toLowerCase().includes(needle));
		if (fuzzy.length === 1) return fuzzy;
		throw new Error(
			`${fuzzy.length ? "Ambiguous" : "No"} task "${target}". Tasks: ${plan.tasks.map(t => `"${t.content}"`).join(", ") || "none"}`,
		);
	}

	const planParentSources = (params: any, ctx: any) => ({
		cwd: ctx.cwd, assigned: { ref: assignedRef, workspace: plan.workspace }, explicit: configuredRef(), initRef: params.ref,
		stored: plan.parent ? { parent: plan.parent, workspace: plan.workspace } : undefined,
	});

	// Creates the session's automatic parent. Once a person deleted it, Kata refuses its idempotency key: `idempotency_deleted`,
	// or `idempotency_mismatch` when this create's title or body differs from the deleted one's. The new parent takes a key
	// derived from the deleted one, so a retry, the lead and its pi children all reach the same issue.
	async function createAutomaticParent(sessionId: string, title: string, where: { project?: string; label?: string }, workspace: string, teammate?: string): Promise<{ ref: string; issue: KataIssue }> {
		const args = [...(where.project ? ["--project", where.project] : []), ...(where.label ? ["--label", where.label] : []), "--body", `Todo plan from ${namespace} session ${sessionId}.`, ...(teammate !== undefined ? ["--teammate", teammate] : []),
			"--meta", `${namespace}.session_id=${sessionId}`, "--meta", `${namespace}.workspace=${workspace}`, "--label", `${namespace}-session`, "--force-new", "--", title];
		let key = `${namespace}-session:${sessionId}`;
		for (const spent = new Set<string>(); ;) {
			let out: any;
			try { out = JSON.parse(await kata.run(["create", "--idempotency-key", key, ...args], workspace)); }
			catch (error) {
				const uid = (error as KataError).info?.data?.uid;
				if (typeof uid !== "string" || spent.has(uid) || !(isKataCode(error, "idempotency_deleted") || isKataCode(error, "idempotency_mismatch") && await isDeleted(uid, workspace))) throw error;
				spent.add(uid);
				key = `${namespace}-session:${sessionId}:after:${uid}`;
				continue;
			}
			const event = out.event ?? out.original_event;
			if (!out.issue?.short_id || !event?.project_name) throw new Error("kata create returned no parent identity");
			return { ref: `${event.project_name}#${out.issue.short_id}`, issue: out.issue };
		}
	}

	async function isDeleted(uid: string, cwd: string): Promise<boolean> {
		try { await kata.show(uid, cwd); return false; }
		catch (error) { if (isKataCode(error, "issue_not_found")) return true; throw error; }
	}

	async function ensureParent(params: any, ctx: any): Promise<string | undefined> {
		let down = false;
		const choice = await decidePlanParent({
			...planParentSources(params, ctx),
			// A Pi child may establish the session parent before the lead uses todo.
			session: async () => {
				if (!await probe(ctx.cwd)) { down = true; return; }
				return sessionBinding(ctx);
			},
		});
		if (choice.parent && isExplicitParent(choice) && (choice.provenance === "init" || !namesPlanParent(plan.parent, aliases, choice.parent))) {
			requestedRef = choice.parent;
			try { await adopt(choice.parent, ctx); }
			catch (error) { bound = false; throw error; }
		}
		if (down) { goLocal(ctx); return; }
		if (!plan.parent && choice.provenance === "session") { setParent({ ...choice.saved!, parent: choice.parent!, workspace: choice.workspace }); await load(choice.workspace); }
		if (plan.parent) {
			const ref = plan.parent;
			let decision: KataIssue | undefined;
			try { decision = await reopenParent(); }
			catch (error) { if (!isDeletedAutomaticParent(error, ref)) throw error; forget(ref); }
			if (plan.parent) {
				if (decision && decision.metadata?.[`${namespace}.auto_parent`] === undefined) decision = await work(plan.parent, `${namespace}.auto_parent`, true, plan.workspace, decision);
				if (decision && decision.metadata?.["work.attention"] === undefined) await work(plan.parent, "work.attention", "ok", plan.workspace, decision);
				return plan.parent;
			}
		}
		const sessionId = sid(ctx);
		if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("Kata needs a real session id before creating an automatic parent.");
		const title = (params.message as string | undefined)?.trim() || host.getSessionName?.() || `Todo plan: ${(params.list ?? []).map((p: any) => p.phase).join(", ") || "tasks"}`.slice(0, 120);
		const cwd = path.resolve(ctx.cwd);
		let where: Awaited<ReturnType<typeof destination>>, created: { ref: string; issue: KataIssue };
		try {
			where = await destination(cwd);
			created = await createAutomaticParent(sessionId, title, where, cwd);
		} catch (error) {
			// A folder with no git ancestor is refused client-side, so the probe never reached the daemon.
			if (!isUnusable(error)) throw error;
			wentDown(error);
			goLocal(ctx); return;
		}
		const { ref } = created;
		let decision = await owned(ref, cwd, true, false, created.issue.revision);
		decision = await work(ref, `${namespace}.auto_parent`, true, cwd, decision);
		setParent({ parent: ref, workspace: cwd, sessionId, auto: true, label: where.label });
		if (decision.metadata?.["work.attention"] === undefined) await work(ref, "work.attention", "ok", cwd, decision);
		return ref;
	}

	async function reopenParent() {
		if (!plan.parent || !plan.auto) return;
		let decision = await owned(plan.parent, plan.workspace, true, true);
		if (decision.status === "closed") {
			await kata.run(["reopen", plan.parent], plan.workspace);
			decision = await owned(plan.parent, plan.workspace, false, false, decision.revision + 1);
		}
		return decision;
	}

	// Thrown when Kata throttled a close, which is now a pending close (settlement.ts owns the `PendingClose` name).
	class ClosePending extends Error {}
	async function closeTask(args: string[], task: Task, to: Status, change: Change, cwd: string) {
		try { await kata.run(args, cwd); }
		catch (error) {
			if (!isKataCode(error, "sibling_throttle")) throw error;
			const text = settlement.pendTaskClose(task, to, change, cwd, task.ticket ? undefined : plan.parent);
			persist();
			throw new ClosePending(text);
		}
	}

	async function performTask(pending: { task: Task; to: Status; change: Change; cwd: string }) {
		const { task, change, cwd } = pending;
		if (change.remove) await remove(task, change, cwd);
		else await transition(task, pending.to, change, cwd);
		if (plan.tasks.some(t => t.ref === task.ref)) { await load(plan.workspace); await advance(plan.workspace); }
	}

	async function flagDropped(ref: string, cwd: string, error: unknown) {
		const code = (error as KataError | undefined)?.code;
		await kata.run(["label", "add", ref, "needs-review"], cwd);
		await kata.run(["comment", ref, "--body", `The plugin gave up closing ${ref} after ${MAX_FAILURES} failed attempts (Kata error code: ${code ?? "none, not a Kata error"}): ${(error as Error)?.message ?? error}. Review it and close it yourself.`], cwd);
	}

	// The one settlement pass: a deleted automatic parent is forgotten first, then exited delegates settle, the session's
	// local plan replays, and pending closes and the automatic parent's close run.
	async function drain() {
		// A deleted automatic parent takes its plan tasks' pending closes with it: the load forgets it before they run.
		if (plan.parent && plan.auto && settlement.hasPlanCloses(plan.parent)) await load(plan.workspace).catch(debug);
		await delegates.settle();
		if (plan.local && currentCtx) await replayLocal(currentCtx).catch(debug);
		await settlement.drain();
		if (plan.local) settlement.schedule();
		persist();
	}

	// ---------------------------------------------------------------------- ops

	// init closes every task missing from the new list; leaving out an open task needs an explicit replace.
	function refuseOpen(replace: boolean, tasks: Task[], wanted: Set<string>): void {
		if (replace) return;
		const open = tasks.filter(t => OPEN.has(t.status) && !wanted.has(itemKey(t)));
		if (!open.length) return;
		throw new Error(`The new todo list leaves out open tasks, so init changed nothing:\n${open.map(t => `- ${MARK[t.status]} ${t.content}`).join("\n")}\nTo replace them, call init again with replace: true.`);
	}

	async function apply(params: any, ctx: any): Promise<string> {
		if (!bound || currentId !== sid(ctx)) await bind(ctx, params.op === "view", params.ref ?? (!bound ? requestedRef : undefined));
		currentCtx = ctx;
		currentId ||= sid(ctx);
		if (plan.local) {
			try { await replayLocal(ctx); }
			catch (error) { if (params.op !== "view") throw new Error(`Kata is reachable again, but the local plan could not be replayed into it: ${(error as Error).message}`); }
		}
		let cwd = plan.workspace;
		const change: Change = { message: params.message?.trim() || undefined, evidence: params.evidence, reason: params.reason?.trim() || undefined };
		const op = params.op as string;
		if (op === "view") {
			await load(cwd);
			if (plan.parent) await drain();
			return render(plan);
		}
		if (op === "init") {
			const desired: { phase: string; content: string }[] = params.list?.length
				? params.list.flatMap((p: any) => p.items.map((content: string) => ({ phase: p.phase, content })))
				: (params.items ?? []).map((content: string) => ({ phase: params.phase || "Tasks", content }));
			if (desired.length === 0) throw new Error("init needs list (phases with items) or items.");
			if (desired.some(d => !d.content.trim() || !d.phase.trim())) throw new Error("Task and phase names must not be blank.");
			const wanted = new Set(desired.map(itemKey));
			const resolved = await resolveNamed(desired, plan.workspace, d => !named.some(t => t.phase === d.phase && t.content === d.content));
			if (plan.parent && plan.auto) await load(plan.workspace);
			const choice = await decidePlanParent(planParentSources(params, ctx));
			const target = choice.parent;
			if (target) {
				const workspace = choice.workspace;
				const keepsParent = choice.provenance === "init" ? target === plan.parent || aliases.has(target) : namesPlanParent(plan.parent, aliases, target);
				const parent = keepsParent && plan.parent ? plan.parent : await kata.pin(target, workspace);
				if (choice.overridden && parent !== await kata.pin(choice.overridden, workspace)) throw new Error(`Kata init ref ${params.ref} conflicts with the explicit binding ${target}; neither plan was replaced.`);
				const tasks = tasksOf((await showParent(parent, workspace)).children ?? [], parent);
				refuseOpen(params.replace === true, [...tasks, ...named], wanted);
				const kept = tasks.filter(t => wanted.has(itemKey(t)));
				const affected = new Set(tasks.filter(t => !kept.includes(t)));
				const next = nextTask(kept);
				if (next) affected.add(next);
				for (const task of affected) await owned(task.ref, workspace, "check", true, task.revision);
			}
			if (!target) refuseOpen(params.replace === true, plan.tasks, wanted);
			if (target || needsParent(desired.map(d => d.content))) await ensureParent(params, ctx);
			cwd = plan.workspace;
			await load(cwd);
			// ensureParent may have found a parent with open tasks (a restored one, or one a pi child created).
			if (!target) refuseOpen(params.replace === true, plan.tasks, wanted);
			for (const task of plan.tasks) if (wanted.has(itemKey(task))) settlement.cancelRemoval(task.ref);
			for (const task of plan.tasks) {
				if (!wanted.has(itemKey(task))) await remove(task, { message: "replaced by a new todo plan" }, cwd);
			}
			const have = new Set(plan.tasks.map(itemKey));
			for (const d of desired) if (!have.has(itemKey(d))) {
				const ticket = resolved.get(itemKey(d));
				if (ticket) addNamed(d.phase, d.content, ticket);
				else if (plan.local) plan.tasks.push({ ...d, ref: `local-${digest(d.phase, d.content)}`, status: "pending", at: nextStamp() });
				else await create(d.phase, d.content, plan.workspace);
				have.add(itemKey(d));
			}
			await load(cwd);
			await advance(cwd);
			return render(plan);
		}
		let children = await load(cwd);
		if (!plan.parent && !plan.local && !named.length) throw new Error("No todo plan yet. Call todo op=init first.");
		switch (op) {
			case "append": {
				const items: string[] = params.items?.length ? params.items : params.task ? [params.task] : [];
				if (items.length === 0) throw new Error("append needs items.");
				if (items.some(content => !content.trim()) || (params.phase !== undefined && !params.phase.trim())) throw new Error("Task and phase names must not be blank.");
				const phase = params.phase || plan.tasks[plan.tasks.length - 1]?.phase || "Tasks";
				const resolved = await resolveNamed(items.map(content => ({ phase, content })), cwd, d => !named.some(t => t.phase === d.phase && t.content === d.content && OPEN.has(t.status)));
				if (needsParent(items) && !plan.parent && !plan.local) {
					await ensureParent({ list: [{ phase }], message: params.message }, ctx);
					cwd = plan.workspace;
					children = await load(cwd);
				}
				if (!plan.local) {
					for (const child of children) {
						const ref = qualifiedRef(child, plan.parent!);
						if (child.metadata?.["todo.phase"] === phase && items.includes(child.title) &&
							(child.status === "closed" || child.metadata?.["todo.removed"] === true)) {
							await owned(ref, cwd, "check", true, child.revision);
						}
					}
				}
				await reopenParent();
				for (const content of items) {
					const ticket = resolved.get(itemKey({ phase, content }));
					if (!ticket && itemTicket(content)) continue;
					if (ticket) {
						named = named.filter(t => t.phase !== phase || t.content !== content || OPEN.has(t.status));
						if (!named.some(t => t.phase === phase && t.content === content)) addNamed(phase, content, ticket);
					} else if (plan.local) {
						const existing = plan.tasks.filter(t => t.content === content && t.phase === phase);
						if (existing.length > 1) throw new Error(`Ambiguous local task "${content}"; no task was appended.`);
						if (!existing.length) plan.tasks.push({ content, phase, ref: `local-${digest(phase, content)}`, status: "pending", at: nextStamp() });
					} else {
						await create(phase, content, cwd);
						for (const task of plan.tasks.filter(t => t.content === content && t.phase === phase)) settlement.cancelRemoval(task.ref);
					}
				}
				await load(cwd);
				break;
			}
			case "start": {
				const [task] = await resolve(params.task, undefined, "none");
				if (task.status === "blocked") throw new Error(`"${task.content}" is blocked; unblock it first.`);
				const decision = plan.local || task.ticket ? undefined : await owned(task.ref, cwd, true, !OPEN.has(task.status), task.revision);
				if (decision) task.revision = decision.revision;
				if (!OPEN.has(task.status) && !task.ticket) await reopenParent();
				for (const other of plan.tasks) if (other !== task && other.status === "in_progress" && leads(other) && !settlement.hasTaskClose(other.ref)) await transition(other, "pending", {}, cwd);
				await transition(task, "in_progress", change, cwd, decision);
				settlement.cancelTaskClose(task.ref);
				break;
			}
			case "done":
			case "drop": {
				const tasks = (await resolve(params.task, params.phase, "active")).filter(t => OPEN.has(t.status));
				for (const task of tasks) await transition(task, op === "done" ? "completed" : "abandoned", change, cwd);
				break;
			}
			case "rm":
				for (const task of await resolve(params.task, params.phase, "none")) await remove(task, change, cwd);
				await load(cwd);
				break;
			case "block":
				for (const task of await resolve(params.task, undefined, "active")) await transition(task, "blocked", change, cwd);
				break;
			case "unblock":
				for (const task of await resolve(params.task, undefined, "none")) if (task.status === "blocked") await transition(task, "pending", change, cwd);
				break;
			default:
				throw new Error(`Unknown op "${op}".`);
		}
		await advance(cwd);
		await drain();
		return render(plan);
	}

	function details(op: string) {
		return {
			op,
			// Not a top-level `phases`: omp's native todo tracker reads that key from
			// any result named `todo` and would add its own reminders, nudges and HUD.
			kata: {
				parent: plan.parent, workspace: plan.workspace, label: plan.label,
				phases: phasesOf(plan.error ? [] : plan.tasks).map(p => ({
					name: p.name,
					tasks: p.tasks.map(t => (t.blocker ? { content: t.content, status: t.status, blocker: t.blocker } : { content: t.content, status: t.status })),
				})),
			},
		};
	}

	async function execute(params: any, ctx: any) {
		return callCtx.run(ctx, () => serial(async () => {
			if (boundAgent && boundAgent !== agentKey(ctx)) {
				return { content: [{ type: "text" as const, text: "Kata agent identity changed; use this worker's own extension context." }], details: { op: params.op, kata: {} }, isError: true };
			}
			try {
				if (!main(ctx) && !delegates.assignment(ctx)) throw new Error(delegates.unassigned(ctx));
				const text = withDeletionNotice(await apply(params, ctx), params.op === "init");
				return { content: [{ type: "text" as const, text }], details: details(params.op) };
			} catch (err) {
				// A failed initial binding has no authoritative plan to render yet; a deleted parent's notice is one.
				if (!bound || !plan.parent && !plan.local && !named.length && !deletedParent) plan.error = (err as Error).message;
				// Kata may have applied part of a batch. A failed reload marks the
				// cached tasks unavailable instead of presenting them as current.
				if (plan.parent || named.length) await load(plan.workspace).catch(debug);
				return {
					content: [{ type: "text" as const, text: withDeletionNotice(`${(err as Error).message}\n\n${render(plan)}`) }],
					details: details(params.op),
					isError: err instanceof ClosePending ? undefined : true,
				};
			} finally {
				persist();
				refresh(ctx);
			}
		}));
	}

	async function command(ctx: any, args: string): Promise<string> {
		const match = /^(\S+)?(?:\s+([\s\S]*))?$/.exec(args.trim());
		const sub = match?.[1] ?? "";
		const arg = match?.[2]?.trim() || undefined;
		const actor = process.env.USER || "user";
		const supported: Record<string, any> = {
			"": { op: "view" },
			start: { op: "start", task: arg },
			done: { op: "done", task: arg, message: `Marked done by ${actor} through /todo in ${namespace}; the user attests the work is complete.`, evidence: [`external:${actor}`] },
			drop: { op: "drop", task: arg, message: `dropped by ${actor} through /todo` },
			rm: { op: "rm", task: arg, message: `removed by ${actor} through /todo` },
			append: { op: "append", items: arg ? [arg] : [] },
			block: { op: "block", reason: arg },
			unblock: { op: "unblock", task: arg },
		};
		const params = supported[sub];
		if (!params) return `/todo ${sub} is not available with Kata. Use /todo [start|done|drop|rm|append|block|unblock], or kata tui.`;
		return serial(async () => {
			try {
				return withDeletionNotice(await apply(params, ctx));
			} catch (err) {
				return withDeletionNotice((err as Error).message);
			} finally {
				persist();
				refresh(ctx);
			}
		});
	}

	async function observeToolResult(event: any, ctx: any) {
		progressed = true;
		if (!main(ctx) || configuredRef() || event.toolName !== "bash" || event.isError || (event.details?.exitCode !== undefined && event.details.exitCode !== 0)) return;
		const command = event.input?.command;
		if (typeof command !== "string" || /[;|\n]/.test(command)) return;
		for (const invocation of kataCommands(command, options.executable, options.executableVars)) {
			const parsed = shellOptions(invocation.words), args = parsed.args;
			let ref = args[0] === "claim" ? args[1] : args[0] === "meta" && args[1] === "set" && args[3] === "work.attention" && args[4] === "ok" ? args[2] : undefined;
			if (!ref || parsed.options.has("--as")) continue;
			if (!ref.includes("#") && parsed.value("--project")) ref = `${parsed.value("--project")}#${ref}`;
			const workspace = path.resolve(event.input.cwd || ctx.cwd, parsed.value("--workspace") || ".");
			const target = ref;
			await bounded(serial(async () => {
				if (plan.tasks.some(t => t.ref === target || t.ref.split("#")[1] === target)) return;
				await owned(target, workspace);
				await adopt(target, ctx, workspace);
			}));
		}
	}

	async function remind(messages: any[], ctx: any, signal?: AbortSignal): Promise<string | undefined> {
		if (!main(ctx)) return;
		const deadline = Date.now() + TURN_SETTLE_MS;
		// An abort (Esc) ends the wait only; the queued cleanups keep running and are safe to repeat.
		let onAbort: (() => void) | undefined;
		const aborted = new Promise<undefined>(resolve => {
			if (signal?.aborted) return resolve(undefined);
			onAbort = () => resolve(undefined);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
		const until = <T>(promise: Promise<T | undefined>) => Promise.race([promise, aborted]);
		const refresh = serial(async () => { await load(plan.workspace); await drain(); return true; });
		let refreshed: boolean | undefined;
		try {
			// Checked after the short bound, not before queuing: a delegate that exited while the queue was busy still counts.
			refreshed = await until(bounded(refresh));
			if (!refreshed && delegates.cleanupPending()) refreshed = await until(bounded(refresh, deadline - Date.now()));
			// A delegate that exits during the wait queues its own cleanup after the refresh: wait for those too. Stop when a pass
			// leaves the same cleanups pending (Kata unreachable, a step failing), so an outage does not hold every turn end.
			while (refreshed && !signal?.aborted && delegates.cleanupPending() && Date.now() < deadline) {
				const seen = delegates.pendingIds().join();
				await until(bounded(serial(async () => { await drain(); return true; }), deadline - Date.now()));
				if (delegates.pendingIds().join() === seen) break;
			}
		} finally { if (onAbort) signal?.removeEventListener("abort", onAbort); }
		if (signal?.aborted) return;
		if (!refreshed || plan.error) return;
		const open = plan.tasks.filter(t => t.status === "pending" || t.status === "in_progress");
		if (open.length === 0 || reminders >= MAX_REMINDERS || !progressed) return;
		// Do not push past a question the assistant just asked the user.
		const last = [...(messages)].reverse().find((m: any) => m?.role === "assistant");
		const text = Array.isArray(last?.content)
			? last.content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("")
			: String(last?.content ?? "");
		if (text.trim().endsWith("?")) return;
		reminders++;
		progressed = false;
		return [
				"<system-reminder>",
				`Open Kata todo tasks${plan.parent ? ` under ${plan.parent}` : ""} (reminder ${reminders}/${MAX_REMINDERS}):`,
				...open.map(t => `- ${t.content} (${t.ticket ?? t.ref}, ${t.status})`),
				"Continue the work, or update the plan: done with evidence, block with a reason when waiting on someone, or drop with a reason.",
				"If the user asked you to stop or pause, do not continue: block the remaining tasks with that reason and stop.",
				"</system-reminder>",
			].join("\n");
	}

	// The actor whose requests count as trusted: resolved once per session, shared by the per-turn
	// read and the live follower so both apply the same rule.
	function inboxActor(cwd: string): Promise<string> {
		const entry = cache;
		return entry.actor ??= actor(cwd).catch(error => { entry.actor = undefined; throw error; });
	}

	// The contract is fetched once per session; the inbox on every call, so a request
	// sent mid-session reaches a later turn. A read slower than the caller's budget
	// keeps running and lands in the cache for the next turn. `inbox: false` leaves the
	// inbox to a caller that keeps it current another way.
	function warm(ctx: any, cwd = ctx.cwd, inbox = true) {
		const id = sid(ctx);
		if (cache.id !== id) cache = { id };
		const entry = cache;
		if (!entry.pending && !entry.contract) {
			entry.pending = (async () => {
				if (!await probe(cwd)) return;
				// Exactly these arguments: some Kata builds print nothing for any other form.
				const out = await kata.run(["agent-contract-hook", "--source", "kata-agent-contract-hook"], cwd, { timeout: 1000, workspace: false }).then(out => JSON.parse(out)?.hookSpecificOutput?.additionalContext);
				if (typeof out === "string") entry.contract = out;
			})().catch(debug).finally(() => { entry.pending = undefined; });
		}
		const user = process.env.KATA_INBOX_USER;
		// A bare actor is a person's own inbox (requests written for them, read by kata inbox and tern-kata's
		// Attention Page), never instructions for this session. Only <actor>/<teammate> is a session inbox.
		if (user && !isSessionAddress(user)) {
			if (!entry.personInbox) {
				entry.personInbox = true;
				uiOf(ctx)?.notify?.(`KATA_INBOX_USER=${user} is a person's inbox, so this session reads none. Use ${user}/<name> for a session inbox.`, "warning");
			}
		} else if (inbox && user && !entry.inboxPending) {
			// Only requests from the session's own actor reach the prompt. A failed read (or actor
			// lookup) keeps the last inbox; no trusted request removes the section.
			entry.inboxPending = (async () => {
				const mine = await inboxActor(cwd);
				const out = JSON.parse(await kata.run(["inbox", "--for", user], cwd));
				entry.inbox = trustedInbox(out?.requests, mine, user).text;
			})().catch(debug).finally(() => { entry.inboxPending = undefined; });
		}
		return Promise.all([entry.pending, entry.inboxPending]).then(() => undefined);
	}

	// ------------------------------------------------------------ live inbox

	// While the follower runs, `liveInbox` is the main session's `<kata_inbox>` text and the per-turn read is skipped for it.
	let liveInbox: string | undefined, follower: InboxFollower | undefined;
	function stopFollower() {
		follower?.stop();
		follower = undefined;
		liveInbox = undefined;
	}

	// Requests are delivered as an aside: an idle session starts a turn on them, a working one takes them at its
	// next step boundary without losing its tool batch. The sender is a relayed agent request, not the person.
	function startFollower(ctx: any, address: string) {
		const cwd = path.resolve(ctx.cwd), live = host.liveInbox!;
		follower = createInboxFollower({
			address,
			actor: () => inboxActor(cwd),
			read: async () => JSON.parse(await kata.run(["inbox", "--for", address], cwd)),
			spawn: cursor => live.spawn(cwd, cursor),
			deliver: text => { try { Promise.resolve(live.deliver(text)).catch(debug); } catch (error) { debug(error); } },
			publish: text => { liveInbox = text; },
			head: () => knownProjectHead(cwd, args => kata.run(args, cwd)),
			now: () => performance.now(),
			setTimer: (fn, ms) => { const handle = setTimeout(fn, ms); handle.unref(); return handle; },
			clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
			debug,
		});
		follower.start();
	}

	// --------------------------------------------------------------- attention

	// Kata owns session attention semantics; the harness name only selects payload parsing and the session token.
	let attentionSession: { id: string; cwd: string; ref?: string } | undefined;
	async function attention(mode: "start" | "end", session: { id: string; cwd: string; ref?: string }) {
		const ref = session.ref;
		if (!ref || !options.attentionHarness) return;
		try {
			// The native hook guards revisions, not the actor or teammate.
			await owned(ref, session.cwd);
			await kata.run(["agent-hook", "attention-native", options.attentionHarness, mode, "--session", session.id, "--host-pid", String(process.pid), "--ref", ref], session.cwd, { timeout: mode === "start" ? 3000 : 1500 });
		} catch (err) {
			debug(`Kata attention skipped: ${(err as Error).message}`);
		}
	}

	// -------------------------------------------------------------- the host

	const lead = (): Lead => ({ parent: plan.parent, workspace: plan.workspace, label: plan.label });
	// The lead stays attached to the main context: a sub identity can reach a main-session handler (omp's advisor).
	const see = (ctx: any) => { if (main(ctx) || !currentCtx || !main(currentCtx)) currentCtx = ctx; };
	const rebind = async (ctx: any): Promise<Lead> => {
		see(ctx);
		if (main(ctx)) await bounded(serial(() => bind(ctx)));
		return lead();
	};
	const warmFor = (ctx: any) => warm(ctx, delegates.assignment(ctx)?.workspace || ctx.cwd, !(main(ctx) && liveInbox !== undefined));
	const prefetch = (ctx: any) => { if (options.prefetch) void warmFor(ctx); };

	// A pi child joins the session that started it: its identity, its parent (found or created in the lead's name) and its assignment.
	// Fills in `parent.ref` and `parent.label`, and sets KATA_TEAMMATE and KATA_INBOX_USER for every later Kata call, bash included.
	async function join(ctx: any, parent: ChildParent, prompt: string): Promise<void> {
		const known = store.of(ctx);
		if (known) {
			process.env.KATA_TEAMMATE = known.teammate;
			process.env.KATA_INBOX_USER = `${await actor(known.binding?.workspace ?? parent.workspace, known.ref ?? parent.ref)}/${known.teammate}`;
			await delegates.apply({ type: "nextUse", id: known.id });
			if (currentId !== sid(ctx)) await bounded(serial(() => bind(ctx)), DELEGATE_BIND_MS);
			return;
		}
		const id = sid(ctx);
		if (!id) throw new Error("Pi child needs a real session identity before tracking work.");
		if (!parent.ref) {
			const workspace = parent.workspace;
			await serial(async () => { await probe(workspace); });
			const existing = (await sessionParents(parent.sessionId, candidate(workspace).project, workspace)).find((issue: any) => issue.metadata?.[`${namespace}.auto_parent`] === true);
			if (existing) parent.ref = existing.qualified_id;
			else {
				// A session-start extension can spawn before the lead uses todo.
				// Establish only parent identity; the child never writes lead work.*.
				const where = await destination(workspace);
				parent.label ??= where.label;
				const created = await createAutomaticParent(parent.sessionId, "Todo plan: tasks", where, workspace, parent.teammate);
				parent.ref = created.ref;
				if (!created.issue.owner) await kata.run(["claim", created.ref, "--if-unowned", "--teammate", parent.teammate], workspace);
				await kata.run(["meta", "set", created.ref, `${namespace}.auto_parent`, "true", "--json-value"], workspace);
			}
		}
		if (!parent.ref) throw new Error("Pi child parent identity is unavailable.");
		// The lead may have moved the parent since it exported its marker: the child's issue goes where the parent lives now.
		const binding: Binding = { parent: await kata.pin(parent.ref, parent.workspace), workspace: parent.workspace, sessionId: parent.sessionId, auto: false, label: parent.label };
		// Keep a teammate the lead chose for this child; otherwise derive a distinct one.
		const chosen = process.env.KATA_TEAMMATE || "";
		const teammate = chosen && chosen !== parent.teammate && chosen !== parent.via && CHILD_TEAMMATE.test(chosen) ? chosen : teammateFor(`${parent.teammate || namespace}:${parent.sessionId}:${id}`);
		process.env.KATA_TEAMMATE = teammate;
		process.env.KATA_INBOX_USER = `${await actor(binding.workspace, binding.parent)}/${teammate}`;
		const delegateScope = { parent: binding.parent, workspace: binding.workspace, label: binding.label, leadTeammate: parent.teammate, teammate };
		// A prompt the assignment rules refuse (two tickets, a taken task) tracks nothing.
		let reserved: Reservation | undefined, untracked = false;
		try { reserved = (await delegates.check([{ text: prompt }], [], delegateScope))[0]; }
		catch (error) { debug(error); untracked = true; }
		await delegates.apply({ type: "started", id, sessionId: id, leadSessionId: parent.sessionId, leadTeammate: parent.teammate, teammate, text: prompt, single: true,
			parent: binding.parent, workspace: binding.workspace, parentLabel: binding.label, reserved, untracked });
		if (currentId !== sid(ctx)) await bounded(serial(() => bind(ctx)), DELEGATE_BIND_MS);
	}

	return {
		session: {
			// The session began or switched: bind the plan, follow the inbox live when the host can, start attention.
			// `after` is host work (a delegate's assignment retry) the first context read waits for.
			// `child`: the workspace of a pi child still to join its parent; when Kata does not answer there, nothing starts and the result is undefined: the host runs the session as a main session and starts it again.
			async start(ctx: any, begin: { after?: Promise<unknown>; child?: string } = {}): Promise<Lead | undefined> {
				if (!main(ctx)) {
					if (begin.child !== undefined && !await probe(begin.child)) return undefined;
					currentCtx = ctx;
					void Promise.resolve(begin.after).then(() => prefetch(ctx)).catch(debug);
					return lead();
				}
				see(ctx);
				const explicit = configuredRef(), previous = attentionSession, id = sid(ctx);
				stopFollower();
				const user = process.env.KATA_INBOX_USER;
				const live = !!host.liveInbox && !!user && isSessionAddress(user);
				if (live) liveInbox = "";
				prefetch(ctx);
				if (live) startFollower(ctx, user!);
				await bounded(serial(async () => {
					await bind(ctx);
					reminders = 0;
					if (!options.attentionHarness || !id || previous?.id === id) return;
					if (previous) await attention("end", previous);
					attentionSession = { id, cwd: plan.workspace || path.resolve(ctx.cwd), ref: explicit && plan.parent };
					await attention("start", attentionSession);
				}));
				return lead();
			},
			branch: rebind,
			tree: rebind,
			input() { reminders = 0; },
			stop(ctx: any, messages: any[], signal?: AbortSignal): Promise<string | undefined> {
				see(ctx);
				return remind(messages, ctx, signal);
			},
			// A delegate that ends with its session passes `delegate`; `ended` makes this call report its exit.
			async shutdown(ctx: any, closing: { delegate?: { id: string; ended: boolean } } = {}): Promise<void> {
				see(ctx);
				if (!main(ctx) && !closing.delegate) return;
				stopFollower();
				const session = attentionSession;
				attentionSession = undefined;
				// After the drain: the automatic parent's close still records this session.
				await bounded((async () => {
					await serial(async () => {
						await load(plan.workspace || ctx.cwd).catch(debug);
						await drain();
						if (session) await attention("end", session);
					});
					if (closing.delegate?.ended) await delegates.apply({ type: "exited", id: closing.delegate.id, outcome: "ended" });
				})(), closing.delegate ? 3000 : SHUTDOWN_BOUND_MS);
			},
			// What the next prompt carries. `context: false` leaves the contract and inbox to another extension.
			async beforePrompt(ctx: any, prompt: { after?: Promise<unknown>; context?: boolean } = {}): Promise<{ sections: PromptSections; lead: Lead }> {
				see(ctx);
				const context = prompt.context !== false;
				// A delegate cannot learn its assignment later, so its prompt waits for it (`after`) up to DELEGATE_BIND_MS. The
				// contract and inbox reads keep their usual budget; a slower read lands in the cache for the next turn.
				if (!main(ctx)) await bounded(Promise.resolve(prompt.after), DELEGATE_BIND_MS);
				await bounded(Promise.all([
					main(ctx) && currentId !== sid(ctx) ? serial(() => bind(ctx)) : undefined,
					context ? warmFor(ctx) : undefined,
				]), main(ctx) ? 250 : 3000);
				const sections: PromptSections = {};
				if (context) {
					if (cache.contract) sections.contract = cache.contract;
					const inbox = main(ctx) && liveInbox !== undefined ? liveInbox : cache.inbox;
					if (inbox) sections.inbox = inbox;
				}
				const record = !main(ctx) ? store.of(ctx) : undefined;
				const assigned = record ? delegates.assignment(ctx) : undefined;
				if (record && assigned) sections.assignment = delegateContext(options.executable, record.id, assigned.ref, assigned.teammate, assigned.binding);
				else if (record?.state === "untracked") sections.assignment = untrackedDelegateContext(record.id);
				if (plan.parent || plan.tasks.some(t => t.ticket)) sections.todo = `The todo tool is backed by Kata. Current plan:\n${render(plan)}`;
				return { sections, lead: lead() };
			},
		},
		tools: {
			// A tool is about to run. `startsChild`: it may start an agent that inherits this session's plan parent, so the parent is established first.
			async call(ctx: any, call: { startsChild?: boolean } = {}): Promise<Lead> {
				see(ctx);
				if (call.startsChild && main(ctx)) await serial(async () => { await ensureParent({}, ctx); });
				return lead();
			},
			// A tool finished: a `kata claim` the agent ran adopts its issue as the plan parent.
			async result(ctx: any, event: { toolName: string; isError?: boolean; input?: any; details?: any }): Promise<Lead> {
				see(ctx);
				await observeToolResult(event, ctx);
				return lead();
			},
		},
		todo: {
			apply: (ctx: any, op: string, params: any) => execute({ ...params, op }, ctx),
			command,
		},
		delegates: {
			apply: delegates.apply,
			// Refuses a spawn that cannot be delegated; otherwise says what each is matched to. `held`: refs other spawns of the same call reserved.
			check: (spawns: Spawn[], held?: Iterable<string>) => delegates.check(spawns, held),
			join,
		},
		// Adds `#` ticket completion to the editor of the current session, once per editor.
		offerTickets: createTicketCompletion(kata, () => ({ session: currentId, cwd: path.resolve(currentCtx?.cwd ?? process.cwd()) }), debug),
	};
}
