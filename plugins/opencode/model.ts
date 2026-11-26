// Generated from core/model.ts; edit there.
import { sha256Hex } from "./sha256";

// The plan vocabulary every core module shares: tasks, plan parents, Kata's issue shape and refs.

export type Status = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";
export const OPEN: ReadonlySet<Status> = new Set(["pending", "in_progress", "blocked"]);
export const WORKING: ReadonlySet<Status> = new Set(["in_progress", "blocked"]);
const openTaskStatus = (value: unknown): Status => value === "in_progress" || value === "blocked" ? value : "pending";
export const closedTaskStatus = (closedReason?: string): "completed" | "abandoned" => closedReason === "wontfix" ? "abandoned" : "completed";
// `released`: started in Kata but marked by no session (its session released it).
// `holder`: another lead session that started this plan task and has not released it (see heldBySession).
export type Task = { ref: string; content: string; phase: string; status: Status; ticket?: string; at?: number; blocker?: string; delegated?: boolean; holder?: string; released?: boolean; review?: boolean; revision?: number; proof?: { message?: string; evidence?: string[] } };
export type Binding = { parent: string; workspace: string; sessionId?: string; auto?: boolean; label?: string };
export type Plan = Partial<Binding> & { workspace: string; tasks: Task[]; local?: boolean; error?: string };
export type Change = { message?: string; evidence?: string[]; reason?: string; remove?: boolean };
// What Kata's close as done needs: evidence, and a message of PROOF_MIN characters (whitespace runs count as one).
export const PROOF_MIN = 40;
// What Kata's close as wontfix needs: a message of WONTFIX_MIN characters.
export const WONTFIX_MIN = 60;
// What `change` lacks of that, as the clause that finishes "cannot be completed without"; undefined when it has proof.
export function proofProblem(change: { message?: string; evidence?: string[] }): string | undefined {
	const message = (change.message || "").replace(/\s+/g, " ").trim().length < PROOF_MIN;
	const evidence = !change.evidence?.some(e => e.trim());
	if (message && evidence) return `a message (${PROOF_MIN}+ characters saying what changed and how it was verified) and evidence`;
	if (message) return `a message of ${PROOF_MIN}+ characters saying what changed and how it was verified`;
	if (evidence) return "evidence";
}
// The longest issue title the plugin writes (automatic parents, missions).
export const TITLE_MAX = 120;

// An issue as `kata show --json` prints it, and each of its children; only the fields the plugin reads.
// `qualified_id` is printed on children, not on the shown issue itself. Labels are strings (Kata 0.21); the object form is older output.
export type KataIssue = {
	uid: string; short_id: string; qualified_id?: string; project_id: number; title: string;
	status: "open" | "closed"; closed_reason?: string; closed_at?: string; created_at: string;
	revision: number; owner?: string; labels?: (string | { label: string })[]; metadata?: Record<string, unknown>;
};
type KataComment = { body: string; teammate?: string };
export type KataShow = { issue: KataIssue; children?: KataIssue[]; comments?: KataComment[] };

// The plan task metadata key naming the lead session that created the task, then the one that last started or blocked it.
export const SESSION_KEY = "todo.session";
// The session holding an open, started or blocked plan task, when it is none of `own` (this session and the sessions it was
// forked from). Pending and closed tasks, tasks without the key and other issues are held by no session. No `own`: unknown.
export function heldBySession(issue: Pick<KataIssue, "status" | "metadata">, own: readonly string[]): string | undefined {
	const meta = issue.metadata, session = meta?.[SESSION_KEY];
	if (!own.length || issue.status !== "open" || typeof meta?.["todo.phase"] !== "string" || typeof session !== "string" || !session) return undefined;
	return WORKING.has(openTaskStatus(meta["todo.status"])) && !own.includes(session) ? session : undefined;
}
// The start of every refusal for a plan task another session holds.
export const heldMessage = (ref: string, holder: string) => `Plan task ${ref} was started by another session (${holder}), which has not released it`;

// Whether an issue carries `label`; Kata lists labels as strings or as `{ label }` objects.
export const hasLabel = (issue: Pick<KataIssue, "labels">, label: string) => (issue.labels ?? []).some(l => (typeof l === "string" ? l : l?.label) === label);

// Kata children as plan tasks, oldest first. Which children are plan tasks is the caller's choice (a lead's plan holds those with
// a phase; a pi child may also name any other open child). What only the asker knows is its own: whether a delegate of another
// teammate holds a task, and which session started it.
export function tasksOf(children: readonly KataIssue[], parent: string, rule: { delegated(issue: KataIssue): boolean; holder(issue: KataIssue): string | undefined }): Task[] {
	return [...children]
		.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
		.map(c => {
			const meta = c.metadata ?? {};
			let status: Status;
			if (c.status === "closed") status = meta["todo.status"] === "abandoned" ? "abandoned" : closedTaskStatus(c.closed_reason);
			else status = openTaskStatus(meta["todo.status"]);
			return {
				ref: qualifiedRef(c, parent),
				content: c.title,
				phase: typeof meta["todo.phase"] === "string" ? meta["todo.phase"] : "",
				revision: c.revision,
				at: Date.parse(c.created_at),
				delegated: rule.delegated(c),
				holder: rule.holder(c),
				released: status === "in_progress" && !meta[SESSION_KEY] ? true : undefined,
				review: hasLabel(c, "needs-review"),
				status,
				blocker: status === "blocked" ? meta["work.attention_msg"] as string | undefined : undefined,
			};
		});
}

