import { createHash } from "node:crypto";
import path from "node:path";
import { appendFileSync, realpathSync } from "node:fs";
import { decidePlanParent, explicitParent, isExplicitParent, namesPlanParent } from "./plan-parent";
import { createInboxFollower, knownProjectHead, trustedInbox, type InboxFollower, type LiveInbox } from "./inbox";
import { createDelegates, heldByDelegate as heldBy, type DelegateAssignment, type DelegateRecord, type DelegateStore, type Reservation, type Spawn, type Who } from "./delegates";
import { createSettlement, MAX_FAILURES, openChildren, type CloseRequest, type PendingClose } from "./settlement";

// Canonical shared source. scripts/vendor-core.ts copies this file into each
// self-contained plugin; host adapters own their event/schema/identity APIs.

function createdParentRef(out: any): string {
	const event = out.event ?? out.original_event;
	if (!out.issue?.short_id || !event?.project_name) throw new Error("kata create returned no parent identity");
	return `${event.project_name}#${out.issue.short_id}`;
}

// An issue's qualified ref: Kata's own `qualified_id`, else `<parent's project>#<short_id>`.
export function qualifiedRef(issue: { qualified_id?: string; short_id: string }, parent: string): string {
	return issue.qualified_id || `${parent.split("#")[0]}#${issue.short_id}`;
}

export interface CoreHost {
	// `ctx` is the context of the event the call serves, for a host that spawns differently per agent (omp's transcript identity).
	exec(file: string, args: string[], options: { cwd: string; timeout: number; ctx?: any }): Promise<{ code: number; stdout: string; stderr?: string; killed?: boolean }>;
	appendEntry(type: string, data: unknown): void;
	getSessionName?(): string | undefined;
	isMain?(ctx: any): boolean;
	allowUI?(ctx: any): boolean;
	// The core serves one session for the process's life (a pi child), so an assigned delegate may bind it. A shared core (omp) stays bound to the lead.
	// Where delegate records live. Default: in memory, found by the delegate's session id.
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

export type Status = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";
export type Task = { ref: string; content: string; phase: string; status: Status; ticket?: string; at?: number; blocker?: string; delegated?: boolean; review?: boolean; revision?: number; proof?: { message?: string; evidence?: string[] } };
export type Binding = { parent: string; workspace: string; sessionId?: string; auto?: boolean; label?: string };
export type Plan = Partial<Binding> & { workspace: string; tasks: Task[]; local?: boolean; error?: string };
export type Change = { message?: string; evidence?: string[]; reason?: string; many?: boolean; remove?: boolean };
export function sessionKey(file: string, cwd: string): string {
	const absolute = path.resolve(cwd, file);
	try { return realpathSync(absolute); }
	catch { try { return path.join(realpathSync(path.dirname(absolute)), path.basename(absolute)); } catch { return absolute; } }
}

// Valid for Kata labels and safe inside a project#id ref.
export function slug(text: string | undefined, keepCase = false): string | undefined {
	const value = (keepCase ? text ?? "" : (text ?? "").toLowerCase()).replace(keepCase ? /[^A-Za-z0-9._-]+/g : /[^a-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "").slice(0, 64).replace(/[-._]+$/, "");
	return value || undefined;
}
// A failed Kata call. Kata's own error envelope (`--json`: {error:{kind,code,
// hint,message,exit_code,data}}) and its documented exit code are kept so callers
// branch on them, never on message wording.
export class KataError extends Error {
	constructor(message: string, readonly info: {
		exit: number;
		code?: string; // the envelope's error code, e.g. project_not_initialized
		detail?: string; // Kata's own message
		data?: Record<string, unknown>; // the envelope's structured data, e.g. {alias} or {project} on project_not_initialized
		killed?: boolean; // our timeout killed it
		notRun?: boolean; // Kata never ran: missing executable
	}) { super(message); }
	get code() { return this.info.code; }
	// Kata cannot serve requests: not runnable, timed out, or daemon unreachable (exit 7).
	get unusable() { return Boolean(this.info.notRun || this.info.killed || this.info.code === "daemon_unavailable" || this.info.exit === 7); }
}
export const isUnusable = (error: unknown) => error instanceof KataError && error.unusable;
export const isKataCode = (error: unknown, code: string) => error instanceof KataError && error.code === code;

// The workspace name Kata would infer, read from the project_not_initialized
// error's structured data: the project it names, else its alias ("local://" and
// ".git" dropped, last segment kept), else the folder.
export function inferredName(data: Record<string, unknown> | undefined, cwd: string): string {
	const text = (value: unknown) => typeof value === "string" && value ? value : undefined;
	const alias = text(data?.alias)?.replace(/^local:\/\//, "").replace(/\/+$/, "").split("/").pop();
	return slug((text(data?.project) ?? alias ?? path.basename(path.resolve(cwd))).replace(/\.git$/, ""), true) ?? slug(path.basename(path.resolve(cwd)), true) ?? "workspace";
}

export function quote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }

// `<actor>/<teammate>` with both parts non-empty is a session inbox; anything else is a person's.
const isSessionAddress = (address: string) => /^[^/]+\/[^/]/.test(address);

export const OPEN: ReadonlySet<Status> = new Set(["pending", "in_progress", "blocked"]);
const WORKING: ReadonlySet<Status> = new Set(["in_progress", "blocked"]);
const MARK: Record<Status, string> = { pending: "[ ]", in_progress: "[/]", completed: "[x]", abandoned: "[~]", blocked: "[!]" };
// A plan item's identity: init keeps, refuses and closes by this same key.
const itemKey = (item: { phase: string; content: string }) => `${item.phase}\u0000${item.content}`;

// How long a main session's shutdown waits for Kata before the host may exit: closing an automatic parent takes six or more spawns, and an exit mid-way leaves the parent open.
const SHUTDOWN_BOUND_MS = 10_000;

export const DESCRIPTION = `Track multi-step work as a todo list stored in Kata. Tasks are identified by verbatim content (or Kata ref), NEVER generated IDs. Unique, stable task/phase names; lost text: view, NEVER guess.
Before work, init for 3+ steps, requested task sets, or new instructions. MUST list EVERY user item separately; NEVER omit or remember leftovers.
After each change: with no active task the earliest pending starts (phase order). Blocked NEVER starts automatically; unblock returns pending. Mark done immediately; follow phase order.
External waits (user/agent/service): block with a reason; it suppresses the stop reminder and starts the next pending task.
NEVER call todo alone: init with first work; done/start with next action.

Kata specifics:
- An item that works an existing ticket starts with its qualified ref: \`<project>#<short_id>: <action>\` (for example \`myproj#a1b2: write the smoke script\`). It creates no issue: start claims the ticket and marks it in progress, done comments on it, and the last item of a ticket to be done closes it with that item's evidence (a ticket with open children stays open and gets a comment), drop/rm only comment and never close it. A ref that does not resolve, or a closed ticket, is an error. Only that prefix names a ticket; a bare id is text. A plan whose items all name tickets creates no parent issue.
- Every other task is a Kata child issue of one parent issue. On init pass \`ref\` with the Kata issue this plan serves (search first: kata search "<terms>" --agent); an explicit KATA_REF or worker binding must match it. Without a ref, use that binding, the session's existing parent, or a new parent titled by \`message\`.
- done closes the issue (an item naming a ticket: see above). Kata requires \`evidence\` (commit:<sha>, test:<cmd>, pr:<url>, reviewed-paths:<path>) and a \`message\` of 40+ characters saying what changed and how it was verified. Unverified work: block it instead.
- init whose new list leaves out open tasks changes nothing and returns an error listing the missing ones; pass \`replace: true\` only to deliberately drop them (they close as wontfix).
- drop/rm take the reason in \`message\`.
- drop and rm close those tasks as wontfix (Kata never deletes). Automatic session parents close from their children’s Kata-recorded evidence once all work has settled. Explicit/claimed parents remain yours to close. Folders with no Kata project use KATA_DEFAULT_PROJECT (labeled with the repo) or register their inferred project; the plan is session-local only while Kata is unreachable and replays when it returns.`;

export function digest(...parts: string[]): string {
	return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24);
}

type ShellWord = { value: string; start: number; end: number };
// Inspect command positions only. Quoted arguments and heredoc bodies are data;
// this lexer never infers whether a test/commit command proves completion.
export function kataCommands(command: string, configuredExecutable = "kata", executableVars: readonly string[] = []): { executable: ShellWord; words: ShellWord[] }[] {
	const segments: ShellWord[][] = [[]];
	let i = 0, heredoc: string | undefined, wantDelimiter = false;
	while (i < command.length) {
		if (command[i] === "\n" && heredoc) {
			const end = command.indexOf(`\n${heredoc}`, i);
			if (end < 0) break;
			i = command.indexOf("\n", end + 1);
			if (i < 0) break;
			heredoc = undefined;
		}
		if (/\s/.test(command[i])) { if (command[i] === "\n") segments.push([]); i++; continue; }
		if (command[i] === "#") { const end = command.indexOf("\n", i); if (end < 0) break; i = end; continue; }
		if (";&|()".includes(command[i])) { segments.push([]); i++; continue; }
		if (command.slice(i, i + 2) === "<<") { i += command[i + 2] === "-" ? 3 : 2; wantDelimiter = true; continue; }
		const start = i;
		let value = "", quote = "";
		while (i < command.length) {
			const char = command[i];
			if (!quote && /[\s;&|()]/.test(char)) break;
			if (char === "\\" && quote !== "'") { value += command[i + 1] || ""; i += 2; continue; }
			if (char === quote) { quote = ""; i++; continue; }
			if (!quote && (char === "'" || char === '"')) { quote = char; i++; continue; }
			value += char; i++;
		}
		if (wantDelimiter) { heredoc = value; wantDelimiter = false; continue; }
		segments.at(-1)!.push({ value, start, end: i });
	}
	const commands: { executable: ShellWord; words: ShellWord[] }[] = [];
	for (const segment of segments) {
		let j = 0;
		while (j < segment.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[j].value) || ["if", "then", "elif", "do", "else", "!", "command", "env", "time"].includes(segment[j].value))) j++;
		const executable = segment[j];
		if (executable && (path.basename(executable.value) === "kata" || executable.value === configuredExecutable || executableVars.some(name => executable.value === `$${name}` || executable.value === `\${${name}}`))) commands.push({ executable, words: segment.slice(j + 1) });
	}
	return commands;
}

