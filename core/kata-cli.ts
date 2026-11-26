import { projectOf, type KataIssue, type KataShow } from "./model";

// Running the Kata CLI: every call, its error envelope, and the registered projects it reads refs against.

// A failed Kata call. Kata's own error envelope (`--json`: {error:{kind,code,
// hint,message,exit_code,data}}) and its documented exit code are kept so callers
// branch on them, never on message wording.
export class KataError extends Error {
	constructor(message: string, readonly info: {
		exit: number;
		code?: string; // the envelope's error code, e.g. project_not_initialized
		data?: Record<string, unknown>; // the envelope's structured data, e.g. {alias} or {project} on project_not_initialized
		killed?: boolean; // our timeout killed it
		notRun?: boolean; // Kata never ran: missing executable
	}) { super(message); }
	get code() { return this.info.code; }
	// Kata cannot serve requests: not runnable, timed out, or daemon unreachable (exit 7).
	get unusable() { return Boolean(this.info.notRun || this.info.killed || this.info.code === "daemon_unavailable" || this.info.exit === 7); }
}
export const isUnusable = (error: unknown) => error instanceof KataError && error.unusable;
export const isKataCode = (error: unknown, code: string) => error instanceof KataError && error.code === code;

// The path operations the core uses. A Node host passes node:path (`nodePlatform.path`), so a Windows host keeps its separators
// and drive letters; a host without Node passes `posixPath` (core/posix-path.ts).
export interface PathOps {
	resolve(...segments: string[]): string;
	join(...segments: string[]): string;
	basename(path: string): string;
	dirname(path: string): string;
}

export type Timers = Pick<Platform, "setTimer" | "clearTimer">;

// Every environment variable the core reads or sets (see `setting` in kata-core.ts); a host asks its own environment for exactly these.
export const CORE_ENV = ["KATA_REF", "KATA_TEAMMATE", "KATA_AUTHOR", "USER", "KATA_DEFAULT_PROJECT", "KATA_INBOX_USER", "KATA_HOME", "KATA_ATTENTION_HOST", "KATA_CLOSE_TRANSCRIPT_ENABLED", "KATA_REF_GUARD"] as const;

// What the core needs from the machine it runs on, so that it imports nothing from Node. A Node host passes node-host.ts's
// `nodePlatform`; a host without a process environment, timers or a synchronous filesystem supplies what it has.
export interface Platform {
	// The environment Kata calls and the shell commands the host runs inherit. `set` exports a value to them (undefined
	// removes it). A host with no process environment keeps the values and need not pass them on.
	env: { get(name: (typeof CORE_ENV)[number]): string | undefined; set(name: (typeof CORE_ENV)[number], value: string | undefined): void };
	cwd(): string;
	path: PathOps;
	// The host process Kata's attention hook is told about.
	pid: number;
	// Timers for work that must not outlive the host; a Node host unrefs them. `clearTimer` takes what `setTimer` returned.
	setTimer(fire: () => void, ms: number): unknown;
	clearTimer(handle: unknown): void;
	// The canonical path (symlinks resolved), rejecting when nothing exists there (a Node host wraps fs.realpathSync). Required: the core compares workspaces by what they resolve to.
	realpath(path: string): Promise<string>;
	// Appends to the debug file.
	appendFile(file: string, text: string): void;
}

// The sink for errors the plugin survives: a line in `file`, nothing without one. Debugging must never interrupt work.
export const debugTo = (file: string | undefined, append: Platform["appendFile"]) => (error: unknown) => {
	if (!file) return;
	try { append(file, `${new Date().toISOString()} ${String(error)}\n`); } catch { /* Ignored: see above. */ }
};

// Waits for `promise` at most `ms`: undefined when the time runs out or the promise rejects (the error goes to `onError`).
// The promise itself is never cancelled.
export async function waitAtMost<T>(promise: Promise<T>, ms: number, onError: (error: unknown) => void, timers: Timers): Promise<T | undefined> {
	let timer: unknown;
	try { return await Promise.race([promise.catch(error => { onError(error); return undefined; }), new Promise<undefined>(resolve => { timer = timers.setTimer(() => resolve(undefined), ms); })]); }
	finally { timers.clearTimer(timer); }
}

const MINIMUM = [0, 23, 0];

