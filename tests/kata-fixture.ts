import { afterAll, beforeAll, beforeEach, expect, setSystemTime } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertIsolated, SCRUBBED_ENV } from "./isolation";
import { recordStore, type DelegateRecord, type DelegateStore } from "../core/delegates";
import { RETRY_MS } from "../core/settlement";
import type { PlanView } from "../core/kata-core";

export function memoryDelegateStore(): DelegateStore & { drop(id: string): void } {
  const records = new Map<string, DelegateRecord>();
  return { ...recordStore(() => records, ctx => [...records.values()].find(record => record.sessionId === ctx.sessionManager.getSessionId())),
    // Forgets a record, as a process whose memory never held it.
    drop: id => { records.delete(id); } };
}

const exec = promisify(execFile);
// One Kata call may take this long, well inside a test's 15 s.
const EXEC_TIMEOUT = 5000;
export function isolatedKata(binary: string, env: NodeJS.ProcessEnv, cwd: string) {
  return async (args: string[], workspace = cwd, timeout = EXEC_TIMEOUT, extraEnv: NodeJS.ProcessEnv = {}) => {
    assertIsolated(env);
    try { return { ...await exec(binary, args, { env: { ...env, ...extraEnv }, cwd: workspace, timeout }), code: 0, killed: false }; }
    catch (error: any) { return { stdout: error.stdout || "", stderr: error.stderr || error.message, code: error.code || 1, killed: !!error.killed }; }
  };
}

/**
 * A real Kata with a store of its own: a scratch directory under the test root holding a workspace and the Kata home,
 * and Kata's environment for `author` with every scrubbed variable removed, then `extra` set. `kata` returns a call's
 * JSON, `text` its output, `show` an issue's whole view; all three throw when Kata fails. Registers no hooks: test
 * files call `realKata`.
 */
export function kataStore(prefix: string, author: string, extra: Record<string, string> = {}) {
  assertIsolated();
  const binary = process.env.KATA_TEST_EXECUTABLE;
  if (!binary || !path.isAbsolute(binary)) throw new Error("Set KATA_TEST_EXECUTABLE to the absolute Kata binary.");
  const scratch = mkdtempSync(path.join(process.env.KATA_TEST_ROOT!, `${prefix}-`));
  const cwd = path.join(scratch, "workspace"), home = path.join(scratch, "home");
  mkdirSync(cwd);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SCRUBBED_ENV) delete env[key];
  Object.assign(env, { KATA_HOME: home, KATA_AUTHOR: author }, extra);
  const run = isolatedKata(binary, env, cwd);
  async function text(args: string[], workspace = cwd, extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
    const out = await run(args, workspace, undefined, extraEnv);
    if (out.code) throw new Error(`kata ${args.join(" ")}: ${out.stderr}`);
    return out.stdout;
  }
  const kata = async (args: string[], workspace?: string, extraEnv?: NodeJS.ProcessEnv): Promise<any> => JSON.parse(await text(args, workspace, extraEnv));
  const show = (ref: string) => kata(["show", ref, "--json"]);
  // Every event of the workspace's project, oldest first. The store holds every earlier test's events, so one page is not all of them.
  async function events(): Promise<any[]> {
    const all: any[] = [];
    for (let after = 0;;) {
      const page = await kata(["events", "--after", String(after), "--limit", "500", "--json"]);
      all.push(...page.events);
      if (page.events.length < 500) return all;
      after = page.next_after_id;
    }
  }
  /** Creates an issue and returns its short id. */
  async function issue(title: string, options: { parent?: string; meta?: string[]; owner?: string; project?: string; body?: string; workspace?: string } = {}): Promise<string> {
    const args = ["create", title, "--force-new", "--json"];
    if (options.parent) args.push("--parent", options.parent);
    if (options.owner) args.push("--owner", options.owner);
    if (options.body) args.push("--body", options.body);
    if (options.project) args.push("--project", options.project);
    for (const value of options.meta ?? []) args.push("--meta", value);
    return (await kata(args, options.workspace)).issue.short_id;
  }
  const deleteIssue = (ref: string) => kata(["delete", ref, "--force", "--confirm", `DELETE ${ref}`, "--json"]);
  const commentsOf = async (ref: string): Promise<string[]> => ((await show(ref)).comments ?? []).map((comment: any) => comment.body);
  /** The issues an adapter recorded for a session (`<namespace>.session_id`); `label`: only its automatic parents, which carry `<namespace>-session`. */
  async function sessionParents(namespace: string, sid: string, label = false): Promise<any[]> {
    return (await kata(["list", "--status", "all", "--meta", `${namespace}.session_id=${sid}`, ...(label ? ["--label", `${namespace}-session`] : []), "--json"])).issues;
  }
  /** The close events of an issue (a short or a qualified ref), oldest first, with their payloads. */
  async function closesOf(ref: string): Promise<any[]> {
    const shortId = ref.split("#").pop();
    return (await events()).filter(event => event.type === "issue.closed" && event.issue_short_id === shortId);
  }
  return { binary, scratch, cwd, home, env, run, text, kata, show, events, issue, deleteIssue, commentsOf, sessionParents, closesOf };
}

