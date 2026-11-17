import { execFile, spawn, type ChildProcess } from "node:child_process";
import { realpathSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach } from "bun:test";
import { eventually, realKata, unique } from "./kata-fixture";
import { assertIsolated } from "./isolation";
import { register } from "../plugins/claude-code/hooks/register";
import { reset, runtime } from "../plugins/claude-code/hooks/lead";

export const PROJECT = "pi-port-claude";

/**
 * Starts a hook and resolves, with the hook's pending result, once it has entered the session chain: the latest event's
 * context is replaced, and a switch has queued its job in the core in the same step. What the hook goes on to run is
 * queued in the core ahead of anything started after this returns.
 */
export async function entering<T>(start: () => Promise<T>): Promise<{ result: Promise<T> }> {
	const before = runtime()?.latest;
	const result = start();
	await eventually(async () => runtime()?.latest !== before, true);
	return { result };
}

/** A clock that moves only when the test says: `fireNext` runs the earliest timer the host armed and moves `elapsed` to its time. */
export function pausedClock($: any) {
	const begun = Date.now();
	const due: { at: number; fire: () => void }[] = [];
	let at = 0;
	$.clock.now = async () => begun + at;
	$.clock.after = (ms: number, fire: () => void) => {
		const timer = { at: at + ms, fire };
		due.push(timer);
		return {
			cancel: () => {
				const i = due.indexOf(timer);
				if (i >= 0) due.splice(i, 1);
			}
		};
	};
	return {
		elapsed: () => at,
		get pending() {
			return due.length;
		},
		fireNext() {
			due.sort((a, b) => a.at - b.at);
			const timer = due.shift();
			if (!timer) return false;
			at = Math.max(at, timer.at);
			timer.fire();
			return true;
		}
	};
}

const AUTHOR = "claude-builder";

type Hook = { event: string; matcher?: any; fn: (...args: any[]) => any };
const matches = (matcher: any, value: any): boolean =>
	matcher === undefined
		? true
		: matcher instanceof RegExp
			? typeof value === "string" && matcher.test(value)
			: Array.isArray(matcher)
				? matcher.some(m => matches(m, value))
				: matcher && typeof matcher === "object"
					? Object.entries(matcher).every(([k, v]) => matches(v, value?.[k]))
					: matcher === value;

/**
 * A hand-made `$` and event chain for the Claude mod: the nouns the plugin uses, backed by this process (real Kata through
 * execFile, real realpath, a Map for `$.store`), and `fire(event, input)` running the registered hooks the way the engine
 * does: each one gets `next` for the rest of the chain, and the engine's own answer sits at the end.
 * A hook that throws is skipped, as in the engine.
 */
