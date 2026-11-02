import { createHash } from "node:crypto";
import path from "node:path";
import { appendFileSync, realpathSync } from "node:fs";

// Canonical shared source. scripts/vendor-core.ts copies this file into each
// self-contained plugin; host adapters own their event/schema/identity APIs.

export function createdParentRef(out: any): string {
	const event = out.event ?? out.original_event;
	if (!out.issue?.short_id || !event?.project_name) throw new Error("kata create returned no parent identity");
	return `${event.project_name}#${out.issue.short_id}`;
}

export interface CoreHost {
	exec(file: string, args: string[], options: { cwd: string; timeout: number }): Promise<{ code: number; stdout: string; stderr?: string; killed?: boolean }>;
	appendEntry(type: string, data: unknown): void;
	getSessionName?(): string | undefined;
	isMain?(ctx: any): boolean;
	allowUI?(ctx: any): boolean;
	isDelegated?(ref: string): boolean;
	beforeReconcile?(): Promise<void>;
	delegatedRunning?(): boolean;
	binding?(ctx: any): Promise<{ ref: string; workspace: string; teammate: string } | undefined>;
}
export interface CoreOptions {
	namespace: string;
	executable: string;
	// Environment variable names (without $) a shell command may use for the executable.
	executableVars: readonly string[];
	debugFile?: string;
	explicitRef?(): string | undefined;
}

export type Status = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";
export type Task = { ref: string; content: string; phase: string; status: Status; blocker?: string; delegated?: boolean; review?: boolean; revision?: number; proof?: { message?: string; evidence?: string[] } };
export type Binding = { parent: string; workspace: string; sessionId?: string; auto?: boolean; label?: string };
export type Plan = Partial<Binding> & { tasks: Task[]; local?: boolean; error?: string };
export type Change = { message?: string; evidence?: string[]; reason?: string; many?: boolean; remove?: boolean };
export function sessionKey(file: string, cwd: string): string {
	const absolute = path.resolve(cwd, file);
	try { return realpathSync(absolute); }
	catch { try { return path.join(realpathSync(path.dirname(absolute)), path.basename(absolute)); } catch { return absolute; } }
}

// Valid for Kata labels and safe inside a project#id ref.
export function slug(text: string | undefined, keepCase = false): string | undefined {
	const value = (keepCase ? text ?? "" : (text ?? "").toLowerCase()).replace(keepCase ? /[^A-Za-z0-9._-]+/g : /[^a-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "").slice(0, 64).replace(/[-._]+$/, "");
	return value || undefined;
}
// The name Kata would infer for an unregistered workspace, read from its own
// refusal ("alias github.com/owner/repo is not registered"), else the folder.
export function inferredName(refusal: string, cwd: string): string {
	const named = /project (\S+) is not registered/.exec(refusal)?.[1];
	const alias = /alias (\S+) is not registered/.exec(refusal)?.[1]?.replace(/^local:\/\//, "").replace(/\/+$/, "").split("/").pop();
	return slug((named ?? alias ?? path.basename(path.resolve(cwd))).replace(/\.git$/, ""), true) ?? slug(path.basename(path.resolve(cwd)), true) ?? "workspace";
}

export function quote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }

export const OPEN: ReadonlySet<Status> = new Set(["pending", "in_progress", "blocked"]);
const MARK: Record<Status, string> = { pending: "[ ]", in_progress: "[/]", completed: "[x]", abandoned: "[~]", blocked: "[!]" };

export const DESCRIPTION = `Track multi-step work as a todo list stored in Kata. Tasks are identified by verbatim content (or Kata ref), NEVER generated IDs. Unique, stable task/phase names; lost text: view, NEVER guess.
Before work, init for 3+ steps, requested task sets, or new instructions. MUST list EVERY user item separately; NEVER omit or remember leftovers.
After each change: with no active task the earliest pending starts (phase order). Blocked NEVER starts automatically; unblock returns pending. Mark done immediately; follow phase order.
External waits (user/agent/service): block with a reason; it suppresses the stop reminder and starts the next pending task.
NEVER call todo alone: init with first work; done/start with next action.

Kata specifics:
- Each task is a Kata child issue of one parent issue. On init pass \`ref\` with the Kata issue this plan serves (search first: kata search "<terms>" --agent); an explicit KATA_REF or worker binding must match it. Without a ref, use that binding, the session's existing parent, or a new parent titled by \`message\`.
- done closes the issue. Kata requires \`evidence\` (commit:<sha>, test:<cmd>, pr:<url>, reviewed-paths:<path>) and a \`message\` of 40+ characters saying what changed and how it was verified. Unverified work: block it instead.
- drop/rm take the reason in \`message\`.
- drop and rm close as wontfix (Kata never deletes). Automatic session parents close from their children’s Kata-recorded evidence once all work has settled. Explicit/claimed parents remain yours to close. Folders with no Kata project use KATA_DEFAULT_PROJECT (labeled with the repo) or register their inferred project; the plan is session-local only while Kata is unreachable and replays when it returns.`;

export function digest(...parts: string[]): string {
	return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24);
}

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


// The salt (a session id) keeps reused agent names distinct across sessions.
export function teammateFor(id: string, salt?: string): string {
	const base = id.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^[^a-z0-9]+/, "") || "agent";
	return `${base.slice(0, 57)}-${digest(salt ? `${salt}:${id}` : id).slice(0, 6)}`;
}

export function delegateCommand(command: string, executable: string, executableVars: readonly string[], teammate: string, binding?: Binding): string {
	const edits: { start: number; end: number; value: string }[] = [];
	for (const invocation of kataCommands(command, executable, executableVars)) {
		const parsed = shellOptions(invocation.words);
		if (parsed.options.has("--as")) throw new Error("Kata subagents keep the current actor. Use your assigned --teammate; --as is not permitted.");
		for (const previous of parsed.occurrences.get("--teammate") ?? []) edits.push({ start: previous[0].start, end: previous.at(-1)!.end, value: "" });
		let flags = ` --teammate ${quote(teammate)}`;
		if (binding) {
			if (!parsed.options.has("--workspace")) flags += ` --workspace ${quote(binding.workspace)}`;
			if (!parsed.options.has("--project")) flags += ` --project ${quote(binding.parent.split("#")[0])}`;
		}
		edits.push({ start: invocation.executable.end, end: invocation.executable.end, value: flags });
	}
	for (const edit of edits.sort((a, b) => b.start - a.start)) command = command.slice(0, edit.start) + edit.value + command.slice(edit.end);
	return command;
}

export function delegateContext(executable: string, id: string, ref: string, teammate: string, binding: Binding): string {
	const command = `${quote(executable)} --workspace ${quote(binding.workspace)} --project ${quote(binding.parent.split("#")[0])} --teammate ${quote(teammate)}`;
	return `You are subagent ${id}. Your Kata issue is ${ref}; your teammate is ${teammate}. Keep the existing actor and use this issue instead of inherited KATA_REF. Track attention on your own issue. When verified, YOU must run: ${command} close ${quote(ref)} --done --message '<describe this task and its verification in at least 40 characters>' --evidence '<typed evidence for your actual verification>'. If unfinished, leave it open and explain what remains.`;
}