const VALUE_OPTIONS = new Set(["--body", "--body-file", "--message", "-m", "--comment", "--evidence", "--test", "--commit", "--pr", "--reviewed", "--reason", "--idempotency-key", "--parent", "--related", "--blocked-by", "--blocks", "--meta", "--owner", "--label", "--priority", "--if-match", "--if-value", "--workspace", "--project", "--teammate", "--as", "--for", "--format", "--daemon"]);
export function shellOptions(words: ShellWord[]) {
	const options = new Map<string, ShellWord[]>(), occurrences = new Map<string, ShellWord[][]>(), args: string[] = [];
	for (let i = 0; i < words.length; i++) {
		const word = words[i];
		if (word.value === "--") { args.push(...words.slice(i + 1).map(w => w.value)); break; }
		const flag = word.value.split("=")[0];
		if (word.value.startsWith("-")) {
			if (VALUE_OPTIONS.has(flag) && !word.value.includes("=") && words[i + 1]) options.set(flag, [word, words[++i]]);
			else options.set(flag, [word]);
			occurrences.set(flag, [...(occurrences.get(flag) || []), options.get(flag)!]);
		} else args.push(word.value);
	}
	const value = (key: string) => { const pair = options.get(key); return pair?.[1]?.value ?? pair?.[0]?.value.slice(key.length + 1); };
	return { options, occurrences, args, value };
}


// The salt (a session id) keeps reused agent names distinct across sessions.
export function teammateFor(id: string, salt?: string): string {
	const base = id.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^[^a-z0-9]+/, "") || "agent";
	return `${base.slice(0, 57)}-${digest(salt ? `${salt}:${id}` : id).slice(0, 6)}`;
}

export function delegateCommand(command: string, executable: string, executableVars: readonly string[], teammate: string, binding?: Binding, transcriptSession?: { agent: string; id: string }): string {
	const edits: { start: number; end: number; value: string }[] = [];
	for (const invocation of kataCommands(command, executable, executableVars)) {
		const parsed = shellOptions(invocation.words);
		if (parsed.options.has("--as")) throw new Error("Kata subagents keep the current actor. Use your assigned --teammate; --as is not permitted.");
		for (const previous of parsed.occurrences.get("--teammate") ?? []) edits.push({ start: previous[0].start, end: previous.at(-1)!.end, value: "" });
		let flags = ` --teammate ${quote(teammate)}`;
		if (binding) {
			if (!parsed.options.has("--workspace")) flags += ` --workspace ${quote(binding.workspace)}`;
			if (!parsed.options.has("--project")) flags += ` --project ${quote(binding.parent.split("#")[0])}`;
		}
		edits.push({ start: invocation.executable.end, end: invocation.executable.end, value: flags });
		// An in-process delegate has its own session; without this its close would record the lead's.
		if (transcriptSession && parsed.args[0] === "close") edits.push({ start: invocation.executable.start, end: invocation.executable.start, value: `env KATA_TRANSCRIPT_AGENT=${quote(transcriptSession.agent)} KATA_TRANSCRIPT_SESSION_ID=${quote(transcriptSession.id)} ` });
	}
	for (const edit of edits.sort((a, b) => b.start - a.start)) command = command.slice(0, edit.start) + edit.value + command.slice(edit.end);
	return command;
}

function delegateContext(executable: string, id: string, ref: string, teammate: string, binding: Binding): string {
	const command = `${quote(executable)} --workspace ${quote(binding.workspace)} --project ${quote(binding.parent.split("#")[0])} --teammate ${quote(teammate)}`;
	return `You are subagent ${id}. Your Kata issue is ${ref}; your teammate is ${teammate}. Keep the existing actor and use this issue instead of inherited KATA_REF. Track attention on your own issue. When verified, YOU must run: ${command} close ${quote(ref)} --done --message '<describe this task and its verification in at least 40 characters>' --evidence '<typed evidence for your actual verification>'. If unfinished, leave it open and explain what remains.`;
}

// A delegate that matched no plan item and named no ticket has no issue. Its
// binding says so instead of sending it to one: the lead tracks the work.
function untrackedDelegateContext(id: string): string {
	return `You are subagent ${id}. The lead session tracks this work and you have no Kata issue. Do not create, claim, close, comment on or edit Kata issues, including one named by an inherited KATA_REF. Reading Kata is fine. Report your results in your reply.`;
}

// Kata's qualified ref `<project>#<short_id>`. A short_id is 4 to 26 lowercase
// Crockford base32 characters (no i, l, o, u); a project name is one token of
// word characters, dots and dashes (Kata allows more, but a token that can be
// told apart in prose needs no spaces). The source is anchored by lookarounds
// only, so the one source parses a strict prefix (`itemTicket`) and scans text
// for whole-token refs (`qualifiedRefs`).
const QUALIFIED_REF = "(?<![\\w./#-])[A-Za-z0-9_][\\w.-]*#[0-9a-hjkmnp-tv-z]{4,26}(?![\\w-])";
const QUALIFIED_REF_ONLY = new RegExp(`^${QUALIFIED_REF}$`, "i");
// Distinct qualified refs in order of appearance. Prose holds look-alikes
// (`README.md#tasks`), so with `projects` only refs of those projects count.
export function qualifiedRefs(text: string, projects?: ReadonlySet<string>): string[] {
	const refs = [...new Set([...text.matchAll(new RegExp(QUALIFIED_REF, "g"))].map(match => match[0]))];
	return projects ? refs.filter(ref => projects.has(ref.slice(0, ref.lastIndexOf("#")))) : refs;
}

// The ticket a todo item names: a strict `<project>#<short_id>: <action>` prefix.
// A bare short id, a ref inside the text, or a prefix with no action is no name.
export function itemTicket(content: string): { ref: string; action: string } | undefined {
	const match = new RegExp(`^(${QUALIFIED_REF}):\\s+(\\S[\\s\\S]*)$`).exec(content.trim());
	return match ? { ref: match[1], action: match[2] } : undefined;
}

// Items that name no ticket become children of a parent issue; a plan of only named items needs none.
const needsParent = (contents: string[]) => contents.some(content => !itemTicket(content));

