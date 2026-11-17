import { closeEnv, type PathOps, type Platform } from "./kata-cli";
import { projectOf, type Binding } from "./model";

// Kata invocations inside a bash command, and the rewrite that pins a delegate's to its teammate.

export function quote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }
// `env NAME='value' ... ` in front of a command; empty for no variables.
export function envPrefix(vars: Record<string, string>): string {
	const assignments = Object.entries(vars).map(([name, value]) => `${name}=${quote(value)}`);
	return assignments.length ? `env ${assignments.join(" ")} ` : "";
}

type ShellWord = { value: string; start: number; end: number };
// One Kata invocation: its executable, the words after it, and the `NAME=value` assignments before it.
type Invocation = { executable: ShellWord; words: ShellWord[]; assignments: ShellWord[] };
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// Inspect command positions only. Quoted arguments and heredoc bodies are data;
// this lexer never infers whether a test/commit command proves completion.
export function kataCommands(path: Pick<PathOps, "basename">, command: string, configuredExecutable = "kata", executableVars: readonly string[] = []): Invocation[] {
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
		let value = "", open = "";
		while (i < command.length) {
			const char = command[i];
			if (!open && /[\s;&|()]/.test(char)) break;
			if (char === "\\" && open !== "'") { value += command[i + 1] || ""; i += 2; continue; }
			if (char === open) { open = ""; i++; continue; }
			if (!open && (char === "'" || char === '"')) { open = char; i++; continue; }
			value += char; i++;
		}
		if (wantDelimiter) { heredoc = value; wantDelimiter = false; continue; }
		segments.at(-1)!.push({ value, start, end: i });
	}
	const commands: Invocation[] = [];
	for (const segment of segments) {
		let j = 0;
		while (j < segment.length && (ASSIGNMENT.test(segment[j].value) || ["if", "then", "elif", "do", "else", "!", "command", "env", "time"].includes(segment[j].value))) j++;
		const executable = segment[j];
		if (executable && (path.basename(executable.value) === "kata" || executable.value === configuredExecutable || executableVars.some(name => executable.value === `$${name}` || executable.value === `\${${name}}`))) commands.push({ executable, words: segment.slice(j + 1), assignments: segment.slice(0, j).filter(word => ASSIGNMENT.test(word.value)) });
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