export interface RealKataOptions {
  /** Names the scratch directory. */
  prefix: string;
  author: string;
  /** Initialised in the workspace before the first test; omitted: the file registers its own projects. */
  project?: string;
  /** Set in Kata's environment besides `KATA_AUTHOR`. */
  env?: Record<string, string>;
  /** Also point this process's own `kata` at the store, for the closes the omp adapter spawns itself (`adoptIsolatedKata`). */
  adopt?: boolean;
  /** What each test starts with in `process.env` besides `KATA_AUTHOR`. */
  process?: Record<string, string>;
}

/**
 * `kataStore` for a test file; call it once at the top. Every test starts with the same `process.env`: the scrubbed
 * variables gone, then `KATA_AUTHOR` and `options.process` set, so a variable one test sets never reaches the next.
 * After the last test the daemon is stopped and `process.env` is what it was before the file.
 */
export function realKata(options: RealKataOptions) {
  const store = kataStore(options.prefix, options.author, options.env);
  // The previous test's environment is undone when the next one starts, not in an afterEach: a file's own afterEach
  // (a session shutdown, say) runs after this fixture's and still needs the adopted store.
  let restore = () => {};
  beforeAll(async () => { if (options.project) await store.text(["init", "--project", options.project]); });
  beforeEach(() => {
    restore();
    const saved = SCRUBBED_ENV.map(key => [key, process.env[key]] as const);
    const unadopt = options.adopt ? adoptIsolatedKata(store.binary, store.home) : undefined;
    for (const key of SCRUBBED_ENV) delete process.env[key];
    Object.assign(process.env, { KATA_AUTHOR: options.author, ...options.process });
    restore = () => {
      unadopt?.();
      for (const [key, value] of saved) value === undefined ? delete process.env[key] : process.env[key] = value;
      restore = () => {};
    };
  });
  afterAll(async () => { await store.run(["daemon", "stop"]); restore(); });
  return store;
}

// One counter for every fixture in the process. The adapters keep lead and delegate records per session id in module
// state, so when several files run in one `bun test` process (KATA_TEST_JOBS=1) their session ids must not repeat.
let sequence = 0;
export const unique = () => ++sequence;

type Callback = (...args: any[]) => any;
/** Callbacks by name, as a host keeps them: `fire` runs every one registered for the name, in order, and returns the last result that is not undefined. */
export function registry() {
  const callbacks = new Map<string, Callback[]>();
  return {
    callbacks,
    on: (name: string, callback: Callback) => { callbacks.set(name, [...(callbacks.get(name) || []), callback]); },
    async fire(name: string, ...args: any[]) {
      let result;
      for (const callback of callbacks.get(name) || []) { const next = await callback(...args); if (next !== undefined) result = next; }
      return result;
    },
  };
}

export interface FakeHostOptions {
  /** Runs Kata for every exec the adapter issues and `before` does not answer. */
  run: (args: string[], opts: any) => Promise<any>;
  cwd: string;
  sid?: string;
  header?: any;
  /** The session branch; `appendEntry` adds to it. */
  entries?: any[];
  /** Answers an exec instead of Kata; undefined falls through to `run`. */
  before?: (args: string[], opts: any) => Promise<any> | any;
  /** Replaces the exec: neither `before` nor `run` is consulted. */
  exec?: (file: string, args: string[], opts: any) => Promise<any>;
}

