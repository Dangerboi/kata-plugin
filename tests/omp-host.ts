import ompKata from "../plugins/oh-my-pi/kata";

type Exec = (args: string[], opts: any) => Promise<any>;
export interface OmpHostOptions {
  /** Runs Kata for every exec the adapter issues and `before` does not answer. */
  run: Exec;
  cwd: string;
  sid?: string;
  agent?: any;
  /** Omitted: the session manager has no session file. */
  sessionFile?: string;
  header?: any;
  /** The session branch; `appendEntry` adds to it. */
  entries?: any[];
  /** Async-job snapshot; omitted: nothing is running. */
  snapshot?: () => any;
  /** Answers an exec instead of Kata; undefined falls through to `run`. */
  before?: (args: string[], opts: any) => Promise<any> | any;
  /** Sees every exec result, whoever produced it. */
  after?: (args: string[], result: any) => void;
  /** Tool call id passed to `execute`. */
  callId?: string;
  /** Receives the adapter's `sendUserMessage` calls; omitted: the host offers none. */
  sendUserMessage?: (...args: any[]) => void;
  /** Runs after each `event`, e.g. to undo process-level side effects of the handler. */
  afterEvent?: () => void;
}

/** The fake omp host: loads the adapter against a recording exec, a session manager, the event bus and the tool call. */
export function ompHost(options: OmpHostOptions) {
  let tool: any;
  const handlers = new Map<string, any>(), bus = new Map<string, any>();
  const entries: any[] = options.entries || [], calls: string[][] = [], notices: any[] = [], widgets: any[] = [];
  const schema: any = new Proxy(() => schema, { get: () => schema });
  const sessionManager: any = { getSessionId: () => options.sid, getBranch: () => entries, getHeader: () => options.header };
  if (options.sessionFile !== undefined) sessionManager.getSessionFile = () => options.sessionFile;
  const ctx: any = {
    cwd: options.cwd,
    agent: options.agent || { kind: "main", id: `main-${options.sid}` },
    sessionManager,
    getAsyncJobSnapshot: () => options.snapshot?.() || { running: [], recent: [] },
    ui: { notify: (...args: any[]) => notices.push(args), setWidget: (...args: any[]) => widgets.push(args) },
  };
  ompKata({ zod: schema, registerTool: (value: any) => tool = value, appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
    ...options.sendUserMessage && { sendUserMessage: options.sendUserMessage },
    on: (name: string, callback: any) => handlers.set(name, callback), events: { on: (name: string, callback: any) => bus.set(name, callback) },
    async exec(_file: string, args: string[], opts: any) {
      calls.push(args);
      const result = await options.before?.(args, opts) ?? await options.run(args, opts);
      options.after?.(args, result);
      return result;
    },
  });
  const callId = options.callId ?? "fixture";
  return { ctx, sid: options.sid, entries, calls, notices, widgets,
    event: async (name: string, data: any = {}, context: any = ctx) => {
      try { return await handlers.get(name)?.(data, context); }
      finally { options.afterEvent?.(); }
    },
    emit: (name: string, data: any) => bus.get(name)?.(data),
    call: (params: any, context: any = ctx) => tool.execute(callId, params, undefined, undefined, context),
  };
}
