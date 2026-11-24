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
  /** omp's queue never makes a tool result wait for `replace`; lists collapse newest-wins while one runs. By default the harness's `call`, `batch`, `edit` and `backend` return once the queue is drained, so a test reads Kata right after; with `queuedReplace` they return at once and `settled()` awaits the queue. `holdReplace()` pauses the queue either way. */
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
  ompKata({ ...host.api, ...extra, pi: { settings }, events: { on: bus.on }, ...options.sendUserMessage && { sendUserMessage: options.sendUserMessage } });
  return { host, bus };
}

/**
 * A host that hands the adapter's todo backend to the test, so two `replace` calls of one session can overlap as the core's queue
 * allows; `ompHost` runs one `replace` at a time. It keeps no list and does no backend selection. Its session manager is omp's:
 * every appended entry gets a new id on the current branch and moves the leaf to it.
 */
export function rawOmpHost(sid: string, options: Omit<OmpHostOptions, "sid">) {
  let entries!: any[], current = sid, branch!: any[], leaf: string | null = null, appended = 0, afterAppend: (() => void) | undefined, header: { parentSession?: string } = {};
  const appendEntry = (customType: string, data: any) => {
    const entry = { id: `entry-${sid}-${++appended}`, parentId: leaf, type: "custom", customType, data };
    if (branch !== entries) entries.push(entry);
    branch.push(entry);
    leaf = entry.id;
    const hook = afterAppend; afterAppend = undefined; hook?.();
  };
  const { host: app } = loadAdapter({ ...options, sid }, list => {
    entries = branch = list;
    return { getSessionId: () => current, getLeafId: () => leaf, getBranch: () => branch, getEntries: () => entries, getHeader: () => header, getSessionFile: () => undefined };
  }, { appendEntry });
  const event = async (name: string) => { try { await app.event(name); } finally { clearTranscriptEnv(); } };
  return { app, event, replace: (phases: any[]) => app.todoBackend.replace(phases, app.ctx), switchTo: (next: string, forkOf?: string) => { current = next; header = forkOf ? { parentSession: forkOf } : {}; },
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
  /** While set, the queue waits on it before each `replace` (`holdReplace`). */
  let gate: Promise<void> | undefined;
  function drain(): Promise<void> {
    if (draining) return draining;
    const run = (async () => {
      await null;
      try {
        while (waiting) {
          while (gate) await gate;
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
  function sync(context: any): Promise<void> | undefined {
    if ((context.agent?.kind ?? "main") !== "main") return;
    if (!started) { unsent = context; return; }
    const backend = host.todoBackend;
    if (settings.backend === "native" || !backend || backend.id !== settings.backend) return;
    const phases = clonePhases(listOf(context)), key = JSON.stringify(phases), sid = manager.getSessionId();
    const last = waiting ? { sid: waiting.sid, id: backend.id, phases: waiting.key } : sent;
    if (last ? last.sid === sid && last.id === backend.id && last.phases === key : phases.length === 0) return;
    waiting = { phases, key, sid, context };
    return drain();
  }
  /** What the harness does with the queue after a step: wait for it to drain, unless the test runs omp's queue as it is or holds it. */
  const flush = async (running: Promise<void> | undefined) => { if (!options.queuedReplace && !gate) await running; };

  const lineOf = (text: string) => text.replace(/\s+/g, " ").trim() || "no reason given";
  /**
   * Fakes omp's `ExtensionRunner.applyTodoBackend` / `#askTodoBackend` (packages/coding-agent/src/extensibility/extensions/runner.ts);
   * its texts and commit rule copy omp's and must follow it. Only the model's call in the main session is asked, after `session_start`, when the
   * selected backend has `apply`. `{ block: true, reason }` refuses the call, a throw fails it as stale, and an accepted call that commits is sent
   * through `replace` like any other commit.
   */
  async function askBackend(context: any, op: string | undefined, previous: TodoPhase[], next: TodoPhase[]): Promise<{ asked: boolean; refusal?: string; failure?: string }> {
    const backend = host.todoBackend;
    if ((context.agent?.kind ?? "main") !== "main" || !started || settings.backend !== backend?.id || typeof backend.apply !== "function" || !op || op === "view") return { asked: false };
    try {
      const answer = await backend.apply({ op, previous: clonePhases(previous), next: clonePhases(next) }, context);
      return answer?.block === true ? { asked: true, refusal: lineOf(answer.reason ?? "") } : { asked: true };
    } catch (error) { return { asked: true, failure: lineOf(String((error as Error)?.message ?? error)) }; }
  }
  // The tool's execution and what follows it: the backend's ask, the commit, then `replace` after the list is saved and `tool_result`. A refused or uncommitted call fails with the list unchanged, then omp resends its current list.
  async function execute(params: any, context: any, callId: string): Promise<TodoResult> {
    // A `tool_call` handler that returns `{ block, reason }` refuses the call: it never runs and omp reports no result for it.
    const blocked = await fire("tool_call", { type: "tool_call", toolName: "todo", toolCallId: callId, input: params }, context);
    if (blocked?.block) return { content: [{ type: "text", text: blocked.reason ?? "Blocked" }], isError: true, details: {} };
    const previous = listOf(context);
    const outcome = executeTodo(previous, params, context.sessionManager.getSessionFile?.() ? "session" : "memory");
    let result = outcome.result;
    if (outcome.committed) {
      const at = manager.getSessionId();
      const { asked, refusal, failure } = await askBackend(context, result.details.op, previous, outcome.committed);
      // The call can be aborted while `apply` still runs: the test's hook says so by returning true.
      const aborted = (await app.beforeCommit?.()) === true;
      // A failed call shows the session's list as it stands: `previous`, unless the list changed while the backend decided (omp's todo.ts returns the current list).
      const fail = (text: string, uncommitted: "refused" | "stale" = "stale"): TodoResult => {
        const now = listOf(context);
        return { content: [{ type: "text", text: `${text}\n${executeTodo(now, { op: "view" }, "memory").result.content[0].text}` }], details: { ...result.details, phases: clonePhases(now), uncommitted }, isError: true };
      };
      const id = host.todoBackend.id;
      // omp's commit rule: the list and the session are as they were when the backend was asked. Otherwise the backend is stale and gets the current list again.
      // The resend and the commit's `replace` are queued: the tool result does not wait for them.
      if (refusal !== undefined) {
        result = fail(`Todo backend "${id}" did not accept this change: ${refusal}`, "refused");
        sent = undefined; void sync(context);
      } else if (failure !== undefined) {
        result = fail(`Todo backend "${id}" failed: ${failure}; nothing was saved.`);
        sent = undefined; void sync(context);
      } else if (asked && aborted) {
        result = fail(`The call was aborted while todo backend "${id}" decided; nothing was saved.`);
        sent = undefined; void sync(context);
      } else if (asked && manager.getSessionId() !== at) {
        result = fail(`The session changed while todo backend "${id}" decided; nothing was saved.`);
        sent = undefined; void sync(context);
      } else if (asked && JSON.stringify(listOf(context)) !== JSON.stringify(previous)) {
        result = fail(`The todo list changed while todo backend "${id}" decided; nothing was saved.`);
        sent = undefined; void sync(context);
      } else { lists.set(listKey(context), outcome.committed); void sync(context); }
    }
    await fire("tool_result", { type: "tool_result", toolName: "todo", toolCallId: callId, input: params, content: result.content, details: result.details, isError: !!result.isError }, context);
    return result;
  }
  const call = async (params: any, context: any = ctx, callId = options.callId ?? "fixture"): Promise<TodoResult> => { const result = await execute(params, context, callId); await flush(draining); return result; };

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

  const app = { beforeCommit: undefined as (() => unknown) | undefined, ctx, get sid() { return manager.getSessionId(); }, entries: host.entries, calls: host.calls, notices: host.notices, widgets: host.widgets,
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
          if (waitingContext) await flush(sync(waitingContext));
        }
        options.afterEvent?.();
      }
    },
    emit: (name: string, data: any) => bus.fire(name, data),
    /**
     * One native `todo` call as omp runs it: the `tool_call` handlers (one that returns `{ block, reason }` refuses the call with `{ isError: true, content: [reason], details: {} }` and no `tool_result`), the op on the calling agent's own list; then, for the model's call in the main session, the
     * backend's `apply` when `todo.backend` selects a backend that has one (a throw fails the call with the list unchanged); then, for a
     * successful non-view op in the main session whose list differs from the last one sent, `replace(phases, ctx)` if `todo.backend`
     * selects the registered backend (awaited, unless `queuedReplace`), then `tool_result`. Returns the native result
     * (`details: { op, phases, storage, completedTasks? }`).
     */
    call,
    /** With `queuedReplace`: resolves once every queued `replace` has run. */
    async settled() { while (draining) await draining; },
    /** Pauses omp's replace queue: calls return without it draining. Returns the release. */
    holdReplace(): () => void {
      let release!: () => void;
      gate = new Promise<void>(resolve => { release = () => { gate = undefined; resolve(); }; });
      return release;
    },
    /**
     * The main session changes to another one (omp `/new`, or a fork with `fork`): a new id, and for a fork a header naming the
     * source and the list carried over. With `listFirst` omp sends the new session's list to the backend before `session_switch`.
     */
    async switchSession(next: string, { listFirst = false, fork = false }: { listFirst?: boolean; fork?: boolean } = {}) {
      const previous = manager.getSessionId();
      manager.switchTo(next, fork ? { parentSession: previous } : {});
      if (!fork) lists.delete(mainId);
      if (listFirst) await flush(sync(ctx));
      return app.event("session_switch", { type: "session_switch", reason: fork ? "fork" : "new" });
    },
    /** A list edit from outside the tool (`/todo` editor, `set_todos`): no `apply`; the list is committed as given and goes to the backend. */
    async edit(phases: TodoPhase[], context: any = ctx) { lists.set(listKey(context), clonePhases(phases)); await flush(sync(context)); },
    /** One assistant message with several calls, run in order: a todo call (asked when it commits) gives a result; a function stands for another tool's call (a `kata close` in bash) and gives none. */
    async batch(calls: (any | (() => Promise<unknown>))[], context: any = ctx): Promise<TodoResult[]> {
      const results: TodoResult[] = [];
      for (const [i, step] of calls.entries()) {
        if (typeof step === "function") await step();
        else results.push(await execute(step, context, `${options.callId ?? "fixture"}-${i}`));
      }
      await flush(draining);
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
      await flush(sync(ctx));
    },
    /** The native list now. */
    list: () => clonePhases(lists.get(mainId) ?? []),
  };
  return app;
}