// Whether a reported Kata version is at least MINIMUM; undefined when it names no release (`dev`, a commit hash).
// `make install` reports git describe (`v0.23.0-4-gabc1234`, `-dirty`): a build after a tag has that tag's release.
// A prerelease precedes its release, so 0.23.0-rc.1 is too old and 0.24.0-rc.1 is not.
function meetsMinimum(version: string): boolean | undefined {
	const release = version.replace(/^(v?\d+\.\d+\.\d+)-(?:\d+-g[0-9a-f]{4,}(?:-dirty)?|dirty)$/, "$1");
	const match = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(release);
	if (!match) return undefined;
	const order = MINIMUM.map((least, i) => Number(match[i + 1]) - least).find(diff => diff !== 0) ?? 0;
	return order > 0 || (order === 0 && !match[4]);
}

// What a `kata close` reads to record the session that made it: the session pair and the switch that turns recording on.
export const TRANSCRIPT_ENV = ["KATA_TRANSCRIPT_AGENT", "KATA_TRANSCRIPT_SESSION_ID", "KATA_CLOSE_TRANSCRIPT_ENABLED"] as const;
const [AGENT, SESSION, ENABLED] = TRANSCRIPT_ENV;
// The environment that makes a close record `sessionId`. The switch stays as the launching environment set it (read from
// `env`), so `KATA_CLOSE_TRANSCRIPT_ENABLED=false` opts out.
export function transcriptEnv(env: Pick<Platform["env"], "get">, agent: string, sessionId: string): Record<(typeof TRANSCRIPT_ENV)[number], string> {
	return { [AGENT]: agent, [SESSION]: sessionId, [ENABLED]: env.get(ENABLED) ?? "true" };
}
// The environment a Kata call carries for a close to record the session that made it; undefined for any other call. With
// no session id (a delegate whose own session is not known yet) recording is switched off: the process carries the lead's
// pair, which that close must not record.
export function closeEnv(env: Pick<Platform["env"], "get">, args: readonly string[], agent: string, sessionId: string | undefined): Record<string, string> | undefined {
	if (args[0] !== "close") return undefined;
	return sessionId ? transcriptEnv(env, agent, sessionId) : { [ENABLED]: "false" };
}

export type ExecResult = { code: number; stdout: string; stderr?: string; killed?: boolean };
export type Exec = (file: string, args: string[], options: { cwd: string; timeout: number; ctx?: any }) => Promise<ExecResult>;

type Project = { id: number; name: string };

const READS = new Set(["show", "list", "status", "version", "agent-contract-hook", "inbox", "events", "audit"]);
export const isRead = (args: string[]) => READS.has(args[0]) || (args[0] === "projects" && args[1] === "list");
// Writes any runner on this thread made (the lead's core, a delegate's, another plugin copy's): each one ends every
// operation's reuse of earlier reads. A Kata command an agent runs in its shell is another process, and an omp subagent on
// a worker thread has its own count, so neither is seen here: an operation is kept short, and a check that must be
// current reads with `fresh`.
const writes = ((globalThis as Record<symbol, unknown>)[Symbol.for("kata.plugin.writes")] ??= { count: 0 }) as { count: number };

// The `kata show` results of one operation (see `Kata.operation`), by the exact arguments, with the write count they were
// read at. Callbacks and timers that hold the job of an operation may run long after it, so the store serves reads only
// while its operation runs (`open`).
type Reads = { open: boolean; seen: Map<string, { writes: number; out: Promise<string> }> };
// A job queued from inside a batch joins it: it runs after the batch's earlier jobs, in the batch's place in the queue
// and with its Kata reads. It ends once the batch's function and every job queued inside it have ended.
export type Batch = { open: boolean; tail: Promise<unknown> };
// What a Kata call serves, passed explicitly down every call chain that started in it; nothing is ambient.
export interface Job {
	// The context of the host event whose call this is, handed to `exec`: another identity's event may move the core's latest
	// context while the call awaits. Absent: the latest one.
	readonly ctx?: any;
	// The operation the call belongs to and reuses reads in. Absent (an event handler, a timer, a poll): every read reaches Kata.
	readonly reads?: Reads;
	// The batch a job queued from this one joins (see the core's `serial`).
	readonly batch?: Batch;
}
// A call made by code that no operation or todo call started.
export const NO_JOB: Job = {};