/**
 * What the fake omp and pi hosts share. `api` is the part of the extension API both adapters use (tool, session entries,
 * event handlers, a recording exec) and `ctx` the part of the context (session manager, UI); each host adds its own
 * members to both before it loads its adapter. `answered(verb)` settles once Kata answered an exec of that verb.
 */
export function fakeHost(options: FakeHostOptions) {
  let tool: any, todoBackend: any;
  const handlers = registry();
  const entries: any[] = options.entries || [], calls: string[][] = [], notices: any[] = [], widgets: any[] = [];
  const answers = new Map<string, PromiseWithResolvers<void>>();
  const answer = (verb: string) => answers.get(verb) ?? answers.set(verb, Promise.withResolvers<void>()).get(verb)!;
  const ctx: any = {
    cwd: options.cwd,
    sessionManager: { getSessionId: () => options.sid, getBranch: () => entries, getEntries: () => entries, getHeader: () => options.header },
    ui: { notify: (...args: any[]) => notices.push(args), setWidget: (...args: any[]) => widgets.push(args) },
  };
  const api: any = {
    registerTool: (value: any) => tool = value,
    registerTodoBackend: (value: any) => { todoBackend = value; },
    appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
    on: handlers.on,
    async exec(file: string, args: string[], opts: any) {
      calls.push(args);
      if (options.exec) return options.exec(file, args, opts);
      const result = await options.before?.(args, opts) ?? await options.run(args, opts);
      answer(args[0]).resolve();
      return result;
    },
  };
  const call = (params: any, context: any = ctx, callId = "fixture") => tool.execute(callId, params, undefined, undefined, context);
  return { api, ctx, sid: options.sid, entries, calls, notices, widgets, handlers: handlers.callbacks,
    get tool() { return tool; },
    /** The todo backend the adapter registered, if any. */
    get todoBackend() { return todoBackend; },
    answered: (verb: string) => answer(verb).promise,
    event: (name: string, data: any = {}, context: any = ctx) => handlers.fire(name, data, context),
    call,
    /** Plans `items`; returns the plan parent. */
    async init(items: string[]) { const result = await call({ op: "init", items }); expect(result.isError).toBeUndefined(); return result.details.kata.parent; },
  };
}

/**
 * Points this process at one fixture's throwaway store and puts its Kata binary first on PATH as `kata`.
 * The omp adapter spawns its own transcript closes itself, outside the fake host's exec, using the
 * process environment and the default executable name. Returns the restore function.
 */
