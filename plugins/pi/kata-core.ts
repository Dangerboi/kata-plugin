// Generated from core/kata-core.ts; edit there.
import { decidePlanParent, explicitParent, isExplicitParent, namesPlanParent } from "./plan-parent";
import { createInboxFollower, knownProjectHead, trustedInbox, type InboxFollower, type LiveInbox } from "./inbox";
import { createDelegates, FINAL, heldByDelegate as heldBy, isUntracked, nameOf, Refusal, teammateFor, type DelegateAssignment, type DelegateStore, type Refused, type Reservation, type SavedDelegate, type Who } from "./delegates";
import { createSettlement, MAX_FAILURES, openChildren, type PendingClose, type SettlementSnapshot } from "./settlement";
import { createKata, debugTo, type CORE_ENV, isKataCode, refGuardOff, isUnusable, KataError, NO_JOB, waitAtMost, type Batch, type Exec, type Job, type PathOps, type Platform, type Timers } from "./kata-cli";
import { createTicketCompletion } from "./autocomplete";
import { offendingRefs } from "./ref-guard";
import { kataCommands, quote, shellOptions } from "./shell";
import { closedTaskStatus, digest, FULL_ID_REF, hasLabel, heldBySession, heldMessage, itemTicket, NATIVE_WORDING, OPEN, PROOF_MIN, projectOf, proofProblem, QUALIFIED_REF_ONLY, qualifiedRef, SESSION_KEY, SHORT_ID_ONLY, sessionParentKeys, slug, tasksOf, textOf, TITLE_MAX, TODO_WORDING, WONTFIX_MIN, WORKING, type Binding, type Change, type KataIssue, type KataShow, type Plan, type Status, type Task, type ToolWording } from "./model";
import { diffNativeList, nativeOpen, nativeTargets, type NativeItem, type NativePhase, type NativeStatus } from "./todo-list";

// What omp's own todo list holds, as `todo.mirror` takes it.
export type { NativePhase, NativeStatus } from "./todo-list";

// Canonical shared source. scripts/vendor-core.ts copies it, and the core modules it imports, into each self-contained
// plugin; host adapters own their event/schema/identity APIs.

// The context of a host event, as the core reads it. omp and pi pass their extension context; a host with none builds this.
export interface HostContext {
	cwd: string;
	// The agent the event belongs to: a todo call from another agent than the one the plan is bound for is refused.
	agent?: { kind?: string; id?: string };
	sessionManager?: {
		getSessionId?(): string | undefined;
		// The current branch of the session, oldest first: the core reads back the ones the host's `appendEntry` added (`type: "custom"`).
		getBranch?(): readonly unknown[];
		// Every entry of the session, on any branch, in the order they were added; the last one is the newest. Read to tell which entries are new.
		getEntries?(): readonly unknown[];
		// omp: `parentSession` names the session this one was forked from.
		getHeader?(): { parentSession?: unknown } | null | undefined;
	};
	// The main session's UI: the plan widget and warnings.
	ui?: { setWidget?(key: string, content: unknown): void; notify?(message: string, level?: string): void };
}

// The host's callbacks get the context back as the host passed it, so they see their own type.
interface CoreHost {
	// What the core takes from the machine it runs on (environment, cwd, timers, filesystem): node-host.ts's `nodePlatform` on Node.
	platform: Platform;
	// Timers the event's context owns, preferred over the platform's: omp's are contained in the session and cleared at its shutdown.
	contextTimers?(ctx: any): Timers | undefined;
	// `ctx` is the context of the event the call serves, for a host that spawns differently per agent (omp's transcript identity).
	exec: Exec;
	appendEntry(type: string, data: unknown): void;
	// Called inside the core's queue when a bind makes a different main session the core's own, after the jobs queued for the
	// session before it: the host moves what it keeps per session (its saved record, its delegate records) at that point, not
	// before. A bind of the session the core already holds (/tree, a branch switch) does not call it.
	switched?(ctx: any): void;
	getSessionName?(): string | undefined;
	isMain?(ctx: any): boolean;
	allowUI?(ctx: any): boolean;
	// Where delegate records live, found by the delegate's session id.
	delegateStore: DelegateStore;
	// Present: the main session follows its session inbox live (the host spawns the event stream and delivers each request as an aside).
	// Absent: the inbox is read once per turn.
	liveInbox?: LiveInbox;
}
interface CoreOptions {
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
	// The progress widget's content for this host and the event's context. Absent: the summary line alone.
	widget?: ((line: string, view: PlanView, ctx: any) => unknown);
	// false: the core never starts a pending task on its own after a change (OpenCode's todowrite list says what is in progress).
	autoStart?: boolean;
	// Where the settings a host keeps per session live (KATA_REF, KATA_TEAMMATE, KATA_AUTHOR, KATA_DEFAULT_PROJECT, KATA_INBOX_USER, USER): asked first, then the platform environment.
	// A host that serves several sessions from one process cannot hold them in the process environment.
	env?(name: string): string | undefined;
	// "shutdown": the automatic parent closes only when the lead's session ends (shutdown without `continues`/`forking`), never in a turn's settle or a drain. Default "drain".
	closeParent?: "drain" | "shutdown";
	// How the host's todo tool is named and used, for the advice in the core's messages. Default: the `todo` tool's, or omp's own tool's (NATIVE_WORDING) when `native`.
	wording?: ToolWording;
	// true: the host's own todo list is mirrored into Kata (omp's native todo through `todo.mirror`), and `todo.guard` refuses what Kata's
	// rules forbid. The plan follows that list, so the core never starts a task on its own, and the prompt carries the rules even before a plan exists.
	// The host's own list shows the plan, so the core sets no widget; `/todo ref` is routed to `todo.command`.
	native?: true;
}

// Where the session's plan lives: the host hands it to child processes it starts.
export type Lead = { parent?: string; workspace: string; label?: string };
// The plan as todo results (`details.kata`) and the widget hand it to the host. `ref` is the task's issue or named ticket.
export type PlanView = {
	parent?: string; workspace?: string; label?: string; local?: true;
	phases: { name: string; tasks: { content: string; status: Status; ref: string; blocker?: string }[] }[];
};
// What a prompt gets from the core, as text: the host formats each section for its prompt.
export type PromptSections = { contract?: string; inbox?: string; todo?: string; assignment?: string };
// The tag each section is wrapped in where a host's prompt has no structure of its own.
export const PROMPT_TAGS = { contract: "kata_contract", inbox: "kata_inbox", assignment: "kata_binding", todo: "kata_todo" } as const satisfies Record<keyof PromptSections, string>;
export const tagged = (name: keyof PromptSections, text: string) => `<${PROMPT_TAGS[name]}>\n${text}\n</${PROMPT_TAGS[name]}>`;
// The session entry the core saves its state in: appended after each change, and the session's latest is read at the next bind.
export const snapshotEntry = (namespace: string) => `io.kata.${namespace}.state`;
export type Snapshot = SettlementSnapshot & { version: number; sessionId: string; ownSessions?: string[]; plan: Plan; delegates?: SavedDelegate[]; named?: Task[]; deletedParent?: string; native?: { prev: Record<string, NativeStatus>; phase: Record<string, string>; listed?: true; leaf?: string } };
// Whether a saved session left work a later instance must finish: a pending close (a task's or a ticket's) or an unfinished
// delegate. The automatic parent's close is not counted: a session owes it only once it ends (see session.end).
export function owes(snapshot: Partial<Snapshot> | undefined): boolean {
	return !!(snapshot?.retries?.length || snapshot?.pendingCloses?.length || snapshot?.delegates?.some(d => !FINAL.has(d.state)));
}
// An entry a host saves for the core (`appendEntry`) and gives back at the next bind (`getBranch`).
export type SavedEntry = { type: "custom"; customType: string; data: unknown };
// `entries` with `data` as the latest of its type: the core reads only the latest of each type.
export const withEntry = (entries: readonly SavedEntry[], customType: string, data: unknown): SavedEntry[] =>
	[...entries.filter(entry => entry.customType !== customType), { type: "custom", customType, data: structuredClone(data) }];
export const savedSnapshot = (entries: readonly SavedEntry[] | undefined, namespace: string): Partial<Snapshot> | undefined =>
	entries?.filter(entry => entry.customType === snapshotEntry(namespace)).at(-1)?.data as Partial<Snapshot> | undefined;
// Whether a saved session has work a resume would take up: what the core owes, or a plan that still has open tasks, whatever
// holds it (an automatic parent, an explicit one, named tickets or a session-local plan).
export const holdsWork = (snapshot: Partial<Snapshot> | undefined): boolean =>
	owes(snapshot) || [...(snapshot?.plan?.tasks ?? []), ...(snapshot?.named ?? [])].some(task => OPEN.has(task.status));
export const todoText = (result: { content: readonly { text: string }[] }): string => result.content.map(part => part.text).join("\n");
// A pi child's view of the session that started it.
export type ChildParent = { sessionId: string; ref?: string; workspace: string; label?: string; teammate: string;
	// The teammate of the child that re-exported the lead's marker.
	via?: string };
const CHILD_TEAMMATE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// A pi child's name: the session name it was started with (`pi --name`), else the task or ticket it was matched to, else
// the end of its session id. Short enough to read in a comment heading.
const CHILD_NAME_LIMIT = 40;
function childName(sessionName: string | undefined, reserved: Reservation | undefined, id: string): string {
	const short = (text: string | undefined) => text?.slice(0, CHILD_NAME_LIMIT).replace(/[-._\s]+$/, "") || undefined;
	// The --name is shown as typed; teammateFor cleans it for the teammate.
	return short(sessionName?.trim()) ?? short(slug(reserved?.title)) ?? `pi-${id.replace(/[^a-z0-9]/gi, "").slice(-6).toLowerCase()}`;
}

// `file` against `cwd` with symlinks resolved: the path itself when it exists, else the nearest existing ancestor within `levels` folders up
// with the rest appended, else the path as written.
async function resolvedPath(host: Pick<Platform, "path" | "realpath">, file: string, cwd: string, levels: number): Promise<string> {
	const { path, realpath } = host, absolute = path.resolve(cwd, file), rest: string[] = [];
	for (let at = absolute, up = 0; up <= levels; up++) {
		try { return rest.length ? path.join(await realpath(at), ...rest) : await realpath(at); }
		catch { /* climb */ }
		const parent = path.dirname(at);
		if (parent === at) break;
		rest.unshift(path.basename(at));
		at = parent;
	}
	return absolute;
}

// The path as the host's filesystem names it: `file` against `cwd`, with symlinks resolved. A file that does not exist yet
// resolves through its folder, and a folder that does not either stays as written. Two workspaces are the same when their
// canonical paths are.
export const canonicalPath = (host: Pick<Platform, "path" | "realpath">, file: string, cwd: string): Promise<string> => resolvedPath(host, file, cwd, 1);

// The same for a file in folders that do not exist yet (a write creates them): the nearest existing ancestor decides.
const canonicalNew = (host: Pick<Platform, "path" | "realpath">, file: string, cwd: string): Promise<string> => resolvedPath(host, file, cwd, Infinity);

