import ompKata from "../plugins/oh-my-pi/kata";
import { fakeHost, registry, type FakeHostOptions } from "./kata-fixture";

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

/** The fake omp host: the shared fake host plus omp's agent, session file, async jobs and event bus, with the omp adapter loaded.
 * `contractReady` settles once the adapter's contract read has answered. */
export function ompHost(options: OmpHostOptions) {
  const host = fakeHost(options), bus = registry();
  const schema: any = new Proxy(() => schema, { get: () => schema });
  const { ctx } = host;
  if (options.sessionFile !== undefined) ctx.sessionManager.getSessionFile = () => options.sessionFile;
  ctx.agent = options.agent || { kind: "main", id: `main-${options.sid}` };
  ctx.getAsyncJobSnapshot = () => options.snapshot?.() || { running: [], recent: [] };
  ompKata({ ...host.api, zod: schema, events: { on: bus.on }, ...options.sendUserMessage && { sendUserMessage: options.sendUserMessage } });
  return { ctx, sid: options.sid, entries: host.entries, calls: host.calls, notices: host.notices, widgets: host.widgets, init: host.init,
    contractReady: host.answered("agent-contract-hook"),
    event: async (name: string, data: any = {}, context: any = ctx) => {
      try { return await host.event(name, data, context); }
      finally { options.afterEvent?.(); }
    },
    emit: (name: string, data: any) => bus.fire(name, data),
    call: (params: any, context: any = ctx) => host.call(params, context, options.callId),
  };
}
