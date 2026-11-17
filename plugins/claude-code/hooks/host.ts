import { closeEnv, type ExecResult, type Platform, type Timers } from "../core/kata-cli";
import * as path from "../core/posix-path";
import { posixPath } from "../core/posix-path";
import type { DelegateRecord } from "../core/delegates";
import type { Engine } from "./engine";
import type { sessionWriter } from "./saved";

// Everything the core takes from its machine, built from `$`: the one place that knows the mod runtime has no Node.

// What one session keeps in memory: its saved record and its delegates' records. An event's context names the session's, and
// the core moves the host onto them when it binds to that session (the host's `switched`).
export interface Held {
	id: string;
	// Set for a fork: the session it was branched from.
	header?: { parentSession: string };
	writer: ReturnType<typeof sessionWriter>;
	records: Map<string, DelegateRecord>;
}

// The context the core gets with each event: the core's HostContext plus the event's own `$.process.run`, so a call made
// for an event runs under that event's `$`. A timer or a retry that carries no event uses the latest one.
export interface RunContext {
	cwd: string;
	held?: Held;
	agent?: { kind?: string; id?: string };
	sessionManager?: {
		getSessionId?(): string | undefined;
		getBranch?(): readonly unknown[];
		getHeader?(): { parentSession?: unknown } | null | undefined;
	};
	run?: (
		argv: readonly string[],
		init: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }
	) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
	timers?: Timers;
	ui?: { setWidget?(key: string, content: unknown): void; notify?(message: string, level?: string): void };
}

// The session cwd as `$.fs.stat` resolves it (symlinks and `..` gone), so a workspace recorded in Kata matches however the
// session was started. A path that leads nowhere keeps its written form.
export async function canonicalPath($: Engine, file: string): Promise<string> {
	try {
		const found = await $.fs.stat(file, { resolve: true });
		if (found.realPath) return found.realPath;
	} catch {
		/* A missing path rejects: resolve its folder and join the name. */
	}
	const parent = path.dirname(file);
	if (parent === file) return file;
	try {
		const found = await $.fs.stat(parent, { resolve: true });
		if (found.realPath) return path.join(found.realPath, path.basename(file));
	} catch {
		/* Nothing resolves: as written. */
	}
	return file;
}

// The core's Platform. `setTimer` uses the clock of the `$` the runtime started under; a context with its own timers wins.
// There is no process environment: `env` is the map the runtime read at start, and what the core sets stays in it.
export function platformOf($: Engine, env: Map<string, string>, state: { cwd: string; debugFile?: string }): Platform {
	let appended: Promise<unknown> = Promise.resolve();
	return {
		env: {
			get: name => env.get(name),
			set(name, value) {
				if (value === undefined) env.delete(name);
				else env.set(name, value);
			}
		},
		cwd: () => state.cwd,
		path: posixPath,
		pid: 0,
		setTimer: (fire, ms) => $.clock.after(ms, fire),
		clearTimer: handle => (handle as { cancel(): void }).cancel(),
		// `realPath` is absent when the path leads nowhere: reject, as realpath does for a missing path.
		realpath: async file => {
			const found = (await $.fs.stat(file, { resolve: true })).realPath;
			if (!found) throw new Error(`${file} does not exist`);
			return found;
		},
		// `$.fs.write` replaces a file, so an append reads the old text first; one at a time.
		appendFile(file, text) {
			appended = appended
				.then(async () => {
					const before = await $.fs.read(file).catch(() => "");
					await $.fs.write(file, (typeof before === "string" ? before.slice(-1_000_000) : "") + text);
				})
				.catch(() => undefined);
		}
	};
}

// Kata through `$.process.run`: no shell, the transcript pair of a close in that call's own environment. Like pi.exec a
// non-zero exit is a result. A rejection is a timeout (the run kills the child) when it came after the limit, else the
// executable could not start (ENOENT, which the core reads as "Kata is missing").
export function execOf($: Engine, env: Map<string, string>, latest: () => RunContext | undefined) {
	return async (file: string, args: string[], options: { cwd: string; timeout: number; ctx?: RunContext }): Promise<ExecResult> => {
		const ctx = options.ctx ?? latest();
		const pair = closeEnv(args, "claude", ctx?.sessionManager?.getSessionId?.(), env.get("KATA_CLOSE_TRANSCRIPT_ENABLED"));
		const begun = await $.clock.now();
		try {
			const run = ctx?.run ?? ((argv, init) => $.process.run(argv, init));
			const out = await run([file, ...args], { cwd: options.cwd, timeoutMs: options.timeout, ...(pair ? { env: pair } : {}) });
			return { code: out.exitCode, stdout: out.stdout, stderr: out.stderr, killed: false };
		} catch (error) {
			if ((await $.clock.now()) - begun >= options.timeout * 0.9) return { code: 1, stdout: "", stderr: String(error), killed: true };
			throw Object.assign(new Error(String(error instanceof Error ? error.message : error)), { code: "ENOENT" });
		}
	};
}
