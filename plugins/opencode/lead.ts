import { waitAtMost } from "./kata-cli";
import { createKataCore, type HostContext, type KataCore, type PlanView } from "./kata-core";
import { teammateFor, type DelegateAssignment, type DelegateEvent, type DelegateRecord, type DelegateStore } from "./delegates";
import { NAMESPACE, type SavedEntry, type SessionStorage } from "./saved";
import { EXECUTABLE_VARS, type Settings } from "./settings";
import type { KataExec } from "./spawn";
import { WORDING } from "./wording";

// How long a hook waits for a session's first binding to its plan before it carries on without the plan.
const READY_MS = 10_000;

// What OpenCode says of a session: "gone" (it no longer holds it), "archived", "alive", or "unknown" when the read failed otherwise.
export type Fate = "alive" | "archived" | "gone" | "unknown";

// The core's `details.kata`: the plan view, or only a notice when the call never reached the plan.
export type TodoResult = { text: string; kata: Partial<PlanView> & { notice?: string }; isError: boolean };

// A session's own plan, as todowrite uses it: the core holds one session's plan, so a delegate has a core of its own and
// never shares the lead's.
export interface Planner {
	// The session whose plan it is.
	readonly id: string;
	// Runs `fn` as one job of the core (its `todo.batch`): the read, diff and writes of one tool call share their Kata reads, and
	// no other call, delegate event or timer of this core runs between them.
	batch<T>(fn: () => Promise<T>): Promise<T>;
	// One todo op through the core (`view` binds and reloads the plan first). Never throws: the result says `isError`.
	todo(op: string, params?: Record<string, unknown>): Promise<TodoResult>;
}

// What a lead knows of one of its child sessions. `record`: the lead tracks it as a delegate. `assignment` (ref, workspace,
// teammate, binding): it holds its Kata issue; an untracked delegate has a record and no assignment. `teammate`: the
// record's, and for a child the lead does not track the one a record would give it.
export interface Child {
	readonly teammate: string;
	readonly record?: DelegateRecord;
	readonly assignment?: DelegateAssignment;
}

// One lead session's core and everything the adapter keeps for it. OpenCode runs many sessions in one server process, so
// each lead has its own core and its own saved state.
export interface Lead extends Planner {
	// Settles once the core bound the session to its plan parent, or after READY_MS; never rejects.
	readonly ready: Promise<void>;
	// The plan as the system prompt shows it, when there is one.
	planSection(): Promise<string | undefined>;

	child(sessionID: string): Child;
	// The plan of a delegate's session under its issue. The core refuses a todo for a delegate with no assigned issue.
	delegatePlan(sessionID: string): Planner;
	// Reads a `subagent` call against the plan before it runs, after any todowrite call still running, and keeps what it names
	// reserved under the call's id. Throws the core's refusal.
	checkSpawn(call: string, text: string): Promise<void>;
	// The call is over: what it reserved and no child took is free again.
	releaseSpawn(call: string): void;
	// A run of a child session began: its first, for the call `call` of the lead, makes its record and takes what the call
	// reserved; a later one goes on with the record (see DelegateEvent `started`). `untracked`: it is never matched to an issue.
	began(sessionID: string, spawn: { text: string; name?: string; agent?: string; call: string; untracked: boolean }): Promise<void>;
	// Any later event of a delegate; its id is the child's session id.
	delegateEvent(event: Exclude<DelegateEvent, { type: "started" }>): Promise<void>;
	// What a delegate's system prompt says of its issue (or that it has none), once `after` settled.
	assignmentSection(sessionID: string, after?: Promise<unknown>): Promise<string | undefined>;

