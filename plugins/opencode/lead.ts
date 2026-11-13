import { waitAtMost } from "./wait-at-most";
import { createKataCore, type KataCore, type PlanView } from "./kata-core";
import { FINAL, type DelegateRecord, type DelegateStore, type SavedDelegate } from "./delegates";
import { coreState, type SavedEntry, type SavedSession, type SessionStorage } from "./saved";
import type { Settings } from "./settings";
import type { KataExec } from "./spawn";

// How long a hook waits for a session's first binding to its plan before it carries on without the plan.
const READY_MS = 10_000;

// The core's `details.kata`: the plan view, or only a notice when the call never reached the plan.
export type TodoResult = { text: string; kata: Partial<PlanView> & { notice?: string }; isError: boolean };

// What a core's callers pass on every call: the core reads `cwd` and the session id from it (`agent` marks a delegate's).
export interface CoreCtx {
	cwd: string;
	agent?: { kind: "sub"; id: string };
	sessionManager: { getSessionId(): string; getBranch(): SavedEntry[]; getHeader(): undefined };
}

// A core and the serial queue and todo entry every caller of it shares.
export interface CoreCaller {
	readonly core: KataCore;
	readonly coreCtx: CoreCtx;
	// Runs `fn` after every earlier exclusive call of this core: read, diff and write of one tool call must not interleave with another's.
	exclusive<T>(fn: () => Promise<T>): Promise<T>;
	// One todo op through the core (`view` binds and reloads the plan first). Never throws: the result says `isError`.
	todo(op: string, params?: Record<string, unknown>): Promise<TodoResult>;
}

// A delegate's session as a caller of its own core: the core holds one session's plan, so a delegate never shares the lead's.
// The core refuses a todo as the delegate when it has no assigned issue.
export interface DelegateCore extends CoreCaller {
	readonly id: string;
}

// One lead session's core and everything the adapter keeps for it. OpenCode runs many sessions in one server process, so
// each lead has its own core (the core holds one session's plan) and its own saved state.
export interface Lead extends CoreCaller {
	readonly id: string;
	readonly directory: string;
	// Delegate records of this lead, in memory (the core saves the unfinished ones with the lead's state).
	readonly delegates: DelegateStore;
	// The core of a delegate's session (a non-main caller of the lead's delegate records), created at first use.
	delegateCore(sessionID: string): DelegateCore;
	// Settles once the core bound the session to its plan parent; never rejects.
	readonly ready: Promise<void>;
	// The plan as the system prompt shows it, when there is one.
	planSection(): Promise<string | undefined>;
	// The lead's turn ended: drain pending closes and hand back exited delegates. Never closes the automatic parent.
	settle(): Promise<void>;
	// The session ended (deleted or archived) and is now an ended session: drain, release what it holds, close the automatic parent when its work is done.
	// Forgets the saved state and returns true when nothing is left to finish; otherwise keeps it saved as an ended session for the next setup and returns false.
	end(): Promise<boolean>;
	// The session is seen alive again (unarchived, or its own hook ran): it is no longer an ended session, so a later setup does not end it.
	clearEnded(): Promise<void>;
	// The plugin instance is going away but the session may resume: drain what fits, keep the rest saved; closes and releases nothing.
	suspend(): Promise<void>;
}

export interface LeadDeps {
	id: string;
	directory: string;
	settings: Settings;
	exec: KataExec;
	storage: SessionStorage;
	// State saved by an earlier instance of this plugin.
	saved?: SavedSession;
	// The delegate records that had ended when an earlier instance last saved them (see saved.ts).
	settled?: SavedDelegate[];
	debug(error: unknown): void;
}

