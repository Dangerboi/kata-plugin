import type { AgentSpawnResult, EngineInterface, Hook, Next } from "claude-code";
import { NO_JOB, waitAtMost } from "../core/kata-cli";
import { posixPath } from "../core/posix-path";
import { Refusal, teammateFor, type DelegateOutcome, type DelegateRecord } from "../core/delegates";
import type { Binding } from "../core/model";
import { delegateCommand, delegateRouted } from "../core/shell";
import { tagged, todoText } from "../core/kata-core";
import { timersOf, type Session } from "./host";
import { contextOf, enter, runtime, waitFor, type Entered, type Runtime } from "./lead";
import { EXECUTABLE_VARS } from "./settings";

// Subagents and Workflow agents as the core's delegates: `agent.spawn` assigns each one the plan item or ticket its text
// names (or leaves it untracked, and its run becomes a mission), `turn.complete` hands in its report, and its kata commands
// run under its own teammate.
//
// A record is made before the agent exists, because its assignment goes in the prompt: it is keyed by the spawn (its call id,
// which a Workflow's agents share, plus the agent's index and a stamp), and its `sessionId` becomes the engine's agent id
// as soon as the spawn returns it. Everything that arrives with an agent id finds the record by that.

// Every wait of a spawn is bounded: the core's decision on what an agent works takes at most ASSIGN_MS before the agent starts
// without its assignment (it still gets its issue, and learns of it from its next todo call). The engine gives a spawn hook 10 s
// in all, so the waits of one spawn draw from that budget (`Spend`) and never run past it.
const ASSIGN_MS = 7000;
// What a spawn hook keeps back for the engine's own spawn (`next`) and its return, and what a wait after the spawn keeps back.
const ENGINE_MS = 3000;
const RETURN_MS = 500;
const within = async (spend: Spend, keep: number) => Math.min(ASSIGN_MS, await spend(keep));
// How long a delegate's own events (report, exit, settle) may hold one hook.
const EVENT_MS = 8000;
// How long a call that names an agent the module has no record of yet waits for the spawn hooks still running.
const SPAWN_MS = 3000;

// A hook's budget (from its call to its return; `$.clock` waits count) as one account: `spend(keep)` is what remains of it
// less `keep`, never below 0. Made when the hook is called, so every wait draws from the same time.
type Spend = (keep: number) => Promise<number>;

async function budgetOf($: EngineInterface, next: Next<"agent.spawn">): Promise<Spend> {
	const total = next.budget.remainingMs;
	const begun = await $.clock.now();
	return async keep => Math.max(0, total - keep - ((await $.clock.now()) - begun));
}

function recordOf(session: Session, agentId: string): DelegateRecord | undefined {
	for (const record of session.records.values()) if (record.sessionId === agentId) return record;
}

// `session` is the one the core is bound to, whose records these are.
interface Found {
	rt: Runtime;
	session: Session;
	record?: DelegateRecord;
}

// Waits for the spawn hooks that may still be recording the agent id before it concludes there is no record.
async function find($: EngineInterface, agentId: string): Promise<Found | undefined> {
	const rt = runtime();
	const session = rt?.bound;
	if (!rt || !session) return undefined;
	let record = recordOf(session, agentId);
	if (!record && rt.spawning.size) {
		await waitFor($, rt, Promise.allSettled([...rt.spawning]), SPAWN_MS);
		record = recordOf(session, agentId);
	}
	return { rt, session, record };
}

// What the delegate has done with Kata so far, as the core wants it told: its first tool call blocks the rollback at exit,
// and a use after the run ended (or while its assignment failed) goes on with the record.
async function used($: EngineInterface, rt: Runtime, record: DelegateRecord) {
	const delegates = rt.core.delegates;
	if (!record.ranTool) void delegates.apply({ type: "ranTool", id: record.id }, NO_JOB);
	if (record.exited || record.state === "started" || record.state === "failed") {
		await waitFor($, rt, delegates.apply({ type: "nextUse", id: record.id }, NO_JOB), EVENT_MS);
	}
}

const textOf = (e: { prompt: string; description: string; name?: string }) => [e.prompt, e.description, e.name].filter(Boolean).join("\n");

// What the agent's prompt gains: the assignment (its issue and commands, or that it has none) and, when the plugin owns the
// contract, the contract.
async function assignmentNote($: EngineInterface, rt: Runtime, session: Session, id: string, ms: number): Promise<string | undefined> {
	const asked = await waitFor($, rt, rt.core.delegate(id).session.beforePrompt(contextOf($, rt, session, id), { context: rt.settings.contract }), ms);
	if (!asked) return undefined;
	const { sections } = asked;
	return [sections.contract && tagged("contract", sections.contract), sections.assignment && tagged("assignment", sections.assignment)].filter(Boolean).join("\n\n") || undefined;
}

