import type { EngineInterface } from "claude-code";
import { closeEnv, type ExecResult, type Platform, type Timers } from "../core/kata-cli";
import type { DelegateRecord } from "../core/delegates";
import type { HostContext } from "../core/kata-core";
import { posixPath } from "../core/posix-path";
import type { sessionWriter } from "./saved";
import { NAMESPACE } from "./settings";

// The core's Platform and its Kata process, built from `$`.

// What one Claude session keeps in memory. An event's context names its session, and the core moves the host onto it when it
// binds to that session (the host's `switched`).
export interface Session {
	id: string;
	header?: { parentSession: string };
	writer: ReturnType<typeof sessionWriter>;
	records: Map<string, DelegateRecord>;
	// What earlier prompts carried, by section: a section is sent again only when it changed.
	sent: Record<string, string>;
	// Delegates whose spawn arrived under auto mode, which refuses a hook's rewrite of a tool call (see `runRewritten`).
	autoMode: Set<string>;
}

// The context the core gets with each event: the core's HostContext plus the event's own `$.process.run`, so a call made
// for an event runs under that event's `$`.
export interface RunContext extends HostContext {
	held: Session;
	run: (
		argv: readonly string[],
		init: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }
	) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
	timers: Timers;
}

export function timersOf($: EngineInterface): Timers {
	return {
		setTimer: (fire, ms) => $.clock.after(ms, fire),
		clearTimer: handle => (handle as { cancel(): void }).cancel()
	};
}

// The core's Platform. Timers use the clock of the `$` the runtime started under; a context with its own timers wins.
// There is no process environment: `env` is the map the runtime read at start, and what the core sets stays in it.
export function platformOf($: EngineInterface, env: Map<string, string>, state: { cwd: string }): Platform {
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
		...timersOf($),
		// `realPath` is absent when the path leads nowhere: reject, as realpath does for a missing path.
		realpath: async file => {
			const found = (await $.fs.stat(file, { resolve: true })).realPath;
			if (!found) throw new Error(`${file} does not exist`);
			return found;
		},
		readFile: async file => {
			const read = await $.fs.read(file);
			return typeof read === "string" ? read : new TextDecoder().decode(read);
		},
		home: env.get("HOME"),
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
export function execOf($: EngineInterface, env: Map<string, string>, latest: () => RunContext | undefined) {
	return async (file: string, args: string[], options: { cwd: string; timeout: number; ctx?: RunContext }): Promise<ExecResult> => {
		const ctx = options.ctx ?? latest();
		const pair = closeEnv({ get: name => env.get(name) }, args, NAMESPACE, ctx?.sessionManager?.getSessionId?.());
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
