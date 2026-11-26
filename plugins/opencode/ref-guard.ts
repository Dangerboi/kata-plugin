// Generated from core/ref-guard.ts; edit there.
import { commandSegments } from "./shell";
import { qualifiedRefs } from "./model";

// Kata refs resolve only in the local tracker, so a write or commit that puts one into the repository is refused. This module is the
// pure part: which refs a tool call would add, never what it removes or leaves.

// Text a call adds, and the files it goes to. `files` empty means the text goes nowhere that counts (a commit message, which is checked anywhere).
type Added = { files: string[] | undefined; text: string };

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const str = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const rec = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const list = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(rec) : [];
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

const diffRows = (diff: string, file: string | undefined): Added[] => [{ files: file ? [file] : undefined, text: diff.split("\n").filter(line => line.startsWith("+")).map(line => line.slice(1)).join("\n") }];

// Git global options that take a value, which `git -C dir commit` puts before the subcommand.
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

// Every `git commit` in a shell command: its words (the message is one, or `-am text`) and, for `-F -`, its heredoc body.
function commitText(command: string): Added[] {
	const added: Added[] = [];
	for (const { words, bodies } of commandSegments(command)) {
		let i = 0;
		while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i].value)) i++;
		if (!/(^|\/)git$/.test(words[i]?.value ?? "")) continue;
		for (i++; i < words.length && words[i].value.startsWith("-"); i += GIT_VALUE_OPTIONS.has(words[i].value) ? 2 : 1);
		if (words[i]?.value !== "commit") continue;
		const rest = words.slice(i + 1).map(word => word.value);
		const fromStdin = rest.some((word, at) => word === "--file=-" || word === "-F-" || ((word === "-F" || word === "--file") && rest[at + 1] === "-"));
		added.push({ files: undefined, text: [...rest, ...fromStdin ? bodies : []].join("\n") });
	}
	return added;
}

// What a call adds to files. A tool this does not know adds nothing.
function addedBy(tool: string, input: unknown): Added[] {
	const call = rec(input), file = str(call.path) ?? str(call.file_path) ?? str(call.notebook_path);
	const one = (text: unknown): Added[] => typeof text === "string" ? [{ files: file ? [file] : undefined, text }] : [];
	switch (tool.toLowerCase()) {
		case "write": return one(call.content);
		case "edit": case "multiedit": {
			const added = [...typeof call.input === "string" ? plusRows(call.input) : [], ...one(call.new_string), ...one(call.newString), ...one(call.newText)];
			for (const edit of list(call.edits)) added.push(...one(edit.newText), ...one(edit.new_string), ...one(edit.newString), ...typeof edit.diff === "string" ? diffRows(edit.diff, file) : []);
			return added;
		}
		case "notebookedit": return one(call.new_source);
		case "apply_patch": case "patch": return [call.input, call.patchText, call.patch].flatMap(patch => typeof patch === "string" ? plusRows(patch) : []);
		case "ast_edit": {
			const paths = (Array.isArray(call.paths) ? call.paths : [call.paths ?? call.path]).filter((p): p is string => typeof p === "string");
			return list(call.ops).flatMap(op => typeof op.out === "string" ? [{ files: paths.length ? paths : ["."], text: op.out }] : []);
		}
		case "bash": case "shell": return typeof call.command === "string" ? commitText(call.command) : [];
		default: return [];
	}
}

export interface RefGuardCall {
	// The host's tool name and its input, as the tool receives them.
	tool: string;
	input: unknown;
	// Whether a file is under the session's workspace; called with the path as the call wrote it.
	inWorkspace(file: string): Promise<boolean>;
	// The qualified refs the session knows. A bare short id counts when it is the id of one of these.
	refs: ReadonlySet<string>;
	// The projects a qualified ref counts for: `README.md#tasks` and a hashline tag look the same but name none.
	projects: ReadonlySet<string>;
}

// The known refs `text` names: a qualified ref of a known project, or a known short id on its own (`namedTasks` boundary).
function refsIn(text: string, projects: ReadonlySet<string>, shortIds: readonly string[]): string[] {
	const found = qualifiedRefs(text, projects);
	for (const id of shortIds) if (new RegExp(`(?<![\\w./#-])${escape(id)}(?![\\w-])`).test(text)) found.push(id);
	return [...new Set(found)];
}

// The refs a call would put into repository content, in order of appearance; empty when it adds none. Files outside the workspace and internal URLs
// are not repository content.
export async function offendingRefs(call: RefGuardCall): Promise<string[]> {
	const shortIds = [...new Set([...call.refs].map(ref => ref.slice(ref.lastIndexOf("#") + 1)))];
	if (!shortIds.length && !call.projects.size) return [];
	const found = new Set<string>();
	for (const { files, text } of addedBy(call.tool, call.input)) {
		if (files) {
			const local = files.filter(file => !INTERNAL_URL.test(file));
			if (!local.length || !(await Promise.all(local.map(call.inWorkspace))).some(Boolean)) continue;
		}
		for (const ref of refsIn(text, call.projects, shortIds)) found.add(ref);
	}
	return [...found];
}
