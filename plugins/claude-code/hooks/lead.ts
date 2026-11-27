import type { EngineInterface } from "claude-code";
import { debugTo, waitAtMost, type Platform } from "../core/kata-cli";
import { recordStore } from "../core/delegates";
import { canonicalPath, createKataCore, type KataCore } from "../core/kata-core";
import { execOf, platformOf, timersOf, type RunContext, type Session } from "./host";
import { planUi } from "./plan";
import { liveInboxOf } from "./inbox";
import { loadSession, pruneSessions, sessionWriter } from "./saved";
import { EXECUTABLE_VARS, NAMESPACE, readEnv, resolveSettings, type Settings } from "./settings";

// One core serves the process's one lead session. A hot reload starts a fresh module (and a fresh `session.start`), so
// nothing here has to survive one; what must survive a restart is saved per session id (saved.ts).

// How long `session.start` waits for the bind: a resumed session's saved work resumes with it.
const READY_MS = 5000;

export interface Runtime {
	core: KataCore;
	settings: Settings;
	platform: Platform;
	debug: (error: unknown) => void;
	state: { cwd: string };
	// The context of the latest event. Its session changes at /clear, /resume and /branch, which fire no `session.start`.
	latest?: RunContext;
	// The session the core is bound to, set only when the core switches to it (the host's `switched`); the core's own binding
	// lags `latest` until its switch job has run. Its writer and its delegates' records are the ones the core works with.
	bound?: Session;
	// Spawn hooks still running: a subagent's first call can arrive before its spawn hook has recorded its agent id.
	spawning: Set<Promise<unknown>>;
	// Whether the lead's loop is working: a live inbox request joins the turn then, and starts one when idle (inbox.ts).
	busy: boolean;
}

let options: Record<string, unknown> | undefined;
let current: Runtime | undefined;
let chain: Promise<unknown> = Promise.resolve();

export const configure = (given: Record<string, unknown> | undefined) => {
	options = given;
};
export const runtime = () => current;

// Waits for `promise` at most `ms`: undefined when the time runs out or the promise rejects (the error goes to the debug sink).
export function waitFor<T>($: EngineInterface, rt: Runtime, promise: Promise<T>, ms: number): Promise<T | undefined> {
	return waitAtMost(promise, ms, rt.debug, timersOf($));
}

// The context for a call made on behalf of `session`: an event's own, or the delegate `delegate`'s.
export function contextOf($: EngineInterface, rt: Runtime, session: Session, delegate?: string): RunContext {
	return {
		cwd: rt.state.cwd,
		held: session,
		...(delegate ? { agent: { kind: "sub", id: delegate } } : {}),
		sessionManager: { getSessionId: () => session.id, getBranch: () => session.writer.entries, getHeader: () => session.header },
		run: (argv, init) => $.process.run(argv, init),
		ui: planUi($),
		timers: timersOf($)
	};
}

async function create($: EngineInterface): Promise<Runtime> {
	const env = await readEnv($);
	const settings = resolveSettings(options, env);
	// The core reads the switch from its environment, where the option becomes the variable.
	env.set("KATA_REF_GUARD", settings.refGuard);
	const state = { cwd: "" };
	const platform = platformOf($, env, state);
	const exec = execOf($, env, () => rt.latest);
	// The core only calls back into `rt` once an event runs, after this literal is built.
	const rt: Runtime = {
		settings,
		platform,
		debug: debugTo(settings.debugFile, platform.appendFile),
		state,
		spawning: new Set(),
		busy: false,
		core: createKataCore(
			{
				platform,
				contextTimers: ctx => ctx?.timers,
				exec,
				appendEntry: (type, data) => rt.bound?.writer.append(type, data),
				// Runs inside the core's bind, before the new session's snapshot is restored. The leaving session's debts are read
				// first: its delegates' records are looked up through `rt.bound`.
				switched: (ctx: RunContext) => {
					const owed = rt.core.session.owes();
					const before = rt.bound;
					rt.bound = ctx.held;
					if (before) void before.writer.end(owed).catch(rt.debug);
				},
				isMain: ctx => ctx?.agent === undefined,
				// Before the core's first switch the records are those of the session the events belong to.
				delegateStore: recordStore(
					() => (rt.bound ?? rt.latest!.held).records,
					ctx => (ctx?.agent?.id ? (rt.bound ?? rt.latest!.held).records.get(ctx.agent.id) : undefined)
				),
				liveInbox: settings.liveInbox ? liveInboxOf($, () => rt.busy) : undefined
			},
			{ namespace: NAMESPACE, executable: settings.executable, executableVars: EXECUTABLE_VARS, debugFile: settings.debugFile, warn: true, widget: (_line, view) => view }
		)
	};
	return rt;
}

export type Entered = { rt: Runtime; ctx: RunContext };

// The runtime for the session `$` belongs to, bound to its plan. The first call creates it; a call that finds another
// session id (/clear, /resume, /branch) switches the core to it, as omp's session switch does. `fork`: the new session
// shares the plan of the one it replaces. Calls queue, so parallel hooks bind once.
export function enter($: EngineInterface, hint: { fork?: boolean } = {}): Promise<Entered> {
	const run = chain.then(() => attach($, hint));
	chain = run.catch(() => undefined);
	return run;
}

async function attach($: EngineInterface, hint: { fork?: boolean }): Promise<Entered> {
	const id = await $.session.id();
	const folder = await $.session.cwd();
	const rt = (current ??= await create($));
	const cwd = await canonicalPath(rt.platform, folder, folder);
	rt.state.cwd = cwd;
	const before = rt.latest?.held;
	if (before?.id === id) {
		const ctx = (rt.latest = contextOf($, rt, before));
		return { rt, ctx };
	}
	// A fork's own record is empty: it starts from what its source saved (the core's bind reads the source's snapshot
	// through the header).
	const source = hint.fork ? before : undefined;
	const session: Session = {
		id,
		header: source && { parentSession: source.id },
		writer: sessionWriter($, id, () => $.clock.now(), rt.debug, await loadSession($, id), source?.writer.entries),
		records: new Map(),
		sent: {},
		autoMode: new Set()
	};
	const ctx = (rt.latest = contextOf($, rt, session));
	// The saved plan, pending closes and unfinished delegates of a resumed session are picked up by the core's bind.
	await rt.core.session.start(ctx, { wait: READY_MS });
	void $.clock.now().then(now => pruneSessions($, now, id)).catch(rt.debug);
	return { rt, ctx };
}

// For tests: forget the module's runtime, as a reload does.
export function reset() {
	current = undefined;
	chain = Promise.resolve();
}