export function phasesOf(tasks: Task[]): { name: string; tasks: Task[] }[] {
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

export type Ticket = { short_id: string; title: string; qualified_id: string };
type Suggestions = { items: { value: string; label: string; description?: string }[]; prefix: string } | null;
// Structural slice of omp's and pi's autocomplete provider; both hosts share it.
export interface TicketAutocompleteProvider {
	// omp passes the AbortSignal itself plus onPartial; pi passes `{ signal, force }`.
	getSuggestions(lines: string[], cursorLine: number, cursorCol: number, signal?: AbortSignal | { signal?: AbortSignal }, onPartial?: (suggestions: NonNullable<Suggestions>) => void): Promise<Suggestions>;
	applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: { value: string; label: string }, prefix: string): { lines: string[]; cursorLine: number; cursorCol: number };
	// pi only: characters that open the menu, and a veto for file completion.
	triggerCharacters?: string[];
	shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
}

// `#<token>` or `#<project>#<token>` ending at the cursor, after a token boundary
// (the set omp's own `#` completion uses, so `C#12` and URL fragments stay untouched).
const TICKET_TOKEN = /(?:^|[\s"'`(<=])#(?:([^\s#]+)#)?([^\s#]*)$/;
const TICKET_LIMIT = 10;

/**
 * Wraps the host's provider: it always runs, and tickets from `source` whose short
 * id starts with the token or whose title has a word starting with it are appended
 * to its items. A digits-only `#1234` stays GitHub's; `#project#1234` reaches an
 * all-digit Kata id. `source(undefined)` is the folder's bound project. Typing never
 * waits on Kata: an abort, a timeout or a failing source leaves the wrapped items.
 */
export function ticketAutocomplete(current: TicketAutocompleteProvider, source: (project?: string) => Promise<Ticket[]>, options: { defaultProject?: string; timeout?: number } = {}): TicketAutocompleteProvider {
	const ours = new Set<string>();
	async function search(project: string | undefined, token: string, signal: AbortSignal | undefined): Promise<Ticket[]> {
		let resolve!: (value: undefined) => void;
		const gone = new Promise<undefined>(done => { resolve = done; });
		const timer = setTimeout(resolve, options.timeout ?? 400);
		const onAbort = () => resolve(undefined);
		if (signal?.aborted) resolve(undefined); else signal?.addEventListener("abort", onAbort);
		try {
			const all: Ticket[] | undefined = await Promise.race([source(project).catch(() => undefined), gone]);
			const wanted = token.toLowerCase();
			const idMatches = (all ?? []).filter(t => t.short_id.toLowerCase().startsWith(wanted));
			const titleMatches = (all ?? []).filter(t => !idMatches.includes(t) && t.title.toLowerCase().split(/[^\p{L}\p{N}]+/u).some(word => word.startsWith(wanted)));
			return [...idMatches, ...titleMatches];
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	}
	return {
		triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), "#"])],
		shouldTriggerFileCompletion: current.shouldTriggerFileCompletion?.bind(current),
		async getSuggestions(lines, cursorLine, cursorCol, hostOptions, onPartial) {
			const inner = current.getSuggestions(lines, cursorLine, cursorCol, hostOptions, onPartial);
			const signal = hostOptions instanceof AbortSignal ? hostOptions : hostOptions?.signal;
			const match = (lines[cursorLine] ?? "").slice(0, cursorCol).match(TICKET_TOKEN);
			const project = match?.[1], token = match?.[2] ?? "";
			if (!match || (!project && (!token || /^\d+$/.test(token)))) return inner;
			const projects = project ? [project] : [undefined, ...(options.defaultProject ? [options.defaultProject] : [])];
			const [base, ...found] = await Promise.all([inner, ...projects.map(p => search(p, token, signal))]);
			const seen = new Set<string>();
			const tickets = found.flat().filter(t => !seen.has(t.qualified_id) && !!seen.add(t.qualified_id)).slice(0, TICKET_LIMIT);
			if (!tickets.length) return base;
			const prefix = match[0].startsWith("#") ? match[0] : match[0].slice(1);
			if (base?.items.length && base.prefix !== prefix) return base; // one list needs one prefix
			for (const t of tickets) ours.add(t.qualified_id);
			return { prefix, items: [...(base?.items ?? []), ...tickets.map(t => ({ value: t.qualified_id, label: `${t.short_id} ${t.title}`, description: t.qualified_id }))] };
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (!ours.has(item.value)) return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			const line = lines[cursorLine] ?? "";
			const start = cursorCol - prefix.length;
			const inserted = `${item.value} `;
			const next = line.slice(0, start) + inserted + line.slice(cursorCol);
			return { lines: lines.map((l, i) => i === cursorLine ? next : l), cursorLine, cursorCol: start + inserted.length };
		},
	};
}

