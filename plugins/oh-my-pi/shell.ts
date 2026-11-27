// Generated from core/shell.ts; edit there.
import { closeEnv, type PathOps, type Platform } from "./kata-cli";
import { projectOf, QUALIFIED_REF_ONLY, SHORT_ID_ONLY, type Binding } from "./model";

// Kata invocations inside a bash command, and the rewrite that pins a delegate's to its teammate.

export function quote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }
// `value` as is when it matches `plain` (a pattern of safe shell words), else quoted.
export const quoteIfNeeded = (value: string, plain: RegExp) => plain.test(value) ? value : quote(value);
// `env NAME='value' ... ` in front of a command; empty for no variables.
export function envPrefix(vars: Record<string, string>): string {
	const assignments = Object.entries(vars).map(([name, value]) => `${name}=${quote(value)}`);
	return assignments.length ? `env ${assignments.join(" ")} ` : "";
}

type ShellWord = { value: string; start: number; end: number };
// One Kata invocation: its executable, the words after it, and the `NAME=value` assignments before it.
type Invocation = { executable: ShellWord; words: ShellWord[]; assignments: ShellWord[]; dir?: string };
export const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// The words of one simple command, and the bodies of the heredocs fed to it.
type Segment = { words: ShellWord[]; bodies: string[] };
// Words that may stand before a command without being it.
export const PREFIXES = ["if", "then", "elif", "do", "else", "!", "command", "env", "time"];
// Splits a command at `;`, `&`, `|`, parentheses and newlines. Quoted arguments and heredoc bodies are data (a body belongs to the
// command whose line holds its `<<`); this lexer never infers whether a test/commit command proves completion.
export function commandSegments(command: string): Segment[] {
	const segments: Segment[] = [{ words: [], bodies: [] }];
	let i = 0, heredoc: string | undefined, owner: Segment | undefined, wantDelimiter = false, hereString = false;
	while (i < command.length) {
		if (command[i] === "\n" && heredoc) {
			const end = command.indexOf(`\n${heredoc}`, i);
			if (end < 0) break;
			owner!.bodies.push(command.slice(i + 1, end));
			i = command.indexOf("\n", end + 1);
			if (i < 0) break;
			heredoc = undefined;
		}
		if (/\s/.test(command[i])) { if (command[i] === "\n") segments.push({ words: [], bodies: [] }); i++; continue; }
		if (command[i] === "#") { const end = command.indexOf("\n", i); if (end < 0) break; i = end; continue; }
		if (";&|()".includes(command[i])) { segments.push({ words: [], bodies: [] }); i++; continue; }
		if (command.slice(i, i + 3) === "<<<") { i += 3; hereString = true; continue; }
		if (command.slice(i, i + 2) === "<<") { i += command[i + 2] === "-" ? 3 : 2; wantDelimiter = true; continue; }
		const start = i;
		let value = "", open = "";
		while (i < command.length) {
			const char = command[i];
			if (!open && /[\s;&|()]/.test(char)) break;
			if (char === "\\" && open !== "'") { value += command[i + 1] || ""; i += 2; continue; }
			if (char === open) { open = ""; i++; continue; }
			if (!open && (char === "'" || char === '"')) { open = char; i++; continue; }
			value += char; i++;
		}
		// A here-string is the next word, fed to the command as its input.
		if (hereString) { segments.at(-1)!.bodies.push(value); hereString = false; continue; }
		if (wantDelimiter) { heredoc = value; owner = segments.at(-1); wantDelimiter = false; continue; }
		segments.at(-1)!.words.push({ value, start, end: i });
	}
	return segments;
}

export const foldDir = (base: string | undefined, dir: string) => dir.startsWith("/") || dir.startsWith("~") || !base ? dir : `${base.replace(/\/+$/, "")}/${dir}`;