export function createLead(deps: LeadDeps): Lead {
	const { id, directory, storage, debug } = deps;
	const entries: SavedEntry[] = structuredClone(deps.saved?.entries ?? []);
	let writes: Promise<unknown> = Promise.resolve(), ended = false;
	// The core's saved state is its latest entry of each type: it reads nothing older.
	function appendEntry(customType: string, data: unknown) {
		const index = entries.findIndex(entry => entry.customType === customType);
		if (index >= 0) entries.splice(index, 1);
		entries.push({ type: "custom", customType, data: structuredClone(data) });
		if (ended) return;
		const body: SavedSession = { directory, entries: structuredClone(entries) };
		writes = writes.then(() => storage.set(id, "entries", body)).catch(debug);
	}

	const records = new Map<string, DelegateRecord>();
	// The unfinished delegates are saved by the core with the lead's state; the ended ones that have an issue are kept
	// apart, so a follow-up after a restart still finds its record.
	const unfinished = new Set<string>(coreState(entries)?.delegates?.map(d => d.id));
	for (const record of deps.settled ?? []) if (!unfinished.has(record.id)) records.set(record.id, { ...record, text: "" });
	let lastSettled = JSON.stringify(settledOf());
	function settledOf(): SavedDelegate[] {
		return [...records.values()].filter(record => FINAL.has(record.state) && record.ref && record.binding).map(({ text: _text, ...record }) => record);
	}
	const delegates: DelegateStore = {
		records: () => [...records.values()],
		get: key => records.get(key),
		put: record => {
			records.set(record.id, record);
			const settled = JSON.stringify(settledOf());
			if (settled === lastSettled || ended) return;
			lastSettled = settled;
			writes = writes.then(() => storage.set(id, "settled", JSON.parse(settled))).catch(debug);
		},
		of: ctx => [...records.values()].find(record => record.sessionId === ctx.sessionManager.getSessionId()),
	};

	// The lead's core and each delegate's differ only in whose session they serve: a non-main core never settles, ends or reminds.
	const newCore = (main: boolean, append: typeof appendEntry, delegateStore: DelegateStore) => createKataCore({
		exec: (file, args, { ctx, ...options }) => deps.exec(ctx?.sessionManager?.getSessionId?.() ?? id, file, args, options),
		appendEntry: append,
		isMain: () => main,
		delegateStore,
	}, {
		namespace: "opencode",
		executable: deps.settings.executable,
		executableVars: ["KATA_OPENCODE_EXECUTABLE"],
		debugFile: deps.settings.debugFile,
		env: deps.settings.env,
		// The todowrite list says what is in progress; Kata tasks start when it says so.
		autoStart: false,
		closeParent: "shutdown",
	});
	const caller = (core: KataCore, coreCtx: CoreCtx): CoreCaller => {
		let tail: Promise<unknown> = Promise.resolve();
		return {
			core, coreCtx,
			exclusive: fn => { const run = tail.then(fn); tail = run.catch(() => undefined); return run; },
			async todo(op, params = {}) {
				const result = await core.todo.apply(coreCtx, op, params);
				return { text: result.content.map(part => part.text).join("\n"), kata: result.details.kata, isError: result.isError === true };
			},
		};
	};
	const coreCtx: CoreCtx = { cwd: directory, sessionManager: { getSessionId: () => id, getBranch: () => entries, getHeader: () => undefined } };
	const lead = caller(newCore(true, appendEntry, delegates), coreCtx);
	const { core } = lead;

	const ready = lead.todo("view").then(() => undefined, debug);

	const delegateCores = new Map<string, DelegateCore>();
	function delegateCore(sessionID: string): DelegateCore {
		let known = delegateCores.get(sessionID);
		if (!known) {
			// Only the lead's core settles delegates, inside its own queue: this core sees its own record and no list of the others.
			// Its state is the lead's record and the delegate's Kata issue: nothing of this core is saved.
			const own: DelegateStore = {
				records: () => [],
				get: key => key === sessionID ? records.get(key) : undefined,
				put: record => delegates.put(record),
				of: () => records.get(sessionID),
			};
			const ctx: CoreCtx = { cwd: directory, agent: { kind: "sub", id: sessionID }, sessionManager: { getSessionId: () => sessionID, getBranch: () => [], getHeader: () => undefined } };
			known = { id: sessionID, ...caller(newCore(false, () => {}, own), ctx) };
			delegateCores.set(sessionID, known);
		}
		return known;
	}

	// Whether storage records this lead as an ended session: unknown until read once.
	let savedEnded: boolean | undefined;

	return {
		id, directory, core, coreCtx, delegates, delegateCore,
		get ready() { return waitAtMost(ready, READY_MS).then(() => undefined); },
		exclusive: lead.exclusive, todo: lead.todo,
		async planSection() {
			await waitAtMost(ready, READY_MS);
			const { sections } = await core.session.beforePrompt(coreCtx, { context: false });
			return sections.todo?.replace(/^The todo tool/, "The todowrite tool");
		},
		async settle() {
			await ready;
			await core.session.stop(coreCtx, []);
			await writes;
		},
		async end() {
			await ready;
			// A first pass keeps the tasks: releasing one changes its revision, which would void a close still waiting to retry.
			await core.session.shutdown(coreCtx, { continues: true });
			await writes;
			if (!core.session.owes({ parents: false })) {
				await core.session.shutdown(coreCtx);
				await writes;
			}
			// A close Kata refused, the automatic parent's close or a delegate still running is finished by the next setup: the state stays saved.
			if (core.session.owes()) {
				await storage.set(id, "ended", true);
				savedEnded = true;
				return false;
			}
			ended = true;
			for (const record of records.values()) await storage.clear(record.id);
			await storage.clear(id);
			return true;
		},
		async clearEnded() {
			if (savedEnded === false) return;
			if (await storage.get(id, "ended")) await storage.remove(id, "ended");
			savedEnded = false;
		},
		async suspend() {
			await ready;
			await core.session.shutdown(coreCtx, { continues: true });
			await writes;
		},
	};
}