async function abandon($: EngineInterface, rt: Runtime, id: string, ms = EVENT_MS) {
	rt.core.delegates.release(id);
	await waitFor($, rt, rt.core.delegates.apply({ type: "exited", id, outcome: "failed" }, NO_JOB), ms);
}

// `Agent` calls, Workflow agents, teammates and nested spawns are assigned here. Forks no tool call starts (`/btw`, `/fork`) are no
// delegation of the lead's work and run as they are. An infrastructure failure never stops the spawn.
export const onSpawn: Hook<"agent.spawn"> = async ($, e, next) => {
	if (e.fork && !e.tool_use_id) return next(e);
	const spend = await budgetOf($, next);
	let entered: Entered;
	try {
		entered = await enter($);
	} catch (error) {
		runtime()?.debug(error);
		return next(e);
	}
	const run = e.resume ? resumed($, entered, e, e.resume.agentId, next, spend) : spawned($, entered, e, next, spend);
	entered.rt.spawning.add(run);
	try {
		return await run;
	} finally {
		entered.rt.spawning.delete(run);
	}
};

type TurnEnd = Parameters<Hook<"turn.complete">>[1];
type Spawn = Parameters<Hook<"agent.spawn">>[1];

// A resumed run (a follow-up message to a finished agent, a woken teammate) goes on with the record it has: its issue while
// that is open, else its mission. The engine accepts no rewrite of it, so nothing is added to its prompt.
async function resumed($: EngineInterface, { rt, ctx }: Entered, e: Spawn, agentId: string, next: Next<"agent.spawn">, spend: Spend) {
	const known = rt.bound && recordOf(rt.bound, agentId);
	if (!known) return next(e);
	await waitFor(
		$,
		rt,
		rt.core.delegates.start({ id: known.id, sessionId: agentId, leadSessionId: ctx.held.id, text: e.prompt, untracked: true, name: known.name, agent: known.agent }, NO_JOB),
		await within(spend, ENGINE_MS)
	);
	let result: AgentSpawnResult;
	try {
		result = await next(e);
	} catch (error) {
		await abandon($, rt, known.id, await spend(RETURN_MS));
		throw error;
	}
	if ("deny" in result) await abandon($, rt, known.id, await spend(RETURN_MS));
	return result;
}

async function spawned($: EngineInterface, { rt, ctx }: Entered, e: Spawn, next: Next<"agent.spawn">, spend: Spend) {
	// The session the spawn belongs to, taken before the waits below: a /resume during them must not name another.
	const lead = ctx.held.id;
	const nested = e.parentAgentId !== undefined;
	const base = e.workflow ? `${e.tool_use_id || e.workflow.runId}.${e.workflow.agentIndex}` : e.tool_use_id || "spawn";
	const id = `${base}-${(await $.clock.now()).toString(36)}`;
	const text = textOf(e);
	if (!nested) {
		await waitFor($, rt, rt.core.tools.call(ctx, { startsChild: true }), await within(spend, ENGINE_MS));
		let failure: unknown;
		await waitAtMost(
			rt.core.delegates.check([text], id, undefined, NO_JOB),
			await within(spend, ENGINE_MS),
			error => {
				failure = error;
				if (!(error instanceof Refusal)) rt.debug(error);
			},
			timersOf($)
		);
		if (failure) {
			rt.core.delegates.release(id);
			// The rules refuse a spawn that names an item another delegate holds, or a ticket it cannot take.
			if (failure instanceof Refusal) return { deny: failure.message };
		}
	}
	const host = {
		id,
		sessionId: id,
		leadSessionId: lead,
		text,
		name: e.name || e.description || undefined,
		agent: e.subagentType || undefined,
		parentAgentId: e.parentAgentId,
		call: id,
		untracked: nested
	};
	await waitFor($, rt, rt.core.delegates.start(host, NO_JOB), await within(spend, ENGINE_MS));
	if (e.permissionMode === "auto") rt.bound?.autoMode.add(id);
	let note: string | undefined;
	try {
		note = await assignmentNote($, rt, ctx.held, id, await within(spend, ENGINE_MS));
	} catch (error) {
		rt.debug(error);
	}
	let result: AgentSpawnResult;
	try {
		result = await next(note ? { ...e, prompt: `${e.prompt}\n\n${note}` } : e);
	} catch (error) {
		await abandon($, rt, id, await spend(RETURN_MS));
		throw error;
	}
	const agentId = "deny" in result ? undefined : (result.agentId ?? result.teammateId);
	if (!agentId) {
		await abandon($, rt, id, await spend(RETURN_MS));
		return result;
	}
	// From here the engine's own id finds the record. A second `started` for a record that goes on only moves its session.
	await waitFor($, rt, rt.core.delegates.start({ ...host, sessionId: agentId }, NO_JOB), await within(spend, RETURN_MS));
	return result;
}