export interface Kata {
	// `workspace: false` leaves out `--workspace <cwd>`.
	run(job: Job, args: string[], cwd: string, options?: { timeout?: number; workspace?: boolean }): Promise<string>;
	show(job: Job, ref: string, cwd: string): Promise<KataShow>;
	// The registered projects, read once per session and again with `fresh` (a project registered later).
	projects(job: Job, cwd: string, fresh?: boolean): Promise<Project[]>;
	// An unreadable list is empty, so no ref in prose is taken for a ticket.
	projectNames(job: Job, cwd: string): Promise<Set<string>>;
	// The issue's current qualified ref: its project is the one it lives in now, not the one `ref` (what Kata was asked) names.
	qualify(job: Job, issue: KataIssue, cwd: string, ref?: string): Promise<string>;
	pin(job: Job, ref: string, cwd: string): Promise<string>;
	// Registers a project in the daemon (idempotent; no files in the repo).
	createProject(job: Job, name: string, cwd: string): Promise<void>;
	// Runs `fn` as one operation, with the job it passes on: an identical `kata show` through that job is read once until a
	// runner on this thread writes. An operation is one tool call; Kata changes made elsewhere meanwhile (an agent's own
	// shell command, another process or thread) show in the next one. Inside an open operation `fn` gets `from` as it is.
	operation<T>(from: Job, fn: (job: Job) => Promise<T>): Promise<T>;
	// The job with every read going to Kata, for a check that must see changes made elsewhere since the operation began.
	fresh(job: Job): Job;
}