	// The lead's turn ended: drain pending closes and hand back exited delegates. Never closes the automatic parent.
	settle(): Promise<void>;
	// The session ended (deleted or archived): drain, release the tasks it holds (one whose close still waits keeps its hold), close the automatic parent when its work is done.
	// With nothing left to finish it forgets its saved state and returns true. While work is still owed it stays saved as an
	// ended session and returns false; it ends again when its core saves a change and OpenCode still says the session ended,
	// and at the next setup.
	end(): Promise<boolean>;
	// What OpenCode says of the session now decides whether it ended. One it no longer holds ended, whether or not an instance saw
	// that, and is finished like `end()`. An archived one ended only when it is saved as an ended session: a session can run after
	// its archive, and then it is alive. An alive one is no ended session any more (unarchived, or its own hook ran), so nothing
	// finishes it. An unknown fate changes nothing.
	revive(fate: Fate): Promise<void>;
	// The plugin instance is going away but the session may resume: drain what fits, keep the rest saved; closes and releases nothing.
	suspend(): Promise<void>;
}

interface LeadDeps {
	id: string;
	// The folder of the location, where every session of this instance runs.
	directory: string;
	settings: Settings;
	exec: KataExec;
	storage: SessionStorage;
	// What an earlier instance saved for the lead.
	entries?: SavedEntry[];
	debug(error: unknown): void;
	// What OpenCode says of the session now.
	fate(): Promise<Fate>;
	// The lead ended with nothing left to finish.
	forget(): void;
}

