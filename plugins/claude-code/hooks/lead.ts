import { createKataCore, type KataCore } from "../core/kata-core";
import { recordStore, type DelegateRecord } from "../core/delegates";
import type { Engine } from "./engine";
import { canonicalPath, execOf, platformOf, type Held, type RunContext } from "./host";
import { planUi } from "./plan";
import { liveInboxOf, resetInbox } from "./inbox";
import { loadSession, NAMESPACE, pruneSessions, sessionWriter } from "./saved";
import { EXECUTABLE_VARS, readEnv, resolveSettings, type Settings } from "./settings";

// One core serves the process's one lead session. A hot reload starts a fresh module (and a fresh `session.start`), so
// nothing here has to survive one; what must survive a restart is saved per session id (saved.ts).

// How long `session.start` waits for the session's first binding to its plan before it carries on without it.
const READY_MS = 5000;

export interface Runtime {
	core: KataCore;
	settings: Settings;
	env: Map<string, string>;
	// The session's folder (what the core's Platform reads) and the debug file; `cwd` is held here only.
	state: { cwd: string; debugFile?: string };
	// The session of the latest event; changes at /clear, /resume and /branch, which fire no `session.start`. The core's own
	// binding follows it once its switch job has run.
	id?: string;
	// The saved record and delegate records of the session the core is bound to: they move with the core's bind (`switched`).
	writer?: ReturnType<typeof sessionWriter>;
	latest?: RunContext;
	// What earlier prompts of this session carried, by section: a section is sent again only when it changed.
	sent: Record<string, string>;
	// Whether an earlier session of this process was left behind (a fork's source, or what a switch ends).
	previous?: string;
	// The lead's delegates by record id (delegates.ts); a delegate reaches its issue through `core.delegate(id)`.
	records: Map<string, DelegateRecord>;
	// Spawn hooks still running: a subagent's first call can arrive before its spawn hook has recorded its agent id.
	spawning: Set<Promise<unknown>>;
}

let options: Record<string, unknown> | undefined;
let current: Runtime | undefined;
let chain: Promise<unknown> = Promise.resolve();

export const configure = (given: Record<string, unknown> | undefined) => {
	options = given;
};
export const runtime = () => current;

// The context for a call. Without `held` it names the session of the latest event, which every hook has just entered, so a hook
// and `enter` reach the same record; the core's own binding may still lag it until the core's switch job has run.
export function contextOf($: Engine, rt: Runtime, delegate?: string, held: Held | undefined = rt.latest?.held): RunContext {
	return {
		cwd: rt.state.cwd,
		held,
		...(delegate ? { agent: { kind: "sub", id: delegate } } : {}),
		sessionManager: { getSessionId: () => held?.id, getBranch: () => held?.writer.entries ?? [], getHeader: () => held?.header },
		run: (argv, init) => $.process.run(argv, init),
		ui: planUi($),
		timers: { setTimer: (fire, ms) => $.clock.after(ms, fire), clearTimer: handle => (handle as { cancel(): void }).cancel() }
	};
}

async function create($: Engine): Promise<Runtime> {
	const env = await readEnv($);
	const settings = resolveSettings(options, env);
	const state = { cwd: "", debugFile: settings.debugFile };
	const platform = platformOf($, env, state);
	const exec = execOf($, env, () => rt.latest);
	// The core only calls back into `rt` once an event runs, after this literal is built.
	const rt: Runtime = {
		settings,
		env,
		state,
		sent: {},
		records: new Map(),
		spawning: new Set(),
		core: createKataCore(
			{
				platform,
				contextTimers: ctx => ctx?.timers,
				exec,
				appendEntry: (type, data) => rt.writer?.append(type, data),
				switched: ctx => {
					if (!ctx.held) return;
					rt.writer = ctx.held.writer;
					rt.records = ctx.held.records;
				},
				isMain: ctx => ctx?.agent === undefined,
				delegateStore: recordStore(
					() => rt.records,
					ctx => (ctx?.agent?.id ? rt.records.get(ctx.agent.id) : undefined)
				),
				liveInbox: settings.liveInbox ? liveInboxOf($, settings.executable) : undefined
			},
			{ namespace: NAMESPACE, executable: settings.executable, executableVars: EXECUTABLE_VARS, debugFile: settings.debugFile, widget: (_line, view) => view }
		)
	};
	return rt;
}

export type Entered = { rt: Runtime; ctx: RunContext };

// The runtime for the session `$` belongs to, bound to its plan. The first call creates it; a call that finds another
// session id (/clear, /resume, /branch) switches the core to it, as omp's session switch does. `fork`: the new session
// shares the plan of the one it replaces. Calls queue, so parallel hooks bind once.
export function enter($: Engine, hint: { fork?: boolean } = {}): Promise<Entered> {
	const run = chain.then(() => attach($, hint));
	chain = run.catch(() => undefined);
	return run;
}

async function attach($: Engine, hint: { fork?: boolean }): Promise<Entered> {
	const id = await $.session.id();
	const cwd = await canonicalPath($, await $.session.cwd());
	const rt = (current ??= await create($));
	rt.state.cwd = cwd;
	if (rt.id === id && rt.latest) {
		const ctx = (rt.latest = contextOf($, rt, undefined, rt.latest.held));
		return { rt, ctx };
	}
	const previous = rt.id;
	// A fork's own record is empty: it starts from what its source saved (the core's bind reads the source's snapshot
	// through the header), taken before the source's writer ends.
	const left = rt.latest?.held?.writer;
	const seed = hint.fork && previous && left ? left.entries : undefined;
	if (left) await left.end(rt.core.session.owes(), await $.clock.now());
	rt.id = id;
	rt.previous = previous;
	rt.sent = {};
	// The previous session's delegates stay with it (saved above, picked up when it resumes).
	const held: Held = {
		id,
		header: hint.fork && previous ? { parentSession: previous } : undefined,
		writer: sessionWriter($, id, () => $.clock.now()),
		records: new Map()
	};
	held.writer.start(await loadSession($, id), cwd, seed);
	const ctx = (rt.latest = contextOf($, rt, undefined, held));
	// The saved plan, pending closes and unfinished delegates of a resumed session are picked up by the core's bind.
	await rt.core.session.start(ctx, { wait: READY_MS });
	void pruneSessions($, await $.clock.now(), id).catch(() => undefined);
	return { rt, ctx };
}

// For tests: forget the module's runtime, as a reload does.
export function reset() {
	current = undefined;
	chain = Promise.resolve();
	resetInbox();
}
