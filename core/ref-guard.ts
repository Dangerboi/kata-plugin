import { ASSIGNMENT, commandSegments, PREFIXES } from "./shell";
import { projectOf, qualifiedRefs } from "./model";

// Kata refs resolve only in the local tracker, so a write or commit that puts one into the repository is refused. This module is the
// pure part: which refs a tool call would add, never ones the text it replaces, or the file it changes, already holds.

// Text a call adds. `files` are the places it goes: undefined means anywhere (a commit message), and files that lie outside the
// workspace make it no repository content. `old` is the text it replaces; without it the file's current text is what it keeps.
type Added = { files?: string[]; from?: string; text: string; old?: string };

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const asString = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const fields = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(fields) : [];
const INTERNAL_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

// The rows a patch adds, per file: `+` rows of a hashline edit (`[path#tag]` sections) or an apply_patch body (`*** Add|Update File:`, with
// `*** Move to:` naming a second place), and the new text of omp's sloppy edit (`*** Edit File:`, then `*** Find` for the old side and
// `*** Replace`, `*** Replace Block: opener`, `*** Insert` or `*** Paste Before|After` followed by raw rows). Headers, context and
// old-side rows are never text.
function patchRows(patch: string): Added[] {
	const groups: { files: string[]; rows: string[] }[] = [];
	let group: { files: string[]; rows: string[] } | undefined, collecting = false;
	for (const line of patch.split("\n")) {
		const hashline = /^\[(.+)#[^#\]]+\]\s*$/.exec(line), named = /^\*\*\* (?:Add|Update|Edit) File:\s*(.+?)(?: all)?\s*$/.exec(line);
		if (hashline || named) { group = { files: [(hashline ?? named)![1]], rows: [] }; groups.push(group); collecting = false; continue; }
		const moved = /^\*\*\* Move to:\s*(.+?)\s*$/.exec(line);
		if (moved) { group?.files.push(moved[1]); continue; }
		if (/^\*\*\* [A-Z]/.test(line)) { collecting = /^\*\*\* (?:Replace|Insert|Paste)\b/.test(line); continue; }
		if (!group) continue;
		if (collecting) group.rows.push(line);
		else if (line.startsWith("+")) group.rows.push(line.slice(1));
	}
	return groups.filter(g => g.rows.length).map(g => ({ files: g.files, text: g.rows.join("\n") }));
}

const addedRows = (diff: string, file: string | undefined): Added => ({ files: file ? [file] : undefined, text: diff.split("\n").filter(line => line.startsWith("+")).map(line => line.slice(1)).join("\n") });

// Git global options that take a value, which `git -C dir commit` puts before the subcommand.
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
// Short flags of `git commit` that take a value; a cluster such as `-am"msg"` is `-a` and `-m` with its text attached.
const SHORT_WITH_VALUE = /[FCctSu]/;

// The message of every `git commit` in a shell command: `-m`, `--message`, `-am` (the text may be attached) and, for `-F -`, the heredoc or
// here-string fed to it. Its other words (--author, --trailer, pathspecs) are not the message. `cwd`: where the bash call runs.
function commitMessages(command: string, cwd: string | undefined): Added[] {
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
			const word = rest[n], short = !word.startsWith("--") && /^-([a-zA-Z]*?)m([\s\S]*)$/.exec(word);
			if (word === "--message") { if (rest[n + 1] !== undefined) parts.push(rest[++n]); }
			else if (word.startsWith("--message=")) parts.push(word.slice(10));
			else if (short && !SHORT_WITH_VALUE.test(short[1])) { if (short[2]) parts.push(short[2]); else if (rest[n + 1] !== undefined) parts.push(rest[++n]); }
			else if (word === "-F-" || word === "--file=-" || ((word === "-F" || word === "--file") && rest[n + 1] === "-")) parts.push(...bodies);
		}
		added.push({ files: dirs.length ? dirs : cwd ? [cwd] : undefined, from: dirs.length ? cwd : undefined, text: parts.join("\n") });
	}
	return added;
}