export function createLead(deps: LeadDeps): Lead {
	const { id, directory, storage, debug } = deps;
	const entries: SavedEntry[] = structuredClone(deps.entries ?? []);
	// `ended`: the lead ended for good and saves nothing more. `owing`: it ended with work left, and `changed` says its core
	// saved a change since its last end began: that work may be done now. `suspended`: the instance is going away.
	let writes: Promise<unknown> = Promise.resolve(), ended = false, owing = false, changed = false, suspended = false;
	// The core's saved state is its latest entry of each type: it reads nothing older.
	function appendEntry(customType: string, data: unknown) {
		const index = entries.findIndex(entry => entry.customType === customType);
		if (index >= 0) entries.splice(index, 1);
		entries.push({ type: "custom", customType, data: structuredClone(data) });
		if (ended) return;
		const body = structuredClone(entries);
		writes = writes.then(() => storage.saveEntries(id, body)).catch(debug);
		if (owing) { changed = true; void endAgain().catch(debug); }
	}

	// Kept by the record's id, which is its child session's id (see `began`).
	const records = new Map<string, DelegateRecord>();
	const delegates: DelegateStore = {
		records: () => [...records.values()],
		get: key => records.get(key),
		put: record => { records.set(record.id, record); },
		of: ctx => records.get(ctx.sessionManager.getSessionId()),
	};

	// What the core reads of a session on every call: the folder, the session's id and its saved entries (`agent` marks a delegate's).
	const contextOf = (sessionID: string, saved: SavedEntry[], delegate: boolean): HostContext =>
		({ cwd: directory, ...(delegate ? { agent: { kind: "sub", id: sessionID } } : {}), sessionManager: { getSessionId: () => sessionID, getBranch: () => saved, getHeader: () => undefined } });
	// A session's core, the context the core gets on that session's calls, and its plan. The lead's core and each delegate's
	// differ only in whose session they serve: a non-main core saves nothing and never settles, ends or reminds.
	type Caller = { core: KataCore; ctx: HostContext; planner: Planner };
	function callerOf(sessionID: string, saved: SavedEntry[], delegateStore: DelegateStore): Caller {
		const main = sessionID === id;
		const core = createKataCore({
			exec: (file, args, { ctx, ...options }) => deps.exec(ctx?.sessionManager?.getSessionId?.() ?? id, file, args, options),
			appendEntry: main ? appendEntry : () => {},
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
			wording: WORDING,
		});
		const ctx = contextOf(sessionID, saved, !main);
		const planner: Planner = {
			id: sessionID,
			batch: fn => core.todo.batch(ctx, fn),
			async todo(op, params = {}) {
				const result = await core.todo.apply(ctx, op, params);
				return { text: result.content.map(part => part.text).join("\n"), kata: result.details.kata, isError: result.isError === true };
			},
		};
		return { core, ctx, planner };
	}
	const { core, ctx, planner } = callerOf(id, entries, delegates);

	const ready = planner.todo("view").then(() => undefined, debug);

	const delegateCallers = new Map<string, Caller>();
	function delegateCaller(sessionID: string): Caller {
		let known = delegateCallers.get(sessionID);
		if (!known) {
			// Only the lead's core settles delegates, inside its own queue: this core sees its own record and no list of the others.
			// Its state is the lead's record and the delegate's Kata issue: nothing of this core is saved.
			const own: DelegateStore = {
				records: () => [],
				get: key => key === sessionID ? records.get(key) : undefined,
				put: record => delegates.put(record),
				of: () => records.get(sessionID),
			};
			delegateCallers.set(sessionID, known = callerOf(sessionID, [], own));
		}
		return known;
	}

	// Whether storage records this lead as an ended session: unknown until read once.
	let flagged: boolean | undefined;
	// One end at a time. A change saved while it runs may be later than its last look at the core, so it ends once more.
	let ending: Promise<boolean> | undefined;
	function end(): Promise<boolean> {
		return ending ??= (async () => {
			await ready;
			changed = false;
			owing = await core.session.end(ctx);
			await writes;
			if (owing) {
				await storage.setEnded(id, true);
				flagged = true;
				return false;
			}
			ended = true;
			for (const sessionID of records.keys()) await storage.clear(sessionID);
			await storage.clear(id);
			deps.forget();
			return true;
		})().finally(() => {
			ending = undefined;
			if (changed) void endAgain().catch(debug);
		});
	}
	// The work an ended lead still owed may be done: it ends again, once OpenCode confirms its session is still ended. A
	// session that is back is no ended session any more. Not while the instance goes away: the next setup looks again.
	async function endAgain() {
		if (!owing || ending || suspended) return;
		const fate = await deps.fate();
		if (fate === "alive" || !suspended) await revive(fate);
	}
	async function revive(fate: Fate) {
		if (fate === "alive") await clearEnded();
		else if (fate === "gone" || (fate === "archived" && (flagged ??= await storage.ended(id)))) await end();
	}
	async function clearEnded() {
		if (flagged === false) return;
		owing = false;
		if (await storage.ended(id)) await storage.setEnded(id, false);
		flagged = false;
	}

	return {
		...planner,
		get ready() { return waitAtMost(ready, READY_MS, debug).then(() => undefined); },
		async planSection() {
			await waitAtMost(ready, READY_MS, debug);
			return (await core.session.beforePrompt(ctx, { context: false })).sections.todo;
		},
		child(sessionID) {
			const record = records.get(sessionID);
			return { teammate: record?.teammate ?? teammateFor(sessionID, id), record, assignment: core.delegates.assignment(contextOf(sessionID, [], true)) };
		},
		delegatePlan: sessionID => delegateCaller(sessionID).planner,
		checkSpawn: (call, text) => core.todo.batch(ctx, async () => { await core.delegates.check([text], call); }),
		releaseSpawn: call => core.delegates.release(call),
		began: (sessionID, spawn) => core.delegates.start({ id: sessionID, sessionId: sessionID, leadSessionId: id, ...spawn }),
		delegateEvent: event => core.delegates.apply(event),
		async assignmentSection(sessionID, after) {
			const own = delegateCaller(sessionID);
			return (await own.core.session.beforePrompt(own.ctx, { context: false, after })).sections.assignment;
		},
		async settle() {
			await ready;
			await core.session.settle(ctx);
			await writes;
		},
		end,
		revive,
		async suspend() {
			suspended = true;
			await ready;
			await core.session.shutdown(ctx, { continues: true });
			await writes;
		},
	};
}
