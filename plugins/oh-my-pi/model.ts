import { createHash } from "node:crypto";

// The plan vocabulary every core module shares: tasks, plan parents, Kata's issue shape and refs.

export type Status = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";
export const OPEN: ReadonlySet<Status> = new Set(["pending", "in_progress", "blocked"]);
export const WORKING: ReadonlySet<Status> = new Set(["in_progress", "blocked"]);
// An open plan task's status from its `todo.status` metadata: anything but started or blocked is pending.
export const openTaskStatus = (value: unknown): Status => value === "in_progress" || value === "blocked" ? value : "pending";
export type Task = { ref: string; content: string; phase: string; status: Status; ticket?: string; at?: number; blocker?: string; delegated?: boolean; review?: boolean; revision?: number; proof?: { message?: string; evidence?: string[] } };
export type Binding = { parent: string; workspace: string; sessionId?: string; auto?: boolean; label?: string };
export type Plan = Partial<Binding> & { workspace: string; tasks: Task[]; local?: boolean; error?: string };
export type Change = { message?: string; evidence?: string[]; reason?: string; remove?: boolean };

// An issue as `kata show --json` prints it, and each of its children; only the fields the plugin reads.
// `qualified_id` is printed on children, not on the shown issue itself. Labels are strings (Kata 0.21); the object form is older output.
export type KataIssue = {
	uid: string; short_id: string; qualified_id?: string; project_id: number; title: string;
	status: "open" | "closed"; closed_reason?: string; closed_at?: string; created_at: string;
	revision: number; owner?: string; labels?: (string | { label: string })[]; metadata?: Record<string, unknown>;
};
export type KataShow = { issue: KataIssue; children?: KataIssue[] };

export const projectOf = (ref: string) => ref.split("#")[0];
// An issue's qualified ref: Kata's own `qualified_id`, else `<parent's project>#<short_id>`.
export function qualifiedRef(issue: { qualified_id?: string; short_id: string }, parent: string): string {
	return issue.qualified_id || `${projectOf(parent)}#${issue.short_id}`;
}

// Kata's qualified ref `<project>#<short_id>`. A short_id is 4 to 26 lowercase
// Crockford base32 characters (no i, l, o, u); a project name is one token of
// word characters, dots and dashes (Kata allows more, but a token that can be
// told apart in prose needs no spaces). The source is anchored by lookarounds
// only, so the one source parses a strict prefix (`itemTicket`) and scans text
// for whole-token refs (`qualifiedRefs`).
const QUALIFIED_REF = "(?<![\\w./#-])[A-Za-z0-9_][\\w.-]*#[0-9a-hjkmnp-tv-z]{4,26}(?![\\w-])";
export const QUALIFIED_REF_ONLY = new RegExp(`^${QUALIFIED_REF}$`, "i");
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
	return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24);
}

export function quote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }
