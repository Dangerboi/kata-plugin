import { appendFileSync } from "node:fs";
import { createLead, type Lead } from "./lead";
import { sessionStorage, type SavedSession, type SessionStorage } from "./saved";
import { createKataExec, type KataExec } from "./spawn";
import type { Settings } from "./settings";

// The adapter's internal seam: what kata.ts hands to every module that adds behaviour to one plugin instance (an instance
// is one location). A module is a file exporting `install(seam: Seam): void`; kata.ts calls it once, after its own handlers
// are registered, so a module's handlers run after the adapter's. Today's modules: todowrite.ts. Next: subagent binding and
// shell routing, each in its own file, each wired by one `import` and one `install(seam)` line in the `MODULES` list of kata.ts.
//
// OpenCode serves many sessions from one process and one plugin instance per location. A session is a lead (no
// `parentID`) or a delegate's child session; only leads have a core (see Lead in lead.ts).
export interface Seam {
	readonly ctx: any;
	readonly directory: string;
	readonly settings: Settings;
	// Kata, run for a session: a `close` carries that session's transcript pair in the environment of this call.
	readonly exec: KataExec;
	// Per-session keys in `ctx.storage` (see saved.ts for the parts in use).
	readonly storage: SessionStorage;
	debug(error: unknown): void;
	// The session as OpenCode reports it, asked once. Undefined when it cannot be read (deleted).
	sessionOf(sessionID: string): Promise<SessionInfo | undefined>;
	// The lead a session belongs to: itself, or the lead above a delegate's child session. Created at first use.
	leadOf(sessionID: string): Promise<Lead | undefined>;
	// This lead session's record, when this instance holds it or storage has state saved for it in this location. Never creates one.
	savedLead(leadID: string): Promise<Lead | undefined>;
	// The lead session ended: `lead.end()`, then this instance forgets it.
	endLead(leadID: string): Promise<void>;

	// Handlers run in registration order. A throw in `before` ends the tool call as an error (the call does not run);
	// a throw anywhere else is logged to the debug file and skipped.
	// `execute.before`: `event` is `{ tool, sessionID, id, messageID, agent, input }`; the handler may replace `event.input`.
	before(handler: (event: any) => void | Promise<void>): void;
	// `execute.after`: `event` is `{ tool, sessionID, id, input, status, result | error }`.
	after(handler: (event: any) => void | Promise<void>): void;
	// The `context` hook: `event` is the session context (`sessionID`, `messages`, `system`, ...). `first`: this instance's first
	// context hook for the session (OpenCode's own `first` flag is not part of the contract, so it is tracked here).
	context(handler: (event: any, info: { first: boolean }) => void | Promise<void>): void;
	// Events of the given types (`session.execution.*`, `session.deleted`, ...) from `ctx.event.subscribe`; `event.data` holds the payload.
	// The stream consumer finishes one event before it takes the next.
	events(types: readonly string[], handler: (event: { type: string; data: any }) => void | Promise<void>): void;
}

export interface SessionInfo {
	id: string;
	parentID?: string;
}

// What kata.ts needs on top of the Seam: the dispatchers it registers with OpenCode, and the lifecycle.
export interface SeamRegistry {
	seam: Seam;
	hooks: {
		before(event: any): Promise<void>;
		after(event: any): Promise<void>;
		context(event: any): Promise<void>;
	};
	// Every event type some handler asked for, and the dispatcher for events of them.
	eventTypes(): string[];
	dispatchEvent(event: any): Promise<void>;
	// Binds every lead of this location with saved closes or delegates waiting, so that work resumes without a hook.
	resumeSaved(): Promise<void>;
	// The instance is going away: every lead drains what fits and keeps the rest saved.
	suspendAll(): Promise<void>;
}

const MAX_DEPTH = 8;
// The core entry holding a lead's pending closes and unfinished delegates (`io.kata.<namespace>.state`, written by the core).
const STATE_ENTRY = "io.kata.opencode.state";

