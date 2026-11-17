import type { AgentSpawnResult, Hook } from 'claude-code'
import { NO_JOB, waitAtMost } from '../core/kata-cli'
import { posixPath } from '../core/posix-path'
import { Refusal, teammateFor, type DelegateOutcome, type DelegateRecord, type DelegateStore } from '../core/delegates'
import type { Binding } from '../core/model'
import { delegateCommand, kataCommands, shellOptions } from '../core/shell'
import type { KataCore } from '../core/kata-core'
import type { Engine } from './engine'
import { contextOf, enter, runtime, type Entered, type Runtime } from './lead'
import { EXECUTABLE_VARS } from './settings'

// Subagents and Workflow agents as the core's delegates: `agent.spawn` binds each one to the plan item or ticket its text
// names (or leaves it untracked, and its run becomes a mission), `turn.complete` hands in its report, and its kata commands
// run under its own teammate.
//
// A record is made before the agent exists, because its binding goes in the prompt: it is keyed by the spawn (its call id,
// which a Workflow's agents share, plus the agent's index and a stamp), and its `sessionId` becomes the engine's agent id
// as soon as the spawn returns it. Everything that arrives with an agent id finds the record by that.

// How long one wait of a spawn may take: the core's decision on what an agent works, before the agent starts without the
// binding (it still gets its issue, and learns of it from its next todo call). The waits of one spawn share the hook's own
// budget (`Spend`), so together they never run past it.
const BIND_MS = 7000
// What a spawn hook keeps back for the engine's own spawn (`next`) and its return, and what a wait after the spawn keeps back.
const ENGINE_MS = 3000
const RETURN_MS = 500
// How long a delegate's own events (report, exit, settle) may hold one hook.
const EVENT_MS = 8000
// How long a call that names an agent the module has no record of yet waits for the spawn hooks still running.
const SPAWN_MS = 3000

type Next<E extends 'agent.spawn' | 'tool.call'> = Parameters<Hook<E>>[2]

// A hook's budget (10 s, from its call to its return; `$.clock` waits count) as one account: `left(keep)` is what remains
// of it less `keep`, never below 0. Made when the hook is called, so every wait draws from the same time.
type Spend = (keep: number) => Promise<number>

async function budgetOf($: Engine, next: Next<'agent.spawn'>): Promise<Spend> {
  const total = next.budget.remainingMs
  const begun = await $.clock.now()
  return async keep => Math.max(0, total - keep - ((await $.clock.now()) - begun))
}

// Delegates whose spawn arrived under auto mode, which refuses a hook's rewrite of a tool call (see `shellRoute` below).
const autoMode = new Set<string>()

function recordOf(rt: Runtime, agentId: string): DelegateRecord | undefined {
  for (const record of rt.records.values()) if (record.sessionId === agentId) return record
}

// A delegate's core: it shares the lead's records, finds its own by its id, and never settles or saves.
function coreOf(rt: Runtime, id: string): KataCore {
  let core = rt.callers.get(id)
  if (!core) {
    const store: DelegateStore = {
      records: () => [],
      get: key => (key === id ? rt.records.get(key) : undefined),
      put: record => { rt.records.set(record.id, record) },
      of: () => rt.records.get(id),
    }
    rt.callers.set(id, core = rt.coreFor(store))
  }
  return core
}

// The record of an agent id, once the spawn hooks that may still be recording it have finished.
interface Found { rt: Runtime; record?: DelegateRecord }

async function find($: Engine, agentId: string): Promise<Found | undefined> {
  const rt = runtime()
  if (!rt?.writer) return undefined
  let record = recordOf(rt, agentId)
  if (!record && rt.spawning.size) {
    await waitAtMost(Promise.allSettled([...rt.spawning]), SPAWN_MS, () => undefined, contextOf($, rt).timers!)
    record = recordOf(rt, agentId)
  }
  return { rt, record }
}

// What the delegate has done with Kata so far, as the core wants it told: its first tool call blocks the rollback at exit,
// and a use after the run ended (or while its assignment failed) goes on with the record.
async function used($: Engine, rt: Runtime, record: DelegateRecord) {
  const delegates = rt.core.delegates
  if (!record.ranTool) void delegates.apply({ type: 'ranTool', id: record.id }, NO_JOB)
  if (record.exited || record.state === 'started' || record.state === 'failed') {
    await waitAtMost(delegates.apply({ type: 'nextUse', id: record.id }, NO_JOB), EVENT_MS, () => undefined, contextOf($, rt).timers!)
  }
}

const textOf = (e: { prompt: string; description: string; name?: string }) => [e.prompt, e.description, e.name].filter(Boolean).join('\n')

