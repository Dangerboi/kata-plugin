import { createKataCore, type KataCore, type PlanView } from "./kata-core";
import { FINAL, type DelegateRecord, type DelegateStore, type SavedDelegate } from "./delegates";
import { STATE_ENTRY, type SavedEntry, type SavedSession, type SessionStorage } from "./saved";
import type { Settings } from "./settings";
import type { KataExec } from "./spawn";

// How long a hook waits for a session's first binding to its plan before it carries on without the plan.
const READY_MS = 10_000;

// The core's `details.kata`: the plan view, or only a notice when the call never reached the plan.
export type TodoResult = { text: string; kata: Partial<PlanView> & { notice?: string }; isError: boolean };

// A delegate's child session as a caller of its own core: the core holds one session's plan, so a delegate never shares the lead's.
export interface Child {
	readonly id: string;
	readonly core: KataCore;
	readonly coreCtx: { cwd: string; agent: { kind: "sub"; id: string }; sessionManager: { getSessionId(): string; getBranch(): SavedEntry[]; getHeader(): undefined } };
	exclusive<T>(fn: () => Promise<T>): Promise<T>;
	// Like `Lead.todo`, as the delegate: the core refuses it when the delegate has no assigned issue.
	todo(op: string, params?: Record<string, unknown>): Promise<TodoResult>;
}

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
	// The core of a delegate's child session (a non-main caller of the lead's delegate records), created at first use.
	child(sessionID: string): Child;
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
	const unfinished = new Set<string>((entries.find(entry => entry.customType === STATE_ENTRY)?.data as { delegates?: { id: string }[] } | undefined)?.delegates?.map(d => d.id));
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

	// The lead's core and each child's differ only in whose session they serve: a non-main core never settles, ends or reminds.
	const newCore = (main: boolean, append: typeof appendEntry) => createKataCore({
		exec: (file, args, { ctx, ...options }) => deps.exec(ctx?.sessionManager?.getSessionId?.() ?? id, file, args, options),
		appendEntry: append,
		isMain: () => main,
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
	const coreCtx: Lead["coreCtx"] = { cwd: directory, sessionManager: { getSessionId: () => id, getBranch: () => entries, getHeader: () => undefined } };
	const core = newCore(true, appendEntry);

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

	const children = new Map<string, Child>();
	function child(sessionID: string): Child {
		let known = children.get(sessionID);
		if (!known) {
			// A delegate's own state is the lead's records and its Kata issue: nothing of the child core is saved.
			const childCore = newCore(false, () => {});
			const ctx: Child["coreCtx"] = { cwd: directory, agent: { kind: "sub", id: sessionID }, sessionManager: { getSessionId: () => sessionID, getBranch: () => [], getHeader: () => undefined } };
			let childTail: Promise<unknown> = Promise.resolve();
			known = {
				id: sessionID, core: childCore, coreCtx: ctx,
				exclusive: fn => { const run = childTail.then(fn); childTail = run.catch(() => undefined); return run; },
				async todo(op, params = {}) {
					const result = await childCore.todo.apply(ctx, op, params);
					return { text: result.content.map(part => part.text).join("\n"), kata: result.details.kata, isError: result.isError === true };
				},
			};
			children.set(sessionID, known);
		}
		return known;
	}

	return {
		id, directory, core, coreCtx, delegates, child,
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
			for (const record of records.values()) await storage.clear(record.id);
			await storage.clear(id);
		},
		async suspend() {
			await ready;
			await core.session.shutdown(coreCtx, { continues: true });
			await writes;
		},
	};
}