const STOPWORDS = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "do", "for", "from", "in", "into", "is", "it", "its", "of", "on", "or", "per", "the", "then", "this", "that", "to", "with", "you", "your", "above", "below", "all", "any", "please", "task", "plan", "subagent", "agent", "current", "complete", "finish"]);
// Lowercase words with camelCase split and simple suffixes stripped; snake_case
// identifiers stay whole because they usually name the code under change.
export function taskTokens(text: string): string[] {
	const words = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9_]+/);
	const tokens: string[] = [];
	for (let word of words) {
		word = word.replace(/^_+|_+$/g, "");
		if (word.length < 2 || STOPWORDS.has(word)) continue;
		if (word.length > 5 && word.endsWith("ing")) word = word.slice(0, -3);
		else if (word.length > 4 && word.endsWith("ed")) word = word.slice(0, -2);
		else if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) word = word.slice(0, -1);
		if (STOPWORDS.has(word)) continue;
		tokens.push(word);
		if (word.length > 4 && word.endsWith("test")) tokens.push("test"); // unittest, pytest
	}
	return [...new Set(tokens)];
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The open task a text names: its title (case-insensitive, whole words; a one-
// or two-word title only quoted or as the whole text), its qualified ref, or its
// short id after a marker, since a bare id can be an ordinary word ("test"). A
// title inside a longer named title yields to the longer one.
export function namedTask(tasks: Task[], text: string): Task | undefined {
	const titled = (title: string) => {
		const phrase = escape(title.trim());
		if (text.trim().toLowerCase() === title.trim().toLowerCase()) return true;
		if (new RegExp(`["'\`\u201c\u2018]\\s*${phrase}\\s*["'\`\u201d\u2019]`, "i").test(text)) return true;
		return title.trim().split(/\s+/).length >= 3 && new RegExp(`(?<![\\w])${phrase}(?![\\w])`, "i").test(text);
	};
	const named = tasks.filter(t => OPEN.has(t.status) && (titled(t.content) || text.includes(t.ref) ||
		new RegExp(`(?:\\b(?:issue|kata|ref|task)\\b\\s*[:=]?\\s*|(?<![\\w.-])#)${escape(t.ref.split("#").pop()!)}(?![\\w-])`, "i").test(text)));
	const longest = named.sort((a, b) => b.content.length - a.content.length)[0];
	if (longest && named.every(t => t === longest || longest.content.toLowerCase().includes(t.content.toLowerCase()))) return longest;
}

export type MatchOptions = { unavailable?: ReadonlySet<string>; single?: boolean; label?: string };
// Pick the plan task a delegation serves. A named task wins, and a named task
// that is taken binds nothing else. Then a clear weighted token overlap with
// the short label (omp's task name) wins; then, for a single delegation, the one
// open task the lead marked for delegation ("... (delegated to subagent)") if it
// shares a word with the spawn; then a clear overlap with the full text. Overlap
// counts the task's leading word twice. The lead's active task scores
// at half weight and is the fallback only for an explicit current-task handoff.
export function matchDelegation(tasks: Task[], text: string, { unavailable = new Set(), single = true, label = "" }: MatchOptions = {}): Task | undefined {
	const available = (t: Task) => OPEN.has(t.status) && t.status !== "blocked" && !t.delegated && !unavailable.has(t.ref);
	const full = label ? `${label}\n${text}` : text;
	const named = namedTask(tasks, full);
	if (named) return available(named) ? named : undefined;
	const candidates = tasks.filter(available);
	const open = tasks.filter(t => OPEN.has(t.status)).map(t => taskTokens(t.content));
	const df = (token: string) => open.filter(tokens => tokens.includes(token)).length;
	const weight = (token: string) => Math.log((open.length + 1) / Math.max(1, df(token)));
	const overlap = (source: string) => {
		const wanted = new Set(taskTokens(source));
		// Coverage counts against the task and against the source's plan vocabulary.
		const vocabulary = [...wanted].filter(token => df(token) > 0).reduce((sum, token) => sum + weight(token), 0);
		const scored = candidates.map(task => {
			const own = taskTokens(task.content), shared = own.filter(token => wanted.has(token));
			const total = own.reduce((sum, token) => sum + weight(token), 0), common = shared.reduce((sum, token) => sum + weight(token), 0);
			const score = (common + (own[0] && wanted.has(own[0]) ? weight(own[0]) : 0)) * (task.status === "in_progress" ? 0.5 : 1);
			return { task, score, eligible: shared.length >= 2 && common > 0 && Math.max(common / total, common / vocabulary) >= 0.3 };
		}).sort((a, b) => b.score - a.score);
		const [best, runner] = scored;
		return best?.eligible && (!runner || best.score >= runner.score * 1.5) ? best.task : undefined;
	};
	const byLabel = label && overlap(label);
	if (byLabel) return byLabel;
	const wanted = new Set(taskTokens(full));
	const marked = candidates.filter(t => /\b(?:delegat\w*|sub-?agents?)\b/i.test(t.content));
	if (single && marked.length === 1 && taskTokens(marked[0].content).some(token => wanted.has(token))) return marked[0];
	const found = overlap(full);
	if (found) return found;
	const active = candidates.filter(t => t.status === "in_progress");
	if (single && active.length === 1 && /\b(?:current|active|this)\s+(?:task|todo|item|step)\b/i.test(full)) return active[0];
}

export function phasesOf(tasks: Task[]): { name: string; tasks: Task[] }[] {
	const phases: { name: string; tasks: Task[] }[] = [];
	for (const task of tasks) {
		let phase = phases.find(p => p.name === task.phase);
		if (!phase) phases.push((phase = { name: task.phase, tasks: [] }));
		phase.tasks.push(task);
	}
	return phases;
}

export function render(plan: Plan): string {
	if (plan.error) return `Kata state unavailable${plan.parent ? ` for ${plan.parent}` : ""}: ${plan.error}. Use todo op=view to refresh.`;
	if (!plan.parent && !plan.local) return "No todo plan. Use todo op=init.";
	if (plan.tasks.length === 0) return `Kata parent ${plan.parent}: no tasks.`;
	const done = plan.tasks.filter(t => t.status === "completed").length;
	const lines = [`${plan.local ? "Session-local plan (Kata is unreachable; it replays into Kata when Kata returns)" : `Kata parent ${plan.parent}`}: ${done}/${plan.tasks.length} done`];
	for (const phase of phasesOf(plan.tasks)) {
		lines.push(`${phase.name}:`);
		for (const t of phase.tasks) lines.push(`  ${MARK[t.status]} ${t.content} (${t.ref})${t.blocker ? ` — blocked: ${t.blocker}` : ""}`);
	}
	return lines.join("\n");
}

export function createKataCore(host: CoreHost, options: CoreOptions) {
	const namespace = options.namespace;
	const STATE_ENTRY = `io.kata.${namespace}.parent`;
	const SNAPSHOT_ENTRY = `io.kata.${namespace}.state`;
	const WIDGET = `${namespace}-kata`;
	const MAX_REMINDERS = 3;
	const main = (ctx: any) => host.isMain?.(ctx) ?? true;
	let plan: Plan = { tasks: [] };
	let queue: Promise<unknown> = Promise.resolve();
	// unknown: not probed; workspace: the cwd has its own project; unbound: Kata is
	// up but the cwd is unregistered; bound: a parent is set; down: Kata unusable.
	let scope: "unknown" | "workspace" | "unbound" | "bound" | "down" = "unknown";
	let refusal = "", outage = "", warnedFor: string | undefined;
	let currentId: string | undefined;
	let bound = false;
	let assignedRef: string | undefined;
	let requestedRef: string | undefined;
	let sessionTeammate: string | undefined;
	let boundAgent: string | undefined;
	const agentKey = (ctx: any) => JSON.stringify([ctx?.agent?.kind, ctx?.agent?.id]);
	let currentCtx: any;
	let reminders = 0;
	let progressed = true;
	let cache: { id?: string; contract?: string; inbox?: string; pending?: Promise<void>; inboxPending?: Promise<void> } = {};
	const autoParents = new Map<string, Binding>();
	const retries = new Map<string, { task: Task; to: Status; change: Change; cwd: string; at: number }>();
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let retryTimerCtx: any;
	let lastSnapshot: string | undefined;
	function persist() {
		if (!currentId || !main(currentCtx)) return;
		const data = { version: 1, sessionId: currentId,
			plan: structuredClone(plan), autoParents: [...autoParents.values()], retries: [...retries.entries()] };
		const encoded = JSON.stringify(data);
		if (encoded === lastSnapshot) return;
		host.appendEntry(SNAPSHOT_ENTRY, data);
		lastSnapshot = encoded;
	}
	function debug(error: unknown) {
		if (!options.debugFile) return;
		try { appendFileSync(options.debugFile, `${new Date().toISOString()} ${String(error)}\n`); } catch { /* Debugging must never interrupt work. */ }
	}
	async function bounded<T>(promise: Promise<T>, ms = 250): Promise<T | undefined> {
		let timer: ReturnType<typeof setTimeout>;
			try { return await Promise.race([promise.catch(error => { debug(error); return undefined; }), new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), ms); })]); }
		finally { clearTimeout(timer!); }
	}

	async function kata(args: string[], cwd: string, timeout = 120_000, workspace = true): Promise<string> {
		const flags = [...(sessionTeammate !== undefined && args[0] !== "agent-contract-hook" ? ["--teammate", sessionTeammate] : []), ...(workspace ? ["--workspace", path.resolve(cwd)] : [])];
		const end = args.indexOf("--");
		args = [...args.slice(0, end < 0 ? args.length : end), ...flags, ...(end < 0 ? [] : args.slice(end))];
		const result = await host.exec(options.executable, args, { cwd, timeout });
		if (result.code !== 0 || result.killed) {
			const detail = (result.stderr || result.stdout || "").trim().split("\n").slice(-3).join(" ");
			throw new Error(`kata ${args[0]} ${result.killed ? `timed out after ${timeout}ms` : "failed"}${detail ? `: ${detail}` : ""}`);
		}
		return result.stdout;
	}

	// Serialize every plan mutation: tool calls, /todo, and session reloads.
	function serial<T>(fn: () => Promise<T>): Promise<T> {
		const run = queue.then(fn);
		queue = run.catch(() => undefined);
		return run;
	}

	async function actor(cwd: string, ref = plan.parent): Promise<string> {
		if (ref) {
			const status = JSON.parse(await kata(["status", ref, "--json"], cwd));
			if (typeof status.actor !== "string" || !status.actor.trim()) throw new Error("Kata status returned no effective actor.");
			return status.actor;
		}
		if (process.env.KATA_AUTHOR || process.env.USER) return (process.env.KATA_AUTHOR || process.env.USER)!;
		const result = await host.exec("git", ["config", "user.name"], { cwd, timeout: 1000 });
		return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : "anonymous";
	}

	// Starting unowned work requires a successful claim. Already-owned tasks
	// require both the actor and teammate, since delegates share an actor.
	// "check" validates assignment without taking ownership.
	async function owned(ref: string, cwd: string, mayClaim: boolean | "check" = false, allowClosed = false, revision?: number): Promise<any> {
		let issue = JSON.parse(await kata(["show", ref, "--json"], cwd)).issue;
		if (revision !== undefined && issue.revision !== revision) throw new Error(`Kata issue ${ref} changed since the task was selected; no work metadata was written.`);
		if (main(currentCtx) && issue.metadata?.[`${namespace}.subagent_id`]) throw new Error(`Kata issue ${ref} belongs to a delegate; no work metadata was written.`);
		const currentActor = await actor(cwd, ref);
		const teammate = sessionTeammate ?? process.env.KATA_TEAMMATE ?? "";
		if (issue?.status !== "open" && !(allowClosed && issue?.status === "closed")) throw new Error(`Kata issue ${ref} is closed or unavailable; no work metadata was written.`);
		const assignedTeammate = issue.metadata?.teammate || "";
		if (assignedTeammate !== teammate && (issue.owner || assignedTeammate)) {
			throw new Error(`Kata issue ${ref} belongs to teammate ${assignedTeammate || "(none)"}, not ${teammate || "(none)"}; no work metadata was written.`);
		}
		if (!issue.owner && mayClaim === true) {
			// Never swallow a claim failure, including an ownership race.
			await kata(["claim", ref, "--if-unowned"], cwd);
			issue = JSON.parse(await kata(["show", ref, "--json"], cwd)).issue;
			if (issue.status !== "open" || issue.owner !== currentActor) throw new Error(`Kata issue ${ref} is no longer owned by ${currentActor}; no work metadata was written.`);
			if (teammate && !issue.metadata?.teammate) {
				await kata(["meta", "set", ref, "teammate", teammate, "--if-absent", "--if-match", String(issue.revision)], cwd);
				issue = JSON.parse(await kata(["show", ref, "--json"], cwd)).issue;
			}
		}
		const unclaimed = mayClaim === "check" && !issue.owner;
		if ((issue.status !== "open" && !(allowClosed && issue.status === "closed")) || (!unclaimed && (issue.owner !== currentActor || (issue.metadata?.teammate || "") !== teammate)) ||
			(main(currentCtx) && issue.metadata?.[`${namespace}.subagent_id`])) {
			throw new Error(`Kata issue ${ref} is not owned by actor ${currentActor} and teammate ${teammate || "(none)"}; no work metadata was written.`);
		}
		if (!Number.isInteger(issue.revision) || issue.revision < 0) throw new Error(`Kata issue ${ref} has no valid metadata revision; no work metadata was written.`);
		return issue;
	}

	// Keep the validated decision through each conditional write. Any intervening
	// assignment or metadata change invalidates its revision, including after close.
	async function work(ref: string, key: string, value: string | boolean | undefined, cwd: string, expected: any): Promise<any> {
		const meta = expected.metadata ?? {};
		const exists = Object.hasOwn(meta, key);
		if ((!exists && value === undefined) || meta[key] === value) return expected;
		const args = value === undefined ? ["meta", "unset", ref, key] : ["meta", "set", ref, key, JSON.stringify(value)];
		args.push("--if-match", String(expected.revision));
		if (exists) args.push("--if-value", JSON.stringify(meta[key]), "--json-value");
		else args.push("--if-absent", "--json-value");
		await kata(args, cwd);
		const changed = { ...meta };
		if (value === undefined) delete changed[key];
		else changed[key] = value;
		return { ...expected, revision: expected.revision + 1, metadata: changed };
	}

	// -------------------------------------------------------------- plan state

	async function childrenOf(parent: string, cwd: string): Promise<any[]> {
		const shown = JSON.parse(await kata(["show", parent, "--json"], cwd));
		const children = (shown.children ?? []) as any[];
		if (!shown.issue || !Array.isArray(children) || children.some(c => !c || typeof c.title !== "string" || typeof c.short_id !== "string")) {
			throw new Error("kata show returned an invalid issue or children response");
		}
		return children;
	}

	function tasksOf(children: any[], parent: string): Task[] {
		return children
			.filter(c => typeof c?.metadata?.["todo.phase"] === "string" && c.metadata["todo.removed"] !== true)
			.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
			.map(c => {
				const meta = c.metadata;
				let status: Status;
				if (c.status === "closed") status = c.closed_reason === "wontfix" || meta["todo.status"] === "abandoned" ? "abandoned" : "completed";
				else status = ["in_progress", "blocked"].includes(meta["todo.status"]) ? meta["todo.status"] : "pending";
				return {
					ref: c.qualified_id || `${parent.split("#")[0]}#${c.short_id}`,
					content: c.title,
					phase: meta["todo.phase"],
					revision: c.revision,
					delegated: !!meta[`${namespace}.subagent_id`] && (meta.teammate || "") !== (sessionTeammate ?? process.env.KATA_TEAMMATE ?? ""),
					review: (c.labels ?? []).some((l: any) => (typeof l === "string" ? l : l?.label) === "needs-review"),
					status,
					blocker: status === "blocked" ? meta["work.attention_msg"] : undefined,
				};
			});
	}

	async function load(cwd: string): Promise<any[]> {
		if (plan.local) { delete plan.error; return []; }
		if (!plan.parent) { plan.tasks = []; return []; }
		try {
			const children = await childrenOf(plan.parent, cwd);
			plan.tasks = tasksOf(children, plan.parent);
			delete plan.error;
			return children;
		} catch (error) {
			plan.error = (error as Error).message;
			throw error;
		}
	}

	function refresh(ctx: any) {
		if (!main(ctx) || host.allowUI?.(ctx) === false) return;
		const ui = ctx?.ui;
		if (!ui?.setWidget) return;
		if (plan.error) { ui.setWidget(WIDGET, [render(plan)]); return; }
		if (!plan.parent || plan.tasks.length === 0) {
			ui.setWidget(WIDGET, undefined);
			return;
		}
		const done = plan.tasks.filter(t => t.status === "completed").length;
		const active = plan.tasks.find(t => t.status === "in_progress");
		const blocked = plan.tasks.filter(t => t.status === "blocked").length;
		const line = `Kata ${plan.parent} · ${done}/${plan.tasks.length} done${blocked ? ` · ${blocked} blocked` : ""}${active ? ` · ▶ ${active.content}` : ""}`;
		ui.setWidget(WIDGET, [line]);
	}

	// Kata itself cannot run: no executable, or a daemon that cannot be reached.
	const UNUSABLE = /\bENOENT\b|\bECONN(?:REFUSED|RESET)\b|executable file not found|not found in \$PATH|command not found|connection refused|dial tcp|no such host|daemon[^\n]{0,40}(?:unavailable|unreachable|not running|did not start|failed to start)|timed out after/i;
	// True while Kata answers. An unregistered cwd is not an outage: it resolves
	// to the default or inferred project. Only an unusable Kata (missing
	// executable, unreachable daemon) is down, and it is probed again next time.
	async function probe(cwd: string): Promise<boolean> {
		if (scope !== "unknown" && scope !== "down") return true;
		try { await kata(["list", "--limit", "1", "--json"], cwd, 15_000); scope = "workspace"; refusal = ""; }
		catch (error) {
			if (/\bproject_not_initialized\b/.test(String(error))) { scope = "unbound"; refusal = String(error); }
			else if (UNUSABLE.test(String(error))) { scope = "down"; outage = (error as Error)?.message ?? String(error); debug(error); return false; }
			else throw error; // a missing project or a refused login is an error, never a local plan
		}
		return true;
	}

	// Where a plan created from this cwd lives. Never writes.
	function candidate(cwd: string): { project?: string; label?: string; register?: boolean } {
		if (!refusal) return {};
		const name = inferredName(refusal, cwd);
		const configured = process.env.KATA_DEFAULT_PROJECT?.trim();
		return configured ? { project: configured, label: slug(name) } : { project: name, register: true };
	}

	// Register the inferred project in the daemon (idempotent; no files in the repo).
	async function destination(cwd: string) {
		const target = candidate(cwd);
		if (target.register) await kata(["projects", "create", target.project!, "--json"], cwd, 20_000, false);
		return target;
	}

	function goLocal(ctx: any) {
		plan.local = true; delete plan.error;
		scheduleRetry();
		if (warnedFor === (currentId ?? "")) return;
		warnedFor = currentId ?? "";
		if (main(ctx) && host.allowUI?.(ctx) !== false) ctx?.ui?.notify?.(`Kata is unreachable${outage ? ` (${outage})` : ""}. todo keeps a session-local plan and replays it into Kata when Kata returns.`, "warning");
	}

	// Kata is back: create the parent and tasks the local plan accumulated.
	async function replayLocal(ctx: any) {
		if (!plan.local || !await probe(ctx.cwd)) return;
		const local = plan.tasks;
		// Nothing was planned offline (a delegation only needed a parent): create nothing.
		if (!local.length) { delete plan.local; return; }
		plan = { tasks: [] };
		try {
			const phases = [...new Set(local.map(t => t.phase))].map(phase => ({ phase }));
			await ensureParent({ list: phases }, ctx);
			if (plan.local) { plan = { tasks: local, local: true }; return; } // Kata went away again
			const cwd = plan.workspace!;
			for (const t of local) await create(t.phase, t.content, cwd);
			await load(cwd);
			for (const t of local) {
				const task = plan.tasks.find(x => x.phase === t.phase && x.content === t.content);
				if (!task || t.status === "pending") continue;
				try {
					if (t.status === "completed" && !(t.proof?.evidence?.length && (t.proof.message || "").trim().length >= 40)) await transition(task, "blocked", { reason: "Completed while Kata was unreachable; add evidence and close it." }, cwd);
					else await transition(task, t.status, { ...t.proof, reason: t.blocker }, cwd);
				} catch (error) {
					debug(error);
					await transition(task, "blocked", { reason: `Replaying "${t.status}" from the offline plan failed: ${(error as Error).message}` }, cwd).catch(debug);
				}
			}
			await advance(cwd).catch(debug);
		} catch (error) {
			// Whatever Kata took stays; the unreplayed plan is retried (creates are idempotent).
			plan = { tasks: local, local: true };
			scheduleRetry();
			throw error;
		}
	}

	async function pin(ref: string, cwd: string): Promise<string> {
		const shown = JSON.parse(await kata(["show", ref, "--json"], cwd));
		if (ref.includes("#")) return `${ref.split("#")[0]}#${shown.issue.short_id}`;
		const projects = JSON.parse(await kata(["projects", "list", "--json"], cwd)).projects;
		const project = projects.find((p: any) => p.id === shown.issue.project_id);
		if (!project) throw new Error("Kata issue project could not be pinned.");
		return `${project.name}#${shown.issue.short_id}`;
	}

	async function sessionBinding(ctx: any): Promise<Binding | undefined> {
		const id = ctx.sessionManager?.getSessionId?.();
		if (!id) return;
		const where = candidate(ctx.cwd);
		let list: any[];
		try { list = JSON.parse(await kata(["list", "--status", "all", ...(where.project ? ["--project", where.project] : []), "--meta", `${namespace}.session_id=${id}`, "--label", `${namespace}-session`, "--limit", "2", "--json"], ctx.cwd)).issues ?? []; }
		catch (error) { if (where.project && /project_not_initialized/.test(String(error))) return; throw error; } // the project is not registered yet: no earlier parent
		// Creation records session identity before the guarded claim can finish.
		const candidates = list.filter((issue: any) => (issue.metadata?.[`${namespace}.auto_parent`] === true || issue.metadata?.[`${namespace}.auto_parent`] === undefined) && issue.metadata?.[`${namespace}.session_id`] === id && sessionKey(issue.metadata?.[`${namespace}.workspace`] || ".", ctx.cwd) === sessionKey(ctx.cwd, ctx.cwd));
		if (candidates.length === 1) return { parent: candidates[0].qualified_id, workspace: candidates[0].metadata[`${namespace}.workspace`], sessionId: id, auto: true, label: where.label };
	}

	async function bind(ctx: any, explicit = options.explicitRef?.() ?? process.env.KATA_REF, replay = true) {
		if (!main(ctx) && !host.binding) return;
		bound = false;
		boundAgent = agentKey(ctx);
		const assigned = await host.binding?.(ctx);
		sessionTeammate = assigned?.teammate;
		explicit = assigned?.ref ?? explicit;
		assignedRef = assigned?.ref;
		requestedRef = explicit;
		const id = ctx.sessionManager?.getSessionId?.();
		currentId = id;
		lastSnapshot = undefined;
		currentCtx = ctx;
		plan = { tasks: [] };
		scope = "unknown"; refusal = ""; outage = "";
		retries.clear(); autoParents.clear();
		clearRetryTimer();
		let snapshot: any;
		for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
			if (entry?.type === "custom" && entry.customType === SNAPSHOT_ENTRY && entry.data?.version === 1 && entry.data.sessionId === id) snapshot = entry.data;
		}
		if (snapshot) {
			for (const binding of snapshot.autoParents ?? []) autoParents.set(binding.parent, binding);
			for (const [ref, pending] of snapshot.retries ?? []) retries.set(ref, pending);
			if (retries.size) scheduleRetry();
			if (snapshot.plan?.local && !explicit) plan = structuredClone(snapshot.plan);
		}
		let stored: any = snapshot?.plan?.parent ? snapshot.plan : undefined;
		for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
			if (entry?.type === "custom" && entry.customType === STATE_ENTRY && typeof entry.data?.parent === "string" && (!entry.data.sessionId || entry.data.sessionId === id)) stored = entry.data;
		}
		if (plan.local && !explicit) stored = undefined;
		if (!explicit && !stored) {
			if (!await probe(ctx.cwd)) { await drainRetries(); bound = true; refresh(ctx); return; }
			// A restored offline plan replays into its parent itself; do not rebind over it.
			if (id && !plan.local) stored = await sessionBinding(ctx);
		}
		const parent = explicit || stored?.parent;
		if (parent) {
			const workspace = assigned?.workspace || (explicit ? path.resolve(ctx.cwd) : stored.workspace || path.resolve(ctx.cwd));
			const qualified = await pin(parent, workspace);
			const issue = JSON.parse(await kata(["show", qualified, "--json"], workspace)).issue;
			const marker = issue.metadata?.[`${namespace}.auto_parent`];
			const auto = !explicit && stored?.auto !== false && (marker === true || (stored?.auto === true && marker === undefined)) && issue.metadata?.[`${namespace}.session_id`] === id;
			setParent({ parent: qualified, workspace, sessionId: id, auto, label: explicit ? undefined : stored?.label });
			await load(workspace);
		}
		if (replay) await drainRetries();
		bound = true;
		refresh(ctx);
	}

	function setParent(binding: Binding) {
		scope = "bound";
		if (!binding.auto) autoParents.delete(binding.parent);
		if (plan.parent === binding.parent && plan.workspace === binding.workspace && plan.auto === binding.auto && plan.label === binding.label) return;
		plan = { ...binding, tasks: plan.parent === binding.parent ? plan.tasks : [] };
		if (binding.auto) autoParents.set(binding.parent, binding);
		host.appendEntry(STATE_ENTRY, binding);
	}

	async function adopt(ref: string, ctx: any, workspace = ctx.cwd) {
		const parent = await pin(ref, workspace);
		if (plan.auto && plan.parent && plan.parent !== parent) {
			// An automatic parent with no children only marks the session; retire it
			// rather than leave an empty child that can never auto-close.
			const shown = JSON.parse(await kata(["show", plan.parent, "--json"], plan.workspace!));
			if (shown.issue.status === "open" && !shown.children?.length) {
				const decision = await owned(plan.parent, plan.workspace!, false, false, shown.issue.revision);
				await kata(["close", plan.parent, "--if-match", String(decision.revision), "--superseded-by", parent, "--message", `This session adopted ${parent} as its plan parent.`], plan.workspace!);
				autoParents.delete(plan.parent);
			}
		}
		if (plan.parent === parent) autoParents.delete(parent);
		setParent({ parent, workspace: path.resolve(workspace), sessionId: ctx.sessionManager?.getSessionId?.(), auto: false });
		await load(workspace);
	}

	// ------------------------------------------------------------- transitions

	async function create(phase: string, content: string, cwd: string): Promise<void> {
		const out = JSON.parse(
			await kata(
				[
					"create",
					"--parent", plan.parent!,
					"--project", plan.parent!.split("#")[0],
					"--body", `Todo task in phase "${phase}".`,
					"--meta", `todo.phase=${phase}`,
					"--meta", "todo.status=pending",
					...(plan.label ? ["--label", plan.label] : []),
					"--idempotency-key", `${namespace}-kata:${digest(plan.parent!, phase, content)}`,
					// Sibling tasks often read alike ("write x" / "verify x"); they are
					// deliberate plan items, so skip the look-alike soft-block.
					"--force-new",
					"--json", "--", content,
				],
				cwd,
			),
		);
		const issue = out?.issue;
		if (typeof issue?.short_id !== "string") throw new Error("kata create returned no short_id");
		// Replays may restore removed work, but never another writer's task.
		const ref = `${plan.parent!.split("#")[0]}#${issue.short_id}`;
		if (issue.status === "closed" || issue.metadata?.["todo.removed"] === true) {
			let decision = await owned(ref, cwd, "check", true, issue.revision);
			if (decision.status === "closed") {
				await kata(["reopen", ref], cwd);
				decision = await owned(ref, cwd, "check", false, decision.revision + 1);
				decision = await work(ref, "todo.status", "pending", cwd, decision);
			}
			await work(ref, "todo.removed", undefined, cwd, decision);
		}
	}

	async function transition(task: Task, to: Status, change: Change, cwd: string, validated?: any): Promise<void> {
		const from = task.status;
		if (from === to && to !== "blocked") return;
		const ref = task.ref;
		if (task.delegated || host.isDelegated?.(ref)) {
			throw new Error(`Kata task ${ref} is delegated. Its subagent must manage and close it; use view to refresh its state.`);
		}
		if (plan.local) {
			task.status = to; task.blocker = to === "blocked" ? change.reason || "Blocked in the local plan." : undefined;
			if (to === "completed" || to === "abandoned") task.proof = { message: change.message, evidence: change.evidence };
			return;
		}
		if (to === "completed" && (!change.evidence?.length || (change.message || "").replace(/\s+/g, " ").trim().length < 40)) {
			throw new Error(`Kata needs evidence and a 40+ character message to close ${ref} ("${task.content}") as done: pass evidence (commit:<sha>, test:<cmd>, pr:<url>, reviewed-paths:<path>) and a message saying what changed and how it was verified. If it is not verified, block it instead.`);
		}
		let decision = validated ?? await owned(ref, cwd, to === "completed" || to === "abandoned" ? "check" : true, !OPEN.has(from) && to === "in_progress", task.revision);
		if (!OPEN.has(from) && to === "in_progress") {
			if (decision.status !== "closed") throw new Error(`Kata task ${ref} changed before restart.`);
			const revision = decision.revision;
			await kata(["reopen", ref], cwd);
			decision = await owned(ref, cwd);
			if (decision.revision !== revision + 1) throw new Error(`Kata task ${ref} changed during restart; no work metadata was written.`);
		}

		switch (to) {
			case "in_progress":
				decision = await work(ref, "work.attention", "ok", cwd, decision);
				if (from === "blocked") decision = await work(ref, "work.attention_msg", undefined, cwd, decision);
				decision = await work(ref, "todo.status", "in_progress", cwd, decision);
				break;
			case "pending":
				if (from === "blocked") {
					decision = await work(ref, "work.attention", "ok", cwd, decision);
					decision = await work(ref, "work.attention_msg", undefined, cwd, decision);
				}
				decision = await work(ref, "todo.status", "pending", cwd, decision);
				break;
			case "blocked": {
				const reason = change.reason || "Blocked in the todo plan.";
				decision = await work(ref, "work.attention", "stuck", cwd, decision);
				decision = await work(ref, "work.attention_msg", reason, cwd, decision);
				decision = await work(ref, "todo.status", "blocked", cwd, decision);
				task.blocker = reason;
				break;
			}
			case "completed": {
				const message = change.message ? `${change.message} (task: ${task.content}; ${task.ref})` : "";

				const args = ["close", ref, "--done", "--if-match", String(decision.revision), "--message", message];
				for (const e of change.evidence!) args.push("--evidence", e);
				task.revision = decision.revision;
				await closeTask(args, task, to, change, cwd);
				decision = await work(ref, "todo.status", "completed", cwd, { ...decision, status: "closed", revision: decision.revision + 1 });
				// Kata accepted the close with evidence; an earlier review request is settled.
				if (task.review) { await owned(ref, cwd, "check", true, decision.revision); await kata(["label", "rm", ref, "needs-review"], cwd); task.review = false; }
				break;
			}
			case "abandoned":
				task.revision = decision.revision;
				await closeTask(["close", ref, "--wontfix", "--if-match", String(decision.revision), "--message", wontfix("Dropped", task, change)], task, to, change, cwd);
				decision = await work(ref, "todo.status", "abandoned", cwd, { ...decision, status: "closed", revision: decision.revision + 1 });
				break;
		}
		task.revision = decision.revision;
		task.status = to;
		if (!change.remove) retries.delete(ref);
		if (to !== "blocked") task.blocker = undefined;
	}

	// Kata wants 60+ characters for wontfix; the task and plan context supply
	// that around the caller's reason.
	function wontfix(verb: string, task: Task, change: Change): string {
		const why = change.message || change.reason || "no longer needed";
		return `${verb} from the todo plan under ${plan.parent}: "${task.content}". Reason: ${why}. This task was intentionally retired from the plan without asserting completion.`;
	}

	// A delegated task is the subagent's; it never occupies the lead's slot.
	const leads = (t: Task) => !t.delegated && !host.isDelegated?.(t.ref);

	// A delegate finished without closing its issue: ask the lead to review it.
	// A plan task returns to the lead (pending, the lead's teammate) only while
	// it still carries the delegate's teammate; the subagent id goes last, so a
	// partial failure leaves it marked delegated rather than free and foreign.
	async function handBack(ref: string, cwd: string, delegate: { id: string; teammate: string; lead: string; state: string; planTask: boolean }) {
		const { lead } = delegate;
		if (delegate.planTask) {
			const issue = JSON.parse(await kata(["show", ref, "--json"], cwd)).issue;
			if (issue.status === "open" && issue.metadata?.teammate === delegate.teammate) {
				await kata(lead ? ["meta", "set", ref, "teammate", lead, "--if-match", String(issue.revision)] : ["meta", "unset", ref, "teammate", "--if-match", String(issue.revision)], cwd);
				await kata(["meta", "set", ref, "todo.status", "pending"], cwd);
				await kata(["meta", "unset", ref, `${namespace}.subagent_id`], cwd);
			}
		}
		await kata(["label", "add", ref, "needs-review"], cwd);
		await kata(["notify", ref, "--to", `${await actor(cwd, ref)}${lead ? `/${lead}` : ""}`, "--message", `Subagent ${delegate.id} ${delegate.state} without closing ${ref}; review it, then close or reassign it.`], cwd);
	}

	async function remove(task: Task, change: Change, cwd: string): Promise<void> {
		if (plan.local) { plan.tasks = plan.tasks.filter(t => t !== task); return; }
		if (OPEN.has(task.status)) {
			await transition(task, "abandoned", { ...change, remove: true }, cwd);
		}
		const decision = await owned(task.ref, cwd, "check", true, task.revision);
		await work(task.ref, "todo.removed", true, cwd, decision);
		retries.delete(task.ref);
	}

	function nextTask(tasks: Task[]): Task | undefined {
		if (tasks.some(t => t.status === "in_progress" && leads(t))) return;
		return phasesOf(tasks).flatMap(p => p.tasks).find(t => t.status === "pending" && leads(t));
	}

	// With no active task, start the earliest pending one (phase order).
	async function advance(cwd: string): Promise<void> {
		const next = nextTask(plan.tasks);
		if (next) await transition(next, "in_progress", {}, cwd);
	}

	async function resolve(target: string | undefined, phase: string | undefined, fallback: "active" | "none"): Promise<Task[]> {
		if (phase && !target) {
			const tasks = plan.tasks.filter(t => t.phase === phase);
			if (tasks.length === 0) throw new Error(`No phase "${phase}". Phases: ${phasesOf(plan.tasks).map(p => p.name).join(", ") || "none"}`);
			return tasks;
		}
		if (!target) {
			// Never guess between two active tasks: closing one closes it with this evidence.
			const active = plan.tasks.filter(t => t.status === "in_progress" && leads(t));
			if (fallback === "active" && active.length === 1) return active;
			if (fallback === "active" && active.length > 1) throw new Error(`Several tasks are in progress (${active.map(t => `"${t.content}"`).join(", ")}); name the task.`);
			throw new Error("Name the task (verbatim content or Kata ref).");
		}
		if (!plan.local && !plan.tasks.some(t => t.content === target) && /(?:^|#)[0-9a-hjkmnp-tv-z]{26}$/i.test(target)) target = await pin(target, plan.workspace!);
		const exact = plan.tasks.filter(t => t.content === target || t.ref === target || t.ref.split("#")[1] === target);
		if (exact.length === 1) return exact;
		const needle = target.toLowerCase();
		const fuzzy = plan.tasks.filter(t => t.content.toLowerCase().includes(needle));
		if (fuzzy.length === 1) return fuzzy;
		throw new Error(
			`${fuzzy.length ? "Ambiguous" : "No"} task "${target}". Tasks: ${plan.tasks.map(t => `"${t.content}"`).join(", ") || "none"}`,
		);
	}

	async function ensureParent(params: any, ctx: any): Promise<string | undefined> {
		const explicit = assignedRef ?? options.explicitRef?.() ?? process.env.KATA_REF;
		const target = explicit || params.ref;
		if (target && ((!explicit && params.ref) || !plan.parent || (target.includes("#") ? plan.parent !== target : plan.parent.split("#").pop() !== target))) {
			requestedRef = target;
			try { await adopt(target, ctx); }
			catch (error) { bound = false; throw error; }
		}
		if (!plan.parent && !await probe(ctx.cwd)) { goLocal(ctx); return; }
		// A Pi child may establish the session parent before the lead uses todo.
		if (!plan.parent && !explicit && !params.ref) {
			const recovered = await sessionBinding(ctx);
			if (recovered) { setParent(recovered); await load(recovered.workspace); }
		}
		if (plan.parent) {
			let decision = await reopenParent();
			if (decision && decision.metadata?.[`${namespace}.auto_parent`] === undefined) decision = await work(plan.parent, `${namespace}.auto_parent`, true, plan.workspace!, decision);
			if (decision && decision.metadata?.["work.attention"] === undefined) await work(plan.parent, "work.attention", "ok", plan.workspace!, decision);
			return plan.parent;
		}
		const sessionId = ctx.sessionManager?.getSessionId?.();
		if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("Kata needs a real session id before creating an automatic parent.");
		const title = (params.message as string | undefined)?.trim() || host.getSessionName?.() || `Todo plan: ${(params.list ?? []).map((p: any) => p.phase).join(", ") || "tasks"}`.slice(0, 120);
		const cwd = path.resolve(ctx.cwd);
		let where: Awaited<ReturnType<typeof destination>>, out: any;
		try {
			where = await destination(cwd);
			out = JSON.parse(await kata(["create", ...(where.project ? ["--project", where.project] : []), ...(where.label ? ["--label", where.label] : []), "--body", `Todo plan from ${namespace} session ${sessionId}.`, "--meta", `${namespace}.session_id=${sessionId}`, "--meta", `${namespace}.workspace=${cwd}`, "--label", `${namespace}-session`, "--idempotency-key", `${namespace}-session:${sessionId}`, "--force-new", "--json", "--", title], cwd));
		} catch (error) {
			// A folder with no git ancestor is refused client-side, so the probe never reached the daemon.
			if (!UNUSABLE.test(String(error))) throw error;
			scope = "down"; outage = (error as Error)?.message ?? String(error); debug(error);
			goLocal(ctx); return;
		}
		const ref = createdParentRef(out);
		let decision = await owned(ref, cwd, true, false, out.issue.revision);
		decision = await work(ref, `${namespace}.auto_parent`, true, cwd, decision);
		setParent({ parent: ref, workspace: cwd, sessionId, auto: true, label: where.label });
		if (decision.metadata?.["work.attention"] === undefined) await work(ref, "work.attention", "ok", cwd, decision);
		return ref;
	}

	async function reopenParent() {
		if (!plan.parent || !plan.auto) return;
		let decision = await owned(plan.parent, plan.workspace!, true, true);
		if (decision.status === "closed") {
			await kata(["reopen", plan.parent], plan.workspace!);
			decision = await owned(plan.parent, plan.workspace!, false, false, decision.revision + 1);
		}
		return decision;
	}

	class DeferredClose extends Error {}
	function scheduleRetry() {
		if (retryTimer) return;
		const fire = () => { retryTimer = undefined; retryTimerCtx = undefined; void serial(drainRetries).catch(debug); };
		// omp's ctx timer is contained and cleared on session_shutdown; pi has none.
		if (typeof currentCtx?.setTimeout === "function" && typeof currentCtx.clearTimer === "function") {
			retryTimerCtx = currentCtx;
			retryTimer = currentCtx.setTimeout(fire, 60_100);
		} else {
			retryTimer = setTimeout(fire, 60_100);
			retryTimer.unref?.();
		}
	}
	function clearRetryTimer() {
		if (!retryTimer) return;
		if (retryTimerCtx) retryTimerCtx.clearTimer(retryTimer); else clearTimeout(retryTimer);
		retryTimer = undefined; retryTimerCtx = undefined;
	}
	async function closeTask(args: string[], task: Task, to: Status, change: Change, cwd: string) {
		try { await kata(args, cwd); }
		catch (error) {
			if (!/throttl|sibling.*(burst|rate)|too many.*clos/i.test(String(error))) throw error;
			retries.set(task.ref, { task: { ...task }, to, change: { ...change }, cwd, at: Date.now() + 60_000 });
			persist();
			scheduleRetry();
			throw new DeferredClose(`Kata deferred closing "${task.content}" under its sibling throttle. It remains open and will retry after 60 seconds.`);
		}
	}
	async function drainRetries() {
		if (plan.local && currentCtx) await replayLocal(currentCtx).catch(debug);
		for (const [ref, pending] of retries) {
			if (pending.at > Date.now()) continue;
			try {
				const current = JSON.parse(await kata(["show", ref, "--json"], pending.cwd)).issue;
				if (pending.task.revision === undefined || current.status !== "open" || current.revision !== pending.task.revision) {
					retries.delete(ref); continue;
				}
				if (pending.change.remove) await remove(pending.task, pending.change, pending.cwd);
				else await transition(pending.task, pending.to, pending.change, pending.cwd);
				retries.delete(ref);
				if (plan.tasks.some(task => task.ref === ref)) { await load(plan.workspace!); await advance(plan.workspace!); }
			} catch (error) { debug(error); }
		}
		if (retries.size || plan.local) scheduleRetry();
		persist();
		await reconcile();
	}

	function proofArgs(items: any[]): string[] {
		const values = new Set<string>();
		for (const item of items) {
			const key: Record<string, string> = { commit: "sha", pr: "url", test: "command", external: "account", "no-change-audit": "rationale", "duplicate-of": "issue_ref", "superseded-by": "issue_ref" };
			const value = item[key[item.type]];
			if (typeof value === "string" && value.trim()) values.add(`${item.type}:${value}`);
			else if (item.type === "reviewed-paths" && Array.isArray(item.paths) && item.paths.length) for (const file of item.paths) { if (typeof file !== "string" || !file.trim()) throw new Error("Malformed Kata evidence"); values.add(`reviewed-paths:${file}`); }
			else throw new Error("Malformed or unknown Kata evidence");
		}
		return [...values].flatMap(value => ["--evidence", value]);
	}

	const delegatedRunning = () => host.delegatedRunning?.() ?? false;
	async function reconcile() {
		await host.beforeReconcile?.();
		for (const binding of autoParents.values()) {
			const { parent, workspace } = binding;
			let decision: any;
			try {
				if (delegatedRunning()) return;
				const initial = JSON.parse(await kata(["show", parent, "--json"], workspace));
				if (initial.issue.status === "closed" || initial.issue.metadata?.[`${namespace}.auto_parent`] !== true || initial.issue.metadata?.[`${namespace}.session_id`] !== binding.sessionId) continue;
				if (!initial.children?.length || initial.children.some((c: any) => c.status !== "closed")) continue;
				decision = await owned(parent, workspace, false, false, initial.issue.revision);
				const closedTimes = initial.children.filter((c: any) => c.closed_reason !== "wontfix").map((c: any) => Date.parse(c.closed_at));
				if (closedTimes.some((time: number) => !Number.isFinite(time))) throw new Error("Kata child close time unavailable");
				const since = closedTimes.length ? new Date(Math.min(...closedTimes)).toISOString() : undefined;
				const evidence: any[] = [];
				const audits = new Map<string, any[]>();
				let projects: any[] | undefined;
				for (const child of initial.children) {
					if (child.closed_reason === "wontfix") continue;
					let project = child.qualified_id?.split("#")[0];
					if (!project && child.project_id === initial.issue.project_id) project = parent.split("#")[0];
					if (!project) {
						projects ??= JSON.parse(await kata(["projects", "list", "--json"], workspace)).projects;
						project = projects!.find(p => p.id === child.project_id)?.name;
					}
					if (!project) throw new Error("Kata child project unavailable");
					if (!audits.has(project)) audits.set(project, JSON.parse(await kata(["audit", "closes", "--project", project, "--since", since!, "--json"], workspace)).rows);
					const rows = audits.get(project)!;
					const row = rows.filter((r: any) => r.issue === child.short_id).sort((a: any, b: any) => b.event_id - a.event_id)[0];
					if (!row?.event_id) throw new Error("Kata child close event unavailable");
					const page = JSON.parse(await kata(["events", "--project", project, "--after", String(row.event_id - 1), "--limit", "1", "--json"], workspace));
					const event = page.events?.[0];
					if (page.reset_required || event?.event_id !== row.event_id || event.type !== "issue.closed" || event.issue_uid !== child.uid || Date.parse(event.payload?.closed_at) !== Date.parse(child.closed_at) || !Array.isArray(event.payload?.evidence) || !event.payload.evidence.length) throw new Error("Kata current child evidence unavailable");
					evidence.push(...event.payload.evidence);
				}
				const proof = proofArgs(evidence);
				if (!proof.length) throw new Error("Kata child close evidence union is empty");
				const final = JSON.parse(await kata(["show", parent, "--json"], workspace));
				if (final.issue.status === "closed" || delegatedRunning()) continue;
				if (final.issue.revision !== initial.issue.revision || final.children?.length !== initial.children.length || final.children.some((c: any) => c.status !== "closed" || !initial.children.some((old: any) => old.uid === c.uid && old.revision === c.revision))) continue;
				await kata(["close", parent, "--done", "--if-match", String(final.issue.revision), "--idempotency-key", `${namespace}-parent-close:${parent}:${final.issue.revision}`, "--message", `${namespace.toUpperCase()} session ${binding.sessionId}: all ${final.children.length} child issues are closed in Kata and delegated work has settled. Evidence is the union of their current Kata-recorded close events.`, ...proof], workspace);
			} catch (error) {
				debug(error);
				if (/throttl|sibling.*(burst|rate)|too many.*clos/i.test(String(error))) scheduleRetry();
				try { const live = await owned(parent, workspace); if (!decision || live.revision === decision.revision) await kata(["label", "add", parent, "needs-review"], workspace); } catch (error) { debug(error); }
			}
		}
	}

	// ---------------------------------------------------------------------- ops

	async function apply(params: any, ctx: any): Promise<string> {
		if (!bound || currentId !== ctx.sessionManager?.getSessionId?.()) await bind(ctx, options.explicitRef?.() ?? process.env.KATA_REF ?? params.ref ?? (!bound ? requestedRef : undefined), params.op === "view");
		currentCtx = ctx;
		currentId ||= ctx.sessionManager?.getSessionId?.();
		if (plan.local) {
			try { await replayLocal(ctx); }
			catch (error) { if (params.op !== "view") throw new Error(`Kata is reachable again, but the session-local plan could not be replayed into it: ${(error as Error).message}`); }
		}
		let cwd = plan.workspace || ctx.cwd;
		const change: Change = { message: params.message?.trim() || undefined, evidence: params.evidence, reason: params.reason?.trim() || undefined };
		const op = params.op as string;
		if (op === "view") {
			await load(cwd);
			if (plan.parent) await reconcile();
			return render(plan);
		}
		if (op === "init") {
			const desired: { phase: string; content: string }[] = params.list?.length
				? params.list.flatMap((p: any) => p.items.map((content: string) => ({ phase: p.phase, content })))
				: (params.items ?? []).map((content: string) => ({ phase: params.phase || "Tasks", content }));
			if (desired.length === 0) throw new Error("init needs list (phases with items) or items.");
			if (desired.some(d => !d.content.trim() || !d.phase.trim())) throw new Error("Task and phase names must not be blank.");
			const wanted = new Set(desired.map(d => `${d.phase}\u0000${d.content}`));
			const explicit = assignedRef ?? options.explicitRef?.() ?? process.env.KATA_REF;
			const target = explicit || params.ref || plan.parent;
			if (target) {
				const workspace = explicit || !params.ref ? plan.workspace || ctx.cwd : ctx.cwd;
				const parent = target === plan.parent ? target : await pin(target, workspace);
				if (explicit && params.ref && parent !== await pin(params.ref, workspace)) throw new Error(`Kata init ref ${params.ref} conflicts with the explicit binding ${explicit}; neither plan was replaced.`);
				const tasks = tasksOf(await childrenOf(parent, workspace), parent);
				const kept = tasks.filter(t => wanted.has(`${t.phase}\u0000${t.content}`));
				const affected = new Set(tasks.filter(t => !kept.includes(t)));
				const next = nextTask(kept);
				if (next) affected.add(next);
				for (const task of affected) await owned(task.ref, workspace, "check", true, task.revision);
			}
			await ensureParent(params, ctx);
			cwd = plan.workspace || ctx.cwd;
			await load(cwd);
			for (const task of plan.tasks) if (wanted.has(`${task.phase}\u0000${task.content}`) && retries.get(task.ref)?.change.remove) retries.delete(task.ref);
			for (const task of plan.tasks) {
				if (!wanted.has(`${task.phase}\u0000${task.content}`)) await remove(task, { message: "replaced by a new todo plan" }, cwd);
			}
			const have = new Set(plan.tasks.map(t => `${t.phase}\u0000${t.content}`));
			for (const d of desired) if (!have.has(`${d.phase}\u0000${d.content}`)) {
				if (plan.local) plan.tasks.push({ ...d, ref: `local-${digest(d.phase, d.content)}`, status: "pending" });
				else await create(d.phase, d.content, plan.workspace!);
				have.add(`${d.phase}\u0000${d.content}`);
			}
			await load(cwd);
			await advance(cwd);
			return render(plan);
		}
		if (!plan.parent && !plan.local) throw new Error("No todo plan yet. Call todo op=init first.");
		const children = await load(cwd);
		switch (op) {
			case "append": {
				const items: string[] = params.items?.length ? params.items : params.task ? [params.task] : [];
				if (items.length === 0) throw new Error("append needs items.");
				if (items.some(content => !content.trim()) || (params.phase !== undefined && !params.phase.trim())) throw new Error("Task and phase names must not be blank.");
				const phase = params.phase || plan.tasks[plan.tasks.length - 1]?.phase || "Tasks";
				if (!plan.local) {
					for (const child of children) {
						const ref = child.qualified_id || `${plan.parent!.split("#")[0]}#${child.short_id}`;
						if (child.metadata?.["todo.phase"] === phase && items.includes(child.title) &&
							(child.status === "closed" || child.metadata?.["todo.removed"] === true)) {
							await owned(ref, cwd, "check", true, child.revision);
						}
					}
				}
				await reopenParent();
				for (const content of items) {
					if (plan.local) {
						const existing = plan.tasks.filter(t => t.content === content && t.phase === phase);
						if (existing.length > 1) throw new Error(`Ambiguous local task "${content}"; no task was appended.`);
						if (!existing.length) plan.tasks.push({ content, phase, ref: `local-${digest(phase, content)}`, status: "pending" });
					} else {
						await create(phase, content, cwd);
						for (const task of plan.tasks.filter(t => t.content === content && t.phase === phase)) if (retries.get(task.ref)?.change.remove) retries.delete(task.ref);
					}
				}
				await load(cwd);
				break;
			}
			case "start": {
				const [task] = await resolve(params.task, undefined, "none");
				if (task.status === "blocked") throw new Error(`"${task.content}" is blocked; unblock it first.`);
				const decision = plan.local ? undefined : await owned(task.ref, cwd, true, !OPEN.has(task.status), task.revision);
				if (decision) task.revision = decision.revision;
				if (!OPEN.has(task.status)) await reopenParent();
				for (const other of plan.tasks) if (other !== task && other.status === "in_progress" && leads(other) && !retries.has(other.ref)) await transition(other, "pending", {}, cwd);
				await transition(task, "in_progress", change, cwd, decision);
				retries.delete(task.ref);
				break;
			}
			case "done":
			case "drop": {
				const tasks = (await resolve(params.task, params.phase, "active")).filter(t => OPEN.has(t.status));
				change.many = tasks.length > 1;
				for (const task of tasks) await transition(task, op === "done" ? "completed" : "abandoned", change, cwd);
				break;
			}
			case "rm":
				for (const task of await resolve(params.task, params.phase, "none")) await remove(task, change, cwd);
				await load(cwd);
				break;
			case "block":
				for (const task of await resolve(params.task, undefined, "active")) await transition(task, "blocked", change, cwd);
				break;
			case "unblock":
				for (const task of await resolve(params.task, undefined, "none")) if (task.status === "blocked") await transition(task, "pending", change, cwd);
				break;
			default:
				throw new Error(`Unknown op "${op}".`);
		}
		await advance(cwd);
		await reconcile();
		return render(plan);
	}

	function details(op: string) {
		return {
			op,
			// Not a top-level `phases`: omp's native todo tracker reads that key from
			// any result named `todo` and would add its own reminders, nudges and HUD.
			kata: {
				parent: plan.parent,
				phases: phasesOf(plan.error ? [] : plan.tasks).map(p => ({
					name: p.name,
					tasks: p.tasks.map(t => (t.blocker ? { content: t.content, status: t.status, blocker: t.blocker } : { content: t.content, status: t.status })),
				})),
			},
		};
	}

	async function execute(params: any, ctx: any) {
		return serial(async () => {
			if (boundAgent && boundAgent !== agentKey(ctx)) {
				return { content: [{ type: "text" as const, text: "Kata agent identity changed; use this worker's own extension context." }], details: { op: params.op, kata: {} }, isError: true };
			}
			try {
				if (!main(ctx) && !host.binding) throw new Error("The todo plan belongs to the main agent.");
				const text = await apply(params, ctx);
				return { content: [{ type: "text" as const, text }], details: details(params.op) };
			} catch (err) {
				// A failed initial binding has no authoritative plan to render yet.
				if (!bound || !plan.parent && !plan.local) plan.error = (err as Error).message;
				// Kata may have applied part of a batch. A failed reload marks the
				// cached tasks unavailable instead of presenting them as current.
				if (plan.parent) await load(plan.workspace || ctx.cwd).catch(debug);
				return {
					content: [{ type: "text" as const, text: `${(err as Error).message}\n\n${render(plan)}` }],
					details: details(params.op),
					isError: err instanceof DeferredClose ? undefined : true,
				};
			} finally {
				persist();
				refresh(ctx);
			}
		});
	}

	async function command(args: string, ctx: any): Promise<string> {
		const match = /^(\S+)?(?:\s+([\s\S]*))?$/.exec(args.trim());
		const sub = match?.[1] ?? "";
		const arg = match?.[2]?.trim() || undefined;
		const actor = process.env.USER || "user";
		const supported: Record<string, any> = {
			"": { op: "view" },
			start: { op: "start", task: arg },
			done: { op: "done", task: arg, message: `Marked done by ${actor} through /todo in ${namespace}; the user attests the work is complete.`, evidence: [`external:${actor}`] },
			drop: { op: "drop", task: arg, message: `dropped by ${actor} through /todo` },
			rm: { op: "rm", task: arg, message: `removed by ${actor} through /todo` },
			append: { op: "append", items: arg ? [arg] : [] },
			block: { op: "block", reason: arg },
			unblock: { op: "unblock", task: arg },
		};
		const params = supported[sub];
		if (!params) return `/todo ${sub} is not available with Kata. Use /todo [start|done|drop|rm|append|block|unblock], or kata tui.`;
		const text = await serial(async () => {
			try {
				return await apply(params, ctx);
			} catch (err) {
				return (err as Error).message;
			} finally {
				persist();
				refresh(ctx);
			}
		});
		return text;
	}

	async function observeToolResult(event: any, ctx: any) {
		progressed = true;
		if (!main(ctx) || (options.explicitRef?.() ?? process.env.KATA_REF) || event.toolName !== "bash" || event.isError || (event.details?.exitCode !== undefined && event.details.exitCode !== 0)) return;
		const command = event.input?.command;
		if (typeof command !== "string" || /[;|\n]/.test(command)) return;
		for (const invocation of kataCommands(command, options.executable, options.executableVars)) {
			const parsed = shellOptions(invocation.words), args = parsed.args;
			let ref = args[0] === "claim" ? args[1] : args[0] === "meta" && args[1] === "set" && args[3] === "work.attention" && args[4] === "ok" ? args[2] : undefined;
			if (!ref || parsed.options.has("--as")) continue;
			if (!ref.includes("#") && parsed.value("--project")) ref = `${parsed.value("--project")}#${ref}`;
			const workspace = path.resolve(event.input.cwd || ctx.cwd, parsed.value("--workspace") || ".");
			const target = ref;
			await bounded(serial(async () => {
				if (plan.tasks.some(t => t.ref === target || t.ref.split("#")[1] === target)) return;
				await owned(target, workspace);
				await adopt(target, ctx, workspace);
			}));
		}
	}

	async function remind(messages: any[], ctx: any): Promise<string | undefined> {
		if (!main(ctx)) return;
		const refreshed = await bounded(serial(async () => { await load(plan.workspace || ctx.cwd); await drainRetries(); return true; }));
		if (!refreshed || plan.error) return;
		const open = plan.tasks.filter(t => t.status === "pending" || t.status === "in_progress");
		if (open.length === 0 || reminders >= MAX_REMINDERS || !progressed) return;
		// Do not push past a question the assistant just asked the user.
		const last = [...(messages)].reverse().find((m: any) => m?.role === "assistant");
		const text = Array.isArray(last?.content)
			? last.content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("")
			: String(last?.content ?? "");
		if (text.trim().endsWith("?")) return;
		reminders++;
		progressed = false;
		return [
				"<system-reminder>",
				`Open Kata todo tasks under ${plan.parent} (reminder ${reminders}/${MAX_REMINDERS}):`,
				...open.map(t => `- ${t.content} (${t.ref}, ${t.status})`),
				"Continue the work, or update the plan: done with evidence, block with a reason when waiting on someone, or drop with a reason.",
				"If the user asked you to stop or pause, do not continue: block the remaining tasks with that reason and stop.",
				"</system-reminder>",
			].join("\n");
	}

	// The contract is fetched once per session; the inbox on every call, so a request
	// sent mid-session reaches a later turn. A read slower than the caller's budget
	// keeps running and lands in the cache for the next turn.
	function warm(ctx: any, cwd = ctx.cwd) {
		const id = ctx.sessionManager?.getSessionId?.();
		if (cache.id !== id) cache = { id };
		const entry = cache;
		if (!entry.pending && !entry.contract) {
			entry.pending = (async () => {
				if (!await probe(cwd)) return;
				// Exactly these arguments: some Kata builds print nothing for any other form.
				const out = await kata(["agent-contract-hook", "--source", "kata-agent-contract-hook"], cwd, 1000, false).then(out => JSON.parse(out)?.hookSpecificOutput?.additionalContext);
				if (typeof out === "string") entry.contract = out;
			})().catch(debug).finally(() => { entry.pending = undefined; });
		}
		const user = process.env.KATA_INBOX_USER;
		if (user && !entry.inboxPending) {
			// Empty output means no requests; a failed read keeps the last inbox.
			entry.inboxPending = kata(["inbox", "--context", "--for", user], cwd)
				.then(out => { entry.inbox = out?.trim(); }, debug)
				.finally(() => { entry.inboxPending = undefined; });
		}
		return Promise.all([entry.pending, entry.inboxPending]).then(() => undefined);
	}

	return {
		get plan() { return plan; },
		get currentId() { return currentId; },
		get currentCtx() { return currentCtx; },
		set currentCtx(ctx: any) { currentCtx = ctx; },
		get cache() { return cache; },
		stateEntry: STATE_ENTRY,
		resetReminders() { reminders = 0; },
		debug, bounded, serial, kata, actor, owned, work, load, refresh, probe, bind, handBack,
		ensureParent, destination, candidate, adopt, reconcile, drainRetries, apply, execute, command,
		observeToolResult, remind, warm,
	};
}