// The workspace name Kata would infer, read from the project_not_initialized
// error's structured data: the project it names, else its alias ("local://" and
// ".git" dropped, last segment kept), else the folder.
function inferredName(path: PathOps, data: Record<string, unknown> | undefined, cwd: string): string {
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
// How long a delegate's shutdown waits for Kata, and how long its prompt waits to read the contract and inbox: a delegate
// has no plan to close, so both are short (docs/explanation/limits.md).
const DELEGATE_SHUTDOWN_MS = 3000;
const DELEGATE_PROMPT_MS = 3000;
// How long a delegate's first prompt waits for its assignment, which it cannot learn later. The lead assigns delegates
// one at a time, about fifteen Kata calls each, so with many at once the last one waits for all the others.
const DELEGATE_BIND_MS = 15_000;
// How long the end of a lead turn waits for exited delegates to be handed back or rolled back. omp gives the stop hook
// 30 s; the cleanups queue behind each other, about ten Kata calls each, so a burst of exits needs a good part of it.
const TURN_SETTLE_MS = 15_000;
// How long a main session's start with an explicit ref waits for attention: omp copies the environment its bash tool
// passes on when the handler returns, so `KATA_ATTENTION_HOST` must be set by then. Kata's own pi hook allows 10 s per
// call; a slower start sets the marker too late for bash, and native children track the issue as before.
const ATTENTION_START_MS = 10_000;

// What every host's tool description says the same way; each host's description puts the rest in the words of its own tool.
// The functions take the host's words: what an item is called in a plan, what a spawn's text and an item's text are called,
// and how a call is repeated.
export const RULES = {
	summary: "Track multi-step work as a todo list stored in Kata.",
	evidence: "commit:<sha>, test:<cmd>, pr:<url>, reviewed-paths:<path>",
	ticketItem: "An item that works an existing ticket starts with its qualified ref: `<project>#<short_id>: <action>`",
	ticketError: "A ref that does not resolve, or a closed ticket, is an error.",
	search: 'search first: kata search "<terms>" --agent',
	bookkeeping: (item: string) => `Do not run \`kata claim\`, \`kata meta set ... work.attention\` or \`kata close\` for them yourself, and never add such bookkeeping as ${item}.`,
	named: (text: string, title: string) => `only when its ${text} names that item: its exact ${title} in quotes, its ref, or for a ticket item its ticket's ref. Naming a ticket outside the plan by qualified ref binds it to that ticket.`,
	untracked: "gets no issue to work, the plugin records its run and report as a closed child issue of the plan parent",
	ownClose: (text: string) => `that issue itself, with its own evidence, once its work is verified, unless its ${text} says to leave the issue open`,
	// `how` follows the clause: a host whose tool has no `takeover` parameter gives "" and names the user's command in `repeat`.
	takeover: (repeat: string, how = " with `takeover: true`") => `If that session crashed or was killed (or the user says so), ${repeat}${how}; never take over work another session may still be doing.`,
};

// The todo tool's ops and parameter descriptions; each host builds its schema from them.
export const TODO_OPS = ["init", "start", "done", "rm", "drop", "block", "unblock", "append", "view"] as const;
// The subcommands `/todo` accepts after the bare form (the op names are `TODO_OPS`).
export const TODO_COMMANDS = ["start", "done", "drop", "rm", "append", "block", "unblock", "takeover"] as const;
// The `/todo` subcommands a native host routes to `todo.command`; its own `/todo` handles the rest.
export const NATIVE_TODO_COMMANDS = ["takeover", "ref"] as const;
export const TODO_PARAMS = {
	list: "phases for init",
	task: "verbatim task content or Kata ref",
	items: "tasks for flat init or append",
	reason: "blocker note for block",
	ref: "existing Kata issue this plan serves (init)",
	replace: "init: replace a plan that still has open tasks (they close as wontfix); without it init refuses",
	takeover: "start/done/drop/rm/block/unblock: take over the named tasks from another session that started them and crashed or was killed (a session that ends normally releases its tasks); recorded on each issue",
	message: `done: what changed and how it was verified (${PROOF_MIN}+ characters); drop/rm: reason; init without ref: title for the automatic parent`,
	evidence: `required for done: ${RULES.evidence}`,
};

export const DESCRIPTION = `${RULES.summary} Tasks are identified by verbatim content (or Kata ref), NEVER generated IDs. Unique, stable task/phase names; lost text: view, NEVER guess.
Before work, init for 3+ steps, requested task sets, or new instructions. MUST list EVERY user item separately; NEVER omit or remember leftovers.
After each change: with no active task the earliest pending starts (phase order). Blocked NEVER starts automatically; unblock returns pending. Mark done immediately; follow phase order.
External waits (user/agent/service): block with a reason; it suppresses the stop reminder and starts the next pending task.
NEVER call todo alone: init with first work; done/start with next action.

Kata specifics:
- ${RULES.ticketItem} (for example \`myproj#a1b2: write the smoke script\`). It creates no issue: start claims the ticket and marks it in progress, done comments on it, and the last item of a ticket to be done closes it with that item's evidence (a ticket with open children stays open and gets a comment), drop/rm only comment and never close it. ${RULES.ticketError} Only that prefix names a ticket; a bare id is text. A plan whose items all name tickets creates no parent issue.
- Every other task is a Kata child issue of one parent issue. On init pass \`ref\` with the Kata issue this plan serves (${RULES.search}); an explicit KATA_REF or a delegate's assignment must match it. Without a ref, use that issue, the session's existing parent, or a new parent titled by \`message\`.
- done closes the issue (an item naming a ticket: see above). Kata requires \`evidence\` (${RULES.evidence}) and a \`message\` of ${PROOF_MIN}+ characters saying what changed and how it was verified. Unverified work: block it instead.
- The tool does the Kata bookkeeping for its tasks and ticket items: it claims them, sets \`work.attention\` (block: stuck with the reason; start/unblock: ok) and closes them on done. ${RULES.bookkeeping("a plan item")}
- A delegate (a pi started from this session, or a Claude Code \`Agent\`) is bound to a plan item ${RULES.named("task text", "title")} A delegate whose text names neither is untracked: it ${RULES.untracked}, and you finish the item yourself with done. A bound delegate is told to close ${RULES.ownClose("task text")}. That close is expected: the item then shows done without your \`done\`, and a later \`done\` on it changes nothing. To close it yourself after your own checks, write "leave the Kata issue open" in the delegate's task text. A delegate that exits with its issue still open hands it back to you, labeled \`needs-review\`.
- init whose new list leaves out open tasks changes nothing and returns an error listing the missing ones; pass \`replace: true\` only to deliberately drop them (they close as wontfix).
- A task another session started stays that session's until it ends; a session that ends normally releases its tasks. Ops on a held task are refused. ${RULES.takeover("repeat the op naming the task")}
- drop/rm take the reason in \`message\`.
- drop and rm close those tasks as wontfix (Kata never deletes). Automatic session parents close from their children’s Kata-recorded evidence once all work has settled. Explicit/claimed parents remain yours to close. Folders with no Kata project use KATA_DEFAULT_PROJECT (labeled with the repo) or register their inferred project; the plan is session-local only while Kata is unreachable and replays when it returns.`;

// The command that closes a Kata issue with its evidence, as the model reads it.
const closeCommand = (ref: string) => `kata close ${ref} --done --message '<what changed and how it was verified, ${PROOF_MIN}+ characters>' --test '<command>' (or --commit/--pr/--reviewed-paths)`;

// The prompt section of a host whose own todo list is mirrored into Kata: the rules `todo.guard` enforces, so the model meets them before a refusal.
const NATIVE_TODO_RULES = [
	"Your todo list is mirrored into Kata: each task is a Kata issue under one parent issue, and the plugin keeps them in step with your list.",
	`- Close before done: close a task's issue yourself, with its evidence, then mark it done. Run ${closeCommand("<ref>")}, then call todo done. todo done on a task still open in Kata is refused, except a task delegated to a subagent: its subagent closes it. An item that names a ticket (\`<project>#<id>: <action>\`) works the same: the ticket's last open item needs the ticket closed first.`,
	"- Leave no open task out of an init. A task your list holds: todo drop it first, in an earlier call, then init. A task your list never held (it came from Kata): keep it in the list, or todo append it and then todo drop it, in earlier calls. An init that leaves open Kata tasks out is refused.",
	"- Set the plan parent before the first init: run `kata claim <ref>` on the issue this plan serves, or ask the user to run `/todo ref <ref>`. Without one the plugin makes a parent issue for this session.",
	`- A subagent you start with the task tool is bound to a plan item ${RULES.named("task text", "title")} A subagent whose text names neither is untracked: it ${RULES.untracked}, and you finish the item yourself with done. A bound subagent is told to close ${RULES.ownClose("task text")}. That close is expected: the item then shows done in Kata, so mark it done in your list without a close of your own. To close it yourself after your own checks, write "leave the Kata issue open" in the task text. A subagent that exits with its issue still open hands it back to you, labeled \`needs-review\`.`,
	"- A task another session started stays that session's: ops on it are refused, and only the user's `/todo takeover <task>` moves it here.",
	"- There is no blocked status. Record a wait with `kata comment <ref> --body '<what you wait for>'` and leave the task as it is.",
].join("\n");

function delegateContext(executable: string, name: string, ref: string, teammate: string, binding: Binding, inbox?: string): string {
	const command = `${quote(executable)} --workspace ${quote(binding.workspace)} --project ${quote(projectOf(binding.parent))} --teammate ${quote(teammate)}`;
	return `You are subagent ${name}. Your Kata issue is ${ref}; your teammate is ${teammate}. Keep the existing actor and use this issue instead of inherited KATA_REF. Track attention on your own issue. Before you finish, whatever the outcome, YOU must comment on your issue what you did, since other subagents may work it before or after you: ${command} comment ${quote(ref)} --body '<what you changed, how you verified it, and what remains, in a few sentences>'. When verified, YOU must then run: ${command} close ${quote(ref)} --done --message '<describe this task and its verification in at least ${PROOF_MIN} characters>' --evidence '<typed evidence for your actual verification>'. Exception: if your task text tells you not to close issues, or to leave this issue open, do not close it; the lead closes it after its own checks. If unfinished, leave it open; your comment says what remains.${inboxLine(inbox)}`;
}

const inboxLine = (address?: string) => address ? ` Your Kata inbox is ${address}; requests sent there reach you.` : "";

// A delegate that matched no plan item and named no ticket has no issue. Its
// context says so instead of sending it to one: the lead tracks the work.
function untrackedDelegateContext(name: string, inbox?: string): string {
	return `You are subagent ${name}. The lead session tracks this work and you have no Kata issue. Do not create, claim, close, comment on or edit Kata issues, including one named by an inherited KATA_REF. Reading Kata is fine. Report your results in your reply.${inboxLine(inbox)}`;
}

// Items that name no ticket become children of a parent issue; a plan of only named items needs none.
const needsParent = (contents: string[]) => contents.some(content => !itemTicket(content));
const hasRef = (task: Task, target: string) => task.ref === target || task.ref.split("#")[1] === target;
// The plan view lists an item as '<content> (<ticket or ref>)'; a name copied from it names that item.
const listedName = (task: Task) => `${task.content} (${task.ticket ?? task.ref})`;
// Why a task or item left the plan: the caller's words, else a reason Kata's wontfix accepts.
const whyDropped = (change: Change) => change.message || change.reason || "no longer needed";
// The comment a ticket gets when its item leaves the plan: a drop never closes a ticket.
const leftPlan = (verb: "Dropped" | "Removed", task: Task, change: Change) => `${verb} from the todo plan: "${task.content}". Reason: ${whyDropped(change)}. The ticket stays open.`;
const delegatedMessage = (kind: "task" | "ticket", ref: string, wording: ToolWording) => `Kata ${kind} ${ref} is delegated. Its subagent must manage and close it. ${wording.refresh}`;

function phasesOf(tasks: Task[]): { name: string; tasks: Task[] }[] {
	const phases: { name: string; tasks: Task[] }[] = [];
	for (const task of tasks) {
		let phase = phases.find(p => p.name === task.phase);
		if (!phase) phases.push((phase = { name: task.phase, tasks: [] }));
		phase.tasks.push(task);
	}
	return phases;
}

function render(plan: Plan, wording: ToolWording = TODO_WORDING): string {
	if (plan.error) return `Kata state unavailable${plan.parent ? ` for ${plan.parent}` : ""}: ${plan.error}. ${wording.refresh}`;
	if (!plan.parent && !plan.local && plan.tasks.length === 0) return `No todo plan. ${wording.plan}`;
	if (plan.tasks.length === 0) return `Kata parent ${plan.parent}: no tasks.`;
	const done = plan.tasks.filter(t => t.status === "completed").length;
	const lines = [`${plan.local ? "Session-local plan (Kata is unreachable; it replays into Kata when Kata returns)" : plan.parent ? `Kata parent ${plan.parent}` : "Kata tickets (no parent issue)"}: ${done}/${plan.tasks.length} done`];
	for (const phase of phasesOf(plan.tasks)) {
		lines.push(`${phase.name}:`);
		for (const t of phase.tasks) lines.push(`  ${MARK[t.status]} ${listedName(t)}${t.blocker ? ` — blocked: ${t.blocker}` : ""}${t.holder ? ` — started by session ${t.holder}` : ""}`);
	}
	return lines.join("\n");
}

// A delegate's core: the same host and options, but never main and saving nothing. Its store sees only its own record, which
// it writes through the lead's.
function delegateHost(host: CoreHost, id: string): CoreHost {
	const lead = host.delegateStore;
	return { ...host, isMain: () => false, appendEntry: () => {},
		delegateStore: { records: () => [], get: key => key === id ? lead.get(key) : undefined, put: record => lead.put(record), of: ctx => { const own = lead.of(ctx); return own?.id === id ? own : lead.get(id); } } };
}

export type KataCore = ReturnType<typeof buildCore> & {
	// The core of the delegate whose record id is `id`; kept until this core binds another session.
	delegate(id: string): KataCore;
};

export function createKataCore(host: CoreHost, options: CoreOptions): KataCore {
	const delegateCores = new Map<string, KataCore>();
	return {
		...buildCore(host, options, () => delegateCores.clear()),
		delegate(id) {
			let known = delegateCores.get(id);
			if (!known) delegateCores.set(id, known = createKataCore(delegateHost(host, id), options));
			return known;
		},
	};
}

// A native `todo` call as omp receives it. omp infers a missing `op` (inferTodoOp): a non-empty `list` is init, `items` with a phase is
// append, and `items` alone is init while omp's list has no phases (`listed` false).
type NativeCall = { op?: unknown; task?: unknown; phase?: unknown; items?: unknown; list?: unknown };
const GUARDED_OPS: readonly string[] = ["init", "start", "done", "drop", "rm"];
function inferNativeOp(call: NativeCall, listed: boolean): string | undefined {
	if (typeof call.op === "string") return call.op;
	if (Array.isArray(call.list) && call.list.length) return "init";
	if (Array.isArray(call.items) && call.items.length) {
		if (typeof call.phase === "string" && call.phase) return "append";
		if (!listed) return "init";
	}
	return undefined;
}
// Whether the guard checks this call: init, start, done, drop or rm, with the op omp would infer. Conservative: a call with only `items`
// and no `phase` counts as init, since whether omp's list has phases is known only inside the guard.
function guardedNativeCall(input: unknown): boolean {
	if (!input || typeof input !== "object") return false;
	const op = inferNativeOp(input as NativeCall, false);
	return !!op && GUARDED_OPS.includes(op);
}
// A failure of a mirror pass: `outage` is Kata being out of reach (the next change tries again), anything else a refusal.
// `task` is the task whose step Kata refused (none: a refused setup, init or parent mark); `removed` marks a refused removal (of a plain
// task, or of a ticket item), whose item has left omp's list, so it is worded apart from the other steps.
type MirrorFailure = { error: unknown; outage: boolean; task?: { content: string; ref?: string }; removed?: "task" | "ticket" };
// An error that is, or was caused by, Kata being unreachable.
const outageOf = (error: unknown): boolean => isUnusable(error) || (error instanceof Error && error.cause !== undefined && outageOf(error.cause));
const messageOf = (error: unknown): string => (error as Error)?.message ?? String(error);
const mapOf = <T>(value: unknown) => new Map<string, T>(Object.entries(typeof value === "object" && value ? value as Record<string, T> : {}));
// What the core last mirrored of omp's list, for the branch whose last entry is `leaf`.
type NativeMemory = {
	prev: Map<string, NativeStatus>;
	// omp's phase per content at the same mirror: a `{phase}` target of a todo call names omp's phases, which Kata's `todo.phase` may no longer match.
	phase: Map<string, string>;
	// Whether omp's list had phases (an emptied list still has them), as omp's own check of `todo` calls without an op reads it.
	listed: boolean;
	leaf?: string;
};
// The saved form of the memory; `leaf` goes in only when asked, as the comparison of snapshots leaves it out.
const savedNative = (memory: NativeMemory, withLeaf = false): Snapshot["native"] => {
	const leaf = withLeaf ? memory.leaf : undefined;
	return memory.prev.size || memory.phase.size || memory.listed || leaf
		? { prev: Object.fromEntries(memory.prev), phase: Object.fromEntries(memory.phase), ...(memory.listed ? { listed: true as const } : {}), ...(leaf ? { leaf } : {}) } : undefined;
};
const nativeMemory = (saved: Snapshot["native"], leaf?: string): NativeMemory => ({ prev: mapOf<NativeStatus>(saved?.prev), phase: mapOf<string>(saved?.phase), listed: saved?.listed === true, leaf });
const tipOf = (branch: readonly any[]): string | undefined => branch[branch.length - 1]?.id;

// `newSession` runs after the host's `switched`, when a bind makes a different session the core's.
function buildCore(host: CoreHost, options: CoreOptions, newSession: () => void) {
	const namespace = options.namespace;
	const wording = options.wording ?? (options.native ? NATIVE_WORDING : TODO_WORDING);
	const listName = wording.list ?? "the todo list";
	const platform = host.platform, path = platform.path;
	const debug = debugTo(options.debugFile, platform.appendFile);
	const bounded = <T>(promise: Promise<T>, ms = 250) => waitAtMost(promise, ms, debug, platform);
	const heldByDelegate = (metadata: Record<string, unknown> | undefined) => heldBy(namespace, metadata);
	const PARENT_ENTRY = `io.kata.${namespace}.parent`;
	const SNAPSHOT_ENTRY = snapshotEntry(namespace);
	const keys = sessionParentKeys(namespace);
	const WIDGET = `${namespace}-kata`;
	const MAX_REMINDERS = 3;
	const main = (ctx: HostContext | undefined) => host.isMain?.(ctx) ?? true;
	const setting = (name: (typeof CORE_ENV)[number]) => options.env?.(name) ?? platform.env.get(name);
	const sid = (ctx: HostContext | undefined): string | undefined => ctx?.sessionManager?.getSessionId?.();
	const uiOf = (ctx: HostContext | undefined) => main(ctx) && host.allowUI?.(ctx) !== false ? ctx?.ui : undefined;
	let plan: Plan = { tasks: [], workspace: path.resolve(platform.cwd()) };
	let queue: Promise<unknown> = Promise.resolve();
	// unknown: not probed; workspace: the cwd has its own project; unbound: Kata is
	// up but the cwd is unregistered; bound: a parent is set; down: Kata unusable.
	let scope: "unknown" | "workspace" | "unbound" | "bound" | "down" = "unknown";
	let refusal: Record<string, unknown> | undefined, outage = "", warnedFor: string | undefined;
	let currentId: string | undefined;
	// This session and the sessions it was forked from: plan tasks any of them started are this session's own. Saved in the snapshot.
	let ownSessions: string[] = [];
	// The session a lead's writes mark plan tasks with. A delegate never marks: its issue is held through the delegate keys.
	const markingSession = (job: Job) => isLeadCall(job) && currentId ? currentId : undefined;
	let bound = false;
	let assignedRef: string | undefined;
	const configuredRef = () => options.explicitRef?.() ?? setting("KATA_REF");
	const aliases = new Set<string>(); // refs the plan's parent was rehomed from: they still name it
	// Refs this session claimed in its shell or named with `/todo ref`: its work, though the plan may never hold them. Read by `tools.guard`.
	const claimed = new Set<string>();
	let requestedRef: string | undefined;
	// A native host's list says what is in progress, so the core never starts a pending task itself (see nextTask).
	const autoStart = options.autoStart !== false && !options.native;
	// The state of `todo.mirror`: its newest call per session, and the notices already shown (see report).
	const mirrorStamps = new Map<string, number>(), shown = new Set<string>();
	// What this core last mirrored of omp's list for the session (see diffNativeList), saved in the session snapshot.
	let native = nativeMemory(undefined);
	// The ids of the entries this core has read: the branch at a bind, a reload or a mirror pass, and every `getEntries` id at a bind or a reload.
	const seenIds = new Set<unknown>();
	const flagged = new Set<string>();
	let sessionTeammate: string | undefined;
	const ownTeammate = () => sessionTeammate ?? setting("KATA_TEAMMATE") ?? "";
	// A ticket item's ticket keeps the actor and teammate rule alone: it is not this plan's task, whoever's plan holds it.
	const TICKET: Who = { ticket: true };
	let boundAgent: string | undefined;
	// An automatic parent a person deleted: todo results say so until a new plan starts. Saved in the session snapshot.
	let deletedParent: string | undefined;
	const agentKey = (ctx: HostContext) => JSON.stringify([ctx?.agent?.kind, ctx?.agent?.id]);
	let currentCtx: HostContext | undefined;
	// Whether the work at hand is the lead's: the context of the todo call its job serves says so (another identity's event can
	// move currentCtx while the call awaits), else the latest context seen.
	const isLeadCall = (job: Job) => main(job.ctx ?? currentCtx);
	let reminders = 0;
	let progressed = true;
	// What one session's prompt reads from Kata, kept between turns. A core serves the lead and every delegate running in its
	// process, so each has its own: the lead's by session id ("" when the host gives none), a delegate's by delegate id.
	type PromptReads = { cwd: string; contract?: string; contractError?: string; contractWarned?: boolean; inbox?: string; address?: string; pending?: Promise<void>; inboxPending?: Promise<void>; inboxNext?: Promise<void>; personInbox?: boolean };
	const leadReads = new Map<string, PromptReads>();
	const delegateReads = new Map<string, PromptReads>();
	const leadKey = (id: string | undefined) => id ?? "";
	const kata = createKata({ path, exec: (...args) => host.exec(...args), executable: options.executable, teammate: () => sessionTeammate, ctx: () => currentCtx, session: () => currentId, debug });
	// Throttled closes, ticket closes waiting on children and the automatic parent's close (see settlement.ts).
	// The timer is omp's ctx timer (contained, cleared on session_shutdown) when the host has one; pi has none.
	const settlement = createSettlement({
		namespace, kata, owned,
		clock: () => Date.now(),
		timer(fire, ms) {
			const timers = host.contextTimers?.(currentCtx) ?? platform;
			const handle = timers.setTimer(fire, ms);
			return () => timers.clearTimer(handle);
		},
		due: () => { void serial(drain).catch(debug); },
		delegatesRunning: () => delegates.running(),
		itemsOpen: ticket => named.some(t => t.ticket === ticket && OPEN.has(t.status)),
		performTask, performTicket: (job, ticket, request) => owned(job, ticket, request.cwd, "check", false, undefined, TICKET).then(decision => closeWith(job, ticket, decision, request)),
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
	const delegates = createDelegates({
		namespace, wording, store: host.delegateStore, persist, kata,
		actor, owned, work, serial, plan: () => plan,
		load, drain, cwd: () => path.resolve(currentCtx?.cwd ?? platform.cwd()), teammate: ownTeammate,
		async missionParent(job) {
			// A local plan replays into its own parent first; a parent made now would orphan its tasks.
			if (plan.local || !currentCtx || !main(currentCtx)) return undefined;
			if (!plan.parent) await ensureParent(job, {}, currentCtx);
			return plan.parent && !plan.local ? { parent: plan.parent, workspace: plan.workspace, label: plan.label } : undefined;
		},
		async create(job, key, args, cwd) {
			const created = await keyedCreate(job, key, args, cwd);
			return "deleted" in created ? undefined : created;
		},
		retryLater: () => settlement.schedule(),
		debug,
	});
	function persist(job: Job): boolean {
		if (!currentId || !isLeadCall(job)) return false;
		const kept = delegates.saved();
		const memory = savedNative(native);
		const data = { version: 1, sessionId: currentId, ...(ownSessions.length ? { ownSessions: [...ownSessions] } : {}),
			plan: structuredClone({ ...plan, tasks: plan.tasks.filter(t => !t.ticket) }), ...settlement.snapshot(),
			...(kept.length ? { delegates: structuredClone(kept) } : {}),
			...(named.length ? { named: structuredClone(named) } : {}), ...(deletedParent ? { deletedParent } : {}),
			...(memory ? { native: memory } : {}) };
		const encoded = JSON.stringify(data);
		if (encoded === lastSnapshot) return false;
		// `leaf` is the entry whose branch the mirror memory describes; a reload takes only snapshots whose leaf is on its branch. It moves
		// without the plan, so it is left out of the comparison above.
		const stamped = savedNative(native, true);
		host.appendEntry(SNAPSHOT_ENTRY, { ...data, ...(stamped ? { native: stamped } : {}) } satisfies Snapshot);
		lastSnapshot = encoded;
		return true;
	}

	// Serialize every plan mutation: tool calls, /todo, session reloads and delegate events. Each job is one Kata operation
	// (see kata.operation) and gets the job its code passes on to every Kata call and every job it queues. `within`: the job
	// of the code that queues this one. It lends its context, and when it is a batch's job that is still open, this one joins
	// the batch: it runs after the batch's earlier jobs, in the batch's place in the queue and with its Kata reads. A job that
	// holds the batch's job after the batch ended (a timer, a callback) queues as usual.
	function serial<T>(fn: (job: Job) => Promise<T>, within: Job = NO_JOB): Promise<T> {
		const joined = within.batch?.open ? within.batch : undefined;
		const run = joined ? joined.tail.then(() => fn(within)) : queue.then(() => kata.operation({ ctx: within.ctx }, fn));
		const settled = run.catch(() => undefined);
		if (joined) joined.tail = settled; else queue = settled;
		return run;
	}
	// One job that keeps its place in the queue while `fn` queues further jobs, through the job it is given (see todo.batch). It
	// ends once `fn` and every job queued inside it have ended: one nothing waited for (a bind's background restore) still
	// belongs to it.
	function batch<T>(ctx: HostContext, fn: (job: Job) => Promise<T>): Promise<T> {
		return serial(async job => {
			const own: Batch = { open: true, tail: Promise.resolve() };
			try { return await fn({ ...job, batch: own }); }
			finally {
				for (let seen: unknown; seen !== own.tail;) { seen = own.tail; await seen; }
				own.open = false;
			}
		}, { ctx });
	}

	// Kata's effective actor for a ref comes from the author setting or the user, not from the issue: read once per session,
	// workspace, project and author setting. With no ref (no plan parent yet) it is the author setting or the user, else
	// git's user name, kept the same way. A failed read is not kept. Ownership checks and the inbox's trust rule share it.
	const actors = new Map<string, Promise<string>>();
	async function actor(job: Job, cwd: string, ref = plan.parent): Promise<string> {
		const author = setting("KATA_AUTHOR") || setting("USER");
		if (!ref && author) return author;
		const key = [currentId, path.resolve(cwd), ref ? projectOf(ref) : "", setting("KATA_AUTHOR")].join("\0");
		let known = actors.get(key);
		if (!known) {
			known = ref
				? kata.run(job, ["status", ref], cwd).then(out => {
					const status = JSON.parse(out);
					if (typeof status.actor !== "string" || !status.actor.trim()) throw new Error("Kata status returned no effective actor.");
					return status.actor as string;
				})
				: host.exec("git", ["config", "user.name"], { cwd, timeout: 1000 }).then(result => result.code === 0 && result.stdout.trim() ? result.stdout.trim() : "anonymous");
			actors.set(key, known);
			known.catch(() => { if (actors.get(key) === known) actors.delete(key); });
		}
		return known;
	}

	// Starting unowned work requires a successful claim. Already-owned tasks
	// require both the actor and teammate, since delegates share an actor.
	// "check" validates assignment without taking ownership.
	// `who` (see Who): the delegate, a takeover, or a ticket item's ticket; the session holding a plan task refuses everyone else.
	async function owned(job: Job, ref: string, cwd: string, mayClaim: boolean | "check" = false, allowClosed = false, revision?: number, who?: Who): Promise<KataIssue> {
		let issue: KataIssue = (await kata.show(job, ref, cwd)).issue;
		if (revision !== undefined && issue.revision !== revision) throw new Error(`Kata issue ${ref} changed since the task was selected; no work metadata was written.`);
		const currentActor = await actor(job, cwd, ref);
		if (!who?.delegate && isLeadCall(job) && heldByDelegate(issue.metadata)) {
			// A closed item left marked (its delegate was killed after closing, its lead never resumed, or another session owns the
			// plan) returns to the lead, unless an unfinished delegate of this session still holds it.
			if (!(allowClosed && issue.status === "closed" && !delegates.holds(ref) && issue.owner === currentActor)) throw new Error(`Kata issue ${ref} belongs to a delegate; no work metadata was written.`);
			await delegates.returnClosed(job, ref, cwd, issue, ownTeammate());
			issue = (await kata.show(job, ref, cwd)).issue;
		}
		const holder = !who?.delegate && !who?.takeover && !who?.ticket && isLeadCall(job) ? heldBySession(issue, ownSessions) : undefined;
		if (holder) throw new Error(`${heldMessage(ref, holder)}; no work metadata was written. If that session crashed or was killed, ${wording.retryTakeover}; the takeover is recorded on the issue.`);
		const teammate = who?.teammate ?? ownTeammate();
		if (issue?.status !== "open" && !(allowClosed && issue?.status === "closed")) throw new Error(`Kata issue ${ref} is closed or unavailable; no work metadata was written.`);
		const assignedTeammate = issue.metadata?.teammate || "";
		if (assignedTeammate !== teammate && (issue.owner || assignedTeammate)) {
			throw new Error(`Kata issue ${ref} belongs to teammate ${assignedTeammate || "(none)"}, not ${teammate || "(none)"}; no work metadata was written.`);
		}
		if (!issue.owner && mayClaim === true) {
			// Never swallow a claim failure, including an ownership race.
			await kata.run(job, ["claim", ref, "--if-unowned"], cwd);
			// Read the issue again, not the one claim prints: a delegate marker another writer added right after the claim
			// must stop this call before it changes any other task.
			issue = (await kata.show(job, ref, cwd)).issue;
			if ((issue.status !== "open" && !(allowClosed && issue.status === "closed")) || issue.owner !== currentActor) throw new Error(`Kata issue ${ref} is no longer owned by ${currentActor}; no work metadata was written.`);
			if (teammate && !issue.metadata?.teammate) {
				await kata.run(job, ["meta", "set", ref, "teammate", teammate, "--if-absent", "--if-match", String(issue.revision)], cwd);
				issue = (await kata.show(job, ref, cwd)).issue;
			}
		}
		const unclaimed = mayClaim === "check" && !issue.owner;
		if ((issue.status !== "open" && !(allowClosed && issue.status === "closed")) || (!unclaimed && (issue.owner !== currentActor || (issue.metadata?.teammate || "") !== teammate)) ||
			(!who?.delegate && isLeadCall(job) && heldByDelegate(issue.metadata))) {
			throw new Error(`Kata issue ${ref} is not owned by actor ${currentActor} and teammate ${teammate || "(none)"}; no work metadata was written.`);
		}
		if (!Number.isInteger(issue.revision) || issue.revision < 0) throw new Error(`Kata issue ${ref} has no valid metadata revision; no work metadata was written.`);
		return issue;
	}

	// Keep the validated decision through each conditional write. Any intervening
	// assignment or metadata change invalidates its revision, including after close.
	async function work(job: Job, ref: string, key: string, value: string | boolean | undefined, cwd: string, expected: KataIssue): Promise<KataIssue> {
		const meta = expected.metadata ?? {};
		const exists = Object.hasOwn(meta, key);
		if ((!exists && value === undefined) || meta[key] === value) return expected;
		const args = value === undefined ? ["meta", "unset", ref, key] : ["meta", "set", ref, key, JSON.stringify(value)];
		args.push("--if-match", String(expected.revision));
		if (exists) args.push("--if-value", JSON.stringify(meta[key]), "--json-value");
		else args.push("--if-absent", "--json-value");
		await kata.run(job, args, cwd);
		const changed = { ...meta };
		if (value === undefined) delete changed[key];
		else changed[key] = value;
		return { ...expected, revision: expected.revision + 1, metadata: changed };
	}

	// -------------------------------------------------------------- plan state

	async function showParent(job: Job, parent: string, cwd: string): Promise<KataShow> {
		const shown = await kata.show(job, parent, cwd);
		const children = shown.children ?? [];
		if (!shown.issue || !Array.isArray(children) || children.some(c => !c || typeof c.title !== "string" || typeof c.short_id !== "string")) {
			throw new Error("kata show returned an invalid issue or children response");
		}
		return shown;
	}

	// `kata move` keeps old refs resolving but the issue and its open children now
	// live in another project. Follow the parent: the saved binding, child
	// creation, delegate context and the pi marker all derive the project from it.
	async function rehome(job: Job, shown: KataShow, old: string, cwd: string): Promise<void> {
		let current: string;
		try { current = await kata.qualify(job, shown.issue, cwd); }
		catch (error) { debug(error); return; }
		if (current === old || plan.parent !== old) return;
		settlement.renamePlan(old, current);
		plan.parent = current;
		aliases.add(old);
		host.appendEntry(PARENT_ENTRY, { parent: current, workspace: plan.workspace, sessionId: plan.sessionId, auto: plan.auto, label: plan.label });
	}

	// A lead's plan tasks: the children with a phase that were not removed. A task is delegated when a delegate of another
	// teammate holds it, and held by a session that started it and is none of this session's lineage.
	const planTasks = (children: KataIssue[], parent: string) => tasksOf(children.filter(c => typeof c?.metadata?.["todo.phase"] === "string" && c.metadata["todo.removed"] !== true), parent, {
		delegated: c => heldByDelegate(c.metadata) && (c.metadata?.teammate || "") !== ownTeammate(),
		holder: c => heldBySession(c, ownSessions),
	});

	// An item follows its ticket: closed by anyone (a delegate, the user) it is completed,
	// or abandoned when closed as wontfix. A ticket that cannot be read keeps its item as is.
	async function followTickets(job: Job, cwd: string) {
		const open = named.filter(t => OPEN.has(t.status));
		for (const ticket of new Set(open.map(t => t.ticket!))) {
			try {
				const shown: KataIssue = (await kata.show(job, ticket, cwd)).issue;
				if (shown.status !== "closed") continue;
				for (const task of open) if (task.ticket === ticket) { task.status = closedTaskStatus(shown.closed_reason); task.blocker = undefined; }
			} catch (error) { debug(error); }
		}
	}

	async function load(job: Job, cwd: string): Promise<KataIssue[]> {
		if (plan.local) { delete plan.error; plan.tasks = withNamed(plan.tasks); return []; }
		if (!plan.parent) { if (named.length) { delete plan.error; await followTickets(job, cwd); } plan.tasks = withNamed([]); return []; }
		const ref = plan.parent;
		try {
			const shown = await showParent(job, ref, cwd);
			await rehome(job, shown, ref, cwd);
			const children = shown.children ?? [];
			await followTickets(job, cwd);
			plan.tasks = withNamed(planTasks(children, plan.parent));
			delete plan.error;
			return children;
		} catch (error) {
			if (isDeletedAutomaticParent(error, ref)) { forget(ref); return load(job, cwd); }
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
		host.appendEntry(PARENT_ENTRY, { parent: null, ...(plan.sessionId ? { sessionId: plan.sessionId } : {}) });
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

	function refresh(ctx: HostContext) {
		if (options.native) return;
		const ui = uiOf(ctx);
		if (!ui?.setWidget) return;
		if (plan.error) { ui.setWidget(WIDGET, [render(plan, wording)]); return; }
		if ((!plan.parent && !named.length) || plan.tasks.length === 0) {
			ui.setWidget(WIDGET, undefined);
			return;
		}
		const done = plan.tasks.filter(t => t.status === "completed").length;
		const active = plan.tasks.find(t => t.status === "in_progress");
		const blocked = plan.tasks.filter(t => t.status === "blocked").length;
		const line = `Kata ${plan.parent ?? "tickets"} · ${done}/${plan.tasks.length} done${blocked ? ` · ${blocked} blocked` : ""}${active ? ` · ▶ ${active.content}` : ""}`;
		ui.setWidget(WIDGET, options.widget ? options.widget(line, view(), ctx) : [line]);
	}

	// True while Kata answers. An unregistered cwd is not an outage: it resolves
	// to the default or inferred project. Only an unusable Kata (missing
	// executable, unreachable daemon) is down, and it is probed again next time.
	// Concurrent probes of one cwd (session start warms the contract while it binds the plan) share one call.
	let probing: { cwd: string; done: Promise<boolean> } | undefined;
	function probe(job: Job, cwd: string): Promise<boolean> {
		if (scope !== "unknown" && scope !== "down") return Promise.resolve(true);
		if (probing?.cwd === cwd) return probing.done;
		const done: Promise<boolean> = (async () => {
			try { await kata.run(job, ["list", "--limit", "1"], cwd, { timeout: 15_000 }); scope = "workspace"; refusal = undefined; }
			catch (error) {
				if (isKataCode(error, "project_not_initialized")) { scope = "unbound"; refusal = (error as KataError).info.data ?? {}; }
				else if (isUnusable(error)) { wentDown(error); return false; }
				else throw error; // a missing project or a refused login is an error, never a local plan
			}
			return true;
		})().finally(() => { if (probing?.done === done) probing = undefined; });
		probing = { cwd, done };
		return done;
	}
	function wentDown(error: unknown) {
		scope = "down"; outage = (error as Error)?.message ?? String(error); debug(error);
	}

	// Where a plan created from this cwd lives. Never writes.
	function candidate(cwd: string): { project?: string; label?: string; register?: boolean } {
		if (!refusal) return {};
		const name = inferredName(path, refusal, cwd);
		const configured = setting("KATA_DEFAULT_PROJECT")?.trim();
		return configured ? { project: configured, label: slug(name) } : { project: name, register: true };
	}

	async function destination(job: Job, cwd: string) {
		const target = candidate(cwd);
		if (target.register) await kata.createProject(job, target.project!, cwd);
		return target;
	}

	function goLocal(ctx: HostContext) {
		plan.local = true; delete plan.error;
		settlement.schedule();
		if (warnedFor === (currentId ?? "")) return;
		warnedFor = currentId ?? "";
		uiOf(ctx)?.notify?.(`Kata is unreachable${outage ? ` (${outage})` : ""}. todo keeps a local plan and replays it into Kata when Kata returns.`, "warning");
	}

	async function replayLocal(job: Job, ctx: HostContext) {
		if (!plan.local || !await probe(job, ctx.cwd)) return;
		const local = plan.tasks.filter(t => !t.ticket);
		if (!local.length) { delete plan.local; return; }
		plan = { tasks: [], workspace: plan.workspace };
		try {
			const phases = [...new Set(local.map(t => t.phase))].map(phase => ({ phase }));
			await ensureParent(job, { list: phases }, ctx);
			if (plan.local) { plan = { tasks: withNamed(local), local: true, workspace: plan.workspace }; return; } // Kata went away again
			const cwd = plan.workspace;
			for (const t of local) await create(job, t.phase, t.content, cwd);
			await load(job, cwd);
			for (const t of local) {
				const task = plan.tasks.find(x => itemKey(x) === itemKey(t));
				if (!task || t.status === "pending") continue;
				try {
					if (t.status === "completed" && proofProblem(t.proof ?? {})) {
						// omp's list marked it completed with no Kata close and has no blocked status: flag it for review, as the mirror does.
						if (options.native) await flagCompleted(job, task, false, cwd);
						else await transition(job, task, "blocked", { reason: "Completed while Kata was unreachable; add evidence and close it." }, cwd);
					} else await transition(job, task, t.status, { ...t.proof, reason: t.blocker }, cwd);
				} catch (error) {
					debug(error);
					const reason = `Replaying "${t.status}" from the local plan failed: ${(error as Error).message}`;
					// omp's list has no blocked status and nothing unblocks a task there: the task is flagged for review with one comment instead.
					if (options.native) await flagForReview(job, task, `${namespace}-native-replay:${digest(task.ref)}`, `${reason}\nThe task stays open: check it, then set it in ${listName}.`, cwd).catch(debug);
					else await transition(job, task, "blocked", { reason }, cwd).catch(debug);
				}
			}
			await advance(job, cwd).catch(debug);
		} catch (error) {
			// Whatever Kata took stays; the unreplayed plan is retried (creates are idempotent).
			plan = { tasks: withNamed(local), local: true, workspace: plan.workspace };
			settlement.schedule();
			throw error;
		}
	}

	// Automatic parents created for a session; none while the project is not registered yet.
	async function sessionParents(job: Job, sessionId: string, project: string | undefined, cwd: string): Promise<any[]> {
		try { return JSON.parse(await kata.run(job, ["list", "--status", "all", ...(project ? ["--project", project] : []), "--meta", `${keys.session}=${sessionId}`, "--label", keys.label, "--limit", "2"], cwd)).issues ?? []; }
		catch (error) { if (project && isKataCode(error, "project_not_initialized")) return []; throw error; }
	}

	// The automatic parent Kata holds for a session that plans from `cwd`, when there is exactly one: the lead finds its own
	// with it, and a pi child its lead's.
	async function automaticParentOf(job: Job, id: string, cwd: string): Promise<Binding | undefined> {
		const where = candidate(cwd);
		const list = await sessionParents(job, id, where.project, cwd);
		// Creation records session identity before the guarded claim can finish.
		const here = await canonicalPath(platform, cwd, cwd), candidates = [];
		for (const issue of list) {
			if ((issue.metadata?.[keys.auto] === true || issue.metadata?.[keys.auto] === undefined) && issue.metadata?.[keys.session] === id && await canonicalPath(platform, issue.metadata?.[keys.workspace] || ".", cwd) === here) candidates.push(issue);
		}
		if (candidates.length === 1) return { parent: candidates[0].qualified_id, workspace: candidates[0].metadata[keys.workspace], sessionId: id, auto: true, label: where.label };
	}
	async function sessionBinding(job: Job, ctx: HostContext): Promise<Binding | undefined> {
		const id = sid(ctx);
		if (id) return automaticParentOf(job, id, ctx.cwd);
	}

	// omp records the fork source in the session header: its id, or its session file `<timestamp>_<id>.jsonl`.
	function forkSource(ctx: HostContext): string | undefined {
		const parentSession = ctx.sessionManager?.getHeader?.()?.parentSession;
		if (typeof parentSession !== "string" || !parentSession) return undefined;
		const name = path.basename(parentSession);
		return name.endsWith(".jsonl") ? name.slice(name.indexOf("_") + 1, -".jsonl".length) || undefined : parentSession;
	}

	async function bind(job: Job, ctx: HostContext, replay = true, initRef?: string) {
		let assigned: DelegateAssignment | undefined;
		if (!main(ctx)) { assigned = delegates.assignment(ctx); if (!assigned) return; }
		bound = false;
		boundAgent = agentKey(ctx);
		sessionTeammate = assigned?.teammate;
		assignedRef = assigned?.ref;
		const sources = { path, cwd: ctx.cwd, assigned, explicit: configuredRef(), initRef };
		const requested = explicitParent(sources)?.parent;
		requestedRef = requested;
		const id = sid(ctx);
		// Only a bind that starts a session this core did not already hold restores delegates: /tree and a branch switch keep the same one.
		const isNew = currentId !== id, previous = currentId;
		currentId = id;
		if (isNew && main(ctx)) { host.switched?.(ctx); newSession(); shown.clear(); }
		lastSnapshot = undefined;
		currentCtx = ctx;
		plan = { tasks: [], workspace: path.resolve(ctx.cwd) }; named = []; aliases.clear(); deletedParent = undefined;
		scope = "unknown"; refusal = undefined; outage = "";
		// A delegate restores nothing from the session's saved entries: they are its lead's.
		const branch: readonly any[] = main(ctx) ? ctx.sessionManager?.getBranch?.() ?? [] : [];
		// A fork gets a new session id and copies the source's entries. It shares the source's work:
		// adopt its parent and ticket items, but not its retries (the source still owns those closes)
		// nor its local plan (replaying that would make a second automatic parent).
		const { snapshot, source } = savedSnapshot(ctx, branch, id, onBranch(branch));
		// The shell claims belong to the session: /tree and a branch switch keep it, a fork of it shares them, any other new session starts with none.
		if (isNew && !(source && source === previous)) claimed.clear();
		// A forked session keeps the source id as the parent's owner: the parent's session_id metadata names it.
		const parentOwner = source ?? id;
		// A resumed lead keeps its saved sessions; a fork adds itself to its source's, so it works on what its source started.
		// A delegate has none: its own issue is held through the delegate keys, and the lead's tasks are not its to judge.
		const lineage = Array.isArray(snapshot?.ownSessions) ? snapshot.ownSessions.filter((o: unknown): o is string => typeof o === "string" && !!o) : [];
		ownSessions = id && main(ctx) ? [...new Set([id, ...(source ? [source] : []), ...lineage])] : [];
		settlement.restore(snapshot && !source ? snapshot : undefined);
		// Delegate records are in memory only: a resumed lead takes back the ones its snapshot kept. A fork leaves them to the source.
		if (isNew && !source && main(ctx) && Array.isArray(snapshot?.delegates)) delegates.restore(snapshot.delegates, job);
		if (snapshot) {
			if (!source && snapshot.plan?.local && !requested) plan = { ...structuredClone(snapshot.plan), workspace: plan.workspace };
			named = structuredClone(snapshot.named ?? []);
			stamp = Math.max(0, ...named.map(t => t.at || 0));
			plan.tasks = withNamed(plan.tasks);
			// A deletion noticed without a todo result (shutdown, a drain, a pi launch) is still reported after a resume.
			if (typeof snapshot.deletedParent === "string") deletedParent = snapshot.deletedParent;
		}
		// The mirror continues from the list this branch's snapshot last mirrored, or from none: a tree move or a branch switch must not carry the old branch's.
		if (main(ctx) && options.native) { seenIds.clear(); native = loadNative(ctx, snapshot, branch); }
		let stored: any = snapshot?.plan?.parent ? snapshot.plan : undefined;
		for (const entry of branch) {
			if (entry?.type !== "custom" || entry.customType !== PARENT_ENTRY || (entry.data?.sessionId && entry.data.sessionId !== parentOwner)) continue;
			if (typeof entry.data?.parent === "string") stored = entry.data;
			else if (entry.data?.parent === null) stored = undefined;
		}
		if (source && !snapshot) stored = stored && { ...stored, sessionId: parentOwner };
		if (plan.local && !requested) stored = undefined;
		let down = false;
		const choice = await decidePlanParent({
			...sources, stored,
			session: async () => {
				if (!await probe(job, ctx.cwd)) { down = true; return; }
				// A restored local plan replays into its parent itself; do not rebind over it.
				if (id && !plan.local) return sessionBinding(job, ctx);
			},
		});
		if (down) { await drain(job); bound = true; refresh(ctx); return; }
		const saved = choice.saved;
		if (choice.parent) {
			const workspace = choice.workspace;
			const shown = await kata.pin(job, choice.parent, workspace)
				.then(async qualified => ({ qualified, issue: (await kata.show(job, qualified, workspace)).issue }))
				.catch(error => {
					if (isExplicitParent(choice) || choice.saved?.auto !== true || !isKataCode(error, "issue_not_found")) throw error;
					forget(choice.parent!);
				});
			if (shown) {
				const { qualified, issue } = shown;
				const marker = issue.metadata?.[keys.auto];
				const owner = saved?.auto && typeof saved.sessionId === "string" && saved.sessionId !== id ? saved.sessionId : id;
				const auto = !isExplicitParent(choice) && saved?.auto !== false && (marker === true || (saved?.auto === true && marker === undefined)) && issue.metadata?.[keys.session] === owner;
				setParent({ parent: qualified, workspace, sessionId: owner, auto, label: saved?.label });
				await load(job, workspace);
			}
		}
		if (replay) await drain(job);
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
		host.appendEntry(PARENT_ENTRY, binding);
	}

	async function adopt(job: Job, ref: string, ctx: HostContext, workspace = ctx.cwd) {
		const parent = await kata.pin(job, ref, workspace);
		if (plan.auto && plan.parent && plan.parent !== parent) {
			// An automatic parent with no children only marks the session; retire it
			// rather than leave an empty child that can never auto-close.
			const old = plan.parent;
			const shown = await kata.show(job, old, plan.workspace).catch(error => {
				if (!isDeletedAutomaticParent(error, old)) throw error;
				forget(old);
			});
			if (shown?.issue.status === "open" && !shown.children?.length) {
				const decision = await owned(job, old, plan.workspace, false, false, shown.issue.revision);
				await kata.run(job, ["close", old, "--if-match", String(decision.revision), "--superseded-by", parent, "--message", `This session adopted ${parent} as its plan parent.`], plan.workspace);
				settlement.dropAutoParent(old);
			}
		}
		if (plan.parent === parent) settlement.dropAutoParent(parent);
		setParent({ parent, workspace: path.resolve(workspace), sessionId: sid(ctx), auto: false });
		await load(job, workspace);
	}

	// ------------------------------------------------------------- transitions

	type Created = { ref: string; issue: KataIssue };
	// What `kata create --json` prints: the new issue's event, or on a replay the first create's.
	type CreateOutput = { issue?: KataIssue; event?: { project_name?: string } | null; original_event?: { project_name?: string } };

	// Creates an issue under a key only this plugin uses, so a replay returns the issue the first create made. Kata
	// fingerprints the whole first create: `--priority none` keeps a changed [create].default_priority out of it, but a plan
	// task's session mark and the teammate of a parent a pi child made are in it, so a replay by another session (an item
	// appended again after a drop) or by the lead (the parent its child made) is refused with `idempotency_mismatch`. The
	// issue that names is still this key's, so it is adopted as it is now. A deleted issue comes back as `deleted`: Kata
	// refuses its key with `idempotency_deleted`, or with `idempotency_mismatch` naming an issue `show` no longer finds.
	// `--force-new`: keyed issues are deliberate, e.g. sibling tasks that read alike ("write x" / "verify x"), so skip
	// Kata's look-alike soft-block.
	async function keyedCreate(job: Job, key: string, args: string[], cwd: string): Promise<Created | { deleted: string; error: unknown }> {
		let out: CreateOutput;
		try { out = JSON.parse(await kata.run(job, ["create", "--idempotency-key", key, "--priority", "none", "--force-new", ...args], cwd)); }
		catch (error) {
			const { uid, qualified_id: qualified } = (error as KataError).info?.data ?? {};
			if (typeof uid !== "string") throw error;
			if (isKataCode(error, "idempotency_deleted")) return { deleted: uid, error };
			if (!isKataCode(error, "idempotency_mismatch") || typeof qualified !== "string") throw error;
			try { return { ref: qualified, issue: (await kata.show(job, qualified, cwd)).issue }; }
			catch (showError) { if (isKataCode(showError, "issue_not_found")) return { deleted: uid, error }; throw showError; }
		}
		const event = out?.event ?? out?.original_event;
		if (typeof out?.issue?.short_id !== "string" || !event?.project_name) throw new Error("kata create returned no issue identity");
		return { ref: `${event.project_name}#${out.issue.short_id}`, issue: out.issue };
	}

	// Reopens a closed issue and checks it again at the revision the reopen leaves, so any other change in between refuses.
	// A closed plan task holds nothing: once reopened it is this session's, whoever's mark it still carries.
	async function reopen(job: Job, ref: string, cwd: string, closed: KataIssue, mayClaim: boolean | "check" = false): Promise<KataIssue> {
		await kata.run(job, ["reopen", ref], cwd);
		return owned(job, ref, cwd, mayClaim, false, closed.revision + 1, { takeover: true });
	}

	async function create(job: Job, phase: string, content: string, cwd: string): Promise<void> {
		const created = await keyedCreate(job, `${namespace}-kata:${digest(plan.parent!, phase, content)}`, [
			"--parent", plan.parent!, "--project", projectOf(plan.parent!), "--body", `Todo task in phase "${phase}".`,
			"--meta", `todo.phase=${phase}`, "--meta", "todo.status=pending", ...(markingSession(job) ? ["--meta", `${SESSION_KEY}=${markingSession(job)}`] : []),
			...(plan.label ? ["--label", plan.label] : []), "--", content,
		], cwd);
		if ("deleted" in created) throw created.error;
		const { ref, issue } = created;
		// Replays may restore removed work, but never another writer's task.
		if (issue.status === "closed" || issue.metadata?.["todo.removed"] === true) {
			let decision = await owned(job, ref, cwd, "check", true, issue.revision);
			if (decision.status === "closed") decision = await work(job, ref, "todo.status", "pending", cwd, await reopen(job, ref, cwd, decision, "check"));
			await work(job, ref, "todo.removed", undefined, cwd, decision);
		}
	}

	async function mark(job: Job, ref: string, task: Task, from: Status, to: "in_progress" | "pending" | "blocked", change: Change, cwd: string, decision: KataIssue): Promise<KataIssue> {
		// A started or blocked plan task is this session's: another session's lead may not rework it without a takeover.
		const session = markingSession(job);
		if (session && !task.ticket && WORKING.has(to)) decision = await work(job, ref, SESSION_KEY, session, cwd, decision);
		if (to === "blocked") {
			const reason = change.reason || "Blocked in the todo plan.";
			decision = await work(job, ref, "work.attention", "stuck", cwd, decision);
			decision = await work(job, ref, "work.attention_msg", reason, cwd, decision);
			task.blocker = reason;
		} else if (to === "in_progress" || from === "blocked") {
			decision = await work(job, ref, "work.attention", "ok", cwd, decision);
			decision = await work(job, ref, "work.attention_msg", undefined, cwd, decision);
		}
		return work(job, ref, "todo.status", to, cwd, decision);
	}

	async function transition(job: Job, task: Task, to: Status, change: Change, cwd: string, validated?: KataIssue): Promise<void> {
		const from = task.status;
		if (from === to && to !== "blocked") {
			// Starting a started plan task again changes only its mark: a task no session holds (released by a graceful end, or
			// older than the mark) becomes this session's.
			const session = markingSession(job);
			if (to === "in_progress" && session && validated) task.revision = (await work(job, task.ref, SESSION_KEY, session, cwd, validated)).revision;
			return;
		}
		if (task.ticket) return transitionNamed(job, task, to, change, cwd);
		const ref = task.ref;
		if (task.delegated || delegates.holds(ref)) throw new Error(delegatedMessage("task", ref, wording));
		if (plan.local) {
			task.status = to; task.blocker = to === "blocked" ? change.reason || "Blocked in the local plan." : undefined;
			if (to === "completed" || to === "abandoned") task.proof = { message: change.message, evidence: change.evidence };
			return;
		}
		if (to === "completed") requireProof(task, ref, change);
		let decision = validated ?? await owned(job, ref, cwd, to === "completed" || to === "abandoned" ? "check" : true, !OPEN.has(from) && to === "in_progress", task.revision);
		if (!OPEN.has(from) && to === "in_progress") {
			if (decision.status !== "closed") throw new Error(`Kata task ${ref} changed before restart.`);
			decision = await reopen(job, ref, cwd, decision);
		}

		switch (to) {
			case "in_progress":
			case "pending":
			case "blocked":
				decision = await mark(job, ref, task, from, to, change, cwd, decision);
				break;
			case "completed": {
				const message = `${change.message} (task: ${task.content}; ${task.ref})`;
				// The close message is only the close reason; the comment keeps it in the issue's activity.
				const args = ["close", ref, "--done", "--if-match", String(decision.revision), "--message", message, "--comment", `Done: ${change.message}\nEvidence: ${change.evidence!.join(", ")}`];
				for (const e of change.evidence!) args.push("--evidence", e);
				task.revision = decision.revision;
				await closeTask(job, args, task, to, change, cwd);
				decision = await work(job, ref, "todo.status", "completed", cwd, { ...decision, status: "closed", revision: decision.revision + 1 });
				// Kata accepted the close with evidence; an earlier review request is settled.
				if (task.review) { await owned(job, ref, cwd, "check", true, decision.revision); await kata.run(job, ["label", "rm", ref, "needs-review"], cwd); task.review = false; }
				break;
			}
			case "abandoned":
				task.revision = decision.revision;
				await closeTask(job, ["close", ref, "--wontfix", "--if-match", String(decision.revision), "--message", wontfix("Dropped", task, change)], task, to, change, cwd);
				decision = await work(job, ref, "todo.status", "abandoned", cwd, { ...decision, status: "closed", revision: decision.revision + 1 });
				break;
		}
		task.revision = decision.revision;
		task.status = to;
		if (!change.remove) settlement.cancelTaskClose(ref);
		if (to !== "blocked") task.blocker = undefined;
	}

	function requireProof(task: Task, ref: string, change: Change): void {
		const problem = proofProblem(change);
		if (problem) throw new Error(`Kata needs ${problem} to close ${ref} ("${task.content}") as done; evidence is ${RULES.evidence}. If it is not verified, block it instead.`);
	}

	// ------------------------------------------------- items naming a ticket

	// Kata deduplicates by this key, so a replay never comments twice for one item.
	const noteKey = (task: Task, verb: string) => `${namespace}-item:${digest(currentId ?? "", task.ticket!, task.phase, task.content, String(task.at ?? 0))}:${verb}`;
	const note = (job: Job, task: Task, verb: string, body: string, cwd: string) => kata.run(job, ["comment", task.ticket!, "--idempotency-key", noteKey(task, verb), "--body", body], cwd);

	// A ticket whose last working item left in_progress/blocked goes back to pending and ok.
	// An unowned-by-us or closed ticket is left alone.
	async function settleTicket(job: Job, task: Task, cwd: string): Promise<void> {
		const ticket = task.ticket!;
		if (named.some(other => other !== task && other.ticket === ticket && WORKING.has(other.status))) return;
		let decision: KataIssue;
		try { decision = await owned(job, ticket, cwd, "check", false, undefined, TICKET); }
		catch (error) { debug(error); return; }
		await mark(job, ticket, task, "blocked", "pending", {}, cwd, decision);
	}

	// An item works its ticket: start claims it, done comments and the last done item closes it,
	// drop only comments. A closed ticket is never reopened and never replaced by a new issue.
	async function transitionNamed(job: Job, task: Task, to: Status, change: Change, cwd: string): Promise<void> {
		const from = task.status, ticket = task.ticket!;
		if (delegates.holds(ticket)) throw new Error(delegatedMessage("ticket", ticket, wording));
		if (to === "completed") requireProof(task, ticket, change);
		if (to === "abandoned") {
			await note(job, task, "drop", leftPlan("Dropped", task, change), cwd);
			if (WORKING.has(from)) await settleTicket(job, task, cwd);
		} else {
			const shown: KataIssue = (await kata.show(job, ticket, cwd)).issue;
			if (shown.status !== "open") {
				if (to !== "pending") throw new Error(`Kata ticket ${ticket} ("${task.content}") is already closed; the plugin never reopens a ticket. Reopen it yourself if the work continues.`);
			} else if (to !== "completed") {
				await mark(job, ticket, task, from, to as "in_progress" | "pending" | "blocked", change, cwd, await owned(job, ticket, cwd, true, false, undefined, TICKET));
			} else {
				const decision = await owned(job, ticket, cwd, "check", false, undefined, TICKET);
				await note(job, task, "done", `Todo item done: "${task.content}"\n${change.message}\nEvidence: ${change.evidence!.join(", ")}`, cwd);
				if (!named.some(other => other !== task && other.ticket === ticket && OPEN.has(other.status))) await closeTicket(job, task, decision, change, cwd);
				else if (WORKING.has(from)) await settleTicket(job, task, cwd);
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
	async function resolveNamed(job: Job, items: { phase: string; content: string }[], cwd: string, isNew: (item: { phase: string; content: string }) => boolean): Promise<Map<string, string>> {
		const tickets = new Map<string, string>(), checked = new Map<string, string>();
		for (const item of items) {
			const ref = itemTicket(item.content)?.ref;
			if (!ref || !isNew(item)) continue;
			let ticket = checked.get(ref);
			if (!ticket) {
				let shown: KataIssue;
				try { shown = (await kata.show(job, ref, cwd)).issue; }
				catch (error) { throw new Error(`Todo item "${item.content}" names ${ref}, which Kata cannot resolve: ${(error as Error).message}. Nothing was created.`, { cause: error }); }
				if (shown.status !== "open") throw new Error(`Todo item "${item.content}" names ${ref}, which is already closed; the plugin never reopens a ticket. Nothing was created.`);
				ticket = await kata.qualify(job, shown, cwd, ref);
				try { await owned(job, ticket, cwd, "check", false, undefined, TICKET); }
				catch (error) { throw new Error(`Todo item "${item.content}" cannot work ${ticket}: ${(error as Error).message} Nothing was created.`, { cause: error }); }
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
	async function closeTicket(job: Job, task: Task, decision: KataIssue, change: Change, cwd: string) {
		const ticket = task.ticket!;
		const request: PendingClose = { key: noteKey(task, "close"), message: `${change.message} (item: ${task.content}; ${ticket})`, evidence: change.evidence!, cwd };
		try { await closeWith(job, ticket, decision, request); }
		catch (error) {
			if (!isKataCode(error, "parent_has_open_children")) throw error;
			const shown: KataShow = await kata.show(job, ticket, cwd);
			const open = openChildren(shown, ticket);
			const many = open.length !== 1;
			const ours = open.every(ref => plan.tasks.some(t => (t.ticket ?? t.ref) === ref));
			if (ours) settlement.holdTicketClose(ticket, { ...request, key: noteKey(task, "close-after-children") }, cwd);
			const why = `Every todo item for ${ticket} is done, but ${open.length} open ${many ? "children block" : "child blocks"} closing it, so it stays open.`;
			await note(job, task, "blocked", ours
				? `${why} It closes once ${many ? "they are" : "that child is"} closed; the plugin retries when ${many ? "they close" : "it closes"} during this session.`
				: `${why} ${many ? "They are" : "It is"} outside this todo plan, so close the ticket yourself once ${many ? "they are" : "it is"} done.`, cwd);
		}
	}

	async function closeWith(job: Job, ticket: string, decision: KataIssue, request: PendingClose) {
		const args = ["close", ticket, "--done", "--if-match", String(decision.revision), "--idempotency-key", request.key, "--message", request.message];
		for (const e of request.evidence) args.push("--evidence", e);
		await kata.run(job, args, request.cwd);
		if (decision.metadata?.["todo.status"] !== undefined) {
			await owned(job, ticket, request.cwd, "check", true, undefined, TICKET).then(closed => work(job, ticket, "todo.status", "completed", request.cwd, closed)).catch(debug);
		}
	}

	// Kata wants WONTFIX_MIN characters for wontfix; the task and plan context supply that around the caller's reason. The ref
	// tells two tasks of one title apart: with Kata's close throttle on, a close that repeats a sibling's message is
	// refused (`duplicate_message`).
	function wontfix(verb: string, task: Task, change: Change): string {
		return `${verb} from the todo plan under ${plan.parent}: "${task.content}" (${task.ref}). Reason: ${whyDropped(change)}. This task was intentionally retired from the plan without asserting completion.`;
	}

	const leads = (t: Task) => !t.delegated && !t.holder && !delegates.holds(t.ticket ?? t.ref);

	async function remove(job: Job, task: Task, change: Change, cwd: string): Promise<void> {
		if (task.ticket) {
			const working = WORKING.has(task.status);
			if (OPEN.has(task.status)) await note(job, task, "rm", leftPlan("Removed", task, change), cwd);
			named = named.filter(t => t !== task);
			plan.tasks = plan.tasks.filter(t => t !== task);
			if (working) await settleTicket(job, task, cwd);
			return;
		}
		if (plan.local) { plan.tasks = plan.tasks.filter(t => t !== task); return; }
		if (OPEN.has(task.status)) {
			await transition(job, task, "abandoned", { ...change, remove: true }, cwd);
		}
		const decision = await owned(job, task.ref, cwd, "check", true, task.revision);
		await work(job, task.ref, "todo.removed", true, cwd, decision);
		settlement.cancelTaskClose(task.ref);
	}

	// The pending task the core starts when no task is active, unless the host's list says what is in progress (autoStart: false).
	function nextTask(tasks: Task[]): Task | undefined {
		if (!autoStart || tasks.some(t => t.status === "in_progress" && leads(t))) return;
		return phasesOf(tasks).flatMap(p => p.tasks).find(t => t.status === "pending" && leads(t));
	}

	async function advance(job: Job, cwd: string): Promise<void> {
		const next = nextTask(plan.tasks);
		if (next) await transition(job, next, "in_progress", {}, cwd);
	}

	async function resolve(job: Job, target: string | undefined, phase: string | undefined, fallback: "active" | "none"): Promise<Task[]> {
		if (phase && !target) {
			const tasks = plan.tasks.filter(t => t.phase === phase);
			if (tasks.length === 0) throw new Error(`No phase "${phase}". Phases: ${phasesOf(plan.tasks).map(p => p.name).join(", ") || "none"}`);
			return tasks;
		}
		if (!target) {
			// Never guess between two active tasks: closing one closes it with this evidence. A task another session started
			// counts too: the caller may mean it, and closing this session's own task with that evidence would be wrong.
			const active = plan.tasks.filter(t => t.status === "in_progress" && leads(t));
			const held = plan.tasks.filter(t => t.status === "in_progress" && t.holder);
			if (fallback === "active" && active.length === 1 && !held.length) return active;
			if (fallback === "active" && active.length + held.length > 1) throw new Error(`Several tasks are in progress (${[...active, ...held].map(t => `"${t.content}"`).join(", ")}); name the task.`);
			throw new Error("Name the task (verbatim content or Kata ref).");
		}
		if (!plan.local && !plan.tasks.some(t => t.content === target) && FULL_ID_REF.test(target)) target = await kata.pin(job, target, plan.workspace);
		const name = target;
		const exact = plan.tasks.filter(t => t.content === name || hasRef(t, name) || listedName(t) === name);
		if (exact.length === 1) return exact;
		if (QUALIFIED_REF_ONLY.test(target) && !exact.length && !plan.local) {
			// A short id is only unique per project: compare the ticket the ref names now, never its short id alone.
			const pinned = await kata.pin(job, target, plan.workspace).catch(() => undefined);
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

	// An item named as the plan view lists it drops the view's ' (<ticket or ref>)' suffix, and a new ticket item drops
	// a trailing ' (<ref>)' that repeats its own ticket. An item already in the plan under that exact content keeps it.
	function withoutListedSuffix(content: string): string {
		const task = plan.tasks.find(t => t.content === content) ?? plan.tasks.find(t => listedName(t) === content);
		if (task) return task.content;
		const ref = itemTicket(content)?.ref, suffix = ` (${ref})`;
		return ref && content.endsWith(suffix) ? content.slice(0, -suffix.length) : content;
	}

	const planParentSources = (params: any, ctx: HostContext) => ({
		path, cwd: ctx.cwd, assigned: { ref: assignedRef, workspace: plan.workspace }, explicit: configuredRef(), initRef: params.ref,
		stored: plan.parent ? { parent: plan.parent, workspace: plan.workspace } : undefined,
	});

	// Creates the session's automatic parent. Once a person deleted it, the new parent takes a key derived from the
	// deleted one, so a retry, the lead and its pi children all reach the same issue.
	async function createAutomaticParent(job: Job, sessionId: string, title: string, where: { project?: string; label?: string }, workspace: string, teammate?: string): Promise<Created> {
		const args = [...(where.project ? ["--project", where.project] : []), ...(where.label ? ["--label", where.label] : []), "--body", `Todo plan from ${namespace} session ${sessionId}.`, ...(teammate !== undefined ? ["--teammate", teammate] : []),
			"--meta", `${keys.session}=${sessionId}`, "--meta", `${keys.workspace}=${workspace}`, "--label", keys.label, "--", title];
		let key = `${namespace}-session:${sessionId}`;
		for (const spent = new Set<string>(); ;) {
			const created = await keyedCreate(job, key, args, workspace);
			if (!("deleted" in created)) return created;
			if (spent.has(created.deleted)) throw created.error;
			spent.add(created.deleted);
			key = `${namespace}-session:${sessionId}:after:${created.deleted}`;
		}
	}

	// The one mark of a session's automatic parent, on an issue this actor owns: the flag, and for the lead `work.attention`.
	// A mark already in place is left, and each write is guarded by the issue's revision. A pi child marks the parent it
	// made for its lead and leaves the lead's work.* alone (`attention: false`).
	async function markAutomaticParent(job: Job, ref: string, cwd: string, decision: KataIssue, attention = true): Promise<void> {
		if (decision.metadata?.[keys.auto] === undefined) decision = await work(job, ref, keys.auto, true, cwd, decision);
		if (attention && decision.metadata?.["work.attention"] === undefined) await work(job, ref, "work.attention", "ok", cwd, decision);
	}

	async function ensureParent(job: Job, params: any, ctx: HostContext): Promise<string | undefined> {
		let down = false;
		const choice = await decidePlanParent({
			...planParentSources(params, ctx),
			// A Pi child may establish the session parent before the lead uses todo.
			session: async () => {
				if (!await probe(job, ctx.cwd)) { down = true; return; }
				return sessionBinding(job, ctx);
			},
		});
		if (choice.parent && isExplicitParent(choice) && (choice.provenance === "init" || !namesPlanParent(plan.parent, aliases, choice.parent))) {
			requestedRef = choice.parent;
			try { await adopt(job, choice.parent, ctx); }
			catch (error) { bound = false; throw error; }
		}
		if (down) { goLocal(ctx); return; }
		if (!plan.parent && choice.provenance === "session") { setParent({ ...choice.saved!, parent: choice.parent!, workspace: choice.workspace }); await load(job, choice.workspace); }
		if (plan.parent) {
			const ref = plan.parent;
			let decision: KataIssue | undefined;
			try { decision = await reopenParent(job); }
			catch (error) { if (!isDeletedAutomaticParent(error, ref)) throw error; forget(ref); }
			if (plan.parent) {
				if (decision) await markAutomaticParent(job, plan.parent, plan.workspace, decision);
				return plan.parent;
			}
		}
		const sessionId = sid(ctx);
		if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("Kata needs a real session id before creating an automatic parent.");
		const title = ((params.message as string | undefined)?.trim() || host.getSessionName?.() || `Todo plan: ${(params.list ?? []).map((p: any) => p.phase).join(", ") || "tasks"}`).slice(0, TITLE_MAX);
		const cwd = path.resolve(ctx.cwd);
		let where: Awaited<ReturnType<typeof destination>>, created: Created;
		try {
			where = await destination(job, cwd);
			created = await createAutomaticParent(job, sessionId, title, where, cwd);
		} catch (error) {
			// A folder with no git ancestor is refused client-side, so the probe never reached the daemon.
			if (!isUnusable(error)) throw error;
			wentDown(error);
			goLocal(ctx); return;
		}
		const { ref } = created;
		await markAutomaticParent(job, ref, cwd, await owned(job, ref, cwd, true, false, created.issue.revision));
		setParent({ parent: ref, workspace: cwd, sessionId, auto: true, label: where.label });
		return ref;
	}

	async function reopenParent(job: Job) {
		if (!plan.parent || !plan.auto) return;
		const decision = await owned(job, plan.parent, plan.workspace, true, true);
		return decision.status === "closed" ? reopen(job, plan.parent, plan.workspace, decision) : decision;
	}

	// Thrown when Kata throttled a close, which is now a pending close (settlement.ts owns the `PendingClose` name).
	class ClosePending extends Error {}
	async function closeTask(job: Job, args: string[], task: Task, to: Status, change: Change, cwd: string) {
		try { await kata.run(job, args, cwd); }
		catch (error) {
			if (!isKataCode(error, "sibling_throttle")) throw error;
			const text = settlement.pendTaskClose(task, to, change, cwd, task.ticket ? undefined : plan.parent);
			persist(job);
			throw new ClosePending(text);
		}
	}

	async function performTask(job: Job, pending: { task: Task; to: Status; change: Change; cwd: string }) {
		const { task, change, cwd } = pending;
		if (change.remove) await remove(job, task, change, cwd);
		else await transition(job, task, pending.to, change, cwd);
		if (plan.tasks.some(t => t.ref === task.ref)) { await load(job, plan.workspace); await advance(job, plan.workspace); }
	}

	async function flagDropped(job: Job, ref: string, cwd: string, error: unknown) {
		const code = (error as KataError | undefined)?.code;
		await kata.run(job, ["label", "add", ref, "needs-review"], cwd);
		await kata.run(job, ["comment", ref, "--body", `The plugin gave up closing ${ref} after ${MAX_FAILURES} failed attempts (Kata error code: ${code ?? "none, not a Kata error"}): ${(error as Error)?.message ?? error}. Review it and close it yourself.`], cwd);
	}

	// The one settlement pass: a deleted automatic parent is forgotten first, then exited delegates settle, the session's
	// local plan replays, and pending closes and the automatic parent's close run.
	async function drain(job: Job) { return sweep(job, options.closeParent !== "shutdown"); }
	async function sweep(job: Job, closeParents: boolean) {
		// A deleted automatic parent takes its plan tasks' pending closes with it: the load forgets it before they run.
		if (plan.parent && plan.auto && settlement.hasPlanCloses(plan.parent)) await load(job, plan.workspace).catch(debug);
		await delegates.settle(job);
		if (plan.local && currentCtx) await replayLocal(job, currentCtx).catch(debug);
		await settlement.drain(job, { parents: closeParents });
		if (plan.local) settlement.schedule();
		persist(job);
	}

	// ---------------------------------------------------------------------- ops

	// init closes every task missing from the new list; leaving out an open task needs an explicit replace.
	// Nor may it drop a task another session started (see takeOver).
	function refuseDropped(replace: boolean, tasks: Task[], wanted: Set<string>): void {
		const open = tasks.filter(t => OPEN.has(t.status) && !wanted.has(itemKey(t)));
		const held = open.filter(t => t.holder);
		if (replace && held.length) throw new Error(`The new list leaves out tasks another session started, so nothing changed:\n${held.map(t => `- ${MARK[t.status]} ${t.content} (session ${t.holder})`).join("\n")}\nIf that session crashed or was killed, take them over first (${wording.takeOverFirst}), or keep them in the list.`);
		if (replace || !open.length) return;
		throw new Error(`The new list leaves out open tasks, so nothing changed:\n${open.map(t => `- ${MARK[t.status]} ${t.content}`).join("\n")}\n${wording.leftOut}`);
	}

	// Moves tasks another session started to this one, and says which it moved (by ref). Nothing tells the plugin
	// whether that session still runs, so only an explicit request takes over, and the comment, written before the marker
	// moves, names both sessions.
	async function takeOver(job: Job, tasks: Task[], cwd: string): Promise<Set<string>> {
		const taken = new Set<string>();
		const held = plan.local ? [] : tasks.filter(t => !t.ticket && t.holder);
		if (!held.length) return taken;
		const session = markingSession(job);
		if (!session) throw new Error("takeover needs a lead session with an id; nothing was taken over.");
		const who = { takeover: true };
		for (const task of held) {
			const first = await owned(job, task.ref, cwd, "check", false, task.revision, who);
			const previous = heldBySession(first, ownSessions);
			if (!previous) continue;
			await kata.run(job, ["comment", task.ref, "--idempotency-key", `${namespace}-takeover:${digest(task.ref, previous, session, String(first.revision))}`,
				"--body", `Taken over by session ${session} from session ${previous}, which started it.`], cwd);
			const current = await owned(job, task.ref, cwd, "check", false, undefined, who);
			if (heldBySession(current, ownSessions) === previous) await work(job, task.ref, SESSION_KEY, session, cwd, current);
			taken.add(task.ref);
		}
		return taken;
	}

	// A lead that ends gracefully (shutdown, or a switch to another session) releases the tasks it holds, so the next
	// session continues them without a takeover; a crash releases nothing, and those still need one. A fork that replaces
	// its source in this process inherits the source's tasks (settleFork) when it works the same plan parent, so its own end
	// releases them later; a fork whose history predates that plan gets nothing, and the tasks are released. The source's
	// tasks come from the source's own plan: captured before the switch rebinds (omp), or left by the source's instance at
	// its fork shutdown (pi, which starts a new instance for the fork). A fork started elsewhere leaves its source's alone.
	// A task whose close waits to retry keeps its mark: moving it changes the task's revision, which voids that close.
	type Leaving = { session: string; workspace: string; parent: string; refs: string[] };
	function leaving(session = currentId): Leaving | undefined {
		if (!session || !plan.parent || plan.local) return undefined;
		const refs = plan.tasks.filter(t => !t.ticket && !t.delegated && !t.holder && WORKING.has(t.status) && !settlement.hasTaskClose(t.ref)).map(t => t.ref);
		return refs.length ? { session, workspace: plan.workspace, parent: plan.parent, refs } : undefined;
	}
	async function moveMarks(job: Job, from: Leaving | undefined, to: string | undefined): Promise<void> {
		if (!from) return;
		for (const ref of from.refs) {
			try {
				const issue: KataIssue = (await kata.show(job, ref, from.workspace)).issue;
				if (issue.status === "open" && issue.metadata?.[SESSION_KEY] === from.session) await work(job, ref, SESSION_KEY, to, from.workspace, issue);
			} catch (error) { debug(error); }
		}
	}
	// The source's tasks go to a fork that works their plan parent; any other fork releases them.
	const settleFork = (job: Job, source: Leaving | undefined, fork: string | undefined) =>
		moveMarks(job, source, fork && source && (plan.parent === source.parent || aliases.has(source.parent)) ? fork : undefined);
	// Tasks a pi source left for the fork that replaces it, by source session id: the fork runs in a new plugin instance.
	const forkSources = ((globalThis as Record<symbol, unknown>)[Symbol.for(`kata.${namespace}.forkSources`)] ??= new Map<string, Leaving>()) as Map<string, Leaving>;

	// A main session starts: the session it replaces ends (its attention, its tasks) or hands its tasks to this fork, then this one binds and its attention
	// starts. `session.start` runs it, and so does every other entry of a native host that finds a new main session first (a mirrored list, a guarded call,
	// `/todo ref`, a prompt: omp may deliver any of them before `session_start`), so the switch is handled once, whichever comes first.
	async function enterSession(job: Job, ctx: HostContext, begin: { forked?: boolean } = {}, replay = true, initRef?: string): Promise<void> {
		const id = sid(ctx), explicit = configuredRef();
		// A switch away from a bound lead ends it; a switch to its own fork hands its tasks on (settleFork).
		const forkOf = forkSource(ctx);
		const switchedToFork = !!currentId && forkOf === currentId && bound;
		const ending = currentId && id && currentId !== id && bound && !switchedToFork ? leaving() : undefined;
		let source: Leaving | undefined;
		if (switchedToFork) source = leaving();
		// pi: the source's instance left its tasks at its fork shutdown (read below, after bind, if it did not).
		else if (begin.forked && forkOf) { source = forkSources.get(forkOf); forkSources.delete(forkOf); }
		// The previous session ended whether or not this one binds: its attention, its tasks and its fork's share go either way.
		const unbound = await bind(job, ctx, replay, initRef).then(() => undefined, (error: unknown) => ({ error }));
		reminders = 0;
		const previous = attentionSession;
		if (options.attentionHarness && id && previous?.id !== id) {
			if (previous) await attention(job, "end", previous);
			const current = attentionSession = { id, cwd: plan.workspace, ref: explicit && plan.parent, hostCwd: path.resolve(ctx.cwd), hostRef: explicit, attended: new Map() };
			await attention(job, "start", current);
			// Refs the previous session holds under this session's own attention session (a switch back after a failed fork start) are this session's again.
			if (previous) for (const [ref, held] of previous.attended) {
				if (!held.sessions.delete(id)) continue;
				current.attended.set(ref, { cwd: held.cwd, sessions: new Set([id]) });
				if (!held.sessions.size) previous.attended.delete(ref);
			}
			// A parent this session restored (a fork, or a resume of a ticket still `ok`) starts under the new attention session before the previous session's end runs: Kata keeps
			// the newest attention session, so that end then does nothing to it. When the start may not have applied, an earlier session may still hold the parent:
			// it is not ended here but carried with every attention session that may hold it, and the next start or the end of this session takes it over.
			const failed = await startParentAttention(job);
			if (previous && failed && plan.parent && previous.attended.has(plan.parent)) {
				const carried = previous.attended.get(plan.parent)!;
				const held = current.attended.get(plan.parent);
				if (held) for (const carriedId of carried.sessions) held.sessions.add(carriedId); else current.attended.set(plan.parent, carried);
				previous.attended.delete(plan.parent);
			}
			if (previous) await endAttended(job, previous);
		}
		await moveMarks(job, ending, undefined);
		// No tasks left by a pi source: the fork's own view of the tasks the source holds in the plan it bound.
		if (!source && begin.forked && forkOf && forkOf !== id) source = leaving(forkOf);
		await settleFork(job, source, unbound ? undefined : id);
		if (unbound) throw unbound.error;
		// The plan was loaded while the previous session still held its tasks: show them as they are now.
		if (ending || source) { await load(job, plan.workspace).catch(debug); refresh(ctx); }
	}
	// Binds the main session a native host's entry found, through the switch above when it is a new one; any other bind is `bind`.
	const enter = (job: Job, ctx: HostContext, replay = true, initRef?: string): Promise<void> =>
		options.native && main(ctx) && currentId !== sid(ctx) ? enterSession(job, ctx, {}, replay, initRef) : bind(job, ctx, replay, initRef);
	const ensureBound = async (job: Job, ctx: HostContext, replay = true, initRef?: string): Promise<void> => {
		if (!bound || currentId !== sid(ctx)) await enter(job, ctx, replay, initRef);
	};

	// The start of every plan operation: bound to the ctx's session, with the mirror memory of the ctx's branch (a no-op on hosts without a mirror).
	async function enterPlan(job: Job, ctx: HostContext, replay = true, initRef?: string): Promise<void> {
		await ensureBound(job, ctx, replay, initRef);
		currentCtx = ctx;
		nativeFromBranch(ctx);
		currentId ||= sid(ctx);
	}

	async function apply(job: Job, params: any, ctx: HostContext): Promise<string> {
		await enterPlan(job, ctx, params.op === "view", params.ref ?? (!bound ? requestedRef : undefined));
		if (plan.local) {
			try { await replayLocal(job, ctx); }
			catch (error) { if (params.op !== "view") throw new Error(`Kata is reachable again, but the local plan could not be replayed into it: ${(error as Error).message}`, { cause: error }); }
		}
		let cwd = plan.workspace;
		const change: Change = { message: params.message?.trim() || undefined, evidence: params.evidence?.filter((e: string) => e.trim()), reason: params.reason?.trim() || undefined };
		const op = params.op as (typeof TODO_OPS)[number];
		if (op === "view") {
			await load(job, cwd);
			await drain(job);
			return render(plan, wording);
		}
		if (op === "init") {
			if (params.takeover === true) throw new Error(`init does not take tasks over, so nothing changed. Take them over first (${wording.takeOverFirst}), then init.`);
			const desired: { phase: string; content: string }[] = (params.list?.length
				? params.list.flatMap((p: any) => p.items.map((content: string) => ({ phase: p.phase, content })))
				: (params.items ?? []).map((content: string) => ({ phase: params.phase || "Tasks", content })))
				.map((d: { phase: string; content: string }) => ({ ...d, content: withoutListedSuffix(d.content) }));
			if (desired.length === 0) throw new Error("init needs list (phases with items) or items.");
			if (desired.some(d => !d.content.trim() || !d.phase.trim())) throw new Error("Task and phase names must not be blank.");
			const wanted = new Set(desired.map(itemKey));
			const resolved = await resolveNamed(job, desired, plan.workspace, d => !named.some(t => itemKey(t) === itemKey(d)));
			if (plan.parent && plan.auto) await load(job, plan.workspace);
			const choice = await decidePlanParent(planParentSources(params, ctx));
			const target = choice.parent;
			if (target) {
				const workspace = choice.workspace;
				const keepsParent = choice.provenance === "init" ? target === plan.parent || aliases.has(target) : namesPlanParent(plan.parent, aliases, target);
				const parent = keepsParent && plan.parent ? plan.parent : await kata.pin(job, target, workspace);
				if (choice.overridden && parent !== await kata.pin(job, choice.overridden, workspace)) throw new Error(`Kata init ref ${params.ref} conflicts with the explicit binding ${target}; neither plan was replaced.`);
				const tasks = planTasks((await showParent(job, parent, workspace)).children ?? [], parent);
				refuseDropped(params.replace === true, [...tasks, ...named], wanted);
				const kept = tasks.filter(t => wanted.has(itemKey(t)));
				const affected = new Set(tasks.filter(t => !kept.includes(t)));
				const next = nextTask(kept);
				if (next) affected.add(next);
				for (const task of affected) await owned(job, task.ref, workspace, "check", true, task.revision);
			}
			if (!target) refuseDropped(params.replace === true, plan.tasks, wanted);
			if (target || needsParent(desired.map(d => d.content))) await ensureParent(job, params, ctx);
			cwd = plan.workspace;
			await load(job, cwd);
			// ensureParent may have found a parent with open tasks (a restored one, or one a pi child created).
			if (!target) refuseDropped(params.replace === true, plan.tasks, wanted);
			for (const task of plan.tasks) if (wanted.has(itemKey(task))) settlement.cancelRemoval(task.ref);
			for (const task of plan.tasks) {
				if (!wanted.has(itemKey(task))) await remove(job, task, { message: "replaced by a new todo plan" }, cwd);
			}
			const have = new Set(plan.tasks.map(itemKey));
			for (const d of desired) if (!have.has(itemKey(d))) {
				const ticket = resolved.get(itemKey(d));
				if (ticket) addNamed(d.phase, d.content, ticket);
				else if (plan.local) plan.tasks.push({ ...d, ref: `local-${digest(d.phase, d.content)}`, status: "pending", at: nextStamp() });
				else await create(job, d.phase, d.content, plan.workspace);
				have.add(itemKey(d));
			}
			await load(job, cwd);
			await advance(job, cwd);
			return render(plan, wording);
		}
		let children = await load(job, cwd);
		if (!plan.parent && !plan.local && !named.length) throw new Error(`No todo plan yet. ${wording.planFirst}`);
		let taken: Set<string> | undefined;
		if (params.takeover === true) {
			if (!params.task && !(params.phase && ["done", "drop", "rm"].includes(op))) throw new Error("takeover needs the task it takes over; nothing was taken over.");
			taken = await takeOver(job, await resolve(job, params.task, params.phase, "none"), cwd);
			children = await load(job, cwd);
		}
		switch (op) {
			case "append": {
				const items: string[] = (params.items?.length ? params.items : params.task ? [params.task] : []).map(withoutListedSuffix);
				if (items.length === 0) throw new Error("append needs items.");
				if (items.some(content => !content.trim()) || (params.phase !== undefined && !params.phase.trim())) throw new Error("Task and phase names must not be blank.");
				const phase = params.phase || plan.tasks[plan.tasks.length - 1]?.phase || "Tasks";
				const resolved = await resolveNamed(job, items.map(content => ({ phase, content })), cwd, d => !named.some(t => itemKey(t) === itemKey(d) && OPEN.has(t.status)));
				if (needsParent(items) && !plan.parent && !plan.local) {
					await ensureParent(job, { list: [{ phase }], message: params.message }, ctx);
					cwd = plan.workspace;
					children = await load(job, cwd);
				}
				if (!plan.local) {
					for (const child of children) {
						const ref = qualifiedRef(child, plan.parent!);
						if (child.metadata?.["todo.phase"] === phase && items.includes(child.title) &&
							(child.status === "closed" || child.metadata?.["todo.removed"] === true)) {
							await owned(job, ref, cwd, "check", true, child.revision);
						}
					}
				}
				await reopenParent(job);
				for (const content of items) {
					const key = itemKey({ phase, content }), ticket = resolved.get(key);
					if (!ticket && itemTicket(content)) continue;
					if (ticket) {
						named = named.filter(t => itemKey(t) !== key || OPEN.has(t.status));
						if (!named.some(t => itemKey(t) === key)) addNamed(phase, content, ticket);
					} else if (plan.local) {
						const existing = plan.tasks.filter(t => itemKey(t) === key);
						if (existing.length > 1) throw new Error(`Ambiguous local task "${content}"; no task was appended.`);
						if (!existing.length) plan.tasks.push({ content, phase, ref: `local-${digest(phase, content)}`, status: "pending", at: nextStamp() });
					} else {
						await create(job, phase, content, cwd);
						for (const task of plan.tasks.filter(t => itemKey(t) === key)) settlement.cancelRemoval(task.ref);
					}
				}
				await load(job, cwd);
				break;
			}
			case "start": {
				const [task] = await resolve(job, params.task, undefined, "none");
				if (task.status === "blocked") {
					// A takeover moves a blocked task to this session as it is: unblocking it is a call of its own.
					if (taken?.has(task.ref)) break;
					throw new Error(`"${task.content}" is blocked; unblock it first.`);
				}
				const decision = plan.local || task.ticket ? undefined : await owned(job, task.ref, cwd, true, !OPEN.has(task.status), task.revision);
				// owned(job) may have returned a closed item a past delegate still marked; it no longer is delegated.
				if (decision) { task.revision = decision.revision; task.delegated = false; }
				if (!OPEN.has(task.status) && !task.ticket) await reopenParent(job);
				// A host whose list says what is in progress (autoStart: false) may have several tasks started.
				if (autoStart) for (const other of plan.tasks) if (other !== task && other.status === "in_progress" && leads(other) && !settlement.hasTaskClose(other.ref)) await transition(job, other, "pending", {}, cwd);
				await transition(job, task, "in_progress", change, cwd, decision);
				settlement.cancelTaskClose(task.ref);
				break;
			}
			case "done":
			case "drop": {
				const tasks = (await resolve(job, params.task, params.phase, "active")).filter(t => OPEN.has(t.status));
				for (const task of tasks) await transition(job, task, op === "done" ? "completed" : "abandoned", change, cwd);
				break;
			}
			case "rm":
				for (const task of await resolve(job, params.task, params.phase, "none")) await remove(job, task, change, cwd);
				await load(job, cwd);
				break;
			case "block":
				for (const task of await resolve(job, params.task, undefined, "active")) await transition(job, task, "blocked", change, cwd);
				break;
			case "unblock":
				for (const task of await resolve(job, params.task, undefined, "none")) if (task.status === "blocked") await transition(job, task, "pending", change, cwd);
				break;
			default: {
				const unknown: never = op;
				throw new Error(`Unknown op ${unknown}.`);
			}
		}
		await advance(job, cwd);
		await drain(job);
		return render(plan, wording);
	}

	function view(): PlanView {
		return {
			parent: plan.parent, workspace: plan.workspace, label: plan.label, ...(plan.local ? { local: true as const } : {}),
			phases: phasesOf(plan.error ? [] : plan.tasks).map(p => ({
				name: p.name,
				tasks: p.tasks.map(t => ({ content: t.content, status: t.status, ref: t.ticket ?? t.ref, ...(t.blocker ? { blocker: t.blocker } : {}) })),
			})),
		};
	}

	// `notice` is the result text before the plan: an error, a pending close or a deleted parent.
	function details(op: string, notice: string) {
		// The plan sits under `kata`, not a top-level `phases`: a host that tracks its own todo list reads that key from
		// any result named `todo` and would take the plan for its list.
		return { op, kata: { ...view(), ...(notice ? { notice } : {}) } };
	}
	const noticeOf = (text: string, planText: string) => text.slice(0, text.length - planText.length).trim();

	// One todo call, from the tool or from /todo: one job that binds the session, applies the op and, when it failed, reloads
	// the plan so the result shows it as Kata has it. `text` is the notice and the plan. `failed`: "pending" when the only
	// failure is a close Kata deferred, "identity" when the call came from another agent than the one the plan is bound for.
	type TodoOutcome = { text: string; notice: string; failed?: "error" | "pending" | "identity" };
	function todoCall(params: any, ctx: HostContext, within: Job): Promise<TodoOutcome> {
		return serial(async (job): Promise<TodoOutcome> => {
			if (boundAgent && boundAgent !== agentKey(ctx)) {
				const text = "Kata agent identity changed; use this worker's own extension context.";
				return { text, notice: text, failed: "identity" };
			}
			try {
				if (!main(ctx) && !delegates.assignment(ctx)) throw new Error(delegates.unassigned(ctx));
				const planText = await apply(job, params, ctx);
				const text = withDeletionNotice(planText, params.op === "init");
				return { text, notice: noticeOf(text, planText) };
			} catch (err) {
				// A failed initial binding has no authoritative plan to render yet; a deleted parent's notice is one.
				if (!bound || !plan.parent && !plan.local && !named.length && !deletedParent) plan.error = (err as Error).message;
				// Kata may have applied part of a batch. A failed reload marks the
				// cached tasks unavailable instead of presenting them as current.
				if (plan.parent || named.length) await load(job, plan.workspace).catch(debug);
				const planText = render(plan, wording);
				const text = withDeletionNotice(`${(err as Error).message}\n\n${planText}`);
				return { text, notice: noticeOf(text, planText), failed: err instanceof ClosePending ? "pending" : "error" };
			} finally {
				persist(job);
				refresh(ctx);
			}
		}, { ...within, ctx });
	}

	async function execute(params: any, ctx: HostContext, within: Job) {
		if (!(TODO_OPS as readonly string[]).includes(params.op)) {
			const text = `todo needs op: one of ${TODO_OPS.join(", ")}.`;
			return { content: [{ type: "text" as const, text }], details: { op: String(params.op), kata: { notice: text } }, isError: true as const };
		}
		const { text, notice, failed } = await todoCall(params, ctx, within);
		return {
			content: [{ type: "text" as const, text }],
			// A call from another identity never reached the plan: its result carries the notice alone.
			details: failed === "identity" ? { op: params.op as string, kata: { notice } } : details(params.op, notice),
			...(failed ? { isError: failed === "pending" ? undefined : true as const } : {}),
		};
	}

	// ------------------------------------------------------ omp's native todo list

	const nativeItems = (phases: NativePhase[]): NativeItem[] => phases.flatMap(p => p.tasks.map(t => ({ phase: p.name || "Tasks", content: t.content, status: t.status })));

	// omp's list stays the truth when Kata cannot take a change, and the next change repeats it all. An outage is shown once, until a pass has none. A refused
	// parent setup, init or parent mark is tried again on the next change; a refused step of a task is sent to Kata again only when that task changes in the
	// list, and a refused removal never is, as the item has left the list. Each distinct refusal (message, kind and task) is shown once, until a pass has no
	// failure at all; a step refused with a message the setup already showed is not shown again, and one notice names every task refused with the same message.
	const OUTAGE = "outage";
	const kindOf = (f: Pick<MirrorFailure, "task" | "removed">) => f.task === undefined ? "setup" : f.removed ? `rm-${f.removed}` : "step";
	const shownKey = (f: Pick<MirrorFailure, "error" | "task" | "removed">) => JSON.stringify([messageOf(f.error), kindOf(f), f.task?.content]);

	function report(ctx: HostContext, failures: MirrorFailure[]) {
		if (!failures.length) { shown.clear(); return; }
		const down = failures.find(f => f.outage);
		if (!down) shown.delete(OUTAGE);
		else if (outageOf(down.error)) wentDown(down.error);
		const groups = new Map<string, MirrorFailure[]>();
		for (const f of failures) {
			if (f.outage ? shown.has(OUTAGE) : shown.has(shownKey(f)) || (f.task !== undefined && shown.has(shownKey({ error: f.error })))) continue;
			const group = f.outage ? OUTAGE : JSON.stringify([messageOf(f.error), kindOf(f)]);
			groups.set(group, [...(groups.get(group) ?? []), f]);
		}
		for (const [group, members] of groups) {
			const { error, removed } = members[0], message = messageOf(error);
			debug(error);
			if (group === OUTAGE) {
				shown.add(OUTAGE);
				uiOf(ctx)?.notify?.(`Kata did not take the latest change to the todo list (${message}). The change stays in ${listName}; the next change tries again.`, "warning");
				continue;
			}
			for (const f of members) shown.add(shownKey(f));
			const tasks = [...new Map(members.flatMap(f => f.task ? [[f.task.content, f.task] as const] : [])).values()];
			const names = tasks.map(t => `"${t.content}"`).join(", "), many = tasks.length > 1;
			const closes = tasks.map(t => `\`kata close ${t.ref} --wontfix --message '<${WONTFIX_MIN}+ characters>'\``).join(", ");
			const stays = !tasks.length
				? `The change stays in ${listName}; the next change tries again.`
				: removed === "ticket"
					? `${names} ${many ? "are ticket items" : "is a ticket item"}. Kata refused part of removing ${many ? "them" : "it"} from the plan; ${many ? "the tickets stay" : "the ticket stays"} open and ${many ? "need" : "needs"} no close, and if ${many ? "one was" : "it was"} in progress or blocked, Kata may still show it so.`
					: removed
						? `${names} ${many ? "stay" : "stays"} open in Kata; close ${many ? "them" : "it"} there with ${closes}.`
						: `${names} ${many ? "stay" : "stays"} in ${listName}. ${many ? "Each is" : "It is"} sent to Kata again only when ${many ? "it" : "that task"} changes in the list.`;
			uiOf(ctx)?.notify?.(`Kata refused the latest change to the todo list (${message}). ${stays}`, "warning");
		}
	}

	// An outage, or any failure while the plan is local, or a refusal.
	function failureOf(error: unknown, task?: MirrorFailure["task"], removed?: MirrorFailure["removed"]): MirrorFailure {
		return outageOf(error) || plan.local ? { error, outage: true } : { error, outage: false, task, removed };
	}

	// A task omp's list marks completed while Kata still has it open: the agent skipped the close. The task stays open and is labeled
	// needs-review, with one comment saying why. A ticket item comments on its ticket instead, and the ticket is labeled when that was
	// the ticket's last open item. The comment's key makes it once-only; the label comes after it, so a retry never labels without the comment.
	async function flagForReview(job: Job, task: Task, key: string, body: string, cwd: string): Promise<void> {
		await kata.run(job, ["comment", task.ref, "--idempotency-key", key, "--body", body], cwd);
		await kata.run(job, ["label", "add", task.ref, "needs-review"], cwd);
		task.review = true;
	}

	async function flagCompleted(job: Job, task: Task, lastOfTicket: boolean, cwd: string): Promise<void> {
		const key = task.ticket ? noteKey(task, "native-done") : `${namespace}-native-done:${digest(task.ref)}`;
		const flag = `${key}:${lastOfTicket}`;
		if (flagged.has(flag) || (!task.ticket && task.review)) return;
		if (!task.ticket) {
			await flagForReview(job, task, key, `"${task.content}" was marked completed in ${listName} without a Kata close, so it stays open. Close it with its evidence, or set it back to pending in ${listName}.`, cwd);
		} else if (lastOfTicket) {
			await note(job, task, "native-done", `Todo item "${task.content}" was marked completed in ${listName} without a Kata close, so the ticket stays open.`, cwd);
			if (!delegates.holds(task.ticket)) {
				const shown: KataIssue = (await kata.show(job, task.ticket, cwd)).issue;
				if (shown.status === "open" && !hasLabel(shown, "needs-review")) await kata.run(job, ["label", "add", task.ticket, "needs-review"], cwd);
			}
		} else {
			// An earlier item of a ticket that still has open items: a plain done comment, and the plan has it done, so the last one is seen as last.
			await note(job, task, "native-done", `Todo item done: "${task.content}"\nMarked completed in ${listName}; the ticket stays open while other items of it are open.`, cwd);
			if (WORKING.has(task.status)) await settleTicket(job, task, cwd);
			task.status = "completed";
			task.blocker = undefined;
		}
		flagged.add(flag);
	}

	// One mirror pass: starts the plan from omp's list when there is none, then brings each plan task in line with it (see diffNativeList). One
	// task's failure does not stop the others; each distinct failure is returned.
	async function mirrorList(job: Job, ctx: HostContext, phases: NativePhase[]): Promise<MirrorFailure[]> {
		// The list just mirrored becomes `prev`, with each task's phase; a task whose step failed keeps its old entries, so the next mirror sees the change again.
		const remember = (items: NativeItem[], failed: ReadonlySet<string> = new Set()) => {
			const next = new Map<string, NativeStatus>(), phaseOf = new Map<string, string>();
			for (const item of items) if (!next.has(item.content)) { next.set(item.content, item.status); phaseOf.set(item.content, item.phase); }
			for (const content of failed) {
				const old = native.prev.get(content), oldPhase = native.phase.get(content);
				if (old === undefined) next.delete(content); else next.set(content, old);
				if (oldPhase === undefined) phaseOf.delete(content); else phaseOf.set(content, oldPhase);
			}
			const own: readonly any[] = main(ctx) ? ctx.sessionManager?.getBranch?.() ?? [] : [];
			native = { prev: next, phase: phaseOf, listed: phases.length > 0, leaf: tipOf(own) };
			markSeen(own);
		};
		if (boundAgent && boundAgent !== agentKey(ctx)) return [];
		// A delegate with no assignment has no plan to mirror into.
		if (!main(ctx) && !delegates.assignment(ctx)) return [];
		await enterPlan(job, ctx, false);
		if (plan.local) await replayLocal(job, ctx).catch(debug);
		const items = nativeItems(phases).filter(item => item.content.trim());
		await load(job, plan.workspace);
		// A local plan with no task yet (Kata was down when the session bound) starts from omp's list the same way: init builds it locally.
		if (!plan.parent && !named.length && (!plan.local || !plan.tasks.length)) {
			const open = items.filter(item => nativeOpen(item.status));
			if (!open.length) { remember(items); return []; }
			const list: { phase: string; items: string[] }[] = [];
			for (const item of open) {
				const phase = list.find(p => p.phase === item.phase) ?? list[list.push({ phase: item.phase, items: [] }) - 1];
				phase.items.push(item.content);
			}
			// A parent this plan lands in (adopted, KATA_REF, a restored session's) may hold open tasks omp's list never had: they stay open.
			// So the parent is established first and the diff below appends what it lacks; an init would refuse to leave them out.
			try {
				if (needsParent(open.map(item => item.content)) || (await decidePlanParent(planParentSources({}, ctx))).parent) {
					await ensureParent(job, { list }, ctx);
					// Kata is unreachable: the plan is local, so it takes omp's open items itself, as init does, for the replay to create later. A ticket item
					// waits: Kata alone can resolve it, so the next mirror once Kata is back appends it (a plain local task would lose its ticket).
					if (plan.local) for (const { phase, content } of open) { if (!itemTicket(content) && !plan.tasks.some(t => itemKey(t) === itemKey({ phase, content }))) plan.tasks.push({ phase, content, ref: `local-${digest(phase, content)}`, status: "pending", at: nextStamp() }); }
					else await load(job, plan.workspace);
				} else await apply(job, { op: "init", list }, ctx);
			} catch (error) {
				// A refusal (not an outage) leaves no parent: the list is not remembered, so the next mirror after a parent exists appends every open item.
				const refused = failureOf(error);
				if (refused.outage) throw error;
				return [refused];
			}
		}
		const failures: MirrorFailure[] = [];
		// An automatic parent a restored session found (its claim never marked it) is marked now, as ensureParent does for a new one.
		if (plan.parent && plan.auto && !plan.local && items.some(item => nativeOpen(item.status))) {
			try {
				const shown: KataIssue = (await kata.show(job, plan.parent, plan.workspace)).issue;
				if (shown.metadata?.[keys.auto] === undefined) {
					const decision = await reopenParent(job);
					if (decision) await markAutomaticParent(job, plan.parent, plan.workspace, decision);
				}
			} catch (error) { debug(error); failures.push(failureOf(error)); }
		}
		const failed = new Set<string>();
		const steps = diffNativeList(plan.tasks, native.prev, items, leads);
		for (const step of steps) {
			try {
				const cwd = plan.workspace;
				// `apply` reloads the plan, so a step names its task by ref; the task object may be stale.
				const current = () => plan.tasks.find(t => "task" in step && t.ref === step.task.ref);
				switch (step.step) {
					case "rm": await apply(job, { op: "rm", task: step.task.ref, message: `removed from ${listName}` }, ctx); break;
					case "drop": await apply(job, { op: "drop", task: step.task.ref, message: `dropped in ${listName}` }, ctx); break;
					case "start": await apply(job, { op: "start", task: step.task.ref }, ctx); break;
					case "append": {
						await apply(job, { op: "append", items: [step.content], phase: step.phase }, ctx);
						const added = step.start && plan.tasks.find(t => t.content === step.content && OPEN.has(t.status));
						if (added && added.status === "pending") await apply(job, { op: "start", task: added.ref }, ctx);
						break;
					}
					case "cleared": {
						// Closed in Kata before omp's list said completed: the completed transition's bookkeeping, without closing again.
						const task = current();
						if (task?.review && !plan.local) {
							await owned(job, task.ref, cwd, "check", true);
							await kata.run(job, ["label", "rm", task.ref, "needs-review"], cwd);
							task.review = false;
						}
						break;
					}
					case "pause": { const task = current(); if (task) await transition(job, task, "pending", {}, cwd); break; }
					case "flag": {
						const task = current();
						if (!task) break;
						// A local plan has no issue to label: it keeps the completion, and the replay flags the task for want of evidence.
						if (plan.local) await transition(job, task, "completed", {}, cwd);
						else await flagCompleted(job, task, step.lastOfTicket, cwd);
						break;
					}
				}
			} catch (error) {
				debug(error);
				const task = step.step === "append" ? { content: step.content } : { content: step.task.content, ref: step.task.ref };
				const next = failureOf(error, task, step.step === "rm" ? (step.task.ticket ? "ticket" : "task") : undefined);
				// An outage is what the next mirror repeats, so the step stays unmirrored. A refusal fails the same way next time: it counts as applied
				// (the list is remembered with it, and the diff asks for it again only when its status changes).
				if (next.outage) failed.add(task.content);
				failures.push(next);
			}
		}
		remember(items, failed);
		return failures;
	}

	const snapshotOf = (entry: any, session: unknown): Snapshot | undefined =>
		entry?.type === "custom" && entry.customType === SNAPSHOT_ENTRY && entry.data?.version === 1 && entry.data.sessionId === session ? entry.data : undefined;

	function markSeen(entries: readonly any[]) {
		for (const entry of entries) seenIds.add(entry?.id);
	}
	const markAllSeen = (ctx: HostContext) => { markSeen(ctx.sessionManager?.getBranch?.() ?? []); markSeen(ctx.sessionManager?.getEntries?.() ?? []); };

	// The mirror memory a snapshot saved, on `branch`; every entry of the session as it is now counts as read.
	function loadNative(ctx: HostContext, snapshot: Snapshot | undefined, branch: readonly any[]): NativeMemory {
		markAllSeen(ctx);
		return nativeMemory(snapshot?.native, tipOf(branch));
	}

	// A snapshot saved under another branch's tip (its `leaf` is not on `branch`) is not this branch's memory.
	const onBranch = (branch: readonly any[]) => (data: Snapshot) => data.native?.leaf === undefined || branch.some(entry => entry?.id === data.native!.leaf);

	// The snapshot of the session's current branch; a branch with no snapshot of its own starts from its fork source's, named as `source`.
	// `accept` filters the candidates: the latest one it accepts is taken.
	function savedSnapshot(ctx: HostContext, branch: readonly any[], id: string | undefined, accept: (data: Snapshot) => boolean = () => true): { snapshot?: Snapshot; source?: string } {
		const find = (session: unknown): Snapshot | undefined => [...branch].reverse().map(entry => snapshotOf(entry, session)).find(data => !!data && accept(data));
		const own = find(id);
		if (own || !id || !main(ctx)) return { snapshot: own };
		const source = forkSource(ctx);
		return { snapshot: source ? find(source) : undefined, source };
	}

	// The mirror's memory belongs to the branch whose last entry is `native.leaf`. It is kept while that entry is on the ctx's branch and none of the
	// entries after it was read before: they are new since the memory was made (messages, tool results, snapshots this core or a delegate saved), so only a
	// mirror pass, a reload or a bind moves `leaf` and `seenIds`. Otherwise the branch moved (a `/tree` to a sibling, back, forward to entries read before):
	// the memory is reloaded from the branch's latest snapshot of this session or of its direct fork source (not the source's own source) that is on the
	// branch, or starts from none.
	function nativeFromBranch(ctx: HostContext) {
		if (!options.native || !main(ctx)) return;
		const branch: readonly any[] = ctx.sessionManager?.getBranch?.() ?? [];
		const at = native.leaf === undefined ? -1 : branch.findIndex(entry => entry?.id === native.leaf);
		if (at >= 0 && !branch.slice(at + 1).some(entry => seenIds.has(entry?.id))) return;
		// Every entry of the session as it is now was read: a later `/tree` forward to one of them reloads.
		const saved = loadNative(ctx, savedSnapshot(ctx, branch, sid(ctx), onBranch(branch)).snapshot, branch);
		// The branch moved: the next snapshot is written even when it equals the last one this core wrote on the other branch.
		if (JSON.stringify(savedNative(saved)) !== JSON.stringify(savedNative(native))) lastSnapshot = undefined;
		native = saved;
	}

	// The snapshot a mirror pass just saved is the last entry of the branch its memory belongs to when it was appended under that branch's tip: the host's newest
	// entry is that snapshot, with the tip as its parent. One that landed under another branch's tip (a pass held across a `/tree`) leaves `native.leaf` alone.
	function ownSnapshotLanded(ctx: HostContext) {
		if (!options.native || !main(ctx)) return;
		const branch: readonly any[] = ctx.sessionManager?.getBranch?.() ?? [];
		const entries: readonly any[] = ctx.sessionManager?.getEntries?.() ?? [];
		const last = entries[entries.length - 1];
		if (last?.type !== "custom" || last.customType !== SNAPSHOT_ENTRY || (last.parentId ?? undefined) !== branch[branch.length - 1]?.id) return;
		native.leaf = last.id;
		seenIds.add(last.id);
	}

	// omp calls this after it saved its list, with the whole list. Newest wins: a mirror still queued when a newer one of the SAME session
	// arrives does nothing, since the newer one carries everything; a list of a session left behind still lands. Never rejects.
	function mirror(ctx: HostContext, phases: NativePhase[]): Promise<void> {
		const session = sid(ctx) ?? "", mine = (mirrorStamps.get(session) ?? 0) + 1;
		mirrorStamps.set(session, mine);
		return serial(async job => {
			if (mine !== mirrorStamps.get(session)) return;
			let failures: MirrorFailure[];
			try { failures = await mirrorList(job, ctx, phases); }
			catch (error) { failures = [failureOf(error)]; }
			finally { if (persist(job)) ownSnapshotLanded(ctx); }
			report(ctx, failures);
		}, { ctx }).catch(debug);
	}

	// How long a todo call waits for the guard's Kata reads: past it the call goes through unchecked.
	const GUARD_MS = 10_000;
	const texts = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

	async function guardText(job: Job, ctx: HostContext, call: NativeCall): Promise<string | undefined> {
		await enterPlan(job, ctx, false);
		// Inferred here: whether omp's list had phases is the branch's, known only after the sync above.
		const op = inferNativeOp(call, native.listed);
		if (!op || !GUARDED_OPS.includes(op)) return;
		if (plan.local) return;
		// What the agent closed in its shell since the last operation counts: every read here reaches Kata.
		await load(kata.fresh(job), plan.workspace);
		if (!plan.parent && !named.length) return;
		const cwd = plan.workspace;
		const held = (t: Task) => `"${t.content}": ${heldMessage(t.ref, t.holder!)}. Do not work around it. ${RULES.takeover(wording.takeOverFirst, "")}`;
		const delegated = (t: Task) => t.delegated || delegates.holds(t.ticket ?? t.ref);
		const open = plan.tasks.filter(t => OPEN.has(t.status));
		if (op === "init") {
			// No list and no items is no plan: omp refuses it itself. An empty list leaves every open task out.
			if (!Array.isArray(call.list) && !Array.isArray(call.items)) return;
			const list = Array.isArray(call.list) && call.list.length ? call.list.flatMap((p: unknown) => p && typeof p === "object" && "items" in p ? texts(p.items) : []) : texts(call.items);
			const left = open.filter(t => !t.ticket && !list.includes(t.content) && !delegated(t));
			const lines = left.filter(t => t.holder).map(held);
			const free = left.filter(t => !t.holder);
			// A task omp's list held can be dropped there; one it never held (it came from Kata) must be appended first, or omp's drop finds nothing.
			const listed = (tasks: Task[]) => tasks.map(t => `- "${t.content}" (${t.ref})`).join("\n");
			const inList = free.filter(t => native.prev.has(t.content)), notInList = free.filter(t => !native.prev.has(t.content));
			if (inList.length) lines.push(`The new list leaves out tasks that are still open in Kata:\n${listed(inList)}\nCall todo drop for them first, in an earlier call, then init again; or keep them in the list.`);
			if (notInList.length) lines.push(`The new list leaves out tasks that are open in Kata but were never in your list:\n${listed(notInList)}\nKeep them in the list; or call todo append for them and then todo drop, in earlier calls, then init again.`);
			return lines.join("\n") || undefined;
		}
		const known = new Set(plan.tasks.map(t => t.content));
		let contents = nativeTargets(known, call.task as string | string[] | undefined);
		if (op === "start") { if (contents.length !== 1) return; }
		else if (!contents.length) contents = texts(call.items);
		// A `{phase}` target names omp's phase, as of the last mirrored list; Kata's own phase is the answer only for a task omp's list never held.
		if (!contents.length && typeof call.phase === "string") contents = plan.tasks.filter(t => (native.phase.get(t.content) ?? t.phase) === call.phase).map(t => t.content);
		const targets = open.filter(t => contents.includes(t.content));
		const lines = targets.filter(t => t.holder).map(held);
		if (op === "done") {
			const own = targets.filter(t => !t.holder);
			const closes: string[] = [];
			for (const t of own.filter(t => !t.ticket)) {
				if (delegated(t)) lines.push(`"${t.content}" is delegated as ${t.ref}: its subagent closes it. Leave it, or wait for the subagent to finish.`);
				else closes.push(`"${t.content}" is open in Kata as ${t.ref}. Close it first: ${closeCommand(t.ref)}.`);
			}
			for (const ticket of new Set(own.filter(t => t.ticket).map(t => t.ticket!))) {
				const item = own.find(t => t.ticket === ticket)!;
				if (delegated(item)) { lines.push(`"${item.content}" works ticket ${ticket}, which is delegated: its subagent closes it. Leave it, or wait for the subagent to finish.`); continue; }
				// Only the ticket's last open item closes it; an earlier one just comments.
				if (open.some(t => t.ticket === ticket && !own.includes(t))) continue;
				try {
					if ((await kata.show(kata.fresh(job), ticket, cwd)).issue.status === "open") closes.push(`"${item.content}" is the last open item of ticket ${ticket}, which is open in Kata. Close the ticket first: ${closeCommand(ticket)}.`);
				} catch (error) { debug(error); }
			}
			if (closes.length) lines.push(...closes, "Then call todo done again.");
		}
		return lines.join("\n") || undefined;
	}

	// Called before omp runs a `todo` call: the text that refuses it, or undefined to let it run. It reads Kata fresh, and never rejects: a failed
	// read, input that is no todo call or a context that is no lead's lets the call through. `after` (a delegate's queued work on the plan) is waited for
	// first, within the same GUARD_MS bound.
	function guard(ctx: HostContext, input: unknown, after?: Promise<unknown>): Promise<string | undefined> {
		const call = input as NativeCall | null;
		if (!call || typeof call !== "object" || !guardedNativeCall(call)) return Promise.resolve(undefined);
		// A delegate's own core is never main, so it is guarded when it has an assignment, which its queued next use (`after`) may give it: it is
		// checked once that has run. A lead's context that is no lead's is not guarded.
		return bounded((async () => { await after?.catch(debug); if (!main(ctx) && !delegates.assignment(ctx)) return undefined; return serial(job => guardText(job, ctx, call), { ctx }); })(), GUARD_MS);
	}

	type MoreRefs = () => Promise<Iterable<string>> | Iterable<string>;
	// How long `tools.guard` waits for its checks (the canonical path of each file the call writes): past it the call goes through unchecked.
	const REF_GUARD_MS = 2_000;

	// Every ref this session works: the plan, its items, the assignment, a claim or `/todo ref`, and the delegates' issues.
	function knownRefs(ctx: HostContext): Set<string> {
		const refs = new Set<string>();
		const add = (...found: (string | undefined)[]) => { for (const ref of found) if (ref) refs.add(ref); };
		add(plan.parent, assignedRef, configuredRef(), requestedRef, ...aliases, ...claimed);
		if (!plan.local) for (const t of plan.tasks) add(t.ref, t.ticket);
		for (const t of named) add(t.ref, t.ticket);
		for (const r of [...host.delegateStore.records(), host.delegateStore.of(ctx)]) add(r?.ref, r?.planRef, r?.mission?.ref, r?.binding?.parent, r?.parent);
		add(delegates.assignment(ctx)?.ref);
		return refs;
	}

	// Called before a tool runs: the text that refuses a call that would put a Kata ref into the repository, or undefined to let it run. It
	// never rejects: an error, a slow check or an off switch (KATA_REF_GUARD=off or 0) lets the call through. `also`: refs a host knows that
	// this core does not (a delegate on another thread asks its lead); called once, inside the bound, and only for a call that adds text.
	function refGuard(ctx: HostContext, call: { tool: string; input: unknown }, also: MoreRefs = () => []): Promise<string | undefined> {
		if (refGuardOff(setting("KATA_REF_GUARD"))) return Promise.resolve(undefined);
		return bounded((async () => {
			const cwd = ctx.cwd ?? platform.cwd();
			const workspaces = await Promise.all([...new Set([cwd, plan.workspace])].map(root => canonicalPath(platform, ".", root)));
			const prefix = (root: string) => path.join(root, "x").slice(0, -1);
			const found = await offendingRefs({
				...call,
				async known() {
					const refs = knownRefs(ctx);
					for (const ref of await also()) refs.add(ref);
					return refs;
				},
				async locate(file) {
					// `~` is the home folder, as the host's own tools read it; a host that knows none cannot place the file.
					if (file === "~" || file.startsWith("~/")) { if (!platform.home) return undefined; file = path.join(platform.home, file.slice(1)); }
					const canonical = await canonicalNew(platform, file, cwd);
					return workspaces.some(root => canonical === root || canonical.startsWith(prefix(root))) ? canonical : undefined;
				},
				read: file => platform.readFile(file),
			});
			if (!found.length) return undefined;
			return `Refused: this ${call.tool} call puts ${found.join(", ")} into the repository. Kata refs only resolve in the local tracker, so code, comments, tests, docs and commit messages should describe the behaviour instead. Rewrite it without the ref and retry. To turn this check off, set KATA_REF_GUARD=off.`;
		})(), REF_GUARD_MS);
	}

	// `/todo ref <id>`: makes the Kata issue the plan's parent at once, loading its open children. A plan that already has a parent keeps it.
	function pinRef(ctx: HostContext, ref: string | undefined): Promise<string> {
		if (!ref) return Promise.resolve("/todo ref needs the Kata issue the todo plan serves: /todo ref <project>#<id>.");
		if (!main(ctx)) return Promise.resolve("/todo ref sets the main session's plan parent.");
		return serial(async job => {
			try {
				await enterPlan(job, ctx, false);
				const pinned = await kata.pin(job, ref, path.resolve(ctx.cwd));
				claimed.add(pinned);
				const explicit = configuredRef();
				if (explicit && await kata.pin(job, explicit, path.resolve(ctx.cwd)) !== pinned) return `KATA_REF is set to ${explicit}, which fixes the plan parent; ${ref} is not used.`;
				if (plan.parent) {
					if (!namesPlanParent(plan.parent, aliases, pinned)) return `This plan's parent is ${plan.parent}; it is not changed.`;
					if (!plan.auto) return `${plan.parent} is already this plan's parent.`;
					// Naming the automatic parent makes it explicit: it no longer closes by itself, and the plan keeps it.
					requestedRef = plan.parent;
					await adoptParent(job, plan.parent, ctx);
					persist(job);
					return `${plan.parent} is now this plan's parent, and it will not close automatically.`;
				}
				requestedRef = pinned;
				await adoptParent(job, pinned, ctx);
				persist(job);
				return `${pinned} is now this plan's parent.`;
			} catch (error) {
				debug(error);
				return `/todo ref ${ref} failed: ${(error as Error).message}`;
			}
		}, { ctx });
	}

	async function command(ctx: HostContext, args: string): Promise<string> {
		const match = /^(\S+)?(?:\s+([\s\S]*))?$/.exec(args.trim());
		const sub = match?.[1] ?? "";
		const arg = match?.[2]?.trim() || undefined;
		if (sub === "ref" && options.native) return pinRef(ctx, arg);
		const user = setting("USER") || "user";
		const supported: Record<"" | (typeof TODO_COMMANDS)[number], any> = {
			"": { op: "view" },
			start: { op: "start", task: arg },
			done: { op: "done", task: arg, message: `Marked done by ${user} through /todo in ${namespace}; the user attests the work is complete.`, evidence: [`external:${user}`] },
			drop: { op: "drop", task: arg, message: `dropped by ${user} through /todo` },
			rm: { op: "rm", task: arg, message: `removed by ${user} through /todo` },
			append: { op: "append", items: arg ? [arg] : [] },
			block: { op: "block", reason: arg },
			unblock: { op: "unblock", task: arg },
			// The user takes a task over from a session that crashed, and continues it here.
			takeover: { op: "start", task: arg, takeover: true },
		};
		if (sub !== "" && !(TODO_COMMANDS as readonly string[]).includes(sub)) return `/todo ${sub} is not available with Kata. Use /todo [${TODO_COMMANDS.join("|")}], or kata tui.`;
		const params = supported[sub as keyof typeof supported];
		// A failed command reports its notice alone; the text of a successful one carries the plan.
		const { text, notice, failed } = await todoCall(params, ctx, NO_JOB);
		return failed ? notice : text;
	}

	async function observeToolResult(event: any, ctx: HostContext) {
		progressed = true;
		if (!main(ctx) || event.toolName !== "bash" || event.isError || (event.details?.exitCode !== undefined && event.details.exitCode !== 0)) return;
		const command = event.input?.command;
		if (typeof command !== "string") return;
		const adopting = !configuredRef() && !/[;|\n]/.test(command);
		for (const invocation of kataCommands(path, command, options.executable, options.executableVars)) {
			const parsed = shellOptions(invocation.words), args = parsed.args;
			let ref = args[0] === "claim" ? args[1] : args[0] === "meta" && args[1] === "set" && args[3] === "work.attention" && args[4] === "ok" ? args[2] : undefined;
			if (!ref || parsed.options.has("--as")) continue;
			if (!ref.includes("#") && parsed.value("--project")) ref = `${parsed.value("--project")}#${ref}`;
			const workspace = path.resolve(event.input.cwd || ctx.cwd, parsed.value("--workspace") || ".");
			// A word the shell expands (`$ref`, a glob) names nothing yet; only the shape of a ref counts. A bare id is recorded at once (with the
			// plan's project when the workspace is its own) and replaced by the ref Kata resolves it to, in the background: the hook never waits.
			if (args[0] === "claim" && QUALIFIED_REF_ONLY.test(ref)) claimed.add(ref);
			else if (args[0] === "claim" && SHORT_ID_ONLY.test(ref)) {
				const bare = ref, session = currentId;
				claimed.add(plan.parent && plan.workspace === workspace ? `${projectOf(plan.parent)}#${bare}` : bare);
				void serial(job => kata.pin(job, bare, workspace)).then(pinned => { if (currentId === session) { claimed.delete(bare); claimed.add(pinned); } }).catch(debug);
			}
			if (!adopting) continue;
			const target = ref;
			await bounded(serial(async job => {
				if (plan.tasks.some(t => hasRef(t, target))) return;
				await owned(job, target, workspace);
				await adoptParent(job, target, ctx, workspace);
			}));
		}
	}

	// The end of a lead's turn: reloads the plan and runs the settlement pass, waiting up to TURN_SETTLE_MS while exited
	// delegates are still being handed back. False when the wait ended first (a busy queue, an abort) or `ctx` is no lead's.
	async function settleTurn(ctx: HostContext, signal?: AbortSignal): Promise<boolean> {
		if (!main(ctx)) return false;
		const deadline = Date.now() + TURN_SETTLE_MS;
		// An abort (Esc) ends the wait only; the queued cleanups keep running and are safe to repeat.
		let onAbort: (() => void) | undefined;
		const aborted = new Promise<undefined>(resolve => {
			if (signal?.aborted) return resolve(undefined);
			onAbort = () => resolve(undefined);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
		const until = <T>(promise: Promise<T | undefined>) => Promise.race([promise, aborted]);
		const reload = serial(async job => { await load(job, plan.workspace); await drain(job); return true; });
		let refreshed: boolean | undefined;
		try {
			// Checked after the short bound, not before queuing: a delegate that exited while the queue was busy still counts.
			const pendingAtStop = delegates.cleanupPending();
			refreshed = await until(bounded(reload));
			// A cleanup that finished during the short bound leaves the refresh queued behind it, so what was pending at the stop counts too.
			if (!refreshed && (pendingAtStop || delegates.cleanupPending())) refreshed = await until(bounded(reload, deadline - Date.now()));
			// A delegate that exits during the wait queues its own cleanup after the refresh: wait for those too. Stop when a pass
			// leaves the same cleanups pending (Kata unreachable, a step failing), so an outage does not hold every turn end.
			while (refreshed && !signal?.aborted && delegates.cleanupPending() && Date.now() < deadline) {
				const seen = delegates.pendingIds().join();
				await until(bounded(serial(async job => { await drain(job); return true; }), deadline - Date.now()));
				if (delegates.pendingIds().join() === seen) break;
			}
		} finally { if (onAbort) signal?.removeEventListener("abort", onAbort); }
		return !!refreshed && !signal?.aborted;
	}

	async function remind(messages: any[], ctx: HostContext, signal?: AbortSignal): Promise<string | undefined> {
		if (!await settleTurn(ctx, signal) || plan.error) return;
		const open = plan.tasks.filter(t => (t.status === "pending" || t.status === "in_progress") && !t.holder);
		if (open.length === 0 || reminders >= MAX_REMINDERS || !progressed) return;
		// Do not push past a question the assistant just asked the user.
		const last = [...(messages)].reverse().find((m: any) => m?.role === "assistant");
		if (textOf(last?.content).trim().endsWith("?")) return;
		reminders++;
		progressed = false;
		return [
				"<system-reminder>",
				`Open Kata todo tasks${plan.parent ? ` under ${plan.parent}` : ""} (reminder ${reminders}/${MAX_REMINDERS}):`,
				...open.map(t => `- ${listedName(t)} — ${t.status}`),
				"Continue the work, or update the plan: done with evidence, block with a reason when waiting on someone, or drop with a reason.",
				"If the user asked you to stop or pause, do not continue: block the remaining tasks with that reason and stop.",
				"</system-reminder>",
			].join("\n");
	}

	// The contract is fetched until one arrives non-empty: Kata 0.23.0 sends an empty one outside a `.kata.toml`
	// folder, so a mid-session `kata init` takes effect on the next turn. The inbox is read on every call, and a call
	// waits for a read that began after it was made, so a request sent before a turn reaches that turn. A read slower
	// than the caller's budget keeps running and lands in the cache for the next turn. `inbox: false` leaves the
	// inbox to a caller that keeps it current another way.
	function warm(ctx: HostContext, cwd = ctx.cwd, inbox = true) {
		const job = NO_JOB;
		// Which reads this context gets: the lead's, a delegate's own, or (a non-main context with no record, such as omp's
		// advisor, which shares the lead's session id) the lead's contract and no inbox.
		const record = !main(ctx) ? host.delegateStore.of(ctx) : undefined;
		const folder = path.resolve(cwd);
		const reads = record ? delegateReads : leadReads;
		const key = record ? record.id : leadKey(sid(ctx));
		let entry = reads.get(key);
		// A delegate's entry follows its folder: the assignment may name another than the one its first call used.
		if (!entry || (record && entry.cwd !== folder)) {
			// A delegate working in the lead's folder starts from the lead's contract: that folder's text.
			const leadEntry = leadReads.get(leadKey(currentId));
			reads.set(key, entry = { cwd: folder, contract: record && leadEntry?.cwd === folder ? leadEntry.contract : undefined });
		}
		if (!entry.pending && !entry.contract) {
			entry.pending = (async () => {
				if (!await probe(job, cwd)) return;
				// Exactly these arguments: some Kata builds print nothing for any other form.
				const raw = await kata.run(job, ["agent-contract-hook", "--source", "kata-agent-contract-hook"], cwd, { timeout: 10_000, workspace: false });
				let output: any;
				try { output = JSON.parse(raw); } catch { throw new Error("invalid JSON from kata agent-contract-hook"); }
				const out = output?.hookSpecificOutput?.additionalContext;
				if (typeof out !== "string") throw new Error("unexpected hook output");
				entry.contract = out;
				entry.contractError = undefined;
			})().catch(error => {
				debug(error);
				if (isKataCode(error, "unsupported_version")) { entry.contractError = undefined; return; }
				entry.contractError = ((error as Error)?.message ?? String(error)).split(/\r?\n/)[0].slice(0, 160);
			}).finally(() => { entry.pending = undefined; });
		}
		const user = setting("KATA_INBOX_USER");
		let inboxRead: Promise<void> | undefined;
		if (!main(ctx)) {
			// A delegate reads its own session inbox, <actor>/<teammate>, and only when the lead opted in with one; with no record
			// it reads none, and never the lead's. A pi child's own process already holds its address in KATA_INBOX_USER.
			if (record && inbox && user && isSessionAddress(user)) {
				const own = user.endsWith(`/${record.teammate}`);
				inboxRead = readInbox(entry, job, cwd, delegates.assignment(ctx)?.ref, mine => own ? user : `${mine}/${record.teammate}`);
			}
		} else if (user && !isSessionAddress(user)) {
			// A bare actor is a person's own inbox (requests written for them, read by kata inbox and tern-kata's
			// Attention Page), never instructions for this session. Only <actor>/<teammate> is a session inbox.
			if (!entry.personInbox) {
				entry.personInbox = true;
				uiOf(ctx)?.notify?.(`KATA_INBOX_USER=${user} is a personal inbox, so this session reads none. Use ${user}/<name> for a session inbox.`, "warning");
			}
		} else if (inbox && user) {
			inboxRead = readInbox(entry, job, cwd, undefined, () => user);
		}
		const done = Promise.all([entry.pending, inboxRead]).then(() => undefined);
		return { entry, record, showsInbox: main(ctx) || !!record, done };
	}

	// Only requests from the session's own actor reach the prompt. A failed read (or actor lookup) keeps the last inbox;
	// no trusted request removes the section. `ref` picks the actor's project; `addressFor` names the inbox from that actor.
	function readInbox(entry: PromptReads, job: Job, cwd: string, ref: string | undefined, addressFor: (actor: string) => string): Promise<void> {
		const read = (): Promise<void> => {
			const running: Promise<void> = (async () => {
				const mine = await actor(job, cwd, ref);
				const address = entry.address = addressFor(mine);
				const out = JSON.parse(await kata.run(job, ["inbox", "--for", address], cwd));
				entry.inbox = trustedInbox(out?.requests, mine, address);
			})().catch(debug).finally(() => { if (entry.inboxPending === running) entry.inboxPending = undefined; });
			return entry.inboxPending = running;
		};
		// A read already running may have begun before a request this call must show, so one more read follows it,
		// shared by every call made meanwhile.
		return !entry.inboxPending ? read() : entry.inboxNext ??= entry.inboxPending.then(() => { entry.inboxNext = undefined; return read(); });
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
	function startFollower(ctx: HostContext, address: string) {
		const job = NO_JOB, cwd = path.resolve(ctx.cwd), live = host.liveInbox!;
		follower = createInboxFollower({
			address,
			actor: () => actor(job, cwd),
			read: async () => JSON.parse(await kata.run(job, ["inbox", "--for", address], cwd)),
			spawn: cursor => live.spawn([options.executable, "events", "--tail", "--json", "--workspace", cwd, ...(cursor ? ["--last-event-id", String(cursor)] : [])], cwd),
			deliver: text => { try { Promise.resolve(live.deliver(text)).catch(debug); } catch (error) { debug(error); } },
			publish: text => { liveInbox = text; },
			head: () => knownProjectHead(cwd, args => kata.run(job, args, cwd), platform.env.get("KATA_HOME")),
			now: () => performance.now(),
			setTimer: (fn, ms) => platform.setTimer(fn, ms),
			clearTimer: handle => platform.clearTimer(handle),
			debug,
		});
		follower.start();
	}

	// --------------------------------------------------------------- attention

	// Kata owns session attention semantics; the harness name only selects payload parsing and the session token.
	// `attended`: refs this session started attention for after it began (a ticket the lead claimed, named with `/todo ref` or marked with
	// `kata meta set ... work.attention ok`, and the explicit parent a fork or resume restored), with the workspace and the attention sessions
	// to end them under: this session's, and every earlier one that may still hold the ref because a start for a restored parent may not have applied.
	// Each stays until the session ends or switches: Kata's end flags a ticket still on `ok`, and does nothing to a closed one.
	type Attended = Map<string, { cwd: string; sessions: Set<string> }>;
	let attentionSession: { id: string; cwd: string; ref?: string; hostCwd: string; hostRef?: string; marker?: string; attended: Attended } | undefined;
	const logSkip = (error: unknown) => debug(`Kata attention skipped: ${(error as Error).message}`);
	const attentionHook = (job: Job, mode: "start" | "end", sessionId: string, ref: string, cwd: string) =>
		kata.run(job, ["agent-hook", "attention-native", options.attentionHarness!, mode, "--session", sessionId, "--host-pid", String(platform.pid), "--ref", ref], cwd, { timeout: mode === "start" ? 3000 : 1500 });
	// Kata ends only what the given attention session holds, so no ownership check is needed here. Together, not one by one: omp gives a shutdown handler 2 s.
	async function endAttended(job: Job, session: NonNullable<typeof attentionSession>) {
		await Promise.all([...session.attended].flatMap(([ref, { cwd, sessions }]) => [...sessions].map(id => attentionHook(job, "end", id, ref, cwd).catch(logSkip))));
		session.attended.clear();
	}
	// Starts attention for the plan's explicit parent; true when the start may not have applied: a failure, including a timeout after Kata wrote ok. Kata's start would reset any `stuck` or `needs-human`
	// to ok, Kata's own session-ended flag included, so those issues are skipped; `kata meta set <ref> work.attention ok` clears the flag and
	// starts attention. A repeat start with the same attention session changes nothing.
	async function startParentAttention(job: Job): Promise<boolean> {
		const session = attentionSession, parent = plan.parent;
		if (!session || !options.attentionHarness || configuredRef() || !parent || plan.auto) return false;
		try {
			const flag = (await owned(job, parent, plan.workspace)).metadata?.["work.attention"];
			if (flag === "stuck" || flag === "needs-human") return false;
			// Recorded first: a start that times out after Kata wrote ok must still be ended.
			const held = session.attended.get(parent) ?? { cwd: plan.workspace, sessions: new Set<string>() };
			held.sessions.add(session.id); session.attended.set(parent, held);
			await attentionHook(job, "start", session.id, parent, plan.workspace);
			return false;
		} catch (err) {
			logSkip(err);
			return true;
		}
	}
	const adoptParent = async (job: Job, ref: string, ctx: HostContext, workspace?: string) => { await adopt(job, ref, ctx, workspace); await startParentAttention(job); };
	async function attention(job: Job, mode: "start" | "end", session: NonNullable<typeof attentionSession>) {
		const ref = session.ref;
		if (!ref || !options.attentionHarness) return;
		try {
			// The native hook guards revisions, not the actor or teammate.
			await owned(job, ref, session.cwd);
			await attentionHook(job, mode, session.id, ref, session.cwd);
			if (mode === "start" && session.hostRef) {
				const route = JSON.parse(await kata.run(job, ["daemon", "locate"], session.hostCwd, { timeout: 1500 }));
				const daemon = route.request_base_url || route.address;
				if (typeof daemon === "string" && daemon) {
					const identity = JSON.stringify({ ref: session.hostRef.trim(), daemon, cwd: session.hostCwd });
					platform.env.set("KATA_ATTENTION_HOST", session.marker = JSON.stringify({ pid: platform.pid, identity }));
				}
			}
		} catch (err) {
			logSkip(err);
		} finally {
			if (mode === "end" && session.marker && platform.env.get("KATA_ATTENTION_HOST") === session.marker) platform.env.set("KATA_ATTENTION_HOST", undefined);
		}
	}

	// -------------------------------------------------------------- the host

	const lead = (): Lead => ({ parent: plan.parent, workspace: plan.workspace, label: plan.label });
	// The lead stays attached to the main context: a sub identity can reach a main-session handler (omp's advisor).
	const see = (ctx: HostContext) => { if (main(ctx) || !currentCtx || !main(currentCtx)) currentCtx = ctx; };
	const rebind = async (ctx: HostContext): Promise<Lead> => {
		see(ctx);
		if (main(ctx)) await bounded(serial(job => enter(job, ctx)));
		return lead();
	};
	const warmFor = (ctx: HostContext, inbox = true) => warm(ctx, delegates.assignment(ctx)?.workspace || ctx.cwd, inbox && !(main(ctx) && liveInbox !== undefined));
	const prefetch = (ctx: HostContext) => { if (options.prefetch) void warmFor(ctx); };

	// A pi child that starts before its lead planned (a session-start extension can spawn it) finds the lead's automatic parent, or
	// makes it in the lead's name. It establishes the parent's identity only: the lead's work.* is never the child's to write.
	async function establishParent(parent: ChildParent): Promise<void> {
		const job = NO_JOB, workspace = parent.workspace;
		await serial(async job => { await probe(job, workspace); });
		const found = await automaticParentOf(job, parent.sessionId, workspace);
		if (found) { parent.ref = found.parent; return; }
		const where = await destination(job, workspace);
		parent.label ??= where.label;
		const created = await createAutomaticParent(job, parent.sessionId, "Todo plan: tasks", where, workspace, parent.teammate);
		parent.ref = created.ref;
		if (!created.issue.owner) await kata.run(job, ["claim", created.ref, "--if-unowned", "--teammate", parent.teammate], workspace);
		await markAutomaticParent(job, created.ref, workspace, (await kata.show(job, created.ref, workspace)).issue, false);
	}

	// A pi child joins the session that started it: its identity, its parent (found or created in the lead's name) and its assignment.
	// Fills in `parent.ref` and `parent.label`, and sets KATA_TEAMMATE and KATA_INBOX_USER for every later Kata call, bash included.
	async function join(ctx: any, parent: ChildParent, prompt: string): Promise<void> {
		const job = NO_JOB;
		const known = host.delegateStore.of(ctx);
		if (known) {
			platform.env.set("KATA_TEAMMATE", known.teammate);
			platform.env.set("KATA_INBOX_USER", `${await actor(job, known.binding?.workspace ?? parent.workspace, known.ref ?? parent.ref)}/${known.teammate}`);
			// The child runs again as the delegate its session saved: on what that record holds, or anew when it holds nothing.
			await delegates.apply({ type: "started", id: known.id, sessionId: known.sessionId, leadSessionId: known.leadSessionId, leadTeammate: known.leadTeammate, teammate: known.teammate, text: prompt,
				name: known.name, parent: known.parent, workspace: known.workspace, parentLabel: known.parentLabel, refused: known.refused }, NO_JOB);
			if (currentId !== sid(ctx)) await bounded(serial(job => bind(job, ctx)), DELEGATE_BIND_MS);
			return;
		}
		const id = sid(ctx);
		if (!id) throw new Error("Pi child needs a real session identity before tracking work.");
		if (!parent.ref) await establishParent(parent);
		if (!parent.ref) throw new Error("Pi child parent identity is unavailable.");
		// The lead may have moved the parent since it exported its marker: the child's issue goes where the parent lives now.
		const binding: Binding = { parent: await kata.pin(job, parent.ref, parent.workspace), workspace: parent.workspace, sessionId: parent.sessionId, auto: false, label: parent.label };
		// Keep a teammate the lead chose for this child; otherwise derive a distinct one from its name, known once it is matched.
		const chosen = setting("KATA_TEAMMATE") || "";
		const kept = chosen && chosen !== parent.teammate && chosen !== parent.via && CHILD_TEAMMATE.test(chosen) ? chosen : undefined;
		const salt = `${parent.teammate || namespace}:${parent.sessionId}:${id}`;
		// Matching reads which issues already carry this child's teammate: none yet, so any unused value matches the same.
		const delegateScope = { parent: binding.parent, workspace: binding.workspace, label: binding.label, leadTeammate: parent.teammate, teammate: kept ?? teammateFor(salt), leadSession: parent.sessionId };
		// A prompt the assignment rules refuse is untracked and makes no mission: its report goes on the tickets or plan items it
		// named, when it named several, and nowhere for a conflict (a taken or held task). A check Kata could not run decides
		// nothing: the child starts undecided and its next use decides it. Any other failure leaves it untracked.
		let reserved: Reservation | undefined, untracked = false, refused: Refused | undefined;
		try { reserved = (await delegates.check([prompt], id, delegateScope, NO_JOB))[0]; }
		catch (error) { debug(error); if (error instanceof Refusal) refused = { targets: error.targets }; else if (!isUnusable(error)) untracked = true; }
		const name = childName(host.getSessionName?.(), reserved, id);
		const teammate = kept ?? teammateFor(name, salt);
		platform.env.set("KATA_TEAMMATE", teammate);
		platform.env.set("KATA_INBOX_USER", `${await actor(job, binding.workspace, binding.parent)}/${teammate}`);
		await delegates.apply({ type: "started", id, sessionId: id, leadSessionId: parent.sessionId, leadTeammate: parent.teammate, teammate, text: prompt,
			name, parent: binding.parent, workspace: binding.workspace, parentLabel: binding.label, call: id, untracked, refused }, NO_JOB);
		if (currentId !== sid(ctx)) await bounded(serial(job => bind(job, ctx)), DELEGATE_BIND_MS);
	}

	const owing = () => settlement.owes() || delegates.owes();

	// The session ended: a lead's work in Kata is left as it stands, a delegate's exit is reported.
	// A delegate that ends with its session passes `delegate`; `ended` makes this call report its exit, after its `report`.
	// `continues`: this shutdown does not end the lead's work (pi's reload: the same session goes on), so it keeps its tasks.
	// `forking`: a fork replaces this session in a new instance (pi's /fork into a saved session); the tasks are left for it.
	async function shutdown(ctx: HostContext, closing: { delegate?: { id: string; ended: boolean; report?: string }; continues?: boolean; forking?: boolean } = {}): Promise<void> {
		see(ctx);
		// A delegate's reads live in its own core (the lead's core never holds them) and go when its own session ends.
		if (!main(ctx)) { const own = host.delegateStore.of(ctx); if (own) delegateReads.delete(own.id); }
		if (!main(ctx) && !closing.delegate) return;
		stopFollower();
		// Left for the fork before the bounded work: pi starts the fork's instance once this shutdown returns or times out.
		const forking = main(ctx) && closing.forking ? leaving() : undefined;
		if (forking) forkSources.set(forking.session, forking);
		await bounded((async () => {
			await serial(async job => {
				const session = attentionSession;
				attentionSession = undefined;
				await load(job, plan.workspace).catch(debug);
				const ends = main(ctx) && !closing.continues && !closing.forking;
				// A pi child that started before this lead had a plan made the session's automatic parent itself (see join),
				// and may have left missions under it: an ending lead with no plan binds that parent, so its close is audited.
				if (ends && !plan.parent && !plan.local) {
					const found = await probe(job, ctx.cwd).then(up => up ? sessionBinding(job, ctx) : undefined).catch(error => { debug(error); return undefined; });
					if (found) { setParent(found); await load(job, found.workspace).catch(debug); }
				}
				await sweep(job, options.closeParent !== "shutdown" || ends);
				const ending = ends ? leaving() : undefined;
				if (session) { await attention(job, "end", session); await endAttended(job, session); }
				await moveMarks(job, ending, undefined);
			});
			if (closing.delegate?.report) await delegates.apply({ type: "reported", id: closing.delegate.id, text: closing.delegate.report }, NO_JOB);
			if (closing.delegate?.ended) await delegates.apply({ type: "exited", id: closing.delegate.id, outcome: "ended" }, NO_JOB);
		})(), closing.delegate ? DELEGATE_SHUTDOWN_MS : SHUTDOWN_BOUND_MS);
	}

	const completion = createTicketCompletion(kata, () => ({ session: currentId, cwd: path.resolve(currentCtx?.cwd ?? platform.cwd()), defaultProject: setting("KATA_DEFAULT_PROJECT") }), debug, platform);

	return {
		session: {
			// The session began or switched: bind the plan, follow the inbox live when the host can, start attention.
			// `after` is host work (a delegate's assignment retry) the first context read waits for.
			// `child`: the workspace of a pi child still to join its parent; when Kata does not answer there, nothing starts and the result is undefined: the host runs the session as a main session and starts it again.
			// `forked`: this session is a fork that replaces its source in this process (pi's /fork); it inherits the source's tasks.
			// `wait`: how long the start waits for the bind (default 250 ms; an explicit ref on a host with an attention harness waits for the attention start instead).
			async start(ctx: HostContext, begin: { after?: Promise<unknown>; child?: string; forked?: boolean; wait?: number } = {}): Promise<Lead | undefined> {
				if (!main(ctx)) {
					if (begin.child !== undefined && !await probe(NO_JOB, begin.child)) return undefined;
					see(ctx);
					void Promise.resolve(begin.after).then(() => prefetch(ctx)).catch(debug);
					return lead();
				}
				see(ctx);
				const explicit = configuredRef(), id = sid(ctx);
				stopFollower();
				// The reads of the session this one replaces go.
				for (const other of [...leadReads.keys()]) if (other !== leadKey(id)) leadReads.delete(other);
				const user = setting("KATA_INBOX_USER");
				const live = !!host.liveInbox && !!user && isSessionAddress(user);
				if (live) liveInbox = "";
				prefetch(ctx);
				if (live) startFollower(ctx, user!);
				const switching = serial(job => enterSession(job, ctx, begin));
				// OMP snapshots the bash environment after this handler returns.
				await bounded(switching, explicit && options.attentionHarness && id ? ATTENTION_START_MS : begin.wait);
				return lead();
			},
			branch: rebind,
			tree: rebind,
			input() { reminders = 0; },
			// Whether the session still owes Kata closes: a pending close, a delegate still to settle, or an automatic parent's close the
			// last audit still means to make. A parent it left open on purpose (flagged for a person) is not owed.
			owes: owing,
			// The lead's turn ended: exited delegates are handed back and due closes retried, with the wait `stop` has. For a host
			// that wants no reminder: none is built, and none is counted.
			async settle(ctx: HostContext, signal?: AbortSignal): Promise<void> {
				see(ctx);
				await settleTurn(ctx, signal);
			},
			stop(ctx: HostContext, messages: any[], signal?: AbortSignal): Promise<string | undefined> {
				see(ctx);
				return remind(messages, ctx, signal);
			},
			// The session ended for good on a host that keeps sessions (deleted, archived): the shutdown of an ending lead. True while
			// it still owes closes (see `owes`): the host keeps what the session saved and ends it again once they can be made.
			async end(ctx: HostContext): Promise<boolean> {
				await shutdown(ctx);
				return owing();
			},
			shutdown,
			// What the next prompt carries. `context: false` leaves the contract and inbox to another extension; `inbox: false` says the host shows a delegate no inbox section, so none is read nor named.
			async beforePrompt(ctx: HostContext, prompt: { after?: Promise<unknown>; context?: boolean; inbox?: boolean } = {}): Promise<{ sections: PromptSections; lead: Lead }> {
				see(ctx);
				const context = prompt.context !== false;
				// A delegate cannot learn its assignment later, so its prompt waits for it (`after`) up to DELEGATE_BIND_MS. The
				// contract and inbox reads keep their usual budget; a slower read lands in the cache for the next turn.
				if (!main(ctx)) await bounded(Promise.resolve(prompt.after), DELEGATE_BIND_MS);
				const turnReads = context ? warmFor(ctx, prompt.inbox !== false) : undefined;
				await bounded(Promise.all([
					main(ctx) && currentId !== sid(ctx) ? serial(job => enter(job, ctx)) : undefined,
					turnReads?.done,
				]), main(ctx) ? 250 : DELEGATE_PROMPT_MS);
				const sections: PromptSections = {};
				if (turnReads) {
					const { entry } = turnReads;
					if (entry.contract) sections.contract = entry.contract;
					else if (entry.contractError) {
						sections.contract = `Kata contract is unavailable (${entry.contractError}). Run \`kata quickstart --format contract\` before using kata.`;
						const ui = uiOf(ctx);
						if (!entry.contractWarned && ui?.notify) {
							entry.contractWarned = true;
							ui.notify(`Kata contract is unavailable (${entry.contractError}). The plugin will retry on the next prompt.`, "warning");
						}
					}
					const inbox = main(ctx) && liveInbox !== undefined ? liveInbox : entry.inbox;
					if (inbox && turnReads.showsInbox) sections.inbox = inbox;
				}
				const record = turnReads?.record ?? (!main(ctx) && !context ? host.delegateStore.of(ctx) : undefined);
				const assigned = record ? delegates.assignment(ctx) : undefined;
				// Known once the inbox read resolved it; a read still running leaves the line out.
				const inboxAddress = record ? turnReads?.entry.address : undefined;
				if (record && assigned) sections.assignment = delegateContext(options.executable, nameOf(record), assigned.ref, assigned.teammate, assigned.binding, inboxAddress);
				else if (isUntracked(record)) sections.assignment = untrackedDelegateContext(nameOf(record), inboxAddress);
				if (options.native) sections.todo = plan.parent || plan.local || plan.tasks.some(t => t.ticket) ? `${NATIVE_TODO_RULES}\nCurrent plan (refs in parentheses):\n${render(plan, wording)}` : NATIVE_TODO_RULES;
				else if (plan.parent || plan.tasks.some(t => t.ticket)) sections.todo = `The ${wording.tool} tool is backed by Kata. Current plan:\n${render(plan, wording)}`;
				return { sections, lead: lead() };
			},
		},
		tools: {
			// A tool is about to run. `startsChild`: it may start an agent that inherits this session's plan parent, so the parent is established first.
			async call(ctx: HostContext, call: { startsChild?: boolean } = {}): Promise<Lead> {
				see(ctx);
				if (call.startsChild && main(ctx)) await serial(async job => { await ensureParent(job, {}, ctx); });
				return lead();
			},
			// A tool finished: a `kata claim` the agent ran adopts its issue as the plan parent.
			async result(ctx: HostContext, event: { toolName: string; isError?: boolean; input?: any; details?: any }): Promise<Lead> {
				see(ctx);
				await observeToolResult(event, ctx);
				return lead();
			},
			// A tool is about to run: the text that refuses it for putting a Kata ref into the repository, or undefined (see `refGuard`).
			guard: refGuard,
			// The refs this session works, for a delegate's host that checks calls against its lead's.
			refs: (ctx: HostContext): string[] => [...knownRefs(ctx)],
		},
		todo: {
			apply: (ctx: HostContext, op: string, params: any, within: Job) => execute({ ...params, op }, ctx, within),
			// Runs `fn` as one job of this session: the todo calls and delegate checks `fn` makes run in it one after another, share
			// its Kata reads until a write, and no delegate event, timer or other call runs between them. For a host whose one tool
			// call is several todo calls (OpenCode's todowrite).
			batch,
			command,
			mirror,
			guard,
		},
		delegates: {
			apply: delegates.apply,
			start: delegates.start,
			assignment: delegates.assignment,
			check: delegates.check,
			release: delegates.release,
			join,
		},
		// `offerTickets` adds `#` ticket completion to the editor of the current session, once per editor; `suggestTickets` is the
		// completion for a line a host draws the menu of itself.
		offerTickets: completion.offer,
		suggestTickets: completion.suggest,
	};
}

// What a batch's function is given: pass it to the todo calls and delegate checks that are to run in the batch.
export type { Job };
