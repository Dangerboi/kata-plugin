// Generated from core/shell.ts; edit there.
import { closeEnv, type PathOps, type Platform } from "./kata-cli";
import { projectOf, type Binding } from "./model";

// Kata invocations inside a bash command, and the rewrite that pins a delegate's to its teammate.

export function quote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }
// `value` as is when it matches `plain` (a pattern of safe shell words), else quoted.
export const quoteIfNeeded = (value: string, plain: RegExp) => plain.test(value) ? value : quote(value);
// `/usr/bin/env NAME='value' ... ` in front of a command; empty for no variables.
export function envPrefix(vars: Record<string, string>): string {
	const assignments = Object.entries(vars).map(([name, value]) => `${name}=${quote(value)}`);
	return assignments.length ? `/usr/bin/env ${assignments.join(" ")} ` : "";
}

type ShellWord = { value: string; start: number; end: number };
// One Kata invocation: its executable, the words after it, and the `NAME=value` assignments before it.
type Invocation = { executable: ShellWord; words: ShellWord[]; assignments: ShellWord[]; directories: string[]; inject: { at: number; raw: boolean } };
export const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// The words of one simple command, and the bodies of the heredocs fed to it.
type Segment = { words: ShellWord[]; bodies: string[] };
const RESERVED = new Set(["if", "then", "elif", "do", "else", "while", "until", "!", "{"]);
const PREFIXES = new Set(["command", "env", "time", "nohup", "exec", "timeout"]);
const PREFIX_VALUES: Record<string, Set<string>> = {
	env: new Set(["-u", "--unset", "-C", "--chdir", "-a", "--argv0", "--env0-from"]), exec: new Set(["-a"]),
	timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
};

// Find the executable without losing the original words' offsets. Prefix options belong to their own command,
// and timeout also consumes a duration. Inspection and split-string modes, and lookup-changing forms we cannot rewrite, are left unseen.
export function commandContext(words: ShellWord[]): { index: number; assignments: ShellWord[]; directories: string[]; inject: { at: number; raw: boolean } } | undefined {
	let at = 0;
	const assignments = new Map<string, ShellWord>(), directories: string[] = [];
	let external = false, slot: number | undefined, last = "";
	while (at < words.length) {
		const word = words[at].value;
		if (ASSIGNMENT.test(word)) { assignments.set(word.slice(0, word.indexOf("=")), words[at++]); continue; }
		if (RESERVED.has(word)) { at++; continue; }
		if (!PREFIXES.has(word) && word !== "/usr/bin/env") return { index: at, assignments: [...assignments.values()], directories, inject: last === "env" ? { at: words[at].start, raw: true } : (last === "command" || last === "exec") && !external ? { at: slot!, raw: true } : { at: words[at].start, raw: false } };
		const prefix = word === "/usr/bin/env" ? "env" : word;
		if ((prefix === "command" || prefix === "exec") && slot === undefined) slot = words[at].start;
		if (prefix !== "time" && prefix !== "command" && prefix !== "exec") external = true;
		last = prefix;
		let directory: string | undefined;
		at++;
		while (at < words.length && words[at].value.startsWith("-") && (words[at].value !== "-" || prefix === "env")) {
			const option = words[at++].value;
			if (option === "--") break;
			if (option === "-") { assignments.clear(); continue; }
			if (option.startsWith("--")) {
				const [flag, ...parts] = option.split("="), attached = parts.length ? parts.join("=") : undefined;
				if (prefix === "env" && flag === "--split-string") return undefined;
				if (prefix === "env" && (flag === "--ignore-environment" || flag === "--env0-from")) assignments.clear();
				if (PREFIX_VALUES[prefix]?.has(flag)) {
					const value = attached ?? words[at++]?.value;
					if (value === undefined) return undefined;
					if (prefix === "env" && flag === "--unset") assignments.delete(value);
					if (prefix === "env" && flag === "--chdir") directory = value;
				}
				continue;
			}
			for (let n = 1; n < option.length; n++) {
				const flag = `-${option[n]}`;
				if ((prefix === "command" && (flag === "-v" || flag === "-V")) || (prefix === "env" && (flag === "-S" || flag === "-P")) || (prefix === "exec" && flag === "-c")) return undefined;
				if (prefix === "env" && flag === "-i") assignments.clear();
				if (PREFIX_VALUES[prefix]?.has(flag)) {
					const value = option.slice(n + 1) || words[at++]?.value;
					if (value === undefined) return undefined;
					if (prefix === "env" && flag === "-u") assignments.delete(value);
					if (prefix === "env" && flag === "-C") directory = value;
					break;
				}
			}
		}
		if (directory !== undefined) directories.push(directory);
		if (prefix === "timeout") {
			if (at >= words.length) return undefined;
			at++;
		}
	}
	return undefined;
}
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

// Inspect command positions only.
export function kataCommands(path: Pick<PathOps, "basename">, command: string, configuredExecutable = "kata", executableVars: readonly string[] = []): Invocation[] {
	const commands: Invocation[] = [];
	for (const { words: segment } of commandSegments(command)) {
		const context = commandContext(segment);
		if (!context) continue;
		const j = context.index;
		const executable = segment[j];
		if (executable && (path.basename(executable.value) === "kata" || executable.value === configuredExecutable || executableVars.some(name => executable.value === `$${name}` || executable.value === `\${${name}}`))) commands.push({ executable, words: segment.slice(j + 1), assignments: context.assignments, directories: context.directories, inject: context.inject });
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

// Whose session a close records: `id` under `agent`, with the recording switch read from `env` (see `closeEnv`).
type Transcript = { env: Pick<Platform["env"], "get">; agent: string; id: string | undefined };

export function inject(invocation: Invocation, vars: Record<string, string>): { at: number; text: string } {
	const text = invocation.inject.raw ? Object.entries(vars).map(([name, value]) => `${name}=${quote(value)}`).join(" ") : envPrefix(vars).trimEnd();
	return { at: invocation.inject.at, text: text ? `${text} ` : "" };
}

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
		if (owed) { const edit = inject(invocation, owed); command = command.slice(0, edit.at) + edit.text + command.slice(edit.at); }
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
		const prefix = inject(invocation, { ...owedPair(invocation, parsed.args, transcript), ...extraEnv });
		if (prefix.text) edits.push({ start: prefix.at, end: prefix.at, value: prefix.text });
	}
	for (const edit of edits.sort((a, b) => b.start - a.start)) command = command.slice(0, edit.start) + edit.value + command.slice(edit.end);
	return command;
}
