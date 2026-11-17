import { createKataCore, type KataCore } from '../core/kata-core'
import { NO_JOB, waitAtMost } from '../core/kata-cli'
import type { DelegateRecord, DelegateStore } from '../core/delegates'
import type { Engine } from './engine'
import { canonicalPath, execOf, platformOf, type RunContext } from './host'
import { planUi } from './plan'
import { liveInboxOf, resetInbox } from './inbox'
import { loadSession, NAMESPACE, pruneSessions, sessionWriter } from './saved'
import { EXECUTABLE_VARS, readEnv, resolveSettings, type Settings } from './settings'

// One core serves the process's one lead session. A hot reload starts a fresh module (and a fresh `session.start`), so
// nothing here has to survive one; what must survive a restart is saved per session id (saved.ts).

// How long `session.start` waits for the session's first binding to its plan before it carries on without it.
const READY_MS = 5000

export interface Runtime {
  core: KataCore
  settings: Settings
  env: Map<string, string>
  state: { cwd: string; debugFile?: string }
  // The session the core is bound to; changes at /clear, /resume and /branch, which fire no `session.start`.
  id?: string
  cwd: string
  header?: { parentSession: string }
  writer?: ReturnType<typeof sessionWriter>
  latest?: RunContext
  // What earlier prompts of this session carried, by section: a section is sent again only when it changed.
  sent: Record<string, string>
  ready: Promise<unknown>
  // Whether an earlier session of this process was left behind (a fork's source, or what a switch ends).
  previous?: string
  // The lead's delegates by record id (delegates.ts), and a core for each: the core holds one session's plan, so a delegate
  // reaches its issue through a core of its own that shares these records and never settles or saves.
  records: Map<string, DelegateRecord>
  coreFor(store: DelegateStore): KataCore
  callers: Map<string, KataCore>
  // Spawn hooks still running: a subagent's first call can arrive before its spawn hook has recorded its agent id.
  spawning: Set<Promise<unknown>>
}

let options: Record<string, unknown> | undefined
let current: Runtime | undefined
let chain: Promise<unknown> = Promise.resolve()

export const configure = (given: Record<string, unknown> | undefined) => { options = given }
export const runtime = () => current

export function contextOf($: Engine, rt: Runtime, delegate?: string): RunContext {
  return {
    cwd: rt.cwd,
    ...(delegate ? { agent: { kind: 'sub', id: delegate } } : {}),
    sessionManager: { getSessionId: () => rt.id, getBranch: () => rt.writer?.entries ?? [], getHeader: () => rt.header },
    run: (argv, init) => $.process.run(argv, init),
    ui: planUi($),
    timers: { setTimer: (fire, ms) => $.clock.after(ms, fire), clearTimer: handle => (handle as { cancel(): void }).cancel() },
  }
}

// Delegates are recorded in memory by record id (the delegate module names it); binding them to plan items is its job too.
function delegateStore(records: Map<string, DelegateRecord>): DelegateStore {
  return {
    records: () => [...records.values()],
    get: key => records.get(key),
    put: record => { records.set(record.id, record) },
    of: ctx => (ctx?.agent?.id ? records.get(ctx.agent.id) : undefined),
  }
}

async function create($: Engine): Promise<Runtime> {
  const env = await readEnv($)
  const settings = resolveSettings(options, env)
  const state = { cwd: '', debugFile: settings.debugFile }
  const records = new Map<string, DelegateRecord>()
  const rt = { settings, env, state, cwd: '', sent: {}, ready: Promise.resolve(), records, callers: new Map(), spawning: new Set() } as Runtime
  const platform = platformOf($, env, state)
  const exec = execOf($, env, () => rt.latest)
  const build = (store: DelegateStore, main: boolean) => createKataCore({
    platform,
    contextTimers: ctx => ctx?.timers,
    exec,
    appendEntry: (type, data) => { if (main) rt.writer?.append(type, data) },
    isMain: ctx => ctx?.agent === undefined,
    delegateStore: store,
    liveInbox: main && settings.liveInbox ? liveInboxOf($, settings.executable) : undefined,
  }, { namespace: NAMESPACE, executable: settings.executable, executableVars: EXECUTABLE_VARS, debugFile: settings.debugFile, widget: (_line, view) => view })
  rt.core = build(delegateStore(records), true)
  rt.coreFor = store => build(store, false)
  return rt
}

export type Entered = { rt: Runtime; ctx: RunContext }

// The runtime for the session `$` belongs to, bound to its plan. The first call creates it; a call that finds another
// session id (/clear, /resume, /branch) switches the core to it, as omp's session switch does. `fork`: the new session
// shares the plan of the one it replaces. Calls queue, so parallel hooks bind once.
export function enter($: Engine, hint: { fork?: boolean } = {}): Promise<Entered> {
  const run = chain.then(() => attach($, hint))
  chain = run.catch(() => undefined)
  return run
}

async function attach($: Engine, hint: { fork?: boolean }): Promise<Entered> {
  const id = await $.session.id()
  const cwd = await canonicalPath($, await $.session.cwd())
  const rt = (current ??= await create($))
  rt.cwd = cwd
  rt.state.cwd = cwd
  if (rt.id === id && rt.writer) {
    const ctx = (rt.latest = contextOf($, rt))
    return { rt, ctx }
  }
  const previous = rt.id
  if (rt.writer) await rt.writer.end(rt.core.session.owes(), await $.clock.now())
  rt.id = id
  rt.previous = previous
  rt.header = hint.fork && previous ? { parentSession: previous } : undefined
  rt.sent = {}
  // The previous session's delegates and cores stay with it (saved above, picked up when it resumes).
  rt.records.clear()
  rt.callers.clear()
  rt.writer = sessionWriter($, id, () => $.clock.now())
  rt.writer.start(await loadSession($, id), cwd)
  const ctx = (rt.latest = contextOf($, rt))
  // The saved plan, pending closes and unfinished delegates of a resumed session are picked up by the core's bind.
  await rt.core.session.start(ctx)
  rt.ready = rt.core.todo.apply(ctx, 'view', {}, NO_JOB).catch(() => undefined)
  await waitAtMost(rt.ready, READY_MS, () => undefined, ctx.timers!)
  void pruneSessions($, await $.clock.now(), id).catch(() => undefined)
  return { rt, ctx }
}

// For tests: forget the module's runtime, as a reload does.
export function reset() { current = undefined; chain = Promise.resolve(); resetInbox() }