export function claudeHost(options: {
	cwd: string;
	binary: string;
	session?: string;
	store?: Map<string, unknown>;
	env?: Record<string, string>;
	options?: Record<string, unknown>;
	/** Runs before a Kata call (`holdKata(…).before`): the call waits for it, and an answer it returns stands in for Kata's. */
	before?: (argv: string[], init: any) => Promise<unknown> | undefined;
	/** The engine's own permission decision at `tool.check` (a query has no `tool_use_id`): rules, mode and PreToolUse hooks; default: ask. */
	rules?: (e: { tool: string; input: any; tool_use_id?: string }) => { decision: "allow" | "ask" | "deny"; reason?: string; hook?: string };
}) {
	reset();
	const state = { session: options.session ?? crypto.randomUUID(), cwd: options.cwd };
	const store = options.store ?? new Map<string, unknown>();
	const hooks: Hook[] = [];
	const calls: { argv: readonly string[]; init: any }[] = [];
	const timers = new Set<ReturnType<typeof setTimeout>>();
	// Set when the test is over: nothing may start after it (a stream that ends schedules its own restart).
	let over = false;
	const streams: ChildProcess[] = [];
	const spawned: any[] = [],
		submitted: any[] = [],
		appended: any[] = [];
	const env = { ...options.env };
	const rules = options.rules ?? (() => ({ decision: "ask" as const }));
	const $: any = {
		plugin: { name: "kata-cc", root: "/plugin" },
		env: { get: async (name: string) => env[name] ?? process.env[name], set: async () => ({}) },
		// A query runs the tool.check chain as the engine does (the asking hook finds no rewrite for the command it asks about).
		tool: { check: (input: { tool: string; input: unknown }) => fire("tool.check", input, rules) },
		session: {
			id: async () => state.session,
			cwd: async () => state.cwd,
			append: async (args: any) => {
				appended.push(args);
				return { message: args.message, uuid: crypto.randomUUID() };
			}
		},
		prompt: {
			submit: async (args: any) => {
				submitted.push(args);
				return { text: args.text, origin: { kind: "plugin", name: "kata-cc" } };
			}
		},
		fs: {
			stat: async (p: string, o?: any) => {
				const real = realpathSync(p);
				return { kind: "dir", size: 0, mtimeMs: 0, isLink: false, ...(o?.resolve ? { realPath: real } : {}) };
			},
			read: async (p: string) => readFileSync(p, "utf8"),
			write: async (p: string, text: string) => writeFileSync(p, text)
		},
		store: {
			get: async (k: string) => (store.has(k) ? structuredClone(store.get(k)) : undefined),
			set: async (k: string, v: unknown) => {
				store.set(k, structuredClone(v));
			},
			delete: async (k: string) => {
				store.delete(k);
			},
			keys: async () => [...store.keys()]
		},
		clock: {
			now: async () => Date.now(),
			after: (ms: number, fn: () => void) => {
				const t = setTimeout(() => {
					if (!over) fn();
				}, ms);
				timers.add(t);
				return {
					cancel: () => {
						clearTimeout(t);
						timers.delete(t);
					}
				};
			}
		},
		process: {
			// Like the engine: a child by argv with no shell; pieces as they come, then `{ code, signal }` as the return value.
			// `return()` kills the child, also while a `next()` is pending: the loop is the child's life.
			spawn: (request: any) => {
				if (over) throw new Error("the test is over");
				spawned.push(request);
				const child = spawn(request.argv[0], request.argv.slice(1), {
					cwd: request.cwd ?? state.cwd,
					env: { ...process.env, ...request.env },
					stdio: ["ignore", "pipe", "ignore"]
				});
				streams.push(child);
				const queue: any[] = [];
				let outcome: any, wake: (() => void) | undefined, failure: unknown;
				const ring = () => {
					const w = wake;
					wake = undefined;
					w?.();
				};
				child.stdout!.setEncoding("utf8");
				child.stdout!.on("data", (text: string) => {
					queue.push({ stream: "stdout", text });
					ring();
				});
				child.on("error", error => {
					failure = error;
					ring();
				});
				child.on("close", (code, signal) => {
					outcome ??= { code, signal };
					ring();
				});
				const it: any = {
					async next() {
						for (;;) {
							if (queue.length) return { done: false, value: queue.shift() };
							if (failure) throw failure;
							if (outcome) return { done: true, value: outcome };
							await new Promise<void>(resolve => {
								wake = resolve;
							});
						}
					},
					async return() {
						child.kill("SIGKILL");
						outcome ??= { code: null, signal: "SIGKILL" };
						ring();
						return { done: true, value: outcome };
					},
					[Symbol.asyncIterator]() {
						return it;
					}
				};
				return it;
			},
			// Like the engine: no shell, env merged over the process's, a timeout kills the child and rejects, any exit code resolves.
			run: async (argv: string[], init: any = {}) => {
				assertIsolated();
				const answered = await options.before?.(argv, init);
				if (answered !== undefined) return answered;
				return new Promise((resolve, reject) => {
					calls.push({ argv, init });
					execFile(
						argv[0]!,
						argv.slice(1),
						{ cwd: init.cwd, env: { ...process.env, ...init.env }, timeout: init.timeoutMs, killSignal: "SIGKILL" },
						(error: any, stdout, stderr) => {
							if (!error) return resolve({ exitCode: 0, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false });
							if (typeof error.code === "number") return resolve({ exitCode: error.code, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false });
							reject(error);
						}
					);
				});
			}
		}
	};
	const on = (event: string, ...rest: any[]) => {
		hooks.push({ event, matcher: rest.length > 1 ? rest[0] : undefined, fn: rest[rest.length - 1] });
	};
	register(on as any, (options.options ?? { kataExecutable: options.binary }) as any);

	/** Runs the chain for an event; `terminal` is the engine's own answer when every hook calls `next`. */
	async function fire(event: string, input: any = {}, terminal: (e: any) => any = e => e, extra: Record<string, unknown> = {}) {
		const chain = hooks.filter(h => h.event === event && matches(h.matcher, input));
		const run = async (i: number, e: any): Promise<any> => {
			const hook = chain[i];
			if (!hook) return terminal(e);
			const next: any = (n: any) => run(i + 1, n);
			next.signal = new AbortController().signal;
			// The engine's own budgets: 10 s for a hook, 1.5 s for the whole chain of `session.end`.
			next.budget = { remainingMs: event === "session.end" ? 1500 : 10_000 };
			Object.assign(next, extra);
			try {
				return await hook.fn($, e, next);
			} catch {
				return run(i + 1, e);
			}
		};
		return run(0, input);
	}
	const base = [
		{ name: "Bash" },
		{ name: "TaskCreate" },
		{ name: "TaskGet" },
		{ name: "TaskList" },
		{ name: "TaskUpdate" },
		{ name: "TodoWrite" },
		{ name: "TaskStop" }
	].map(t => ({ ...t, description: "", mcp: false }));
	const api = {
		$,
		state,
		store,
		calls,
		hooks,
		spawned,
		submitted,
		appended,
		streams,
		fire,
		start: () => fire("session.start", { cwd: state.cwd, surface: null, isInteractive: false }),
		toolList: () => fire("tool.list", {}, () => ({ value: base })),
		/** A `todo` call; `agentId` makes it a subagent's, `callId` names the row its card is drawn for. */
		todo: (params: Record<string, unknown>, agentId?: string, callId = `t-${unique()}`) =>
			fire("tool.call", { tool: "todo", tool_use_id: callId, ...(agentId ? { agentId } : {}), ...params }, () => {
				throw new Error("the engine ran todo");
			}),
		prompt: (text = "hello", origin = "composer") => fire("prompt.submit", { text, wait: true, origin: { kind: origin } }),
		/** An `agent.spawn`; the engine's own answer starts the agent as `agentId` and keeps the prompt it was given. */
		spawn: (
			input: Record<string, unknown>,
			agentId: string | undefined = `agent-${unique()}`,
			answer: (e: any) => any = e => ({ model: "haiku", ...(agentId ? { agentId } : {}), prompt: e.prompt })
		) =>
			fire(
				"agent.spawn",
				{
					tool_use_id: `toolu_${unique()}`,
					prompt: "",
					description: "",
					subagentType: "general-purpose",
					provider: { plugin: "engine", tier: "core" },
					parentModel: "sonnet",
					background: true,
					fork: false,
					...input
				},
				answer
			),
		/** A tool call of a subagent; the engine's own answer is the call as it would run. */
		agentCall: (agentId: string, tool: string, input: Record<string, unknown> = {}, terminal: (e: any) => any = e => e) =>
			fire("tool.call", { tool, tool_use_id: `toolu_${unique()}`, agentId, ...input }, terminal),
		/** The permission decision for a Bash call: the `tool.check` chain over `rules`. */
		check: (command: string, agentId?: string) =>
			fire("tool.check", { tool: "Bash", input: { command }, tool_use_id: `toolu_${unique()}`, ...(agentId ? { agentId } : {}) }, rules),
		agentTurn: (agentId: string, answer: string, extra: Record<string, unknown> = {}) =>
			fire("turn.complete", { answer, durationMs: 1, isAborted: false, turnId: `turn-${unique()}`, reason: "answer", agentId, ...extra }),
		turnStart: (agentId?: string) => fire("turn.start", { text: "", turnId: "t", ...(agentId ? { agentId } : {}) }),
		turnComplete: (agentId?: string) =>
			fire("turn.complete", { answer: "ok", durationMs: 1, isAborted: false, turnId: "t", reason: "answer", ...(agentId ? { agentId } : {}) }),
		stop: (last = "Done for now.") => fire("classic.Stop", { stop_hook_active: false, last_assistant_message: last }),
		end: (reason = "other") => fire("session.end", { reason, sessionId: state.session, resume: { id: state.session } }),
		cancelTimers: () => {
			over = true;
			for (const t of timers) clearTimeout(t);
			for (const stream of streams) stream.kill("SIGKILL");
		}
	};
	return api;
}

export type ClaudeHost = ReturnType<typeof claudeHost>;

/** A real Kata for Claude adapter tests; hosts a test starts have their timers cleared after it. `sh` runs a Bash call's command in the store's workspace, as the engine's Bash would. */
export function claudeKata(prefix: string) {
	const store = realKata({ prefix, author: AUTHOR, project: PROJECT, adopt: true });
	const hosts: ClaudeHost[] = [];
	afterEach(() => {
		for (const h of hosts.splice(0)) h.cancelTimers();
	});
	const host = (extra: Partial<Parameters<typeof claudeHost>[0]> = {}) => {
		const h = claudeHost({ cwd: store.cwd, binary: store.binary, ...extra });
		hosts.push(h);
		return h;
	};
	async function sh(command: string) {
		const proc = Bun.spawn(["bash", "-c", command], { cwd: store.cwd, env: { ...store.env, PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		return { code: await proc.exited, stdout, stderr };
	}
	return { ...store, author: AUTHOR, host, sh };
}
