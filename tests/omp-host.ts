import { mock } from "bun:test";
import ompKata from "../plugins/oh-my-pi/kata";
import { EVIDENCE, fakeHost, MESSAGE, registry, type FakeHostOptions } from "./kata-fixture";
import { clonePhases, executeTodo, type TodoPhase, type TodoResult } from "./omp-native-todo";

/** One host's `todo.backend` setting. omp's `pi.pi.settings` is the object the registry reads and watches. */
type SettingsListener = (next: string, prev: string) => unknown;
interface FakeSettings { backend: string; listeners: Set<SettingsListener> }

// The adapter reads the setting through a lazy `import()` of omp's config registry, a module that exists only inside omp. This
// mock answers `lookup("todo.backend")` against the settings object the adapter passes, so each host has its own value.
mock.module("@oh-my-pi/pi-coding-agent/config/registry", () => ({
  lookup: (id: string) => id !== "todo.backend" ? undefined : {
    get: (settings: FakeSettings) => settings.backend,
    listen: (settings: FakeSettings, listener: SettingsListener) => {
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
}

/** What a todo call returns: omp's tool result, which for a refused call is the error result carrying the reason. */
export type OmpTodoResult = TodoResult;

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
  getHeader() { return this.#header; }
  getSessionFile() { return this.#file; }
}

/**
 * The fake omp host: the shared fake host plus omp's agent, session file, async jobs and event bus, with the omp adapter loaded,
 * and omp 19.1.1's native todo (`omp-native-todo.ts`) with the todo-backend plumbing around it.
 * `contractReady` settles once the adapter's contract read has answered.
 */
export function ompHost(options: OmpHostOptions) {
  const host = fakeHost(options), bus = registry();
  const schema: any = new Proxy(() => schema, { get: () => schema });
  const { ctx } = host;
  ctx.sessionManager = new FakeSessionManager(options.sid, host.entries, options.header, options.sessionFile);
  ctx.agent = options.agent || { kind: "main", id: `main-${options.sid}` };
  ctx.getAsyncJobSnapshot = () => options.snapshot?.() || { running: [], recent: [] };
  const settings: FakeSettings = { backend: "kata", listeners: new Set() };
  ompKata({ ...host.api, pi: { settings }, zod: schema, events: { on: bus.on }, ...options.sendUserMessage && { sendUserMessage: options.sendUserMessage } });

  // The session's todo list, as the session holds it, and what the runner last handed the backend (runner.ts #sendTodoList 1792-1834).
  let todos: TodoPhase[] = [];
  let sent: { id: string; phases: string } | undefined;
  /** Errors of backend calls (a throwing `replace` is an extension error in omp; the list stays). */
  const backendErrors: unknown[] = [];

  const fire = (name: string, data: any, context: any) => host.event(name, data, context);

  // omp's `#mirrorTodoPhases` (agent-session.ts 12157) then `syncTodoBackend`/`#sendTodoList`: main session only, a registered
  // backend that `todo.backend` selects, and a list that differs from the one last taken. A throw leaves nothing recorded, so the next list goes out again.
  async function sync(context: any) {
    if ((context.agent?.kind ?? "main") !== "main") return;
    const backend = host.todoBackend;
    if (settings.backend === "native" || !backend || backend.id !== settings.backend) return;
    const phases = clonePhases(todos), key = JSON.stringify(phases);
    if (sent?.id === backend.id && sent?.phases === key) return;
    sent = undefined;
    try { await backend.replace(phases, context); sent = { id: backend.id, phases: key }; }
    catch (error) { backendErrors.push(error); }
  }

  const blocked = (reason: string): OmpTodoResult => ({ content: [{ type: "text", text: reason }], isError: true, details: {} });
  const guard = async (params: any, context: any, callId: string) => {
    const refusal = await fire("tool_call", { type: "tool_call", toolName: "todo", toolCallId: callId, input: params }, context);
    return refusal?.block ? blocked(refusal.reason ?? "Blocked") : undefined;
  };
  // The tool's execution and what follows it: `replace` after the list is saved, then `tool_result`.
  async function execute(params: any, context: any, callId: string, refused: OmpTodoResult | undefined): Promise<OmpTodoResult> {
    let result: OmpTodoResult;
    if (refused) result = refused;
    else {
      const outcome = executeTodo(todos, params, context.sessionManager.getSessionFile?.() ? "session" : "memory");
      result = outcome.result;
      if (outcome.committed) { todos = outcome.committed; await sync(context); }
    }
    await fire("tool_result", { type: "tool_result", toolName: "todo", toolCallId: callId, input: params, content: result.content, details: result.details, isError: !!result.isError }, context);
    return result;
  }
  const call = async (params: any, context: any = ctx, callId = options.callId ?? "fixture"): Promise<OmpTodoResult> => execute(params, context, callId, await guard(params, context, callId));

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
      const issue = found.find((i: any) => i.metadata?.["todo.session"] === options.sid) ?? found[0];
      if (issue) return { qualified_id: issue.parent.qualified_id };
    }
    if (!options.sid) throw new Error("This host has no session id.");
    const find = async (label: boolean) => (await kata(["list", "--status", "all", "--meta", `omp.session_id=${options.sid}`, ...label ? ["--label", "omp-session"] : [], "--json"])).issues[0];
    const parent = await find(true) ?? await find(false);
    if (!parent) throw new Error(`Kata holds no plan parent for session ${options.sid}.`);
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

  return { ctx, sid: options.sid, entries: host.entries, calls: host.calls, notices: host.notices, widgets: host.widgets,
    contractReady: host.answered("agent-contract-hook"),
    /** Errors thrown by the backend's `replace` (omp reports them as extension errors and keeps its list). */
    backendErrors,
    event: async (name: string, data: any = {}, context: any = ctx) => {
      try { return await host.event(name, data, context); }
      finally { options.afterEvent?.(); }
    },
    emit: (name: string, data: any) => bus.fire(name, data),
    /**
     * One native `todo` call as omp runs it: the `tool_call` handlers (one that returns `{ block, reason }` refuses the call with
     * `{ isError: true, content: [reason], details: {} }`), the op on this host's list, then, for a successful non-view op in the
     * main session whose list differs from the last one sent, `await replace(phases, ctx)` if `todo.backend` selects the registered
     * backend, then `tool_result`. Returns the native result (`details: { op, phases, storage, completedTasks? }`).
     */
    call,
    /** A list edit from outside the tool (`/todo` editor, `set_todos`): no `tool_call`; the list is committed as given and goes to the backend. */
    async edit(phases: TodoPhase[], context: any = ctx) { todos = clonePhases(phases); await sync(context); },
    /** One assistant message with several todo calls: every `tool_call` handler runs first, then the ops run in order, as omp does. */
    async batch(paramsList: any[], context: any = ctx): Promise<OmpTodoResult[]> {
      const ids = paramsList.map((_, i) => `${options.callId ?? "fixture"}-${i}`);
      const refusals: (OmpTodoResult | undefined)[] = [];
      for (const [i, params] of paramsList.entries()) refusals.push(await guard(params, context, ids[i]));
      const results: OmpTodoResult[] = [];
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
      const previous = settings.backend;
      settings.backend = value;
      for (const listener of [...settings.listeners]) await listener(value, previous);
      await sync(ctx);
    },
    /** The native list now. */
    list: () => clonePhases(todos),
  };
}
