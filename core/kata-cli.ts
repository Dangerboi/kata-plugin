import path from "node:path";
import { valid, gte } from "semver";
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

// What a `kata close` reads to record the session that made it: the session pair and the switch that turns recording on.
export const TRANSCRIPT_ENV = ["KATA_TRANSCRIPT_AGENT", "KATA_TRANSCRIPT_SESSION_ID", "KATA_CLOSE_TRANSCRIPT_ENABLED"] as const;
const [AGENT, SESSION, ENABLED] = TRANSCRIPT_ENV;
// Every later close from this process and what it spawns (the bash tool, delegates, harnesses launched from bash) then
// records this session. The switch stays as the launching environment set it, so `KATA_CLOSE_TRANSCRIPT_ENABLED=false` opts out.
export function exportTranscriptSession(agent: string, sessionId: string | undefined): void {
	if (!sessionId) return;
	process.env[AGENT] = agent;
	process.env[SESSION] = sessionId;
	process.env[ENABLED] ??= "true";
}

export type ExecResult = { code: number; stdout: string; stderr?: string; killed?: boolean };
export type Exec = (file: string, args: string[], options: { cwd: string; timeout: number; ctx?: any }) => Promise<ExecResult>;
export type Project = { id: number; name: string };

export interface Kata {
	// `workspace: false` leaves out `--workspace <cwd>`.
	run(args: string[], cwd: string, options?: { timeout?: number; workspace?: boolean }): Promise<string>;
	show(ref: string, cwd: string): Promise<KataShow>;
	// The registered projects, read once per session and again with `fresh` (a project registered later).
	projects(cwd: string, fresh?: boolean): Promise<Project[]>;
	// An unreadable list is empty, so no ref in prose is taken for a ticket.
	projectNames(cwd: string): Promise<Set<string>>;
	// The issue's current qualified ref: its project is the one it lives in now, not the one `ref` (what Kata was asked) names.
	qualify(issue: KataIssue, cwd: string, ref?: string): Promise<string>;
	pin(ref: string, cwd: string): Promise<string>;
	// Registers a project in the daemon (idempotent; no files in the repo).
	createProject(name: string, cwd: string): Promise<void>;
}

export function createKata(env: {
	exec: Exec;
	executable: string;
	// Added to every call as `--teammate` when set.
	teammate(): string | undefined;
	// Handed to `exec`: the context of the event the call serves.
	ctx(): any;
	// The project list is read once per session.
	session(): string | undefined;
	debug(error: unknown): void;
}): Kata {
	let registered: { id?: string; list: Promise<Project[]> } | undefined;

	async function invoke(args: string[], cwd: string, { timeout = 120_000, workspace = true } = {}): Promise<string> {
		// --json makes every failure carry Kata's error code; the contract hook prints its own format.
		const plain = args[0] === "agent-contract-hook" || args[0] === "version";
		const teammate = env.teammate();
		// Options end at `--`: what follows (a title, an item) is data, even when it reads `--json`.
		const at = args.indexOf("--"), end = at < 0 ? args.length : at;
		const flags = [...(plain || args.slice(0, end).includes("--json") ? [] : ["--json"]), ...(teammate !== undefined && !plain ? ["--teammate", teammate] : []), ...(workspace ? ["--workspace", path.resolve(cwd)] : [])];
		args = [...args.slice(0, end), ...flags, ...args.slice(end)];
		let result: ExecResult;
		try { result = await env.exec(env.executable, args, { cwd, timeout, ctx: env.ctx() }); }
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
	async function run(args: string[], cwd: string, options?: { timeout?: number; workspace?: boolean }): Promise<string> {
		await (compatible ??= (async () => {
			let version: unknown, output = "";
			try { output = await invoke(["version", "--json"], cwd, { timeout: 3000, workspace: false }); }
			catch (error) { if (!(error instanceof KataError) || isUnusable(error)) throw error; }
			try {
				const identity = JSON.parse(output);
				if (identity?.kata_api_version === 1) version = identity.version;
			} catch { /* Malformed JSON cannot prove a compatible release. */ }
			// Kata's Makefile uses git describe; descendants and dirty trees keep the release tag's minimum.
			const normalized = typeof version === "string" ? version.replace(/^(v?\d+\.\d+\.\d+)-(?:\d+-g[0-9a-f]{4,}(?:-dirty)?|dirty)$/, "$1") : "";
			const release = valid(normalized);
			if (!release) {
				throw new KataError(`kata-plugin requires Kata >=0.23.0, but this Kata reports version ${JSON.stringify(version ?? "unknown")}, which does not prove its release. Install a versioned release (Homebrew, release archive or kata update), or build from a tagged clone with make install.`, { exit: 1, code: "unsupported_version" });
			}
			if (!gte(release, "0.23.0")) {
				throw new KataError(`kata-plugin requires Kata >=0.23.0 (found ${version}). Upgrade Kata and retry.`, { exit: 1, code: "unsupported_version" });
			}
		})().catch(error => { compatible = undefined; throw error; }));
		return invoke(args, cwd, options);
	}

	const show = async (ref: string, cwd: string): Promise<KataShow> => JSON.parse(await run(["show", ref], cwd));

	function projects(cwd: string, fresh = false): Promise<Project[]> {
		if (fresh || registered?.id !== env.session()) registered = undefined;
		const entry: NonNullable<typeof registered> = registered ??= {
			id: env.session(),
			list: run(["projects", "list"], cwd).then(out => (JSON.parse(out).projects as any[]).map(p => ({ id: p.id, name: p.name })))
				.catch(error => { if (registered === entry) registered = undefined; throw error; }),
		};
		return entry.list;
	}

	// A project name the list lacks means the project was renamed since it was read.
	async function qualify(issue: KataIssue, cwd: string, ref?: string): Promise<string> {
		const asked = ref?.includes("#") ? projectOf(ref) : undefined;
		const known = await projects(cwd);
		const stale = asked !== undefined && !known.some(p => p.name === asked);
		const project = (stale ? undefined : known.find(p => p.id === issue.project_id)) ?? (await projects(cwd, true)).find(p => p.id === issue.project_id);
		if (!project) throw new Error("Kata issue project could not be pinned.");
		return `${project.name}#${issue.short_id}`;
	}

	return {
		run, show, projects, qualify,
		projectNames: cwd => projects(cwd).then(list => new Set(list.map(p => p.name)), error => { env.debug(error); return new Set<string>(); }),
		pin: async (ref, cwd) => qualify((await show(ref, cwd)).issue, cwd, ref),
		async createProject(name, cwd) {
			registered = undefined;
			await run(["projects", "create", name], cwd, { timeout: 20_000, workspace: false });
		},
	};
}
