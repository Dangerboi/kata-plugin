import { createKataCore, type KataCore, type PlanView } from "./kata-core";
import type { DelegateRecord, DelegateStore } from "./delegates";
import type { SavedEntry, SavedSession, SessionStorage } from "./saved";
import type { Settings } from "./settings";
import type { KataExec } from "./spawn";

// How long a hook waits for a session's first binding to its plan before it carries on without the plan.
const READY_MS = 10_000;

// The core's `details.kata`: the plan view, or only a notice when the call never reached the plan.
export type TodoResult = { text: string; kata: Partial<PlanView> & { notice?: string }; isError: boolean };

// One lead session's core and everything the adapter keeps for it. OpenCode runs many sessions in one server process, so
// each lead has its own core (the core holds one session's plan) and its own saved state.
export interface Lead {
	readonly id: string;
	readonly directory: string;
	readonly core: KataCore;
	// The context object every call into `core` for this session passes (the core reads `cwd` and the session id from it).
	readonly coreCtx: { cwd: string; sessionManager: { getSessionId(): string; getBranch(): SavedEntry[]; getHeader(): undefined } };
	// Delegate records of this lead, in memory (the core saves the unfinished ones with the lead's state).
	readonly delegates: DelegateStore;
	// Settles once the core bound the session to its plan parent; never rejects.
	readonly ready: Promise<void>;
	// Runs `fn` after every earlier exclusive call of this lead: read, diff and write of one tool call must not interleave with another's.
	exclusive<T>(fn: () => Promise<T>): Promise<T>;
	// One todo op through the core (`view` binds and reloads the plan first). Never throws: the result says `isError`.
	todo(op: string, params?: Record<string, unknown>): Promise<TodoResult>;
	// The plan as the system prompt shows it, when there is one.
	planSection(): Promise<string | undefined>;
	// The lead's turn ended: drain pending closes and hand back exited delegates. Never closes the automatic parent.
	settle(): Promise<void>;
	// The session ended (deleted or archived): drain, release what it holds, close the automatic parent when its work is done, forget the saved state.
	end(): Promise<void>;
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

	const coreCtx: Lead["coreCtx"] = { cwd: directory, sessionManager: { getSessionId: () => id, getBranch: () => entries, getHeader: () => undefined } };
	const core = createKataCore({
		exec: (file, args, { ctx, ...options }) => deps.exec(ctx?.sessionManager?.getSessionId?.() ?? id, file, args, options),
		appendEntry,
		delegateStore: delegates,
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

	let tail: Promise<unknown> = Promise.resolve();
	const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
		const run = tail.then(fn);
		tail = run.catch(() => undefined);
		return run;
	};
	const todo: Lead["todo"] = async (op, params = {}) => {
		const result = await core.todo.apply(coreCtx, op, params);
		return { text: result.content.map(part => part.text).join("\n"), kata: result.details.kata, isError: result.isError === true };
	};
	const ready = todo("view").then(() => undefined, debug);
	const bounded = <T>(promise: Promise<T>) => {
		let timer: unknown;
		return Promise.race([promise, new Promise<undefined>(resolve => { timer = setTimeout(resolve, READY_MS); })]).finally(() => clearTimeout(timer as Parameters<typeof clearTimeout>[0]));
	};

	return {
		id, directory, core, coreCtx, delegates,
		get ready() { return bounded(ready).then(() => undefined); },
		exclusive, todo,
		async planSection() {
			await bounded(ready);
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
			await core.session.shutdown(coreCtx);
			ended = true;
			await writes;
			await storage.clear(id);
		},
		async suspend() {
			await ready;
			await core.session.shutdown(coreCtx, { continues: true });
			await writes;
		},
	};
}