// What a call adds to files. A tool this does not know adds nothing.
function addedBy(tool: string, input: unknown): Added[] {
	const call = fields(input), file = asString(call.path) ?? asString(call.file_path) ?? asString(call.notebook_path);
	const files = file ? [file] : undefined;
	const whole = (value: unknown): Added[] => typeof value === "string" ? [{ files, text: value }] : [];
	// A replacement: its new text, and the text it replaces (any of the spellings the hosts use).
	const replaced = (edit: Record<string, unknown>): Added[] => {
		const added = asString(edit.newText) ?? asString(edit.new_string) ?? asString(edit.newString) ?? asString(edit.new_text) ?? asString(edit.new_str);
		return added === undefined ? [] : [{ files, text: added, old: asString(edit.oldText) ?? asString(edit.old_string) ?? asString(edit.oldString) ?? asString(edit.old_text) ?? asString(edit.old_str) }];
	};
	switch (tool.toLowerCase()) {
		case "write": return whole(call.content);
		case "edit": case "multiedit": {
			const added = [...asString(call.input) ? patchRows(call.input as string) : [], ...replaced(call)];
			for (const edit of records(call.edits)) {
				added.push(...replaced(edit));
				const diff = asString(edit.diff);
				// A created file's diff is its whole body; any other diff marks what it adds with `+`.
				if (diff !== undefined) added.push(edit.op === "create" ? { files, text: diff } : addedRows(diff, file));
			}
			return added;
		}
		case "notebookedit": return whole(call.new_source);
		case "apply_patch": case "patch": return [call.input, call.patchText, call.patch].flatMap(patch => typeof patch === "string" ? patchRows(patch) : []);
		case "ast_edit": {
			const paths = (Array.isArray(call.paths) ? call.paths : [call.paths ?? call.path]).filter((p): p is string => typeof p === "string");
			return records(call.ops).flatMap(op => typeof op.out === "string" ? [{ files: paths.length ? paths : ["."], text: op.out }] : []);
		}
		case "bash": case "shell": return typeof call.command === "string" ? commitMessages(call.command, asString(call.cwd) ?? asString(call.workdir)) : [];
		default: return [];
	}
}

export interface RefGuardCall {
	// The host's tool name and its input, as the tool receives them.
	tool: string;
	input: unknown;
	// The canonical path of a file or folder as the call wrote it, when it lies in the session's workspace; undefined outside it.
	// `from`: the folder a relative `file` is relative to, when it is not the session's (a bash call's own `cwd`).
	locate(file: string, from?: string): Promise<string | undefined>;
	// A file's current text; rejects when it cannot be read, which counts as empty.
	read(file: string): Promise<string>;
	// The qualified refs the session knows; a bare short id counts when it is the id of one of these. Asked only when the call adds text, so
	// a host that has to wait for them (a delegate on another thread) never does for a call that adds none.
	known(): Promise<ReadonlySet<string>>;
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
	const adds = addedBy(call.tool, call.input);
	if (!adds.length) return [];
	const known = [...await call.known()];
	const shortIds = [...new Set(known.map(ref => ref.slice(ref.lastIndexOf("#") + 1)))];
	const projects = new Set(known.filter(ref => ref.includes("#")).map(ref => projectOf(ref)));
	if (!shortIds.length) return [];
	const found = new Set<string>();
	for (const added of adds) {
		const candidates = refsIn(added.text, projects, shortIds);
		if (!candidates.length) continue;
		const located: string[] = [];
		if (added.files) {
			for (const file of added.files.filter(name => !INTERNAL_URL.test(name))) { const place = await call.locate(file, added.from); if (place) located.push(place); }
			if (!located.length) continue;
		}
		// Held: what the call replaces and what the files it changes already say.
		const before = [added.old ?? "", ...await Promise.all(located.map(file => call.read(file).catch(() => "")))].join("\n");
		const held = new Set(refsIn(before, projects, shortIds));
		for (const ref of candidates) if (!held.has(ref)) found.add(ref);
	}
	return [...found];
}
