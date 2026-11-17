import { execFile } from "node:child_process";
import { realpathSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach } from "bun:test";
import { realKata, unique } from "./kata-fixture";
import { register } from "../plugins/claude-code/hooks/register";
import { reset } from "../plugins/claude-code/hooks/lead";

export const PROJECT = "pi-port-claude";
const AUTHOR = "claude-builder";

type Hook = { event: string; matcher?: any; fn: (...args: any[]) => any };
const matches = (matcher: any, value: any): boolean => matcher === undefined ? true
  : matcher instanceof RegExp ? typeof value === "string" && matcher.test(value)
  : Array.isArray(matcher) ? matcher.some(m => matches(m, value))
  : matcher && typeof matcher === "object" ? Object.entries(matcher).every(([k, v]) => matches(v, value?.[k]))
  : matcher === value;

/**
 * A hand-made `$` and event chain for the Claude mod: the nouns the plugin uses, backed by this process (real Kata through
 * execFile, real realpath, a Map for `$.store`), and `fire(event, input)` running the registered hooks the way the engine
 * does: each one gets `next` for the rest of the chain, and the engine's own answer sits at the end.
 * A hook that throws is skipped, as in the engine.
 */
export function claudeHost(options: { cwd: string; binary: string; session?: string; store?: Map<string, unknown>; env?: Record<string, string>; options?: Record<string, unknown> }) {
  reset();
  const state = { session: options.session ?? crypto.randomUUID(), cwd: options.cwd };
  const store = options.store ?? new Map<string, unknown>();
  const hooks: Hook[] = [];
  const calls: { argv: readonly string[]; init: any }[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const env = { ...options.env };
  const $: any = {
    plugin: { name: "kata-cc", root: "/plugin" },
    env: { get: async (name: string) => env[name] ?? process.env[name], set: async () => ({}) },
    session: { id: async () => state.session, cwd: async () => state.cwd },
    fs: {
      stat: async (p: string, o?: any) => { const real = realpathSync(p); return { kind: "dir", size: 0, mtimeMs: 0, isLink: false, ...(o?.resolve ? { realPath: real } : {}) }; },
      read: async (p: string) => readFileSync(p, "utf8"),
      write: async (p: string, text: string) => writeFileSync(p, text),
    },
    store: {
      get: async (k: string) => store.has(k) ? structuredClone(store.get(k)) : undefined,
      set: async (k: string, v: unknown) => { store.set(k, structuredClone(v)); },
      delete: async (k: string) => { store.delete(k); },
      keys: async () => [...store.keys()],
    },
    clock: {
      now: async () => Date.now(),
      after: (ms: number, fn: () => void) => { const t = setTimeout(fn, ms); timers.add(t); return { cancel: () => { clearTimeout(t); timers.delete(t); } }; },
    },
    process: {
      // Like the engine: no shell, env merged over the process's, a timeout kills the child and rejects, any exit code resolves.
      run: (argv: readonly string[], init: any = {}) => new Promise((resolve, reject) => {
        calls.push({ argv, init });
        execFile(argv[0]!, argv.slice(1), { cwd: init.cwd, env: { ...process.env, ...init.env }, timeout: init.timeoutMs, killSignal: "SIGKILL" }, (error: any, stdout, stderr) => {
          if (!error) return resolve({ exitCode: 0, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false });
          if (typeof error.code === "number") return resolve({ exitCode: error.code, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false });
          reject(error);
        });
      }),
    },
  };
  const on = (event: string, ...rest: any[]) => { hooks.push({ event, matcher: rest.length > 1 ? rest[0] : undefined, fn: rest[rest.length - 1] }); };
  register(on as any, (options.options ?? { kataExecutable: options.binary }) as any);

  /** Runs the chain for an event; `terminal` is the engine's own answer when every hook calls `next`. */
  async function fire(event: string, input: any = {}, terminal: (e: any) => any = e => e, extra: Record<string, unknown> = {}) {
    const chain = hooks.filter(h => h.event === event && matches(h.matcher, input));
    const run = async (i: number, e: any): Promise<any> => {
      const hook = chain[i];
      if (!hook) return terminal(e);
      const next: any = (n: any) => run(i + 1, n);
      next.signal = new AbortController().signal;
      next.budget = { remainingMs: 1500 };
      Object.assign(next, extra);
      try { return await hook.fn($, e, next); } catch { return run(i + 1, e); }
    };
    return run(0, input);
  }
  const base = [{ name: "Bash" }, { name: "TaskCreate" }, { name: "TaskGet" }, { name: "TaskList" }, { name: "TaskUpdate" }, { name: "TodoWrite" }, { name: "TaskStop" }]
    .map(t => ({ ...t, description: "", mcp: false }));
  const api = {
    $, state, store, calls, hooks,
    fire,
    start: () => fire("session.start", { cwd: state.cwd, surface: null, isInteractive: false }),
    toolList: () => fire("tool.list", {}, () => ({ value: base })),
    /** A `todo` call; `agentId` makes it a subagent's. */
    todo: (params: Record<string, unknown>, agentId?: string) => fire("tool.call", { tool: "todo", tool_use_id: `t-${unique()}`, ...(agentId ? { agentId } : {}), ...params }, () => { throw new Error("the engine ran todo"); }),
    prompt: (text = "hello", origin = "composer") => fire("prompt.submit", { text, wait: true, origin: { kind: origin } }),
    turnComplete: () => fire("turn.complete", { answer: "ok", durationMs: 1, isAborted: false, turnId: "t", reason: "answer" }),
    /** An `agent.spawn`; the engine's own answer starts the agent as `agentId` and keeps the prompt it was given. */
    spawn: (input: Record<string, unknown>, agentId: string | undefined = `agent-${unique()}`, answer: (e: any) => any = e => ({ model: "haiku", ...(agentId ? { agentId } : {}), prompt: e.prompt })) =>
      fire("agent.spawn", { tool_use_id: `toolu_${unique()}`, prompt: "", description: "", subagentType: "general-purpose", provider: { plugin: "engine", tier: "core" }, parentModel: "sonnet", background: true, fork: false, ...input }, answer),
    /** A tool call of a subagent; the engine's own answer is the call as it would run. */
    agentCall: (agentId: string, tool: string, input: Record<string, unknown> = {}, terminal: (e: any) => any = e => e) =>
      fire("tool.call", { tool, tool_use_id: `toolu_${unique()}`, agentId, ...input }, terminal),
    /** The end of a subagent's run. */
    agentTurn: (agentId: string, answer: string, extra: Record<string, unknown> = {}) =>
      fire("turn.complete", { answer, durationMs: 1, isAborted: false, turnId: `turn-${unique()}`, reason: "answer", agentId, ...extra }),
    stop: (last = "Done for now.") => fire("classic.Stop", { stop_hook_active: false, last_assistant_message: last }),
    end: (reason = "other") => fire("session.end", { reason, sessionId: state.session, resume: { id: state.session } }),
    cancelTimers: () => { for (const t of timers) clearTimeout(t); timers.clear(); },
  };
  return api;
}

export type ClaudeHost = ReturnType<typeof claudeHost>;

/** A real Kata for Claude adapter tests; hosts a test starts have their timers cleared after it. */
export function claudeKata(prefix: string) {
  const store = realKata({ prefix, author: AUTHOR, project: PROJECT, adopt: true });
  const hosts: ClaudeHost[] = [];
  afterEach(() => { for (const h of hosts.splice(0)) h.cancelTimers(); });
  const host = (extra: Partial<Parameters<typeof claudeHost>[0]> = {}) => {
    const h = claudeHost({ cwd: store.cwd, binary: store.binary, ...extra });
    hosts.push(h);
    return h;
  };
  return { ...store, host };
}
