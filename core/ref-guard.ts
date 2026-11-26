import { ASSIGNMENT, commandSegments, PREFIXES } from "./shell";
import { qualifiedRefs } from "./model";

// Kata refs resolve only in the local tracker, so a write or commit that puts one into the repository is refused. This module is the
// pure part: which refs a tool call would add, never ones the text it replaces, or the file it changes, already holds.

// Text a call adds. `files` are the places it goes: undefined means anywhere (a commit message), and files that lie outside the
// workspace make it no repository content. `old` is the text it replaces; without it the file's current text is what it keeps.
type Added = { files?: string[]; text: string; old?: string };

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const fields = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(fields) : [];
const INTERNAL_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

// The `+` rows of a hashline edit (`[path#tag]` sections) or an apply_patch body (`*** Add File: path`). Headers and context rows are never text.
function plusRows(patch: string): Added[] {
	const rows = new Map<string, string[]>();
	let file: string | undefined;
	for (const line of patch.split("\n")) {
		const header = /^\[(.+)#[^#\]]+\]\s*$/.exec(line) ?? /^\*\*\* (?:Add File|Update File|Move to):\s*(.+?)\s*$/.exec(line);
		if (header) { file = header[1]; continue; }
		if (file && line.startsWith("+")) rows.set(file, [...rows.get(file) ?? [], line.slice(1)]);
	}
	return [...rows].map(([name, lines]) => ({ files: [name], text: lines.join("\n") }));
}

const addedRows = (diff: string, file: string | undefined): Added => ({ files: file ? [file] : undefined, text: diff.split("\n").filter(line => line.startsWith("+")).map(line => line.slice(1)).join("\n") });

// Git global options that take a value, which `git -C dir commit` puts before the subcommand.
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

// The message of every `git commit` in a shell command: `-m`, `--message`, `-am` and, for `-F -`, the heredoc fed to it.
// Its other words (--author, --trailer, pathspecs) are not the message.
function commitMessages(command: string): Added[] {
	const added: Added[] = [];
	const segments = commandSegments(command);
	for (const [index, { words, bodies: own }] of segments.entries()) {
		// Stdin is the heredoc of this command, or of the one before it (`cat <<EOF | git commit -F -`).
		const bodies = own.length ? own : segments[index - 1]?.bodies ?? [];
		let at = 0;
		while (at < words.length && (ASSIGNMENT.test(words[at].value) || PREFIXES.includes(words[at].value))) at++;
		if (!/(^|\/)git$/.test(words[at]?.value ?? "")) continue;
		const dirs: string[] = [];
		for (at++; at < words.length && words[at].value.startsWith("-"); at += GIT_VALUE_OPTIONS.has(words[at].value) ? 2 : 1) if (words[at].value === "-C" && words[at + 1]) dirs.push(words[at + 1].value);
		if (words[at]?.value !== "commit") continue;
		const rest = words.slice(at + 1).map(word => word.value), parts: string[] = [];
		for (let n = 0; n < rest.length; n++) {
			const word = rest[n];
			if (/^-[a-zA-Z]*m$/.test(word) || word === "--message") { if (rest[n + 1] !== undefined) parts.push(rest[++n]); }
			else if (word.startsWith("--message=")) parts.push(word.slice(10));
			else if (/^-m./.test(word)) parts.push(word.slice(2));
			else if (word === "-F-" || word === "--file=-" || ((word === "-F" || word === "--file") && rest[n + 1] === "-")) parts.push(...bodies);
		}
		added.push({ files: dirs.length ? dirs : undefined, text: parts.join("\n") });
	}
	return added;
}

// What a call adds to files. A tool this does not know adds nothing.
function addedBy(tool: string, input: unknown): Added[] {
	const call = fields(input), file = text(call.path) ?? text(call.file_path) ?? text(call.notebook_path);
	const files = file ? [file] : undefined;
	// A replacement: its new text, and the text it replaces (any of the spellings the hosts use).
	const replaced = (edit: Record<string, unknown>): Added[] => {
		const added = text(edit.newText) ?? text(edit.new_string) ?? text(edit.newString) ?? text(edit.new_text) ?? text(edit.new_str);
		return added === undefined ? [] : [{ files, text: added, old: text(edit.oldText) ?? text(edit.old_string) ?? text(edit.oldString) ?? text(edit.old_text) ?? text(edit.old_str) }];
	};
	switch (tool.toLowerCase()) {
		case "write": return text(call.content) === undefined ? [] : [{ files, text: call.content as string }];
		case "edit": case "multiedit": {
			const added = [...text(call.input) ? plusRows(call.input as string) : [], ...replaced(call)];
			for (const edit of records(call.edits)) {
				added.push(...replaced(edit));
				const diff = text(edit.diff);
				// A created file's diff is its whole body; any other diff marks what it adds with `+`.
				if (diff !== undefined) added.push(edit.op === "create" ? { files, text: diff } : addedRows(diff, file));
			}
			return added;
		}
		case "notebookedit": return text(call.new_source) === undefined ? [] : [{ files, text: call.new_source as string }];
		case "apply_patch": case "patch": return [call.input, call.patchText, call.patch].flatMap(patch => typeof patch === "string" ? plusRows(patch) : []);
		case "ast_edit": {
			const paths = (Array.isArray(call.paths) ? call.paths : [call.paths ?? call.path]).filter((p): p is string => typeof p === "string");
			return records(call.ops).flatMap(op => typeof op.out === "string" ? [{ files: paths.length ? paths : ["."], text: op.out }] : []);
		}
		case "bash": case "shell": return typeof call.command === "string" ? commitMessages(call.command) : [];
		default: return [];
	}
}

export interface RefGuardCall {
	// The host's tool name and its input, as the tool receives them.
	tool: string;
	input: unknown;
	// The canonical path of a file or folder as the call wrote it, when it lies in the session's workspace; undefined outside it.
	locate(file: string): Promise<string | undefined>;
	// A file's current text; rejects when it cannot be read, which counts as empty.
	read(file: string): Promise<string>;
	// The qualified refs the session knows. A bare short id counts when it is the id of one of these.
	refs: ReadonlySet<string>;
}

// The known refs `body` names: a qualified ref of a known project (`README.md#tasks` and a hashline tag look the same but name none),
// or a known short id on its own (the `namedTasks` boundary).
function refsIn(body: string, projects: ReadonlySet<string>, shortIds: readonly string[]): string[] {
	const found = qualifiedRefs(body, projects);
	for (const id of shortIds) if (new RegExp(`(?<![\\w./#-])${escape(id)}(?![\\w-])`).test(body)) found.push(id);
	return found;
}

// The refs a call would add to repository content, in order of appearance; empty when it adds none. Files outside the workspace and
// internal URLs are not repository content.
export async function offendingRefs(call: RefGuardCall): Promise<string[]> {
	const known = [...call.refs];
	const shortIds = [...new Set(known.map(ref => ref.slice(ref.lastIndexOf("#") + 1)))];
	const projects = new Set(known.filter(ref => ref.includes("#")).map(ref => ref.slice(0, ref.lastIndexOf("#"))));
	if (!shortIds.length) return [];
	const found = new Set<string>();
	for (const added of addedBy(call.tool, call.input)) {
		const candidates = refsIn(added.text, projects, shortIds);
		if (!candidates.length) continue;
		let located: string | undefined;
		if (added.files) {
			for (const file of added.files.filter(name => !INTERNAL_URL.test(name))) if ((located = await call.locate(file))) break;
			if (!located) continue;
		}
		const before = added.old ?? (located ? await call.read(located).catch(() => "") : "");
		const held = new Set(refsIn(before, projects, shortIds));
		for (const ref of candidates) if (!held.has(ref)) found.add(ref);
	}
	return [...found];
}
