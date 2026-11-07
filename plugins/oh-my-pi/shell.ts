import path from "node:path";
import { projectOf, quote, type Binding } from "./model";

// Kata invocations inside a bash command, and the rewrite that pins a delegate's to its teammate.

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

export function delegateCommand(command: string, executable: string, executableVars: readonly string[], teammate: string, binding?: Binding, transcriptSession?: { agent: string; id: string }): string {
	const edits: { start: number; end: number; value: string }[] = [];
	for (const invocation of kataCommands(command, executable, executableVars)) {
		const parsed = shellOptions(invocation.words);
		if (parsed.options.has("--as")) throw new Error("Kata subagents keep the current actor. Use your assigned --teammate; --as is not permitted.");
		for (const previous of parsed.occurrences.get("--teammate") ?? []) edits.push({ start: previous[0].start, end: previous.at(-1)!.end, value: "" });
		let flags = ` --teammate ${quote(teammate)}`;
		if (binding) {
			if (!parsed.options.has("--workspace")) flags += ` --workspace ${quote(binding.workspace)}`;
			if (!parsed.options.has("--project")) flags += ` --project ${quote(projectOf(binding.parent))}`;
		}
		edits.push({ start: invocation.executable.end, end: invocation.executable.end, value: flags });
		// An in-process delegate has its own session; without this its close would record the lead's.
		if (transcriptSession && parsed.args[0] === "close") edits.push({ start: invocation.executable.start, end: invocation.executable.start, value: `env KATA_TRANSCRIPT_AGENT=${quote(transcriptSession.agent)} KATA_TRANSCRIPT_SESSION_ID=${quote(transcriptSession.id)} ` });
	}
	for (const edit of edits.sort((a, b) => b.start - a.start)) command = command.slice(0, edit.start) + edit.value + command.slice(edit.end);
	return command;
}