export function createKata(env: {
	exec: Exec;
	path: Pick<PathOps, "resolve">;
	executable: string;
	teammate(): string | undefined;
	// The context `exec` gets for a call whose job carries none: the latest event's.
	ctx(): any;
	// The session the registered-project list was read for: a new one reads it again.
	session(): string | undefined;
	debug(error: unknown): void;
}): Kata {
	let registered: { id?: string; list: Promise<Project[]> } | undefined;
	async function operation<T>(from: Job, fn: (job: Job) => Promise<T>): Promise<T> {
		if (from.reads?.open) return fn(from);
		const store: Reads = { open: true, seen: new Map() };
		try { return await fn({ ...from, reads: store }); } finally { store.open = false; store.seen.clear(); }
	}

	async function invoke(job: Job, args: string[], cwd: string, { timeout = 120_000, workspace = true } = {}): Promise<string> {
		// --json makes every failure carry Kata's error code; the contract hook prints its own format.
		const plain = args[0] === "agent-contract-hook" || args[0] === "version";
		const teammate = env.teammate();
		// Options end at `--`: what follows (a title, an item) is data, even when it reads `--json`.
		const at = args.indexOf("--"), end = at < 0 ? args.length : at;
		const flags = [...(plain || args.slice(0, end).includes("--json") ? [] : ["--json"]), ...(teammate !== undefined && !plain ? ["--teammate", teammate] : []), ...(workspace ? ["--workspace", env.path.resolve(cwd)] : [])];
		args = [...args.slice(0, end), ...flags, ...args.slice(end)];
		if (!isRead(args)) {
			// Counted when it starts and when it ends, so a read that overlapped it is not reused either.
			writes.count++;
			try { return await call(job, args, cwd, timeout); } finally { writes.count++; }
		}
		const store = args[0] === "show" ? job.reads : undefined;
		if (!store?.open) return call(job, args, cwd, timeout);
		const key = args.join("\0");
		const seen = store.seen.get(key);
		if (seen && seen.writes === writes.count) return seen.out;
		const out = call(job, args, cwd, timeout);
		store.seen.set(key, { writes: writes.count, out });
		out.catch(() => { if (store.seen.get(key)?.out === out) store.seen.delete(key); });
		return out;
	}

	async function call(job: Job, args: string[], cwd: string, timeout: number): Promise<string> {
		let result: ExecResult;
		try { result = await env.exec(env.executable, args, { cwd, timeout, ctx: job.ctx ?? env.ctx() }); }
		catch (error) {
			if ((error as { code?: unknown })?.code !== "ENOENT") throw error;
			throw new KataError(`kata ${args[0]} could not run: ${(error as Error).message}`, { exit: -1, notRun: true });
		}
		if (result.code !== 0 || result.killed) {
			// Kata may print warning lines (e.g. a skipped transcript) before the envelope, which is always the last line.
			const envelope = [result.stdout, result.stderr].map(text => { try { return JSON.parse((text ?? "").trim().split("\n").pop() ?? "").error; } catch { return undefined; } }).find(e => e && typeof e === "object");
			const detail = envelope?.message ?? (result.stderr || result.stdout || "").trim().split("\n").slice(-3).join(" ");
			// A host that fails to spawn reports a bare failure with no output at all; Kata always says something.
			const notRun = !result.killed && !envelope && !detail;
			// A renamed project's old name no longer resolves: drop the cached list so the next lookup reloads it.
			if (envelope?.code === "project_not_initialized") registered = undefined;
			throw new KataError(`kata ${args[0]} ${result.killed ? `timed out after ${timeout}ms` : notRun ? "could not run" : "failed"}${detail ? `: ${detail}` : ""}`, { exit: result.code, code: envelope?.code, data: envelope?.data && typeof envelope.data === "object" ? envelope.data : undefined, killed: result.killed, notRun });
		}
		return result.stdout;
	}

	// Share one bounded check across concurrent reads. Failed checks retry so installing
	// or upgrading Kata can recover without restarting the host; outages stay outages.
	let compatible: Promise<void> | undefined;
	async function run(job: Job, args: string[], cwd: string, options?: { timeout?: number; workspace?: boolean }): Promise<string> {
		await (compatible ??= (async () => {
			let version: unknown, output = "";
			try { output = await invoke(job, ["version", "--json"], cwd, { timeout: 3000, workspace: false }); }
			catch (error) { if (!(error instanceof KataError) || isUnusable(error)) throw error; }
			try {
				const identity = JSON.parse(output);
				if (identity?.kata_api_version === 1) version = identity.version;
			} catch { /* Malformed JSON cannot prove a compatible release. */ }
			const meets = typeof version === "string" ? meetsMinimum(version) : undefined;
			const minimum = MINIMUM.join(".");
			if (meets === undefined) {
				throw new KataError(`kata-plugin requires Kata >=${minimum}, but this Kata reports version ${JSON.stringify(version ?? "unknown")}, which does not prove its release. Install a versioned release (Homebrew, release archive or kata update), or build from a tagged clone with make install.`, { exit: 1, code: "unsupported_version" });
			}
			if (!meets) {
				throw new KataError(`kata-plugin requires Kata >=${minimum} (found ${version}). Upgrade Kata and retry.`, { exit: 1, code: "unsupported_version" });
			}
		})().catch(error => { compatible = undefined; throw error; }));
		return invoke(job, args, cwd, options);
	}

	const show = async (job: Job, ref: string, cwd: string): Promise<KataShow> => JSON.parse(await run(job, ["show", ref], cwd));

	function projects(job: Job, cwd: string, fresh = false): Promise<Project[]> {
		if (fresh || registered?.id !== env.session()) registered = undefined;
		const entry: NonNullable<typeof registered> = registered ??= {
			id: env.session(),
			list: run(job, ["projects", "list"], cwd).then(out => (JSON.parse(out).projects as any[]).map(p => ({ id: p.id, name: p.name })))
				.catch(error => { if (registered === entry) registered = undefined; throw error; }),
		};
		return entry.list;
	}

	// A project name the list lacks means the project was renamed since it was read.
	async function qualify(job: Job, issue: KataIssue, cwd: string, ref?: string): Promise<string> {
		const asked = ref?.includes("#") ? projectOf(ref) : undefined;
		const known = await projects(job, cwd);
		const stale = asked !== undefined && !known.some(p => p.name === asked);
		const project = (stale ? undefined : known.find(p => p.id === issue.project_id)) ?? (await projects(job, cwd, true)).find(p => p.id === issue.project_id);
		if (!project) throw new Error("Kata issue project could not be pinned.");
		return `${project.name}#${issue.short_id}`;
	}

	return {
		run, show, projects, qualify,
		operation,
		fresh: job => ({ ...job, reads: undefined }),
		projectNames: (job, cwd) => projects(job, cwd).then(list => new Set(list.map(p => p.name)), error => { env.debug(error); return new Set<string>(); }),
		pin: async (job, ref, cwd) => qualify(job, (await show(job, ref, cwd)).issue, cwd, ref),
		async createProject(job, name, cwd) {
			registered = undefined;
			await run(job, ["projects", "create", name], cwd, { timeout: 20_000, workspace: false });
		},
	};
}
