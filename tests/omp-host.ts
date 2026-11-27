import { TRANSCRIPT_ENV } from "../core/kata-cli";
import { mock } from "bun:test";
import ompKata from "../plugins/oh-my-pi/kata";
import { EVIDENCE, fakeHost, MESSAGE, registry, type FakeHostOptions } from "./kata-fixture";
import { clonePhases, executeTodo, type TodoPhase, type TodoResult } from "./omp-native-todo";

/** omp's `todo.backend` setting. One settings object serves the whole process, so every host shares it and its listeners. */
type SettingsListener = (next: string, prev: string) => unknown;
const settings = { backend: "kata", listeners: new Set<SettingsListener>() };

/** Sets the backend; the listeners fire only when the value changes. */
async function setBackend(value: string): Promise<void> {
  const previous = settings.backend;
  if (previous === value) return;
  settings.backend = value;
  for (const listener of [...settings.listeners]) await listener(value, previous);
}

// The adapter reads the setting through a lazy `import()` of omp's config registry, a module that exists only inside omp. This
// mock answers `lookup("todo.backend")` against the shared settings object.
mock.module("@oh-my-pi/pi-coding-agent/config/registry", () => ({
  lookup: (id: string) => id !== "todo.backend" ? undefined : {
    get: () => settings.backend,
    listen: (_settings: unknown, listener: SettingsListener) => {
      settings.listeners.add(listener);
      return () => { settings.listeners.delete(listener); };
    },
  },
}));

export interface OmpHostOptions extends Omit<FakeHostOptions, "exec"> {
  agent?: any;
  /** Omitted: the session manager has no session file. */
  sessionFile?: string;
  /** Async-job snapshot; omitted: nothing is running. */
  snapshot?: () => any;
  /** Tool call id passed to `execute`. */
  callId?: string;
  /** Receives the adapter's `sendUserMessage` calls; omitted: the host offers none. */
  sendUserMessage?: (...args: any[]) => void;
  /** Runs after each `event`, e.g. to undo process-level side effects of the handler. */
  afterEvent?: () => void;
  /** omp's queue: a call does not wait for `replace`, lists collapse newest-wins while one runs, and `settled()` awaits the queue. Default: each call awaits its `replace`. */
  queuedReplace?: boolean;
}

/**
 * omp's session manager is a class whose state lives in private fields, so a method called on anything but the instance
 * (an `Object.create` wrapper, a spread copy) throws as it does in real omp. Methods are on the prototype for the same reason.
 */