export function adoptIsolatedKata(binary: string, home: string): () => void {
  assertIsolated({ ...process.env, KATA_HOME: home });
  const bin = path.join(path.dirname(home), "bin");
  mkdirSync(bin, { recursive: true });
  if (!existsSync(path.join(bin, "kata"))) symlinkSync(binary, path.join(bin, "kata"));
  const saved = { PATH: process.env.PATH, KATA_HOME: process.env.KATA_HOME };
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ""}`;
  process.env.KATA_HOME = home;
  return () => {
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
  };
}

/** What a deferred close tells the model about its retry, as the core words it. */
export const retryNote = `retry after ${RETRY_MS / 1000} seconds`;

/** A retry deadline passes while `fn` runs, without sleeping: a throttled close is due again. */
export async function later<T>(fn: () => Promise<T>): Promise<T> {
	setSystemTime(new Date(Date.now() + 2 * RETRY_MS));
	try { return await fn(); } finally { setSystemTime(); }
}

// Reads until `done` accepts the value or `ms` pass; returns the last value read. The deadline uses `performance.now()`
// because tests that pin the clock with `setSystemTime` freeze `Date.now()`.
async function poll<T>(read: () => T | Promise<T>, done: (value: T) => boolean, ms: number): Promise<T> {
  const end = performance.now() + ms;
  let value = await read();
  while (!done(value) && performance.now() < end) {
    await new Promise(resolve => setTimeout(resolve, 25));
    value = await read();
  }
  return value;
}
/** Polls `condition` until it holds or `ms` pass; returns its final value. */
export const until = (condition: () => boolean, ms = 8000): Promise<boolean> => poll(condition, Boolean, ms);
/** Stream followers for this fixture workspace. */
export const inboxChildren = (cwd: string): string[] => Bun.spawnSync(["pgrep", "-f", `events --tail --json --workspace ${cwd}`]).stdout.toString().split("\n").filter(Boolean);
/**
 * Reads `read()` until it equals `expected` or `ms` pass, then asserts on the last value, so a wrong
 * value still fails and shows what was seen. For state a plugin settles in the background after the
 * event handler returned (the core bounds how long a handler waits for it).
 */
export async function eventually<T>(read: () => Promise<T>, expected: Awaited<T>, ms = 8000): Promise<void> {
  expect(await poll(read, value => Bun.deepEquals(value, expected), ms)).toEqual(expected);
}
/** The plan a todo result reports. A call from another identity reports a notice and no plan. */
export function planOf(result: { details: { kata: PlanView | { notice?: string } } }): PlanView {
  const kata = result.details.kata;
  if (!("phases" in kata)) throw new Error(`The todo result holds no plan: ${kata.notice}`);
  return kata;
}
/** The Kata parent a todo result names. A local plan, an empty one or one whose items all name tickets has none. */
export function planParent(result: Parameters<typeof planOf>[0]): string {
  const parent = planOf(result).parent;
  if (!parent) throw new Error(`The todo result names no Kata parent: ${JSON.stringify(result.details.kata)}`);
  return parent;
}
/**
 * Whether `work` finishes within `ms`, for a test that holds what `work` may or may not wait for (Kata's answer, say).
 * Expecting true shows `work` does not wait for it: the default `ms` only turns a hang into a failure and is far longer
 * than a pass takes, so a loaded machine never fails on it. Expecting false, with a short `ms`, shows `work` does
 * wait: a correct `work` cannot finish while the thing is held, so load never fails that either.
 */
export async function finishes(work: Promise<unknown>, ms = 5000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
  finally { clearTimeout(timer); }
}
// For the one thing a real event stream cannot show structurally: that nothing arrives after a wait. Where an ordering
// (a later event arrives after an earlier one) or a structural fact (no stream child started) exists, use it instead.
export const settle = (ms = 700) => new Promise(resolve => setTimeout(resolve, ms));

/** A close message and evidence that Kata accepts, for the tests whose subject is not the proof itself. */
export const MESSAGE = "Implemented this isolated fixture and verified its behavior with the regression suite.";
export const EVIDENCE = ["test:bun test fixture"];

/**
 * Holds the Kata calls `applies` accepts until `release()`: `before` goes in a host's `before` option or an exec wrapper.
 * `entered` settles when the first held call arrives, `held` counts them. A released call goes to Kata, or to `then`
 * when given, which answers in Kata's place so a test can fail the call after the wait.
 */
export function holdKata(applies: (args: string[], opts: any) => boolean = () => true, then?: (args: string[], opts: any) => Promise<any> | any) {
  const gate = Promise.withResolvers<void>(), reached = Promise.withResolvers<void>();
  let held = 0;
  return {
    before: async (args: string[], opts: any) => {
      if (!applies(args, opts)) return undefined;
      held++; reached.resolve();
      await gate.promise;
      return then?.(args, opts);
    },
    entered: reached.promise,
    release: () => gate.resolve(),
    get held() { return held; },
  };
}

/** `holdKata` for the one call `applies` accepts after `arm()`: calls before the arming and after that call pass at once. */
export function holdNext(applies: (args: string[], opts: any) => boolean = () => true) {
  let armed = false;
  const hold = holdKata((args, opts) => {
    if (!armed || !applies(args, opts)) return false;
    armed = false;
    return true;
  });
  return {
    before: hold.before,
    entered: hold.entered,
    release: hold.release,
    arm: () => { armed = true; },
  };
}

/** A value as one word of a POSIX shell command. */
export const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

/**
 * What the delegate's prompt holds for it: its issue, its teammate and the close command it is told to run, with the two
 * placeholders (the message and the evidence) still to fill. `close` is undefined when the prompt has no such command.
 */
export function assignmentOf(system: string) {
	const ref = /Your Kata issue is (\S+?);/.exec(system)?.[1] ?? "";
	const teammate = /your teammate is ([a-z0-9._-]+?)\. Keep/.exec(system)?.[1] ?? "";
	const close = /YOU must then run: (.+?) --message '<[^']*>' --evidence '<[^']*>'/.exec(system)?.[1];
	return { ref, teammate, close };
}
