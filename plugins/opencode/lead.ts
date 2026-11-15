import { waitAtMost } from "./wait-at-most";
import { createKataCore, type HostContext, type KataCore, type PlanView } from "./kata-core";
import type { DelegateRecord, DelegateStore } from "./delegates";
import { NAMESPACE, type SavedEntry, type SavedSession, type SessionStorage } from "./saved";
import { EXECUTABLE_VARS, type Settings } from "./settings";
import type { KataExec } from "./spawn";

// How long a hook waits for a session's first binding to its plan before it carries on without the plan.
const READY_MS = 10_000;

// The core's `details.kata`: the plan view, or only a notice when the call never reached the plan.
export type TodoResult = { text: string; kata: Partial<PlanView> & { notice?: string }; isError: boolean };

// A core and the todo entry every caller of it shares.
export interface CoreCaller {
	readonly core: KataCore;
	// What the core reads of this caller's session on every call: its directory, its id and its saved entries (`agent` marks a delegate's).
	readonly coreCtx: HostContext;
	// Runs `fn` as one job of the core (its `todo.batch`): the read, diff and writes of one tool call share their Kata reads, and
	// no other call, delegate event or timer of this core runs between them.
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
	// Delegate records of this lead, in memory (the core saves the ones it still needs with the lead's state, and brings them back).
	readonly delegates: DelegateStore;
	// The core of a delegate's session (a non-main caller of the lead's delegate records), created at first use.
	delegateCore(sessionID: string): DelegateCore;
	// Settles once the core bound the session to its plan parent; never rejects.
	readonly ready: Promise<void>;
	// The plan as the system prompt shows it, when there is one.
	planSection(): Promise<string | undefined>;
	// The lead's turn ended: drain pending closes and hand back exited delegates. Never closes the automatic parent.
	settle(): Promise<void>;
	// The session ended (deleted or archived): drain, release the tasks it holds (one whose close still waits keeps its hold), close the automatic parent when its work is done.
	// Forgets the saved state and returns true when nothing is left to finish; when work is still owed it stays saved as an ended session for the next setup and returns false.
	end(): Promise<boolean>;
	// The session is seen alive again (unarchived, or its own hook ran): it is no longer an ended session, so a later setup does not finish it.
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
	const delegates: DelegateStore = {
		records: () => [...records.values()],
		get: key => records.get(key),
		put: record => { records.set(record.id, record); },
		of: ctx => [...records.values()].find(record => record.sessionId === ctx.sessionManager.getSessionId()),
	};

	// The lead's core and each delegate's differ only in whose session they serve: a non-main core never settles, ends or reminds.
	const newCore = (main: boolean, append: typeof appendEntry, delegateStore: DelegateStore) => createKataCore({
		exec: (file, args, { ctx, ...options }) => deps.exec(ctx?.sessionManager?.getSessionId?.() ?? id, file, args, options),
		appendEntry: append,
		isMain: () => main,
		delegateStore,
	}, {
		namespace: NAMESPACE,
		executable: deps.settings.executable,
		executableVars: EXECUTABLE_VARS,
		debugFile: deps.settings.debugFile,
		env: deps.settings.env,
		// The todowrite list says what is in progress; Kata tasks start when it says so.
		autoStart: false,
		closeParent: "shutdown",
	});
	const caller = (core: KataCore, coreCtx: HostContext): CoreCaller => ({
		core, coreCtx,
		exclusive: fn => core.todo.batch(coreCtx, fn),
		async todo(op, params = {}) {
			const result = await core.todo.apply(coreCtx, op, params);
			return { text: result.content.map(part => part.text).join("\n"), kata: result.details.kata, isError: result.isError === true };
		},
	});
	const contextOf = (sessionID: string, saved: SavedEntry[], delegate: boolean): HostContext =>
		({ cwd: directory, ...(delegate ? { agent: { kind: "sub", id: sessionID } } : {}), sessionManager: { getSessionId: () => sessionID, getBranch: () => saved, getHeader: () => undefined } });
	const lead = caller(newCore(true, appendEntry, delegates), contextOf(id, entries, false));
	const { core, coreCtx } = lead;

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
			known = { id: sessionID, ...caller(newCore(false, () => {}, own), contextOf(sessionID, [], true)) };
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
			await core.session.settle(coreCtx);
			await writes;
		},
		async end() {
			await ready;
			const owed = await core.session.end(coreCtx);
			await writes;
			// A close Kata refused, the automatic parent's close or a delegate still running is finished by the next setup: the state stays saved.
			if (owed) {
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