class FakeSessionManager {
  #id: string | undefined;
  #branch: any[];
  #header: any;
  #file: string | undefined;
  constructor(id: string | undefined, branch: any[], header: any, file: string | undefined) { this.#id = id; this.#branch = branch; this.#header = header; this.#file = file; }
  getSessionId() { return this.#id; }
  getBranch() { return this.#branch; }
  getEntries() { return this.#branch; }
  getHeader() { return this.#header; }
  getSessionFile() { return this.#file; }
  switchTo(id: string, header: any) { this.#id = id; this.#header = header; }
}

/** The notice that says todo.backend is not Kata: a warning, but not a failed mirror. */
const BACKEND_OFF = /Kata is not tracking your todo list/;

/** The warnings among `notices` (`notify` argument lists) that are not the backend-off notice: every mirror failure or refusal, whatever its wording. */
export const mirrorFailures = (notices: any[][]): any[][] => notices.filter(args => args[1] === "warning" && !BACKEND_OFF.test(String(args[0])));

/** Removes the process-level variables the adapter sets while a transcript session is exported, because it spawns Kata outside the fake exec. */
export const clearTranscriptEnv = () => { for (const key of TRANSCRIPT_ENV) delete process.env[key]; };

/**
 * The fake host with the omp adapter loaded: omp's agent, async jobs and event bus on the shared fake host. `makeManager` builds the
 * session manager over the host's entries (default: `FakeSessionManager`); `extra` is merged into the adapter's api.
 */
function loadAdapter(options: OmpHostOptions, makeManager?: (entries: any[]) => any, extra: Record<string, unknown> = {}) {
  const host = fakeHost(options), bus = registry();
  const { ctx } = host;
  ctx.sessionManager = makeManager ? makeManager(host.entries) : new FakeSessionManager(options.sid, host.entries, options.header, options.sessionFile);
  ctx.agent = options.agent || { kind: "main", id: `main-${options.sid}` };
  ctx.getAsyncJobSnapshot = () => options.snapshot?.() || { running: [], recent: [] };
  void setBackend("kata");
  const detached: Promise<any>[] = [];
  const runtime = {
    execKata: (file: string, args: string[], opts: any) => host.api.exec(file, args, opts),
    spawnDetached: (file: string, args: string[], opts: any) => { detached.push(host.api.exec(file, args, opts)); },
  };
  ompKata({ ...host.api, ...extra, pi: { settings }, events: { on: bus.on }, ...options.sendUserMessage && { sendUserMessage: options.sendUserMessage } }, runtime);
  const event = host.event;
  host.event = async (...args: Parameters<typeof event>) => { const result = await event(...args); await Promise.all(detached.splice(0)); return result; };
  return { host, bus };
}

/**
 * A host that hands the adapter's todo backend to the test, so two `replace` calls of one session can overlap as the core's queue
 * allows; `ompHost` runs one `replace` at a time. It keeps no list and does no backend selection. Its session manager is omp's:
 * every appended entry gets a new id on the current branch and moves the leaf to it.
 */
export function rawOmpHost(sid: string, options: Omit<OmpHostOptions, "sid">) {
  let entries!: any[], current = sid, branch!: any[], leaf: string | null = null, appended = 0, afterAppend: (() => void) | undefined;
  const appendEntry = (customType: string, data: any) => {
    const entry = { id: `entry-${sid}-${++appended}`, parentId: leaf, type: "custom", customType, data };
    if (branch !== entries) entries.push(entry);
    branch.push(entry);
    leaf = entry.id;
    const hook = afterAppend; afterAppend = undefined; hook?.();
  };
  const { host: app } = loadAdapter({ ...options, sid }, list => {
    entries = branch = list;
    return { getSessionId: () => current, getLeafId: () => leaf, getBranch: () => branch, getEntries: () => entries, getHeader: () => ({}), getSessionFile: () => undefined };
  }, { appendEntry });
  const event = async (name: string) => { try { await app.event(name); } finally { clearTranscriptEnv(); } };
  return { app, event, replace: (phases: any[]) => app.todoBackend.replace(phases, app.ctx), switchTo: (next: string) => { current = next; },
    /** /tree: the same session now answers for another branch and leaf. */
    moveTo: (next: any[], nextLeaf: string | null) => { branch = next; leaf = nextLeaf; },
    /** /tree right after the next saved entry: the move lands between one mirror's save and the next mirror's bind. */
    moveAfterNextAppend: (next: any[], nextLeaf: string | null) => { afterAppend = () => { branch = next; leaf = nextLeaf; }; },
    /** Runs `then` right after the next saved entry, as another caller appending to the session would. */
    afterNextAppend: (then: () => void) => { afterAppend = then; },
    /** /tree to an earlier entry: the branch is the entries up to it; the entries after it stay in `app.entries`. */
    moveToEntry: (id: string) => { branch = entries.slice(0, entries.findIndex((e: any) => e.id === id) + 1); leaf = id; } };
}

/** The Kata views the omp tests share, over the fixture's `show`. */
export function kataViews(show: (ref: string) => Promise<any>) {
  const refOf = (short: string) => `v2test#${short}`;
  const children = async (parent: string): Promise<any[]> => (await show(parent)).children ?? [];
  const childRef = async (parent: string, title: string): Promise<string> => {
    const child = (await children(parent)).find((c: any) => c.title === title);
    if (!child) throw new Error(`${parent} has no child "${title}"`);
    return refOf(child.short_id);
  };
  return {
    refOf, children, childRef,
    issueOf: async (ref: string) => (await show(ref)).issue,
    labelsOf: async (ref: string): Promise<string[]> => ((await show(ref)).labels ?? []).map((l: any) => l.label),
    titles: async (parent: string) => (await children(parent)).map((c: any) => c.title).sort(),
  };
}

/**
 * The fake omp host: the shared fake host plus omp's agent, session file, async jobs and event bus, with the omp adapter loaded,
 * and omp 19.1.1's native todo (`omp-native-todo.ts`) with the todo-backend plumbing around it.
 * `contractReady` settles once the adapter's contract read has answered.
 */
export function ompHost(options: OmpHostOptions) {
  const { host, bus } = loadAdapter(options);
  const { ctx } = host;
  const manager = ctx.sessionManager as FakeSessionManager;

  // Each agent's todo list, keyed by agent id as omp keeps one per session. The runner's `#todoSent` (runner.ts, `#sendTodoList`)
  // is what the backend last took: `undefined` is omp's "none", which an empty list does not replace, and it holds the session id too.
  const mainId: string = ctx.agent.id;
  const lists = new Map<string, TodoPhase[]>();
  const listKey = (context: any): string => context.agent?.id ?? mainId;
  const listOf = (context: any): TodoPhase[] => lists.get(listKey(context)) ?? [];
  let sent: { sid: string | undefined; id: string; phases: string } | undefined;
  /** omp sends no list before the host's `session_start` has fired. */
  let started = false;
  let unsent: Parameters<typeof sync>[0];

  // The queue behind `queuedReplace`: one list waits while a `replace` runs, and a newer list takes its place.
  let waiting: { phases: TodoPhase[]; key: string; sid: string | undefined; context: any } | undefined;
  let draining: Promise<void> | undefined;
  function drain(): Promise<void> {
    if (draining) return draining;
    const run = (async () => {
      await null;
      try {
        while (waiting) {
          const next = waiting;
          waiting = undefined;
          const backend = host.todoBackend;
          // A list waiting while the session changed belongs to the old session and is dropped.
          if (next.sid !== manager.getSessionId() || !backend || backend.id !== settings.backend) continue;
          sent = { sid: next.sid, id: backend.id, phases: next.key };
          try { await backend.replace(next.phases, next.context); }
          catch { sent = undefined; }
        }
      } finally { draining = undefined; }
    })();
    draining = run;
    return run;
  }

  const fire = (name: string, data: any, context: any) => host.event(name, data, context);

  // omp's `#mirrorTodoPhases` (agent-session.ts) then `syncTodoBackend`/`#sendTodoList` (runner.ts): main session only, after
  // `session_start`, a registered backend that `todo.backend` selects, and a list that differs from the one last taken. A throw
  // leaves nothing recorded, so the next list goes out again.
  async function sync(context: any) {
    if ((context.agent?.kind ?? "main") !== "main") return;
    if (!started) { unsent = context; return; }
    const backend = host.todoBackend;
    if (settings.backend === "native" || !backend || backend.id !== settings.backend) return;
    const phases = clonePhases(listOf(context)), key = JSON.stringify(phases), sid = manager.getSessionId();
    const last = waiting ? { sid: waiting.sid, id: backend.id, phases: waiting.key } : sent;
    if (last ? last.sid === sid && last.id === backend.id && last.phases === key : phases.length === 0) return;
    waiting = { phases, key, sid, context };
    const running = drain();
    if (!options.queuedReplace) await running;
  }

  const blocked = (reason: string): TodoResult => ({ content: [{ type: "text", text: reason }], isError: true, details: {} });
  const guard = async (params: any, context: any, callId: string) => {
    const refusal = await fire("tool_call", { type: "tool_call", toolName: "todo", toolCallId: callId, input: params }, context);
    return refusal?.block ? blocked(refusal.reason ?? "Blocked") : undefined;
  };
  // The tool's execution and what follows it: `replace` after the list is saved, then `tool_result`. A refused call never ran, so omp reports no result for it.
  async function execute(params: any, context: any, callId: string, refused: TodoResult | undefined): Promise<TodoResult> {
    if (refused) return refused;
    const outcome = executeTodo(listOf(context), params, context.sessionManager.getSessionFile?.() ? "session" : "memory");
    const result = outcome.result;
    if (outcome.committed) { lists.set(listKey(context), outcome.committed); await sync(context); }
    await fire("tool_result", { type: "tool_result", toolName: "todo", toolCallId: callId, input: params, content: result.content, details: result.details, isError: !!result.isError }, context);
    return result;
  }
  const call = async (params: any, context: any = ctx, callId = options.callId ?? "fixture"): Promise<TodoResult> => execute(params, context, callId, await guard(params, context, callId));

  // Kata, through the same runner the fixture gives the adapter.
  const kata = async (args: string[]) => {
    const out = await options.run(args, { cwd: options.cwd, timeout: 5000 });
    if (out.code) throw new Error(`kata ${args.join(" ")}: ${out.stderr}`);
    return JSON.parse(out.stdout);
  };
  /** The plan parent however it was bound: the parent of the issue titled `title`, in any project; the session's automatic parent when none is. */
  async function planParent(title?: string): Promise<any> {
    if (title) {
      const found = (await kata(["list", "--all", "--status", "all", "--json"])).issues.filter((i: any) => i.title === title && i.parent);
      const issue = found.find((i: any) => i.metadata?.["todo.session"] === manager.getSessionId()) ?? found[0];
      if (issue) return { qualified_id: issue.parent.qualified_id };
    }
    if (!manager.getSessionId()) throw new Error("This host has no session id.");
    const find = async (label: boolean) => (await kata(["list", "--status", "all", "--meta", `omp.session_id=${manager.getSessionId()}`, ...label ? ["--label", "omp-session"] : [], "--json"])).issues[0];
    const parent = await find(true) ?? await find(false);
    if (!parent) throw new Error(`Kata holds no plan parent for session ${manager.getSessionId()}.`);
    return parent;
  }
  async function close(content: string, close: { message?: string; evidence?: string[] } = {}) {
    const parent = await planParent(content), project = parent.qualified_id.split("#")[0];
    const child = (await kata(["show", parent.qualified_id, "--json"])).children?.find((c: any) => c.title === content);
    if (!child) throw new Error(`The plan of ${parent.qualified_id} has no task "${content}".`);
    const ref = `${project}#${child.short_id}`;
    const out = await options.run(["close", ref, "--done", "--message", close.message ?? MESSAGE, ...(close.evidence ?? EVIDENCE).flatMap(e => ["--evidence", e]), "--json"], { cwd: options.cwd, timeout: 5000 });
    if (out.code) throw new Error(`kata close ${ref}: ${out.stderr}`);
    return ref;
  }

  const app = { ctx, get sid() { return manager.getSessionId(); }, entries: host.entries, calls: host.calls, notices: host.notices, widgets: host.widgets,
    contractReady: host.answered("agent-contract-hook"),
    /** Every warning the adapter showed except the backend-off one: a failing or refused mirror shows only here, because the adapter catches a failing `replace` and tells the user. */
    mirrorFailures: () => mirrorFailures(host.notices),
    event: async (name: string, data: any = {}, context: any = ctx) => {
      try { return await host.event(name, data, context); }
      finally {
        if (name === "session_start") {
          started = true;
          // A list set before `session_start` waited (omp's `syncTodoBackend`) and goes out now.
          const waitingContext = unsent;
          unsent = undefined;
          if (waitingContext) await sync(waitingContext);
        }
        options.afterEvent?.();
      }
    },
    emit: (name: string, data: any) => bus.fire(name, data),
    /**
     * One native `todo` call as omp runs it: the `tool_call` handlers (one that returns `{ block, reason }` refuses the call with
     * `{ isError: true, content: [reason], details: {} }` and no `tool_result`), the op on the calling agent's own list, then, for a
     * successful non-view op in the main session whose list differs from the last one sent, `replace(phases, ctx)` if `todo.backend`
     * selects the registered backend (awaited, unless `queuedReplace`), then `tool_result`. Returns the native result
     * (`details: { op, phases, storage, completedTasks? }`).
     */
    call,
    /** With `queuedReplace`: resolves once every queued `replace` has run. */
    async settled() { while (draining) await draining; },
    /**
     * The main session changes to another one (omp `/new`, or a fork with `fork`): a new id, and for a fork a header naming the
     * source and the list carried over. With `listFirst` omp sends the new session's list to the backend before `session_switch`.
     */
    async switchSession(next: string, { listFirst = false, fork = false }: { listFirst?: boolean; fork?: boolean } = {}) {
      const previous = manager.getSessionId();
      manager.switchTo(next, fork ? { parentSession: previous } : {});
      if (!fork) lists.delete(mainId);
      if (listFirst) await sync(ctx);
      return app.event("session_switch", { type: "session_switch", reason: fork ? "fork" : "new" });
    },
    /** A list edit from outside the tool (`/todo` editor, `set_todos`): no `tool_call`; the list is committed as given and goes to the backend. */
    async edit(phases: TodoPhase[], context: any = ctx) { lists.set(listKey(context), clonePhases(phases)); await sync(context); },
    /** One assistant message with several todo calls: every `tool_call` handler runs first, then the ops run in order, as omp does. */
    async batch(paramsList: any[], context: any = ctx): Promise<TodoResult[]> {
      const ids = paramsList.map((_, i) => `${options.callId ?? "fixture"}-${i}`);
      const refusals: (TodoResult | undefined)[] = [];
      for (const [i, params] of paramsList.entries()) refusals.push(await guard(params, context, ids[i]));
      const results: TodoResult[] = [];
      for (const [i, params] of paramsList.entries()) results.push(await execute(params, context, ids[i], refusals[i]));
      return results;
    },
    /**
     * A native init of `items` (one flat phase); returns the plan parent's qualified ref, as Kata holds it. Throws when Kata holds
     * no parent for it, except when every item is a ticket item (it adopts those tickets, no parent): then it returns `""`.
     */
    async init(items: string[]): Promise<string> {
      const result = await call({ op: "init", items });
      if (result.isError) throw new Error(`The init was refused: ${result.content[0].text}`);
      if (items.every(item => /^[\w.-]+#[a-z0-9]+:/i.test(item))) return "";
      return (await planParent(items[0])).qualified_id as string;
    },
    /** Closes the child Kata holds for task `content`, with a valid message and `test:` evidence unless given; returns the child's qualified ref. The native list is untouched. */
    close,
    /** `close`, then the native `done` of the task. */
    async done(content: string) { await close(content); return call({ op: "done", task: content }); },
    /** Switches `todo.backend` (`"kata"` is this adapter's; `"native"` the default omp has), fires the setting's listeners, and, as omp's settings UI does for a non-native backend, hands it the current list. */
    async backend(value: string) {
      await setBackend(value);
      await sync(ctx);
    },
    /** The native list now. */
    list: () => clonePhases(lists.get(mainId) ?? []),
  };
  return app;
}