export function createSeam(ctx: any, settings: Settings): SeamRegistry {
	const directory: string = ctx.location.directory;
	const debug = (error: unknown) => {
		if (!settings.debugFile) return;
		try { appendFileSync(settings.debugFile, `${new Date().toISOString()} ${String(error)}\n`); } catch { /* Debugging must never interrupt work. */ }
	};
	const exec = createKataExec(settings);
	const storage = sessionStorage(ctx.storage);
	const sessions = new Map<string, Promise<SessionInfo | undefined>>();
	const leads = new Map<string, Lead>();
	const contextSeen = new Set<string>();
	const handlers = {
		before: [] as ((event: any) => void | Promise<void>)[],
		after: [] as ((event: any) => void | Promise<void>)[],
		context: [] as ((event: any, info: { first: boolean }) => void | Promise<void>)[],
		events: [] as { types: readonly string[]; handler: (event: any) => void | Promise<void> }[],
	};

	function sessionOf(sessionID: string): Promise<SessionInfo | undefined> {
		let known = sessions.get(sessionID);
		if (!known) {
			known = Promise.resolve(ctx.session.get({ sessionID })).then(
				(session: any) => ({ id: sessionID, ...(typeof session?.parentID === "string" ? { parentID: session.parentID } : {}) }),
				error => { debug(error); sessions.delete(sessionID); return undefined; });
			sessions.set(sessionID, known);
		}
		return known;
	}

	function leadFor(id: string, saved?: SavedSession): Lead {
		let lead = leads.get(id);
		if (!lead) leads.set(id, lead = createLead({ id, directory: saved?.directory ?? directory, settings, exec, storage, saved, debug }));
		return lead;
	}

	// What an earlier instance saved for the lead in this location: a lead resumes from it, never from scratch.
	async function savedState(leadID: string): Promise<SavedSession | undefined> {
		const saved = await storage.get<SavedSession>(leadID, "entries");
		return saved && saved.directory === directory ? saved : undefined;
	}

	async function leadOf(sessionID: string): Promise<Lead | undefined> {
		let info = await sessionOf(sessionID);
		for (let depth = 0; info?.parentID !== undefined && depth < MAX_DEPTH; depth++) info = await sessionOf(info.parentID);
		if (!info || info.parentID !== undefined) return undefined;
		return leads.get(info.id) ?? leadFor(info.id, await savedState(info.id));
	}

	async function savedLead(leadID: string): Promise<Lead | undefined> {
		const held = leads.get(leadID);
		if (held) return held;
		const saved = await savedState(leadID);
		return saved && leadFor(leadID, saved);
	}

	async function endLead(leadID: string): Promise<void> {
		const lead = await savedLead(leadID);
		if (!lead) return;
		await lead.end();
		leads.delete(leadID);
	}

	const seam: Seam = {
		ctx, directory, settings, exec, storage, debug, sessionOf, leadOf, savedLead, endLead,
		before: handler => void handlers.before.push(handler),
		after: handler => void handlers.after.push(handler),
		context: handler => void handlers.context.push(handler),
		events: (types, handler) => void handlers.events.push({ types, handler }),
	};

	// Hooks run one after another on the one event object; a failing `before` handler refuses the call.
	const run = async (list: ((event: any) => void | Promise<void>)[], event: any, swallow: boolean) => {
		for (const handler of list) {
			try { await handler(event); }
			catch (error) { if (!swallow) throw error; debug(error); }
		}
	};

	return {
		seam,
		hooks: {
			before: event => run(handlers.before, event, false),
			after: event => run(handlers.after, event, true),
			async context(event) {
				const first = !contextSeen.has(event.sessionID);
				contextSeen.add(event.sessionID);
				await run(handlers.context.map(handler => (e: any) => handler(e, { first })), event, true);
			},
		},
		eventTypes: () => [...new Set(handlers.events.flatMap(entry => entry.types))],
		dispatchEvent: event => run(handlers.events.filter(entry => entry.types.includes(event.type)).map(entry => entry.handler), event, true),
		async resumeSaved() {
			for (const { id, saved } of await storage.sessions()) {
				if (saved.directory !== directory) continue;
				const state = saved.entries.find(entry => entry.customType === STATE_ENTRY)?.data as { retries?: unknown[]; pendingCloses?: unknown[]; delegates?: unknown[] } | undefined;
				if (state?.retries?.length || state?.pendingCloses?.length || state?.delegates?.length) leadFor(id, saved);
			}
		},
		async suspendAll() {
			await Promise.all([...leads.values()].map(lead => lead.suspend().catch(debug)));
		},
	};
}