// Inspect command positions only.
export function kataCommands(path: Pick<PathOps, "basename">, command: string, configuredExecutable = "kata", executableVars: readonly string[] = [], callFolder?: string): Invocation[] {
	const commands: Invocation[] = [];
	let dir = callFolder;
	for (const { words: segment } of commandSegments(command)) {
		let j = 0;
		while (j < segment.length && (ASSIGNMENT.test(segment[j].value) || PREFIXES.includes(segment[j].value))) j++;
		const executable = segment[j];
		if (executable?.value === "cd" && segment[j + 1] && !segment[j + 1].value.startsWith("-")) dir = foldDir(dir, segment[j + 1].value);
		if (executable && (path.basename(executable.value) === "kata" || executable.value === configuredExecutable || executableVars.some(name => executable.value === `$${name}` || executable.value === `\${${name}}`))) commands.push({ executable, words: segment.slice(j + 1), assignments: segment.slice(0, j).filter(word => ASSIGNMENT.test(word.value)), dir });
	}
	return commands;
}

export const VALUE_OPTIONS = new Set(["--body", "--body-file", "--message", "-m", "--comment", "--evidence", "--test", "--commit", "--pr", "--reviewed", "--reason", "--idempotency-key", "--parent", "--related", "--blocked-by", "--blocks", "--meta", "--owner", "--label", "--priority", "--if-match", "--if-value", "--workspace", "--project", "--teammate", "--as", "--for", "--format", "--daemon", "--title", "--ttl", "--since", "--kind", "--thread", "--until", "--reply", "--refute", "--supersede", "--re", "--to", "--repeat", "--timezone", "--confirm", "--expect-owner", "--docbank", "--duplicate-of", "--superseded-by", "--refs-from", "--poll-interval", "--timeout", "--connector", "--external", "--use", "--adopt", "--version", "--remove-parent", "--remove-related", "--remove-blocked-by", "--remove-blocks", "--issue", "-o", "--output"]);
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

// Ref-bearing operands and options, as named by Kata's command forms.
const REF_AFTER: Record<string, "one" | "all" | "move"> = Object.fromEntries([
	..."assign unassign claim close comment delete edit notify deadline schedule purge restore reopen status show".split(" ").map(key => [key, "one"]),
	["wait", "all"], ["move", "move"], ["comment edit", "one"],
	..."add rm".split(" ").map(op => [`label ${op}`, "one"]),
	..."get set unset".split(" ").map(op => [`meta ${op}`, "one"]),
	..."bind show reconcile pause resume resolve-field resolve-comment unbind".split(" ").map(op => [`bridge ${op}`, "one"]),
	..."acquire renew release force-release steal".split(" ").map(op => [`federation lease ${op}`, "one"]),
	..."link add get rm ls".split(" ").map(op => [`docbank attachments ${op}`, "one"]),
]);
const REF_OPTIONS = ["--parent", "--related", "--blocked-by", "--blocks", "--remove-parent", "--remove-related", "--remove-blocked-by", "--remove-blocks", "--issue", "--duplicate-of", "--superseded-by"];
export function callRefs(words: ShellWord[]): string[] {
	const refs = new Set<string>();
	const add = (value: string, qualifiedOnly = false) => { for (const part of value.split(",")) { const ref = part.trim(); if (QUALIFIED_REF_ONLY.test(ref) || (!qualifiedOnly && SHORT_ID_ONLY.test(ref))) refs.add(ref); } };
	for (const word of words) add(word.value.replace(/^--[^=]+=([^]*)$/, "$1"), true);
	const parsed = shellOptions(words);
	for (const option of REF_OPTIONS) for (const pair of parsed.occurrences.get(option) ?? []) add(pair[1]?.value ?? pair[0].value.slice(option.length + 1));
	const key = Object.keys(REF_AFTER).sort((a, b) => b.length - a.length).find(key => key.split(" ").every((part, index) => parsed.args[index] === part));
	if (key) { const operands = parsed.args.slice(key.split(" ").length), arity = REF_AFTER[key]; for (const value of arity === "one" ? operands.slice(0, 1) : arity === "move" ? operands.slice(0, -1) : operands) add(value); }
	return [...refs];
}