// What the agent's prompt gains: the assignment (its issue and commands, or that it has none) and, when the plugin owns the
// contract, the contract.
async function bindingNote($: Engine, rt: Runtime, id: string, ms: number): Promise<string | undefined> {
  const asked = await waitAtMost(coreOf(rt, id).session.beforePrompt(contextOf($, rt, id), { context: rt.settings.contract }), ms, () => undefined, contextOf($, rt).timers!)
  if (!asked) return undefined
  const { sections } = asked
  const tagged = (name: string, text: string | undefined) => (text ? `<kata_${name}>\n${text}\n</kata_${name}>` : undefined)
  return [tagged('contract', sections.contract), tagged('binding', sections.assignment)].filter(Boolean).join('\n\n') || undefined
}

// The record of an agent that never ran, or whose run failed, gives back what its assignment wrote.
async function abandon($: Engine, rt: Runtime, id: string, ms = EVENT_MS) {
  rt.core.delegates.release(id)
  await waitAtMost(rt.core.delegates.apply({ type: 'exited', id, outcome: 'failed' }, NO_JOB), ms, () => undefined, contextOf($, rt).timers!)
}

// `Agent` calls, Workflow agents, teammates and nested spawns bind here. Forks no tool call starts (`/btw`, `/fork`) are no
// delegation of the lead's work and run as they are. An infrastructure failure never stops the spawn.
export const onSpawn: Hook<'agent.spawn'> = async ($, e, next) => {
  if (e.fork && !e.tool_use_id) return next(e)
  const spend = await budgetOf($, next)
  let entered: Entered
  try { entered = await enter($) } catch { return next(e) }
  const run = e.resume ? resumed($, entered, e, next, spend) : spawned($, entered, e, next, spend)
  entered.rt.spawning.add(run)
  try { return await run } finally { entered.rt.spawning.delete(run) }
}

type TurnEnd = Parameters<Hook<'turn.complete'>>[1]
type Spawn = Parameters<Hook<'agent.spawn'>>[1]

// A resumed run (a follow-up message to a finished agent, a woken teammate) goes on with the record it has: its issue while
// that is open, else its mission. The engine accepts no rewrite of it, so nothing is added to its prompt.
async function resumed($: Engine, { rt, ctx }: Entered, e: Spawn, next: Next<'agent.spawn'>, spend: Spend) {
  const known = e.resume ? recordOf(rt, e.resume.agentId) : undefined
  if (!known) return next(e)
  const { sessionId: _session, ...unchanged } = known
  await waitAtMost(rt.core.delegates.start({ id: known.id, sessionId: e.resume!.agentId, leadSessionId: rt.id!, text: e.prompt, untracked: true, name: unchanged.name, agent: unchanged.agent }, NO_JOB), Math.min(BIND_MS, await spend(ENGINE_MS)), () => undefined, ctx.timers!)
  let result: AgentSpawnResult
  try { result = await next(e) } catch (error) { await abandon($, rt, known.id, await spend(RETURN_MS)); throw error }
  if ('deny' in result) await abandon($, rt, known.id, await spend(RETURN_MS))
  return result
}

async function spawned($: Engine, { rt, ctx }: Entered, e: Spawn, next: Next<'agent.spawn'>, spend: Spend) {
  const nested = e.parentAgentId !== undefined
  const base = e.workflow ? `${e.tool_use_id || e.workflow.runId}.${e.workflow.agentIndex}` : e.tool_use_id || 'spawn'
  const id = `${base}-${(await $.clock.now()).toString(36)}`
  const text = textOf(e)
  // Each wait draws on what is left of the hook's budget, less what the engine's spawn and the return need.
  const before = async () => Math.min(BIND_MS, await spend(ENGINE_MS))
  // A nested spawn is the delegate's own, not the lead's: it is never matched against the lead's plan.
  if (!nested) {
    await waitAtMost(rt.core.tools.call(ctx, { startsChild: true }), await before(), () => undefined, ctx.timers!) // The parent is made when it is first needed.
    let failure: unknown
    await waitAtMost(rt.core.delegates.check([text], id, undefined, NO_JOB), await before(), error => { failure = error }, ctx.timers!)
    if (failure) {
      rt.core.delegates.release(id)
      // The rules refuse a spawn that names an item another delegate holds, or a ticket it cannot take.
      if (failure instanceof Refusal) return { deny: failure.message }
    }
  }
  const host = { id, sessionId: id, leadSessionId: rt.id!, text, name: e.name || e.description || undefined, agent: e.subagentType || undefined, parentAgentId: e.parentAgentId, call: id, untracked: nested }
  const began = rt.core.delegates.start(host, NO_JOB)
  await waitAtMost(began, await before(), () => undefined, ctx.timers!)
  if (e.permissionMode === 'auto') autoMode.add(id)
  let note: string | undefined
  try { note = await bindingNote($, rt, id, await before()) } catch { /* The agent starts with the prompt it was given. */ }
  let result: AgentSpawnResult
  try { result = await next(note ? { ...e, prompt: `${e.prompt}\n\n${note}` } : e) } catch (error) { await abandon($, rt, id, await spend(RETURN_MS)); throw error }
  const agentId = 'deny' in result ? undefined : (result.agentId ?? result.teammateId)
  if (!agentId) { await abandon($, rt, id, await spend(RETURN_MS)); return result }
  // From here the engine's own id finds the record. A second `started` for a record that goes on only moves its session.
  await waitAtMost(rt.core.delegates.start({ ...host, sessionId: agentId }, NO_JOB), Math.min(BIND_MS, await spend(RETURN_MS)), () => undefined, ctx.timers!)
  return result
}