export function createKataCore(host: CoreHost, options: CoreOptions) {
	const namespace = options.namespace;
	const heldByDelegate = (metadata: any) => heldBy(namespace, metadata);
	const STATE_ENTRY = `io.kata.${namespace}.parent`;
	const SNAPSHOT_ENTRY = `io.kata.${namespace}.state`;
	const WIDGET = `${namespace}-kata`;
	const MAX_REMINDERS = 3;
	const main = (ctx: any) => host.isMain?.(ctx) ?? true;
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
	let boundAgent: string | undefined;
	const agentKey = (ctx: any) => JSON.stringify([ctx?.agent?.kind, ctx?.agent?.id]);
	let currentCtx: any;
	let reminders = 0;
	let progressed = true;
	let cache: { id?: string; contract?: string; inbox?: string; actor?: Promise<string>; pending?: Promise<void>; inboxPending?: Promise<void>; personInbox?: boolean } = {};
	// Throttled closes, ticket closes waiting on children and the automatic parent's close (see settlement.ts).
	// The timer is omp's ctx timer (contained, cleared on session_shutdown) when the host has one; pi has none.
	const settlement = createSettlement({
		namespace, kata: (args, cwd) => kata(args, cwd), owned, projectList: cwd => projectList(cwd),
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
	let registered: { id?: string; list: Promise<{ id: number; name: string }[]> } | undefined;
	let lastSnapshot: string | undefined;
	// Items that name an existing ticket. They live in the session's snapshot, not
	// in Kata: the ticket can sit under any parent or project, and several items
	// may name one ticket.
	let named: Task[] = [];
	let stamp = 0;
	const nextStamp = () => (stamp = Math.max(Date.now(), stamp + 1));
	// The plan's tasks: Kata children (or the local plan) merged with named items by creation time.
	const withNamed = (base: Task[]) => named.length ? [...base.filter(t => !t.ticket), ...named].sort((a, b) => (a.at || 0) - (b.at || 0)) : base;
	const store = host.delegateStore;
	const delegates = createDelegates({
		namespace, store,
		kata: (args, cwd) => kata(args, cwd), actor: (cwd, ref) => actor(cwd, ref), owned, work, serial, plan: () => plan,
		load: cwd => load(cwd), projectNames: cwd => projectNames(cwd), drain: () => drain(), cwd: () => path.resolve(currentCtx?.cwd ?? process.cwd()), debug,
	});
	function persist() {
		if (!currentId || !main(currentCtx)) return;
		const data = { version: 1, sessionId: currentId,
			plan: structuredClone({ ...plan, tasks: plan.tasks.filter(t => !t.ticket) }), ...settlement.snapshot(),
			...(named.length ? { named: structuredClone(named) } : {}) };
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

	async function kata(args: string[], cwd: string, timeout = 120_000, workspace = true): Promise<string> {
		// --json makes every failure carry Kata's error code; the contract hook prints its own format.
		const json = args[0] !== "agent-contract-hook" && !args.includes("--json");
		const flags = [...(json ? ["--json"] : []), ...(sessionTeammate !== undefined && args[0] !== "agent-contract-hook" ? ["--teammate", sessionTeammate] : []), ...(workspace ? ["--workspace", path.resolve(cwd)] : [])];
		const end = args.indexOf("--");
		args = [...args.slice(0, end < 0 ? args.length : end), ...flags, ...(end < 0 ? [] : args.slice(end))];
		let result: Awaited<ReturnType<CoreHost["exec"]>>;
		try { result = await host.exec(options.executable, args, { cwd, timeout, ctx: currentCtx }); }
		catch (error) {
			if ((error as { code?: unknown })?.code !== "ENOENT") throw error;
			throw new KataError(`kata ${args[0]} could not run: ${(error as Error).message}`, { exit: -1, notRun: true });
		}
		if (result.code !== 0 || result.killed) {
			// Kata may print warning lines (e.g. a skipped transcript) before the envelope, which is always the last line.
			const envelope = [result.stdout, result.stderr].map(text => { try { return JSON.parse((text ?? "").trim().split("\n").pop() ?? "").error; } catch { return undefined; } }).find(e => e && typeof e === "object");
			const detail = envelope?.message ?? (result.stderr || result.stdout || "").trim().split("\n").slice(-3).join(" ");
			// A host that fails to spawn reports a bare failure with no output at all; Kata always says something.
			const notRun = !result.killed && !envelope && !detail;
			// A renamed project's old name no longer resolves: drop the cached list so the next lookup reloads it.
			if (envelope?.code === "project_not_initialized") registered = undefined;
			throw new KataError(`kata ${args[0]} ${result.killed ? `timed out after ${timeout}ms` : notRun ? "could not run" : "failed"}${detail ? `: ${detail}` : ""}`, { exit: result.code, code: envelope?.code, detail, data: envelope?.data && typeof envelope.data === "object" ? envelope.data : undefined, killed: result.killed, notRun });
		}
		return result.stdout;
	}

	// Serialize every plan mutation: tool calls, /todo, and session reloads.
	function serial<T>(fn: () => Promise<T>): Promise<T> {
		const run = queue.then(fn);
		queue = run.catch(() => undefined);
		return run;
	}

	async function actor(cwd: string, ref = plan.parent): Promise<string> {
		if (ref) {
			const status = JSON.parse(await kata(["status", ref, "--json"], cwd));
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
	async function owned(ref: string, cwd: string, mayClaim: boolean | "check" = false, allowClosed = false, revision?: number, who?: Who): Promise<any> {
		let issue = JSON.parse(await kata(["show", ref, "--json"], cwd)).issue;
		if (revision !== undefined && issue.revision !== revision) throw new Error(`Kata issue ${ref} changed since the task was selected; no work metadata was written.`);
		if (!who?.delegate && main(currentCtx) && heldByDelegate(issue.metadata)) throw new Error(`Kata issue ${ref} belongs to a delegate; no work metadata was written.`);
		const currentActor = await actor(cwd, ref);
		const teammate = who?.teammate ?? sessionTeammate ?? process.env.KATA_TEAMMATE ?? "";
		if (issue?.status !== "open" && !(allowClosed && issue?.status === "closed")) throw new Error(`Kata issue ${ref} is closed or unavailable; no work metadata was written.`);
		const assignedTeammate = issue.metadata?.teammate || "";
		if (assignedTeammate !== teammate && (issue.owner || assignedTeammate)) {
			throw new Error(`Kata issue ${ref} belongs to teammate ${assignedTeammate || "(none)"}, not ${teammate || "(none)"}; no work metadata was written.`);
		}
		if (!issue.owner && mayClaim === true) {
			// Never swallow a claim failure, including an ownership race.
			await kata(["claim", ref, "--if-unowned"], cwd);
			issue = JSON.parse(await kata(["show", ref, "--json"], cwd)).issue;
			if (issue.status !== "open" || issue.owner !== currentActor) throw new Error(`Kata issue ${ref} is no longer owned by ${currentActor}; no work metadata was written.`);
			if (teammate && !issue.metadata?.teammate) {
				await kata(["meta", "set", ref, "teammate", teammate, "--if-absent", "--if-match", String(issue.revision)], cwd);
				issue = JSON.parse(await kata(["show", ref, "--json"], cwd)).issue;
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
	async function work(ref: string, key: string, value: string | boolean | undefined, cwd: string, expected: any): Promise<any> {
		const meta = expected.metadata ?? {};
		const exists = Object.hasOwn(meta, key);
		if ((!exists && value === undefined) || meta[key] === value) return expected;
		const args = value === undefined ? ["meta", "unset", ref, key] : ["meta", "set", ref, key, JSON.stringify(value)];
		args.push("--if-match", String(expected.revision));
		if (exists) args.push("--if-value", JSON.stringify(meta[key]), "--json-value");
		else args.push("--if-absent", "--json-value");
		await kata(args, cwd);
		const changed = { ...meta };
		if (value === undefined) delete changed[key];
		else changed[key] = value;
		return { ...expected, revision: expected.revision + 1, metadata: changed };
	}

	// -------------------------------------------------------------- plan state

	async function showParent(parent: string, cwd: string): Promise<any> {
		const shown = JSON.parse(await kata(["show", parent, "--json"], cwd));
		const children = (shown.children ?? []) as any[];
		if (!shown.issue || !Array.isArray(children) || children.some(c => !c || typeof c.title !== "string" || typeof c.short_id !== "string")) {
			throw new Error("kata show returned an invalid issue or children response");
		}
		return shown;
	}

	async function childrenOf(parent: string, cwd: string): Promise<any[]> {
		return (await showParent(parent, cwd)).children ?? [];
	}

	// `kata move` keeps old refs resolving but the issue and its open children now
	// live in another project. Follow the parent: the saved binding, child
	// creation, delegate context and the pi marker all derive the project from it.
	async function rehome(shown: any, ref: string, cwd: string): Promise<void> {
		const old = ref;
		let current: string;
		try { current = `${await projectName(shown.issue.project_id, cwd)}#${shown.issue.short_id}`; }
		catch (error) { debug(error); return; }
		if (current === old || plan.parent !== old) return;
		settlement.renameAutoParent(old, current);
		plan.parent = current;
		aliases.add(old);
		host.appendEntry(STATE_ENTRY, { parent: current, workspace: plan.workspace, sessionId: plan.sessionId, auto: plan.auto, label: plan.label });
	}

	function tasksOf(children: any[], parent: string): Task[] {
		return children
			.filter(c => typeof c?.metadata?.["todo.phase"] === "string" && c.metadata["todo.removed"] !== true)
			.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
			.map(c => {
				const meta = c.metadata;
				let status: Status;
				if (c.status === "closed") status = c.closed_reason === "wontfix" || meta["todo.status"] === "abandoned" ? "abandoned" : "completed";
				else status = ["in_progress", "blocked"].includes(meta["todo.status"]) ? meta["todo.status"] : "pending";
				return {
					ref: qualifiedRef(c, parent),
					content: c.title,
					phase: meta["todo.phase"],
					revision: c.revision,
					at: Date.parse(c.created_at),
					delegated: heldByDelegate(meta) && (meta.teammate || "") !== (sessionTeammate ?? process.env.KATA_TEAMMATE ?? ""),
					review: (c.labels ?? []).some((l: any) => (typeof l === "string" ? l : l?.label) === "needs-review"),
					status,
					blocker: status === "blocked" ? meta["work.attention_msg"] : undefined,
				};
			});
	}

	// An item follows its ticket: closed by anyone (a delegate, the user) it is completed,
	// or abandoned when closed as wontfix. A ticket that cannot be read keeps its item as is.
	async function followTickets(cwd: string) {
		const open = named.filter(t => OPEN.has(t.status));
		for (const ticket of new Set(open.map(t => t.ticket!))) {
			try {
				const shown = JSON.parse(await kata(["show", ticket, "--json"], cwd)).issue;
				if (shown.status !== "closed") continue;
				for (const task of open) if (task.ticket === ticket) { task.status = shown.closed_reason === "wontfix" ? "abandoned" : "completed"; task.blocker = undefined; }
			} catch (error) { debug(error); }
		}
	}

	async function load(cwd: string): Promise<any[]> {
		if (plan.local) { delete plan.error; plan.tasks = withNamed(plan.tasks); return []; }
		if (!plan.parent) { if (named.length) { delete plan.error; await followTickets(cwd); } plan.tasks = withNamed([]); return []; }
		try {
			const ref = plan.parent;
			const shown = await showParent(ref, cwd);
			await rehome(shown, ref, cwd);
			const children = (shown.children ?? []) as any[];
			await followTickets(cwd);
			plan.tasks = withNamed(tasksOf(children, plan.parent));
			delete plan.error;
			return children;
		} catch (error) {
			plan.error = (error as Error).message;
			throw error;
		}
	}

	function refresh(ctx: any) {
		if (!main(ctx) || host.allowUI?.(ctx) === false) return;
		const ui = ctx?.ui;
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
		try { await kata(["list", "--limit", "1", "--json"], cwd, 15_000); scope = "workspace"; refusal = undefined; }
		catch (error) {
			if (isKataCode(error, "project_not_initialized")) { scope = "unbound"; refusal = (error as KataError).info.data ?? {}; }
			else if (isUnusable(error)) { scope = "down"; outage = (error as Error)?.message ?? String(error); debug(error); return false; }
			else throw error; // a missing project or a refused login is an error, never a local plan
		}
		return true;
	}

	// Where a plan created from this cwd lives. Never writes.
	function candidate(cwd: string): { project?: string; label?: string; register?: boolean } {
		if (!refusal) return {};
		const name = inferredName(refusal, cwd);
		const configured = process.env.KATA_DEFAULT_PROJECT?.trim();
		return configured ? { project: configured, label: slug(name) } : { project: name, register: true };
	}

	// Register the inferred project in the daemon (idempotent; no files in the repo).
	async function destination(cwd: string) {
		const target = candidate(cwd);
		if (target.register) { registered = undefined; await kata(["projects", "create", target.project!, "--json"], cwd, 20_000, false); }
		return target;
	}

	function goLocal(ctx: any) {
		plan.local = true; delete plan.error;
		settlement.schedule();
		if (warnedFor === (currentId ?? "")) return;
		warnedFor = currentId ?? "";
		if (main(ctx) && host.allowUI?.(ctx) !== false) ctx?.ui?.notify?.(`Kata is unreachable${outage ? ` (${outage})` : ""}. todo keeps a session-local plan and replays it into Kata when Kata returns.`, "warning");
	}

	// Kata is back: create the parent and tasks the local plan accumulated.
	async function replayLocal(ctx: any) {
		if (!plan.local || !await probe(ctx.cwd)) return;
		const local = plan.tasks.filter(t => !t.ticket);
		// Nothing was planned offline: create nothing.
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
					if (t.status === "completed" && !(t.proof?.evidence?.length && (t.proof.message || "").trim().length >= 40)) await transition(task, "blocked", { reason: "Completed while Kata was unreachable; add evidence and close it." }, cwd);
					else await transition(task, t.status, { ...t.proof, reason: t.blocker }, cwd);
				} catch (error) {
					debug(error);
					await transition(task, "blocked", { reason: `Replaying "${t.status}" from the offline plan failed: ${(error as Error).message}` }, cwd).catch(debug);
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

	// The registered Kata projects (id and name), read once per session and
	// again only when a project id is not in it (a project registered later).
	function projectList(cwd: string, fresh = false): Promise<{ id: number; name: string }[]> {
		if (fresh || registered?.id !== currentId) registered = undefined;
		const entry: NonNullable<typeof registered> = registered ??= {
			id: currentId,
			list: kata(["projects", "list", "--json"], cwd).then(out => (JSON.parse(out).projects as any[]).map(p => ({ id: p.id, name: p.name })))
				.catch(error => { if (registered === entry) registered = undefined; throw error; }),
		};
		return entry.list;
	}

	// An unreadable list is empty, so no ref in prose is taken for a ticket.
	function projectNames(cwd: string): Promise<Set<string>> {
		return projectList(cwd).then(list => new Set(list.map(p => p.name)), error => { debug(error); return new Set<string>(); });
	}

	// `ref` is what Kata was asked: a project name the list lacks means the project was renamed since it was read.
	async function projectName(id: number, cwd: string, ref?: string): Promise<string> {
		const asked = ref?.includes("#") ? ref.split("#")[0] : undefined;
		const stale = asked !== undefined && !(await projectList(cwd)).some(p => p.name === asked);
		const project = (stale ? undefined : (await projectList(cwd)).find(p => p.id === id)) ?? (await projectList(cwd, true)).find(p => p.id === id);
		if (!project) throw new Error("Kata issue project could not be pinned.");
		return project.name;
	}

	// The issue's current qualified ref: its project is the one it lives in now,
	// not the one the given ref names.
	async function qualify(issue: any, cwd: string, ref: string): Promise<string> {
		return `${await projectName(issue.project_id, cwd, ref)}#${issue.short_id}`;
	}
	async function pin(ref: string, cwd: string): Promise<string> {
		return qualify(JSON.parse(await kata(["show", ref, "--json"], cwd)).issue, cwd, ref);
	}

	async function sessionBinding(ctx: any): Promise<Binding | undefined> {
		const id = ctx.sessionManager?.getSessionId?.();
		if (!id) return;
		const where = candidate(ctx.cwd);
		let list: any[];
		try { list = JSON.parse(await kata(["list", "--status", "all", ...(where.project ? ["--project", where.project] : []), "--meta", `${namespace}.session_id=${id}`, "--label", `${namespace}-session`, "--limit", "2", "--json"], ctx.cwd)).issues ?? []; }
		catch (error) { if (where.project && isKataCode(error, "project_not_initialized")) return; throw error; } // the project is not registered yet: no earlier parent
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

	async function bind(ctx: any, explicit = configuredRef(), replay = true, initRef?: string) {
		let assigned: DelegateAssignment | undefined;
		if (!main(ctx)) { assigned = delegates.assignment(ctx); if (!assigned) return; }
		bound = false;
		boundAgent = agentKey(ctx);
		sessionTeammate = assigned?.teammate;
		assignedRef = assigned?.ref;
		const sources = { cwd: ctx.cwd, assigned, explicit, initRef };
		const requested = explicitParent(sources)?.parent;
		requestedRef = requested;
		const id = ctx.sessionManager?.getSessionId?.();
		currentId = id;
		lastSnapshot = undefined;
		currentCtx = ctx;
		plan = { tasks: [], workspace: path.resolve(ctx.cwd) }; named = []; aliases.clear();
		scope = "unknown"; refusal = undefined; outage = "";
		const branch: any[] = ctx.sessionManager?.getBranch?.() ?? [];
		const snapshotOf = (owner: unknown) => [...branch].reverse().find((entry: any) => entry?.type === "custom" && entry.customType === SNAPSHOT_ENTRY && entry.data?.version === 1 && entry.data.sessionId === owner)?.data;
		let snapshot = snapshotOf(id);
		// A fork gets a new session id and copies the source's entries. It shares the source's work:
		// adopt its parent and ticket items, but not its retries (the source still owns those closes)
		// nor its offline plan (replaying that would make a second automatic parent).
		let source: string | undefined;
		if (!snapshot && id) {
			source = forkSourceId(ctx.sessionManager?.getHeader?.()?.parentSession);
			snapshot = source && snapshotOf(source);
		}
		// A forked session keeps the source id as the parent's owner: the parent's session_id metadata names it.
		const parentOwner = source ?? id;
		settlement.restore(snapshot && !source ? snapshot : undefined);
		if (snapshot) {
			if (!source) {
				if (snapshot.plan?.local && !requested) plan = { ...structuredClone(snapshot.plan), workspace: plan.workspace };
			}
			named = structuredClone(snapshot.named ?? []);
			stamp = Math.max(0, ...named.map(t => t.at || 0));
			plan.tasks = withNamed(plan.tasks);
		}
		let stored: any = snapshot?.plan?.parent ? snapshot.plan : undefined;
		for (const entry of branch) {
			if (entry?.type === "custom" && entry.customType === STATE_ENTRY && typeof entry.data?.parent === "string" && (!entry.data.sessionId || entry.data.sessionId === parentOwner)) stored = entry.data;
		}
		if (source && !snapshot) stored = stored && { ...stored, sessionId: parentOwner };
		if (plan.local && !requested) stored = undefined;
		let down = false;
		const choice = await decidePlanParent({
			...sources, stored,
			session: async () => {
				if (!await probe(ctx.cwd)) { down = true; return; }
				// A restored offline plan replays into its parent itself; do not rebind over it.
				if (id && !plan.local) return sessionBinding(ctx);
			},
		});
		if (down) { await drain(); bound = true; refresh(ctx); return; }
		const saved = choice.saved;
		if (choice.parent) {
			const workspace = choice.workspace;
			const qualified = await pin(choice.parent, workspace);
			const issue = JSON.parse(await kata(["show", qualified, "--json"], workspace)).issue;
			const marker = issue.metadata?.[`${namespace}.auto_parent`];
			const owner = saved?.auto && typeof saved.sessionId === "string" && saved.sessionId !== id ? saved.sessionId : id;
			const auto = !isExplicitParent(choice) && saved?.auto !== false && (marker === true || (saved?.auto === true && marker === undefined)) && issue.metadata?.[`${namespace}.session_id`] === owner;
			setParent({ parent: qualified, workspace, sessionId: owner, auto, label: saved?.label });
			await load(workspace);
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
		const parent = await pin(ref, workspace);
		if (plan.auto && plan.parent && plan.parent !== parent) {
			// An automatic parent with no children only marks the session; retire it
			// rather than leave an empty child that can never auto-close.
			const shown = JSON.parse(await kata(["show", plan.parent, "--json"], plan.workspace));
			if (shown.issue.status === "open" && !shown.children?.length) {
				const decision = await owned(plan.parent, plan.workspace, false, false, shown.issue.revision);
				await kata(["close", plan.parent, "--if-match", String(decision.revision), "--superseded-by", parent, "--message", `This session adopted ${parent} as its plan parent.`], plan.workspace);
				settlement.dropAutoParent(plan.parent);
			}
		}
		if (plan.parent === parent) settlement.dropAutoParent(parent);
		setParent({ parent, workspace: path.resolve(workspace), sessionId: ctx.sessionManager?.getSessionId?.(), auto: false });
		await load(workspace);
	}

	// ------------------------------------------------------------- transitions

	async function create(phase: string, content: string, cwd: string): Promise<void> {
		const out = JSON.parse(
			await kata(
				[
					"create",
					"--parent", plan.parent!,
					"--project", plan.parent!.split("#")[0],
					"--body", `Todo task in phase "${phase}".`,
					"--meta", `todo.phase=${phase}`,
					"--meta", "todo.status=pending",
					...(plan.label ? ["--label", plan.label] : []),
					"--idempotency-key", `${namespace}-kata:${digest(plan.parent!, phase, content)}`,
					// Sibling tasks often read alike ("write x" / "verify x"); they are
					// deliberate plan items, so skip the look-alike soft-block.
					"--force-new",
					"--json", "--", content,
				],
				cwd,
			),
		);
		const issue = out?.issue;
		if (typeof issue?.short_id !== "string") throw new Error("kata create returned no short_id");
		// Replays may restore removed work, but never another writer's task.
		const ref = `${plan.parent!.split("#")[0]}#${issue.short_id}`;
		if (issue.status === "closed" || issue.metadata?.["todo.removed"] === true) {
			let decision = await owned(ref, cwd, "check", true, issue.revision);
			if (decision.status === "closed") {
				await kata(["reopen", ref], cwd);
				decision = await owned(ref, cwd, "check", false, decision.revision + 1);
				decision = await work(ref, "todo.status", "pending", cwd, decision);
			}
			await work(ref, "todo.removed", undefined, cwd, decision);
		}
	}

	// The attention and status writes for a task that starts, returns to pending, or blocks.
	async function mark(ref: string, task: Task, from: Status, to: "in_progress" | "pending" | "blocked", change: Change, cwd: string, decision: any): Promise<any> {
		switch (to) {
			case "in_progress":
				decision = await work(ref, "work.attention", "ok", cwd, decision);
				decision = await work(ref, "work.attention_msg", undefined, cwd, decision);
				return work(ref, "todo.status", "in_progress", cwd, decision);
			case "pending":
				if (from === "blocked") {
					decision = await work(ref, "work.attention", "ok", cwd, decision);
					decision = await work(ref, "work.attention_msg", undefined, cwd, decision);
				}
				return work(ref, "todo.status", "pending", cwd, decision);
			case "blocked": {
				const reason = change.reason || "Blocked in the todo plan.";
				decision = await work(ref, "work.attention", "stuck", cwd, decision);
				decision = await work(ref, "work.attention_msg", reason, cwd, decision);
				task.blocker = reason;
				return work(ref, "todo.status", "blocked", cwd, decision);
			}
		}
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
			await kata(["reopen", ref], cwd);
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
				if (task.review) { await owned(ref, cwd, "check", true, decision.revision); await kata(["label", "rm", ref, "needs-review"], cwd); task.review = false; }
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
		if (!change.evidence?.length || (change.message || "").replace(/\s+/g, " ").trim().length < 40) {
			throw new Error(`Kata needs evidence and a 40+ character message to close ${ref} ("${task.content}") as done: pass evidence (commit:<sha>, test:<cmd>, pr:<url>, reviewed-paths:<path>) and a message saying what changed and how it was verified. If it is not verified, block it instead.`);
		}
	}

	// ------------------------------------------------- items naming a ticket

	// Kata deduplicates by this key, so a replay never comments twice for one item.
	const noteKey = (task: Task, verb: string) => `${namespace}-item:${digest(currentId ?? "", task.ticket!, task.phase, task.content, String(task.at ?? 0))}:${verb}`;
	const note = (task: Task, verb: string, body: string, cwd: string) => kata(["comment", task.ticket!, "--idempotency-key", noteKey(task, verb), "--body", body], cwd);

	// A ticket whose last working item left in_progress/blocked goes back to pending and ok.
	// An unowned-by-us or closed ticket is left alone.
	async function settleTicket(task: Task, cwd: string): Promise<void> {
		const ticket = task.ticket!;
		if (named.some(other => other !== task && other.ticket === ticket && WORKING.has(other.status))) return;
		let decision: any;
		try { decision = await owned(ticket, cwd, "check"); }
		catch (error) { debug(error); return; }
		decision = await work(ticket, "work.attention", "ok", cwd, decision);
		decision = await work(ticket, "work.attention_msg", undefined, cwd, decision);
		await work(ticket, "todo.status", "pending", cwd, decision);
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
			const shown = JSON.parse(await kata(["show", ticket, "--json"], cwd)).issue;
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
				let shown: any;
				try { shown = JSON.parse(await kata(["show", ref, "--json"], cwd)).issue; }
				catch (error) { throw new Error(`Todo item "${item.content}" names ${ref}, which Kata cannot resolve: ${(error as Error).message}. Nothing was created.`); }
				if (shown.status !== "open") throw new Error(`Todo item "${item.content}" names ${ref}, which is already closed; the plugin never reopens a ticket. Nothing was created.`);
				ticket = await qualify(shown, cwd, ref);
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
	async function closeTicket(task: Task, decision: any, change: Change, cwd: string) {
		const ticket = task.ticket!;
		const request: PendingClose = { key: noteKey(task, "close"), message: `${change.message} (item: ${task.content}; ${ticket})`, evidence: change.evidence!, cwd };
		try { await closeWith(ticket, decision, request); }
		catch (error) {
			if (!isKataCode(error, "parent_has_open_children")) throw error;
			const open = openChildren(JSON.parse(await kata(["show", ticket, "--json"], cwd)), ticket);
			const many = open.length !== 1;
			const ours = open.every(ref => plan.tasks.some(t => (t.ticket ?? t.ref) === ref));
			if (ours) settlement.holdTicketClose(ticket, { ...request, key: noteKey(task, "close-after-children") }, cwd);
			const why = `Every todo item for ${ticket} is done, but ${open.length} open ${many ? "children block" : "child blocks"} closing it, so it stays open.`;
			await note(task, "blocked", ours
				? `${why} It closes once ${many ? "they are" : "that child is"} closed; the plugin retries when ${many ? "they close" : "it closes"} during this session.`
				: `${why} ${many ? "They are" : "It is"} outside this todo plan, so close the ticket yourself once ${many ? "they are" : "it is"} done.`, cwd);
		}
	}

	async function closeWith(ticket: string, decision: any, request: PendingClose) {
		const args = ["close", ticket, "--done", "--if-match", String(decision.revision), "--idempotency-key", request.key, "--message", request.message];
		for (const e of request.evidence) args.push("--evidence", e);
		await kata(args, request.cwd);
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

	// A delegated task is the subagent's; it never occupies the lead's slot.
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

	// With no active task, start the earliest pending one (phase order).
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
		if (!plan.local && !plan.tasks.some(t => t.content === target) && /(?:^|#)[0-9a-hjkmnp-tv-z]{26}$/i.test(target)) target = await pin(target, plan.workspace);
		const exact = plan.tasks.filter(t => t.content === target || t.ref === target || t.ref.split("#")[1] === target);
		if (exact.length === 1) return exact;
		if (QUALIFIED_REF_ONLY.test(target) && !exact.length && !plan.local) {
			// A short id is only unique per project: compare the ticket the ref names now, never its short id alone.
			const pinned = await pin(target, plan.workspace).catch(() => undefined);
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

	async function ensureParent(params: any, ctx: any): Promise<string | undefined> {
		let down = false;
		const choice = await decidePlanParent({
			cwd: ctx.cwd, assigned: { ref: assignedRef, workspace: plan.workspace }, explicit: configuredRef(), initRef: params.ref,
			stored: plan.parent ? { parent: plan.parent, workspace: plan.workspace } : undefined,
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
			let decision = await reopenParent();
			if (decision && decision.metadata?.[`${namespace}.auto_parent`] === undefined) decision = await work(plan.parent, `${namespace}.auto_parent`, true, plan.workspace, decision);
			if (decision && decision.metadata?.["work.attention"] === undefined) await work(plan.parent, "work.attention", "ok", plan.workspace, decision);
			return plan.parent;
		}
		const sessionId = ctx.sessionManager?.getSessionId?.();
		if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("Kata needs a real session id before creating an automatic parent.");
		const title = (params.message as string | undefined)?.trim() || host.getSessionName?.() || `Todo plan: ${(params.list ?? []).map((p: any) => p.phase).join(", ") || "tasks"}`.slice(0, 120);
		const cwd = path.resolve(ctx.cwd);
		let where: Awaited<ReturnType<typeof destination>>, out: any;
		try {
			where = await destination(cwd);
			out = JSON.parse(await kata(["create", ...(where.project ? ["--project", where.project] : []), ...(where.label ? ["--label", where.label] : []), "--body", `Todo plan from ${namespace} session ${sessionId}.`, "--meta", `${namespace}.session_id=${sessionId}`, "--meta", `${namespace}.workspace=${cwd}`, "--label", `${namespace}-session`, "--idempotency-key", `${namespace}-session:${sessionId}`, "--force-new", "--json", "--", title], cwd));
		} catch (error) {
			// A folder with no git ancestor is refused client-side, so the probe never reached the daemon.
			if (!isUnusable(error)) throw error;
			scope = "down"; outage = (error as Error)?.message ?? String(error); debug(error);
			goLocal(ctx); return;
		}
		const ref = createdParentRef(out);
		let decision = await owned(ref, cwd, true, false, out.issue.revision);
		decision = await work(ref, `${namespace}.auto_parent`, true, cwd, decision);
		setParent({ parent: ref, workspace: cwd, sessionId, auto: true, label: where.label });
		if (decision.metadata?.["work.attention"] === undefined) await work(ref, "work.attention", "ok", cwd, decision);
		return ref;
	}

	async function reopenParent() {
		if (!plan.parent || !plan.auto) return;
		let decision = await owned(plan.parent, plan.workspace, true, true);
		if (decision.status === "closed") {
			await kata(["reopen", plan.parent], plan.workspace);
			decision = await owned(plan.parent, plan.workspace, false, false, decision.revision + 1);
		}
		return decision;
	}

	class DeferredClose extends Error {}
	async function closeTask(args: string[], task: Task, to: Status, change: Change, cwd: string) {
		try { await kata(args, cwd); }
		catch (error) {
			if (!isKataCode(error, "sibling_throttle")) throw error;
			const text = settlement.pendTaskClose(task, to, change, cwd);
			persist();
			throw new DeferredClose(text);
		}
	}

	// Re-run a throttled close, then reload and start the next task.
	async function performTask(pending: { task: Task; to: Status; change: Change; cwd: string }) {
		const { task, change, cwd } = pending;
		if (change.remove) await remove(task, change, cwd);
		else await transition(task, pending.to, change, cwd);
		if (plan.tasks.some(t => t.ref === task.ref)) { await load(plan.workspace); await advance(plan.workspace); }
	}

	// The plugin gave up on a close: the issue needs a human.
	async function flagDropped(ref: string, cwd: string, error: unknown) {
		const code = (error as KataError | undefined)?.code;
		await kata(["label", "add", ref, "needs-review"], cwd);
		await kata(["comment", ref, "--body", `The plugin gave up closing ${ref} after ${MAX_FAILURES} failed attempts (Kata error code: ${code ?? "none, not a Kata error"}): ${(error as Error)?.message ?? error}. Review it and close it yourself.`], cwd);
	}

	// The one settlement pass: exited delegates settle first, then the session's offline plan replays, then pending closes and the automatic parent.
	async function drain() {
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
		if (!bound || currentId !== ctx.sessionManager?.getSessionId?.()) await bind(ctx, configuredRef(), params.op === "view", params.ref ?? (!bound ? requestedRef : undefined));
		currentCtx = ctx;
		currentId ||= ctx.sessionManager?.getSessionId?.();
		if (plan.local) {
			try { await replayLocal(ctx); }
			catch (error) { if (params.op !== "view") throw new Error(`Kata is reachable again, but the session-local plan could not be replayed into it: ${(error as Error).message}`); }
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
			const choice = await decidePlanParent({
				cwd: ctx.cwd, assigned: { ref: assignedRef, workspace: plan.workspace }, explicit: configuredRef(), initRef: params.ref,
				stored: plan.parent ? { parent: plan.parent, workspace: plan.workspace } : undefined,
			});
			const target = choice.parent;
			if (target) {
				const workspace = choice.workspace;
				const keepsParent = choice.provenance === "init" ? target === plan.parent || aliases.has(target) : namesPlanParent(plan.parent, aliases, target);
				const parent = keepsParent && plan.parent ? plan.parent : await pin(target, workspace);
				if (choice.overridden && parent !== await pin(choice.overridden, workspace)) throw new Error(`Kata init ref ${params.ref} conflicts with the explicit binding ${target}; neither plan was replaced.`);
				const tasks = tasksOf(await childrenOf(parent, workspace), parent);
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
		if (!plan.parent && !plan.local && !named.length) throw new Error("No todo plan yet. Call todo op=init first.");
		let children = await load(cwd);
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
					// A ticket item already open in the plan is already there: it is never a child to create.
					if (!ticket && itemTicket(content)) continue;
					if (ticket) {
						// A finished or dropped item comes back as a fresh one.
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
				change.many = tasks.length > 1;
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
		return serial(async () => {
			if (boundAgent && boundAgent !== agentKey(ctx)) {
				return { content: [{ type: "text" as const, text: "Kata agent identity changed; use this worker's own extension context." }], details: { op: params.op, kata: {} }, isError: true };
			}
			try {
				if (!main(ctx) && !delegates.assignment(ctx)) throw new Error(delegates.unassigned(ctx));
				const text = await apply(params, ctx);
				return { content: [{ type: "text" as const, text }], details: details(params.op) };
			} catch (err) {
				// A failed initial binding has no authoritative plan to render yet.
				if (!bound || !plan.parent && !plan.local && !named.length) plan.error = (err as Error).message;
				// Kata may have applied part of a batch. A failed reload marks the
				// cached tasks unavailable instead of presenting them as current.
				if (plan.parent || named.length) await load(plan.workspace).catch(debug);
				return {
					content: [{ type: "text" as const, text: `${(err as Error).message}\n\n${render(plan)}` }],
					details: details(params.op),
					isError: err instanceof DeferredClose ? undefined : true,
				};
			} finally {
				persist();
				refresh(ctx);
			}
		});
	}

	async function command(args: string, ctx: any): Promise<string> {
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
		const text = await serial(async () => {
			try {
				return await apply(params, ctx);
			} catch (err) {
				return (err as Error).message;
			} finally {
				persist();
				refresh(ctx);
			}
		});
		return text;
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

	async function remind(messages: any[], ctx: any): Promise<string | undefined> {
		if (!main(ctx)) return;
		const refreshed = await bounded(serial(async () => { await load(plan.workspace); await drain(); return true; }));
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
		const id = ctx.sessionManager?.getSessionId?.();
		if (cache.id !== id) cache = { id };
		const entry = cache;
		if (!entry.pending && !entry.contract) {
			entry.pending = (async () => {
				if (!await probe(cwd)) return;
				// Exactly these arguments: some Kata builds print nothing for any other form.
				const out = await kata(["agent-contract-hook", "--source", "kata-agent-contract-hook"], cwd, 1000, false).then(out => JSON.parse(out)?.hookSpecificOutput?.additionalContext);
				if (typeof out === "string") entry.contract = out;
			})().catch(debug).finally(() => { entry.pending = undefined; });
		}
		const user = process.env.KATA_INBOX_USER;
		// A bare actor is a person's own inbox (requests written for them, read by kata inbox and tern-kata's
		// Attention Page), never instructions for this session. Only <actor>/<teammate> is a session inbox.
		if (user && !isSessionAddress(user)) {
			if (!entry.personInbox) {
				entry.personInbox = true;
				if (main(ctx) && host.allowUI?.(ctx) !== false) ctx?.ui?.notify?.(`KATA_INBOX_USER=${user} is a person's inbox, so this session reads none. Use ${user}/<name> for a session inbox.`, "warning");
			}
		} else if (inbox && user && !entry.inboxPending) {
			// Only requests from the session's own actor reach the prompt. A failed read (or actor
			// lookup) keeps the last inbox; no trusted request removes the section.
			entry.inboxPending = (async () => {
				const mine = await inboxActor(cwd);
				const out = JSON.parse(await kata(["inbox", "--for", user, "--json"], cwd));
				entry.inbox = trustedInbox(out?.requests, mine, user).text;
			})().catch(debug).finally(() => { entry.inboxPending = undefined; });
		}
		return Promise.all([entry.pending, entry.inboxPending]).then(() => undefined);
	}

	// Open issues per project for ticket autocomplete: one list per session, served
	// from cache and refreshed in the background. Only the first load, or a load
	// after a failure, is awaited; the caller bounds that wait.
	const TICKET_STALE = 30_000, TICKET_RETRY = 5_000;
	const ticketLists = new Map<string, { at: number; tickets: Ticket[]; pending?: Promise<void>; failedAt?: number; error?: unknown }>();
	function tickets(project?: string): Promise<Ticket[]> {
		const cwd = path.resolve(currentCtx?.cwd ?? process.cwd());
		const key = `${currentId ?? ""}\0${cwd}\0${project ?? ""}`;
		let entry = ticketLists.get(key);
		if (!entry) ticketLists.set(key, entry = { at: 0, tickets: [] });
		const list = entry;
		if (list.failedAt && Date.now() - list.failedAt < TICKET_RETRY && !list.at) return Promise.reject(list.error);
		if (!list.pending && Date.now() - list.at > TICKET_STALE) {
			const args = ["list", "--limit", "1000", "--json", ...(project ? ["--project", project] : [])];
			list.pending = kata(args, cwd, 5_000, !project).then(out => {
				list.tickets = (JSON.parse(out).issues ?? []).map((i: Ticket) => ({ short_id: i.short_id, title: i.title, qualified_id: i.qualified_id }));
				list.at = Date.now(); delete list.failedAt;
			}, error => {
				// An unregistered folder simply has no bound project to list.
				if (isKataCode(error, "project_not_initialized")) { list.at = Date.now(); list.tickets = []; return; }
				debug(error);
				list.failedAt = Date.now(); list.error = error;
				if (list.at) list.at = Date.now() - TICKET_STALE + TICKET_RETRY; // keep serving the old list, retry soon
			}).finally(() => { list.pending = undefined; });
		}
		if (list.at) return Promise.resolve(list.tickets);
		return list.pending!.then(() => list.at ? list.tickets : Promise.reject(list.error));
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
			read: async () => JSON.parse(await kata(["inbox", "--for", address, "--json"], cwd)),
			spawn: cursor => live.spawn(cwd, cursor),
			deliver: text => { try { Promise.resolve(live.deliver(text)).catch(debug); } catch (error) { debug(error); } },
			publish: text => { liveInbox = text; },
			head: () => knownProjectHead(cwd, args => kata(args, cwd)),
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
			await kata(["agent-hook", "attention-native", options.attentionHarness, mode, "--session", session.id, "--host-pid", String(process.pid), "--ref", ref], session.cwd, mode === "start" ? 3000 : 1500);
		} catch (err) {
			debug(`Kata attention skipped: ${(err as Error).message}`);
		}
	}

	// -------------------------------------------------------------- the host

	const sid = (ctx: any): string | undefined => ctx?.sessionManager?.getSessionId?.();
	const lead = (): Lead => ({ parent: plan.parent, workspace: plan.workspace, label: plan.label });
	// The session coordinator stays attached to the main context: a sub identity can reach a main-session handler (omp's advisor).
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
			if (currentId !== sid(ctx)) await bounded(serial(() => bind(ctx)), 3000);
			return;
		}
		const id = sid(ctx);
		if (!id) throw new Error("Pi child needs a real session identity before tracking work.");
		if (!parent.ref) {
			const workspace = parent.workspace;
			await serial(async () => { await probe(workspace); }); // after any bind in flight
			const project = candidate(workspace).project;
			let found: any[] = [];
			try { found = JSON.parse(await kata(["list", "--status", "all", ...(project ? ["--project", project] : []), "--meta", `${namespace}.session_id=${parent.sessionId}`, "--label", `${namespace}-session`, "--limit", "2", "--json"], workspace)).issues ?? []; }
			catch (error) { if (!project || !isKataCode(error, "project_not_initialized")) throw error; } // the project is not registered yet: no earlier parent
			const existing = found.find((issue: any) => issue.metadata?.[`${namespace}.auto_parent`] === true);
			if (existing) parent.ref = existing.qualified_id;
			else {
				// A session-start extension can spawn before the lead uses todo.
				// Establish only parent identity; the child never writes lead work.*.
				const where = await destination(workspace);
				parent.label ??= where.label;
				const out = JSON.parse(await kata(["create", "Todo plan: tasks", ...(where.project ? ["--project", where.project] : []), ...(where.label ? ["--label", where.label] : []), "--body", `Todo plan from ${namespace} session ${parent.sessionId}.`,
					"--teammate", parent.teammate,
					"--meta", `${namespace}.session_id=${parent.sessionId}`, "--meta", `${namespace}.workspace=${workspace}`, "--label", `${namespace}-session`,
					"--idempotency-key", `${namespace}-session:${parent.sessionId}`, "--force-new", "--json"], workspace));
				parent.ref = createdParentRef(out);
				if (!out.issue.owner) await kata(["claim", parent.ref!, "--if-unowned", "--teammate", parent.teammate], workspace);
				await kata(["meta", "set", parent.ref!, `${namespace}.auto_parent`, "true", "--json-value"], workspace);
			}
		}
		if (!parent.ref) throw new Error("Pi child parent identity is unavailable.");
		// The lead may have moved the parent since it exported its marker: the child's issue goes where the parent lives now.
		const binding: Binding = { parent: await pin(parent.ref, parent.workspace), workspace: parent.workspace, sessionId: parent.sessionId, auto: false, label: parent.label };
		// Keep a teammate the lead chose for this child; otherwise derive a distinct one.
		const chosen = process.env.KATA_TEAMMATE || "";
		const teammate = chosen && chosen !== parent.teammate && chosen !== parent.via && CHILD_TEAMMATE.test(chosen) ? chosen : teammateFor(`${parent.teammate || namespace}:${parent.sessionId}:${id}`);
		process.env.KATA_TEAMMATE = teammate;
		process.env.KATA_INBOX_USER = `${await actor(binding.workspace, binding.parent)}/${teammate}`;
		const scope = { parent: binding.parent, workspace: binding.workspace, label: binding.label, leadTeammate: parent.teammate, teammate };
		// A prompt the assignment rules refuse (two tickets, a taken task) tracks nothing.
		let reserved: Reservation | undefined, untracked = false;
		try { reserved = (await delegates.check([{ text: prompt }], [], scope))[0]; }
		catch (error) { debug(error); untracked = true; }
		await delegates.apply({ type: "started", id, sessionId: id, leadSessionId: parent.sessionId, leadTeammate: parent.teammate, teammate, text: prompt, single: true,
			parent: binding.parent, workspace: binding.workspace, parentLabel: binding.label, reserved, untracked });
		if (currentId !== sid(ctx)) await bounded(serial(() => bind(ctx)), 3000); // a delegate cannot learn its issue later
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
					await bind(ctx, explicit);
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
			// The user typed a new prompt: stop reminders count again from zero.
			input() { reminders = 0; },
			// The agent wants to stop: the reminder text while tasks remain open.
			stop(ctx: any, messages: any[]): Promise<string | undefined> {
				see(ctx);
				return remind(messages, ctx);
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
				await bounded(Promise.all([
					main(ctx) && currentId !== sid(ctx) ? serial(() => bind(ctx)) : undefined,
					(async () => { await prompt.after; if (context) await warmFor(ctx); })(),
				]), main(ctx) ? 250 : 3000); // a delegate cannot learn its issue later
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
			// Replaces the plan with these phases; the tasks they leave out close as wontfix.
			replace: (ctx: any, phases: { name: string; tasks: { content: string }[] }[]) =>
				execute({ op: "init", replace: true, list: phases.map(phase => ({ phase: phase.name, items: phase.tasks.map(task => task.content) })) }, ctx),
			command: (ctx: any, args: string) => command(args, ctx),
		},
		delegates: {
			apply: delegates.apply,
			// Refuses a spawn that cannot be delegated; otherwise says what each is matched to. `held`: refs other spawns of the same call reserved.
			check: (spawns: Spawn[], held?: Iterable<string>) => delegates.check(spawns, held),
			join,
		},
		// Open tickets for `#` autocomplete in the editor of the current session.
		tickets,
	};
}
