// Generated from core/ref-guard.ts; edit there.
import { ASSIGNMENT, commandSegments, PREFIXES } from "./shell";
import { projectOf, qualifiedRefs } from "./model";

// Kata refs resolve only in the local tracker, so a write or commit that puts one into the repository is refused. This module is the
// pure part: which refs a tool call would add, never ones the text it replaces, or the file it changes, already holds.

// Text a call adds. `files` are the places it goes: undefined means anywhere, and files that lie outside the workspace make it no
// repository content. `old` is the text it replaces; the call's refs are held by that and by what the files already say.
type Added = { files?: string[]; text: string; old?: string };

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const asString = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const fields = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(fields) : [];
const INTERNAL_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

// A patch's rows, per target file. Every row but the headers that name a target is candidate text, with a leading `+`, `-` or space marker
// stripped: whatever a format calls its actions, new text sits in some row. Search text, context and removed rows are in the file already, whose
// refs the caller holds, so counting them is harmless. The format is chosen first, and only its own headers name targets (`*** Begin|End Patch`
// at the top level are skipped in every format):
// - hashline, when the first row is `[path#tag]`: those rows;
// - sloppy (omp's `*** Edit File:` / `*** Find` / `*** Replace`), when any opener or action row of it is there: `*** Edit File:` rows, which may
//   continue the current file with an empty path or `all`, and a first-row `*** Update File:`; its other `***` rows are text;
// - otherwise apply_patch: `*** Add|Update|Delete File:` and `*** Move to:` (naming a second place for the file).
const HASHLINE = /^\[(.+)#[^#\]]+\]\s*$/, SLOPPY = /^\s*\*{3}\s+(?:Edit\s+File|Find|Replace|Insert|Cut|Paste)\b/im;
const SLOPPY_FILE = /^\s*\*{3}\s+Edit\s+File:?(.*)$/i, SLOPPY_FIRST = /^\s*\*{3}\s+Update\s+File:?(.*)$/i;
const APPLY_FILE = /^\s*\*{3}\s+(?:Add|Update|Delete)\s+File:(.*)$/i, MOVE_HEADER = /^\s*\*{3}\s+Move\s+to:\s*(.+?)\s*$/i, ENVELOPE = /^\s*\*{3}\s+(?:Begin|End)\s+Patch\s*$/i;

function patchRows(patch: string): Added[] {
	const lines = patch.split("\n").map(line => line.replace(/\r$/, ""));
	const start = lines.findIndex(line => line.trim());
	const format = start >= 0 && HASHLINE.test(lines[start]) ? "hashline" : SLOPPY.test(patch) ? "sloppy" : "apply";
	let last = lines.length - 1;
	while (last > 0 && !lines[last].trim()) last--;
	const groups: { files: string[]; rows: string[] }[] = [];
	let group: { files: string[]; rows: string[] } | undefined;
	for (const [at, line] of lines.entries()) {
		const hashline = format === "hashline" && HASHLINE.exec(line);
		const sloppy = format === "sloppy" && (SLOPPY_FILE.exec(line) ?? (at === start ? SLOPPY_FIRST.exec(line) : null));
		const apply = format === "apply" && APPLY_FILE.exec(line);
		if (hashline || sloppy || apply) {
			// Sloppy: an optional path, then an optional ` all`; without a path the patch goes on with the current file.
			let name = hashline ? hashline[1] : sloppy ? sloppy[1].trim().replace(/(?:^|\s)all$/i, "").trim() : apply ? apply[1].trim() : "";
			if (name.startsWith('"')) try { name = JSON.parse(name); } catch { /* as written */ }
			if (name) { group = { files: [name], rows: [] }; groups.push(group); }
			continue;
		}
		const moved = format === "apply" && MOVE_HEADER.exec(line);
		if (moved) { group?.files.push(moved[1]); continue; }
		if (ENVELOPE.test(line) && (!group || at === last)) continue;
		group?.rows.push(/^[-+ ]/.test(line) ? line.slice(1) : line);
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
	// Where each command runs: the call's folder, moved by a `cd` before it, then by `git -C` values in order (absolute replaces, relative appends).
	const fold = (base: string | undefined, dir: string) => dir.startsWith("/") || dir.startsWith("~") || !base ? dir : `${base.replace(/\/+$/, "")}/${dir}`;
	let base = cwd;
	const segments = commandSegments(command);
	for (const [index, { words, bodies: own }] of segments.entries()) {
		// Stdin is the heredoc of this command, or of the one before it (`cat <<EOF | git commit -F -`).
		const bodies = own.length ? own : segments[index - 1]?.bodies ?? [];
		let at = 0;
		while (at < words.length && (ASSIGNMENT.test(words[at].value) || PREFIXES.includes(words[at].value))) at++;
		if (words[at]?.value === "cd" && words[at + 1] && !words[at + 1].value.startsWith("-")) base = fold(base, words[at + 1].value);
		if (!/(^|\/)git$/.test(words[at]?.value ?? "")) continue;
		let place = base;
		for (at++; at < words.length && words[at].value.startsWith("-"); at += GIT_VALUE_OPTIONS.has(words[at].value) ? 2 : 1) if (words[at].value === "-C" && words[at + 1]) place = fold(place, words[at + 1].value);
		if (words[at]?.value !== "commit") continue;
		const rest = words.slice(at + 1).map(word => word.value), parts: string[] = [];
		for (let n = 0; n < rest.length; n++) {
			const word = rest[n], short = !word.startsWith("--") && /^-([a-zA-Z]*?)m([\s\S]*)$/.exec(word);
			if (word === "--message") { if (rest[n + 1] !== undefined) parts.push(rest[++n]); }
			else if (word.startsWith("--message=")) parts.push(word.slice(10));
			else if (short && !SHORT_WITH_VALUE.test(short[1])) { if (short[2]) parts.push(short[2]); else if (rest[n + 1] !== undefined) parts.push(rest[++n]); }
			else if (word === "-F-" || word === "--file=-" || ((word === "-F" || word === "--file") && rest[n + 1] === "-")) parts.push(...bodies);
		}
		added.push({ files: place === undefined ? undefined : [place], text: parts.join("\n") });
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
	locate(file: string): Promise<string | undefined>;
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
			for (const file of added.files.filter(name => !INTERNAL_URL.test(name))) { const place = await call.locate(file); if (place) located.push(place); }
			if (!located.length) continue;
		}
		// Held: what the call replaces and what the files it changes already say.
		const before = [added.old ?? "", ...await Promise.all(located.map(file => call.read(file).catch(() => "")))].join("\n");
		const held = new Set(refsIn(before, projects, shortIds));
		for (const ref of candidates) if (!held.has(ref)) found.add(ref);
	}
	return [...found];
}