// A mission: the issue the plugin makes, under the plan parent, to record the run of a delegate that had no issue of its own
// (see delegates.ts). It is closed without proof of a change, so it adds no evidence to its parent's close.
export const missionKey = (namespace: string) => `${namespace}.mission`;
export const isMission = (namespace: string, issue: Pick<KataIssue, "metadata">) => issue.metadata?.[missionKey(namespace)] === "true";
// The close of a mission, by its delegate's settle or, when that settle could not close it (cut off, killed, a pi child's close
// throttled), by the automatic parent's audit. The message names the mission: with Kata's close throttle on, a close that
// repeats a sibling's message is refused (`duplicate_message`).
export const missionCloseArgs = (ref: string) => ["close", ref, "--audit-no-change", "--message", `${ref} records the run of a subagent that had no Kata issue of its own; its report is in the comments. The lead verifies any change the run made.`,
	"--evidence", "no-change-audit:Records a subagent run, not a verified change; any change the run made is the lead's to verify."];

// What marks a session's automatic parent, the issue the plugin makes for a plan that serves no existing one: its metadata
// keys (the flag, the session that owns it, the workspace it was made from) and its label.
export const sessionParentKeys = (namespace: string) => ({ auto: `${namespace}.auto_parent`, session: `${namespace}.session_id`, workspace: `${namespace}.workspace`, label: `${namespace}-session` });

// The text of a message's content: a plain string, or its text blocks joined.
export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.filter(b => b?.type === "text" && typeof b.text === "string").map(b => b.text).join("\n") : "";
}
// A delegate's report out of its messages' contents, oldest first: the text of the last one that has any (a failed or cut-off
// turn can end on one without).
export const lastText = (contents: readonly unknown[]): string | undefined => contents.map(content => textOf(content).trim()).filter(Boolean).at(-1);

// How a host's todo tool is named and used, in the advice its model reads: every message of the core names the host's own tool.
export interface ToolWording {
	tool: string;
	// Sentences: how to load the plan again, how to make one, and the same as the step a call skipped.
	refresh: string;
	plan: string;
	planFirst: string;
	// What to do about open tasks a new plan leaves out.
	leftOut: string;
	// Clauses: how to repeat a refused call as a takeover, how to take a held task over before delegating it, and how to plan
	// work as child issues of `ticket`.
	retryTakeover: string;
	takeOverFirst: string;
	planUnder(ticket: string): string;
	// What the host calls its own todo list in the notes and comments the core writes when it mirrors that list; absent: "the todo list".
	list?: string;
}
// The `todo` tool of pi, which takes ops. (omp's own tool takes the same ops, but has no takeover or ref parameter: see NATIVE_WORDING.)
export const TODO_WORDING: ToolWording = {
	tool: "todo",
	refresh: "Use todo op=view to refresh.",
	plan: "Use todo op=init.",
	planFirst: "Call todo op=init first.",
	leftOut: "To replace them, call init again with replace: true.",
	retryTakeover: "repeat the call with takeover: true",
	takeOverFirst: "todo start with takeover: true",
	planUnder: ticket => `todo init with ref ${ticket}`,
};

// omp's own todo tool, whose list is mirrored into Kata. It has no `replace`, `takeover` or `ref` parameter: a held task is taken over by
// the user's `/todo takeover`, and the plan parent is set by `kata claim` or `/todo ref`.
export const NATIVE_WORDING: ToolWording = {
	...TODO_WORDING,
	leftOut: "Keep them in the list, or todo drop them first (todo append any that omp's list lacks), then call init again.",
	retryTakeover: "ask the user to run /todo takeover with the task's text",
	takeOverFirst: "ask the user to run /todo takeover with the task's text",
	// The plan already has its parent when this is read, and a parent never changes: work several items share is split into child issues of the ticket.
	planUnder: ticket => `create each one with kata create --parent ${ticket}`,
	list: "omp's todo list",
};

export const projectOf = (ref: string) => ref.split("#")[0];
// An issue's qualified ref: Kata's own `qualified_id`, else `<parent's project>#<short_id>`.
export function qualifiedRef(issue: { qualified_id?: string; short_id: string }, parent: string): string {
	return issue.qualified_id || `${projectOf(parent)}#${issue.short_id}`;
}

// One character of a Kata id: lowercase Crockford base32 (no i, l, o, u).
const ID_CHAR = "[0-9a-hjkmnp-tv-z]";
// Kata's qualified ref `<project>#<short_id>`. A short_id is 4 to 26 id
// characters; a project name is one token of word characters, dots and
// dashes (Kata allows more, but a token that can be told apart in prose
// needs no spaces). The source is anchored by lookarounds only, so the one
// source parses a strict prefix (`itemTicket`) and scans text for
// whole-token refs (`qualifiedRefs`).
const QUALIFIED_REF = `(?<![\\w./#-])[A-Za-z0-9_][\\w.-]*#${ID_CHAR}{4,26}(?![\\w-])`;
export const QUALIFIED_REF_ONLY = new RegExp(`^${QUALIFIED_REF}$`, "i");
// An issue's short id on its own; a shell word that holds `$` or a glob is no ref.
export const SHORT_ID_ONLY = new RegExp(`^${ID_CHAR}{4,26}$`, "i");
// A ref that ends in an issue's full 26-character id, bare or after a project: a plan task's ref carries the short id, so Kata resolves this one.
export const FULL_ID_REF = new RegExp(`(?:^|#)${ID_CHAR}{26}$`, "i");
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

// Valid for Kata labels and safe inside a project#id ref.
export function slug(text: string | undefined, keepCase = false): string | undefined {
	const value = (keepCase ? text ?? "" : (text ?? "").toLowerCase()).replace(keepCase ? /[^A-Za-z0-9._-]+/g : /[^a-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "").slice(0, 64).replace(/[-._]+$/, "");
	return value || undefined;
}

export function digest(...parts: string[]): string {
	return sha256Hex(parts.join("\u0000")).slice(0, 24);
}