// Whose session a close records: `id` under `agent`, with the recording switch read from `env` (see `closeEnv`).
type Transcript = { env: Pick<Platform["env"], "get">; agent: string; id: string | undefined };

// The pair `transcript` gives a close, or nothing for any other command and for a close whose own assignments already set
// that pair (the last assignment of a name is the one Kata gets).
function owedPair(invocation: Invocation, args: readonly string[], transcript: Transcript | undefined): Record<string, string> | undefined {
	const pair = transcript && closeEnv(transcript.env, args, transcript.agent, transcript.id);
	if (!pair) return undefined;
	const set = new Map(invocation.assignments.map(word => [word.value.slice(0, word.value.indexOf("=")), word.value.slice(word.value.indexOf("=") + 1)]));
	return Object.entries(pair).every(([name, value]) => set.get(name) === value) ? undefined : pair;
}

// A lead's command with its transcript pair in front of each Kata close that does not carry it yet; the rest as written.
export function transcriptCommand(path: Pick<PathOps, "basename">, command: string, executable: string, executableVars: readonly string[], transcript: Transcript): string {
	for (const invocation of kataCommands(path, command, executable, executableVars).reverse()) {
		const owed = owedPair(invocation, shellOptions(invocation.words).args, transcript);
		if (owed) command = command.slice(0, invocation.executable.start) + envPrefix(owed) + command.slice(invocation.executable.start);
	}
	return command;
}

// Whether every Kata invocation of `command` already carries what `delegateCommand` would add (exactly the teammate, with a
// binding `--workspace` and `--project`, and a close's transcript pair) and none uses `--as`, which it refuses. Kept beside
// `delegateCommand`: what it adds must be checked here too.
export function delegateRouted(path: Pick<PathOps, "basename">, command: string, executable: string, executableVars: readonly string[], teammate: string, binding?: Binding, transcript?: Transcript): boolean {
	return kataCommands(path, command, executable, executableVars).every(invocation => {
		const parsed = shellOptions(invocation.words);
		return !parsed.options.has("--as") && (parsed.occurrences.get("--teammate")?.length ?? 0) === 1 && parsed.value("--teammate") === teammate
			&& (!binding || (parsed.options.has("--workspace") && parsed.options.has("--project")))
			&& !owedPair(invocation, parsed.args, transcript);
	});
}

export function delegateCommand(path: Pick<PathOps, "basename">, command: string, executable: string, executableVars: readonly string[], teammate: string, binding?: Binding, transcript?: Transcript, extraEnv: Record<string, string> = {}): string {
	const edits: { start: number; end: number; value: string }[] = [];
	for (const invocation of kataCommands(path, command, executable, executableVars)) {
		const parsed = shellOptions(invocation.words);
		if (parsed.options.has("--as")) throw new Error("Kata subagents keep the current actor. Use your assigned --teammate; --as is not permitted.");
		for (const previous of parsed.occurrences.get("--teammate") ?? []) edits.push({ start: previous[0].start, end: previous.at(-1)!.end, value: "" });
		let flags = ` --teammate ${quote(teammate)}`;
		if (binding) {
			if (!parsed.options.has("--workspace")) flags += ` --workspace ${quote(binding.workspace)}`;
			if (!parsed.options.has("--project")) flags += ` --project ${quote(projectOf(binding.parent))}`;
		}
		edits.push({ start: invocation.executable.end, end: invocation.executable.end, value: flags });
		// The session the host names for the delegate: its own where it has one, else the lead's that holds its transcript.
		// Without it a close would record whatever pair the process carries.
		const prefix = envPrefix({ ...owedPair(invocation, parsed.args, transcript), ...extraEnv });
		if (prefix) edits.push({ start: invocation.executable.start, end: invocation.executable.start, value: prefix });
	}
	for (const edit of edits.sort((a, b) => b.start - a.start)) command = command.slice(0, edit.start) + edit.value + command.slice(edit.end);
	return command;
}
