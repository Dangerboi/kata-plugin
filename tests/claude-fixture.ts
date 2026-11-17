import { execFile, spawn } from "node:child_process";
import { realpathSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach } from "bun:test";
import { realKata, unique } from "./kata-fixture";
import { register } from "../plugins/claude-code/hooks/register";
import { reset } from "../plugins/claude-code/hooks/lead";

export const PROJECT = "pi-port-claude";
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
	/** Holds a process call (a gate in a test) until the promise it returns settles. */
	hold?: (argv: readonly string[]) => Promise<unknown> | undefined;
}) {
	reset();
	const state = { session: options.session ?? crypto.randomUUID(), cwd: options.cwd };
	const store = options.store ?? new Map<string, unknown>();
	const hooks: Hook[] = [];
	const calls: { argv: readonly string[]; init: any }[] = [];
	const timers = new Set<ReturnType<typeof setTimeout>>();
	// Set when the test is over: nothing may start after it (a stream that ends schedules its own restart).
	let over = false;
	const children = new Set<{ kill(signal?: string): unknown }>();
	const spawned: any[] = [],
		submitted: any[] = [],
		appended: any[] = [];
	const env = { ...options.env };
	const $: any = {
		plugin: { name: "kata-cc", root: "/plugin" },
		env: { get: async (name: string) => env[name] ?? process.env[name], set: async () => ({}) },
		session: {
			id: async () => state.session,
			cwd: async () => state.cwd,
			// The engine's own answer for a row it accepts.
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
				children.add(child);
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
			run: async (argv: readonly string[], init: any = {}) => {
				await options.hold?.(argv);
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
		fire,
		start: () => fire("session.start", { cwd: state.cwd, surface: null, isInteractive: false }),
		toolList: () => fire("tool.list", {}, () => ({ value: base })),
		/** A `todo` call; `agentId` makes it a subagent's. */
		todo: (params: Record<string, unknown>, agentId?: string) =>
			fire("tool.call", { tool: "todo", tool_use_id: `t-${unique()}`, ...(agentId ? { agentId } : {}), ...params }, () => {
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
		/** The end of a subagent's run. */
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
			timers.clear();
			for (const c of children) c.kill("SIGKILL");
			children.clear();
		}
	};
	return api;
}

export type ClaudeHost = ReturnType<typeof claudeHost>;

/** A real Kata for Claude adapter tests; hosts a test starts have their timers cleared after it. */
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
	return { ...store, author: AUTHOR, host };
}