// The agent's run ended: its answer is its report (posted when it left no comment of its own), and a later run of the same
// agent (a follow-up, a woken teammate) goes on with the record.
export async function delegateTurn($: Engine, e: TurnEnd) {
  if (e.agentId === undefined) return
  try {
    const found = await find($, e.agentId)
    if (!found?.record) return
    const { rt, record } = found
    const outcome: DelegateOutcome = e.isAborted || e.reason === 'aborted' ? 'aborted' : e.reason === 'answer' ? 'completed' : 'failed'
    const answer = e.answer.trim()
    const report = answer || (outcome === 'completed' ? '' : `Failed: ${e.reason}`)
    const events = rt.core.delegates
    const work = (async () => {
      if (report) await events.apply({ type: 'reported', id: record.id, text: report }, NO_JOB)
      await events.apply({ type: 'exited', id: record.id, outcome }, NO_JOB)
    })()
    await waitAtMost(work, EVENT_MS, () => undefined, contextOf($, rt).timers!)
  } catch { /* A report that was not posted is settled with the lead's turn end or kept for its resume. */ }
}

export interface Routed { command: string; same: boolean }

// Where a kata command goes under the delegate's teammate: unchanged when it already carries it (and its workspace and
// project, for a delegate with an issue), else the same command with the flags added. `--as` is refused. Pure, so a refusal
// can name the exact command to run.
export function shellRoute(command: string, executable: string, teammate: string, binding?: Binding): Routed {
  if (!kataCommands(posixPath, command, executable, EXECUTABLE_VARS).length) return { command, same: true }
  const fixed = delegateCommand(posixPath, command, executable, EXECUTABLE_VARS, teammate, binding)
  const compliant = kataCommands(posixPath, command, executable, EXECUTABLE_VARS).every(invocation => {
    const parsed = shellOptions(invocation.words)
    return (parsed.occurrences.get('--teammate')?.length ?? 0) === 1 && parsed.value('--teammate') === teammate
      && (!binding || (parsed.options.has('--workspace') && parsed.options.has('--project')))
  })
  return { command: compliant ? command : fixed, same: compliant }
}

const mustRun = (fixed: string) => `Kata subagents run every kata command under their own teammate. Run it again exactly like this: ${fixed}`

// A subagent's tool calls: the first one tells the core the delegate did something, and its kata commands carry its teammate.
// A rewrite of the Bash command is the first choice. Auto mode refuses a tool call a hook changed after the classifier read it
// (the model is told so and its repeat of the exact call goes through with the change dropped), so there the call is refused
// with the exact command to run instead: the model's next call already carries the flags and passes untouched.
export const onDelegateCall: Hook<'tool.call'> = async ($, e, next) => {
  if (e.agentId === undefined) return next(e)
  let found: Found | undefined
  try { found = await find($, e.agentId); if (found?.record) await used($, found.rt, found.record) } catch { /* Observing never fails a call. */ }
  if (e.tool !== 'Bash' || !('command' in e) || typeof e.command !== 'string' || !found) return next(e)
  const command = e.command
  const { rt, record } = found
  // An agent the lead does not track (an engine fork, a Workflow Code Review agent) keeps the teammate a record would give it.
  const teammate = record?.teammate ?? teammateFor(e.agentId, rt.id)
  let routed: Routed
  try { routed = shellRoute(command, rt.settings.executable, teammate, record?.binding) } catch (error) { return { deny: error instanceof Error ? error.message : String(error) } }
  if (routed.same) return next(e)
  if (record && autoMode.has(record.id)) return { deny: mustRun(routed.command) }
  const done = await next({ ...e, command: routed.command })
  if (done.deny !== undefined && /changed this call's input/i.test(done.deny)) return { deny: mustRun(routed.command) }
  return done
}

// A subagent's `todo` call: it works its own issue through a core of its own, the way a delegate does on the other hosts.
export async function delegateTodo($: Engine, agentId: string, op: string, params: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const found = await find($, agentId)
  if (!found) return { text: 'Kata is not ready for this session.', isError: true }
  const { rt, record } = found
  if (!record) return { text: 'This subagent has no Kata assignment: it is not one the lead tracks, so report your work in your reply.', isError: true }
  try {
    await used($, rt, record)
    const out = await coreOf(rt, record.id).todo.apply(contextOf($, rt, record.id), op, params, NO_JOB)
    return { text: out.content.map(part => part.text).join('\n'), isError: out.isError === true }
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), isError: true }
  }
}