// The agent's run ended: its answer is its report, posted when it left no comment of its own.
export async function delegateTurn($: EngineInterface, e: TurnEnd) {
	if (e.agentId === undefined) return;
	try {
		const found = await find($, e.agentId);
		if (!found?.record) return;
		const { rt, record } = found;
		const outcome: DelegateOutcome = e.isAborted || e.reason === "aborted" ? "aborted" : e.reason === "answer" ? "completed" : "failed";
		const answer = e.answer.trim();
		const report = answer || (outcome === "completed" ? "" : `Failed: ${e.reason}`);
		const events = rt.core.delegates;
		const work = (async () => {
			if (report) await events.apply({ type: "reported", id: record.id, text: report }, NO_JOB);
			await events.apply({ type: "exited", id: record.id, outcome }, NO_JOB);
		})();
		await waitFor($, rt, work, EVENT_MS);
	} catch (error) {
		runtime()?.debug(error);
	}
}

interface Routed {
	command: string;
	same: boolean;
}

// Where a kata command goes under the delegate's teammate: unchanged when it already carries it (and its workspace and
// project, for a delegate with an issue), else the same command with the flags added. `--as` is refused. Pure, so a refusal
// can name the exact command to run.
function shellRoute(command: string, executable: string, teammate: string, binding?: Binding): Routed {
	const fixed = delegateCommand(posixPath, command, executable, EXECUTABLE_VARS, teammate, binding);
	const same = delegateRouted(posixPath, command, executable, EXECUTABLE_VARS, teammate, binding);
	return { command: same ? command : fixed, same };
}

const mustRun = (fixed: string) => `Kata subagents run every kata command under their own teammate. Run it again exactly like this: ${fixed}`;

// A subagent's tool calls: the first one tells the core the delegate did something, and its kata commands carry its teammate.
// A rewrite of the Bash command is the first choice. Auto mode refuses a tool call a hook changed after the classifier read it
// (the model is told so and its repeat of the exact call goes through with the change dropped), so there the call is refused
// with the exact command to run instead: the model's next call already carries the flags and passes untouched.
export const onDelegateCall: Hook<"tool.call"> = async ($, e, next) => {
	if (e.agentId === undefined) return next(e);
	let found: Found | undefined;
	try {
		found = await find($, e.agentId);
		if (found?.record) await used($, found.rt, found.record);
	} catch (error) {
		runtime()?.debug(error);
	}
	if (e.tool !== "Bash" || !("command" in e) || typeof e.command !== "string" || !found) return next(e);
	const command = e.command;
	const { rt, record } = found;
	// An agent the lead does not track (an engine fork, a Workflow Code Review agent) keeps the teammate a record would give it.
	const teammate = record?.teammate ?? teammateFor(e.agentId, found.session.id);
	let routed: Routed;
	try {
		routed = shellRoute(command, rt.settings.executable, teammate, record?.binding);
	} catch (error) {
		return { deny: error instanceof Error ? error.message : String(error) };
	}
	if (routed.same) return next(e);
	if (record && found.session.autoMode.has(record.id)) return { deny: mustRun(routed.command) };
	const done = await next({ ...e, command: routed.command });
	if (done.deny !== undefined && /changed this call's input/i.test(done.deny)) return { deny: mustRun(routed.command) };
	return done;
};

// A subagent's `todo` call: it works its own issue through a core of its own, the way a delegate does on the other hosts.
export async function delegateTodo($: EngineInterface, agentId: string, op: string, params: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
	const found = await find($, agentId);
	if (!found) return { text: "Kata is not ready for this session.", isError: true };
	const { rt, session, record } = found;
	if (!record) return { text: "This subagent has no Kata assignment: it is not one the lead tracks, so report your work in your reply.", isError: true };
	try {
		await used($, rt, record);
		const out = await rt.core.delegate(record.id).todo.apply(contextOf($, rt, session, record.id), op, params, NO_JOB);
		return { text: todoText(out), isError: out.isError === true };
	} catch (error) {
		return { text: error instanceof Error ? error.message : String(error), isError: true };
	}
}
