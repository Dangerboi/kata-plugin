import { appendFileSync } from "node:fs";
import { waitAtMost } from "./wait-at-most";
import { createLead, type Child, type Lead } from "./lead";
import { owes } from "./kata-core";
import { coreState, sessionStorage, type SavedEntry, type SessionStorage } from "./saved";
import type { DelegateOutcome } from "./delegates";
import { createKataExec } from "./spawn";
import type { Settings } from "./settings";

// A session's run ended (its turn, for a lead), and how, as a delegate's outcome.
export const EXECUTION_ENDED: Readonly<Record<string, DelegateOutcome>> = {
	"session.execution.succeeded": "completed",
	"session.execution.failed": "failed",
	"session.execution.interrupted": "aborted",
};
// The session itself ended: nothing more runs in it unless it is unarchived.
export const SESSION_ENDED = ["session.deleted", "session.archived"] as const;

// What a session is to this instance. OpenCode serves many sessions from one process and one plugin instance per location;
// only leads have a core (see Lead in lead.ts).
export type Role =
	// A session with no parent.
	| { kind: "lead"; lead: Lead }
	// A child session, and what the lead at the root of its parents knows of it (see Child): it is a delegate once it has a record.
	| ({ kind: "delegate"; lead: Lead } & Child)
	// A session that cannot be read, or whose lead cannot be.
	| { kind: "other" };

// A `before` handler's deliberate refusal of the tool call: the call ends as an error with this message.
export class CallRefused extends Error {}

// The adapter's internal seam: what kata.ts hands to every module that adds behaviour to one plugin instance (an instance
// is one location). A module is a file exporting `install(seam: Seam): void`; kata.ts calls it once, after its own handlers
// are registered, so a module's handlers run after the adapter's. A new module is wired by one `import` and one
// `install(seam)` line in the `MODULES` list of kata.ts.
export interface Seam {
	readonly ctx: any;
	readonly settings: Settings;
	readonly storage: SessionStorage;
	debug(error: unknown): void;
	// The session's role, for a hook or tool call of a running session: OpenCode is asked about a session once, and a lead's
	// core is created at first use. Rejects when storage cannot be read.
	roleOf(sessionID: string): Promise<Role>;
	// The session's role, for an event about a session that may be gone or may never have run here: only what this instance
	// and its storage hold. A lead with nothing saved, and a child no lead in memory tracks, are `other`. Never creates a lead
	// from scratch.
	knownRole(sessionID: string): Promise<Role>;

	// Handlers run in registration order. A `before` handler that throws CallRefused ends the tool call as an error (the
	// call does not run); any other throw, in any handler, is logged to the debug file and skipped, so a failed lookup never
	// fails a session's call.
	// `execute.before`: `event` is `{ tool, sessionID, id, messageID, agent, input }`; the handler may replace `event.input`.
	before(handler: (event: any) => void | Promise<void>): void;
	// `execute.after`: `event` is `{ tool, sessionID, id, input, status, result | error }`.
	after(handler: (event: any) => void | Promise<void>): void;
	// The `context` hook: `event` is the session context (`sessionID`, `messages`, `system`, ...). `first`: this instance's first
	// context hook for the session (OpenCode's own `first` flag is not part of the contract, so it is tracked here).
	context(handler: (event: any, info: { first: boolean }) => void | Promise<void>): void;
	// Session events of the given types (`session.execution.*`, `session.deleted`, ...) from `ctx.event.subscribe`. A
	// session's events are handled one after another, in the order they arrived; the events of other sessions do not wait
	// for them.
	events(types: readonly string[], handler: (event: SessionEvent) => void | Promise<void>): void;
}

// `created`: when OpenCode made the event, in milliseconds.
export interface SessionEvent {
	type: string;
	created?: number;
	data: { sessionID: string; [key: string]: unknown };
}

interface SessionInfo {
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
	// Every event type some handler asked for.
	eventTypes(): string[];
	// Queues an event behind the earlier events of its session and returns at once. An event that names no session is dropped.
	dispatchEvent(event: any): void;
	// Settles once every event dispatched so far is handled.
	eventsHandled(): Promise<void>;
	// Starts, in the background, the work an earlier instance left: binds every lead of this location with saved closes or delegates
	// waiting, and ends the saved sessions OpenCode no longer holds. Never waits for Kata; errors go to the debug file.
	resumeSaved(): void;
	// The instance is going away: every lead drains what fits and keeps the rest saved. Waits for the background resume, at most RESUME_WAIT_MS.
	suspendAll(): Promise<void>;
}

const MAX_DEPTH = 8;
// How long the instance's cleanup waits for the background resume before it suspends the leads.
const RESUME_WAIT_MS = 10_000;
const OTHER: Role = { kind: "other" };

// The instance set up with a `ctx`. For a caller that holds nothing of the plugin but that `ctx`: the tests' host, which
// waits for the events it emitted (OpenCode itself never waits for a plugin's event handlers).
const instances = new WeakMap<object, SeamRegistry>();
export const eventsHandled = (ctx: object): Promise<void> => instances.get(ctx)?.eventsHandled() ?? Promise.resolve();

export function createSeam(ctx: any, settings: Settings): SeamRegistry {
	const directory: string = ctx.location.directory;
	const debug = (error: unknown) => {
		if (!settings.debugFile) return;
		try { appendFileSync(settings.debugFile, `${new Date().toISOString()} ${String(error)}\n`); } catch { /* Debugging must never interrupt work. */ }
	};
	const exec = createKataExec(settings);
	const storage = sessionStorage(ctx.storage, directory);
	const sessions = new Map<string, Promise<SessionInfo | undefined>>();
	const leads = new Map<string, Lead>();
	const contextSeen = new Set<string>();
	const handlers = {
		before: [] as ((event: any) => void | Promise<void>)[],
		after: [] as ((event: any) => void | Promise<void>)[],
		context: [] as ((event: any, info: { first: boolean }) => void | Promise<void>)[],
		events: [] as { types: readonly string[]; handler: (event: SessionEvent) => void | Promise<void> }[],
	};

	// The session as OpenCode reports it, asked once. Undefined when it cannot be read (deleted).
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

	function leadFor(id: string, entries?: SavedEntry[]): Lead {
		const held = leads.get(id);
		if (held) return held;
		const lead: Lead = createLead({
			id, directory, settings, exec, storage, entries, debug,
			stillEnded: async () => ({ gone: true, archived: true, alive: false, unknown: undefined })[await openCodeSays(id)],
			forget: () => { if (leads.get(id) === lead) leads.delete(id); },
		});
		leads.set(id, lead);
		return lead;
	}

	async function roleOf(sessionID: string): Promise<Role> {
		const session = await sessionOf(sessionID);
		let root = session;
		for (let depth = 0; root?.parentID !== undefined && depth < MAX_DEPTH; depth++) root = await sessionOf(root.parentID);
		if (!session || !root || root.parentID !== undefined) return OTHER;
		const lead = leads.get(root.id) ?? leadFor(root.id, await storage.entries(root.id));
		return session === root ? { kind: "lead", lead } : { kind: "delegate", lead, ...lead.child(sessionID) };
	}

	async function knownRole(sessionID: string): Promise<Role> {
		const held = leads.get(sessionID);
		if (held) return { kind: "lead", lead: held };
		for (const lead of leads.values()) {
			const child = lead.child(sessionID);
			if (child.record) return { kind: "delegate", lead, ...child };
		}
		const entries = await storage.entries(sessionID);
		return entries ? { kind: "lead", lead: leadFor(sessionID, entries) } : OTHER;
	}

	// What OpenCode says of the session: "gone" (it no longer holds it), "archived", "alive", or "unknown" when the read failed otherwise.
	async function openCodeSays(sessionID: string): Promise<"alive" | "archived" | "gone" | "unknown"> {
		try {
			const session = await ctx.session.get({ sessionID });
			return typeof session?.time?.archived === "number" ? "archived" : "alive";
		} catch (error) {
			debug(error);
			// A session OpenCode no longer holds rejects with `Session.NotFoundError`
			// (see `packages/core/src/session/session.ts` in OpenCode).
			const tag = (error as { _tag?: string } | undefined)?._tag;
			return tag === "Session.NotFoundError" ? "gone" : "unknown";
		}
	}

	let stopped = false, resuming: Promise<unknown> = Promise.resolve();
	// One saved session, as OpenCode has it now. One it no longer holds ended, whether or not an instance saw that. An archived
	// one ended only when it was saved as an ended session: a session can run after its archive, and then it is alive. One
	// saved as ended that OpenCode holds alive was unarchived, so it is not finished.
	async function resumeOne(id: string, entries: SavedEntry[]) {
		const flagged = await storage.ended(id);
		const fate = await openCodeSays(id);
		if (flagged && fate === "alive") await storage.setEnded(id, false);
		const ended = fate === "gone" || (flagged && fate === "archived");
		// The instance stopped meanwhile: a lead made now would never be suspended.
		if (stopped || !(ended || (flagged && fate === "unknown") || owes(coreState(entries)))) return;
		const lead = leadFor(id, entries);
		// A session that ended finishes its work now, and forgets its state once nothing is left.
		if (ended) await lead.end();
	}

	const seam: Seam = {
		ctx, settings, storage, debug, roleOf, knownRole,
		before: handler => void handlers.before.push(handler),
		after: handler => void handlers.after.push(handler),
		context: handler => void handlers.context.push(handler),
		events: (types, handler) => void handlers.events.push({ types, handler }),
	};

	// Hooks run one after another on the one event object.
	const run = async <E>(list: ((event: E) => void | Promise<void>)[], event: E, refusable = false) => {
		for (const handler of list) {
			try { await handler(event); }
			catch (error) { if (refusable && error instanceof CallRefused) throw error; debug(error); }
		}
	};

	// The events of each session still to handle, as the promise of the last one.
	const queues = new Map<string, Promise<void>>();

	const registry: SeamRegistry = {
		seam,
		hooks: {
			before: event => run(handlers.before, event, true),
			after: event => run(handlers.after, event),
			async context(event) {
				const first = !contextSeen.has(event.sessionID);
				contextSeen.add(event.sessionID);
				await run(handlers.context.map(handler => (e: any) => handler(e, { first })), event);
			},
		},
		eventTypes: () => [...new Set(handlers.events.flatMap(entry => entry.types))],
		dispatchEvent(event) {
			const sessionID: unknown = event?.data?.sessionID;
			if (typeof sessionID !== "string" || !sessionID) return;
			const matching = handlers.events.filter(entry => entry.types.includes(event.type)).map(entry => entry.handler);
			const handled = (queues.get(sessionID) ?? Promise.resolve()).then(() => run(matching, event as SessionEvent));
			queues.set(sessionID, handled);
			void handled.then(() => { if (queues.get(sessionID) === handled) queues.delete(sessionID); });
		},
		async eventsHandled() {
			while (queues.size) await Promise.all(queues.values());
		},
		resumeSaved() {
			resuming = (async () => {
				await Promise.all((await storage.leads()).map(({ id, entries }) => resumeOne(id, entries).catch(debug)));
			})().catch(debug);
		},
		async suspendAll() {
			stopped = true;
			await waitAtMost(resuming, RESUME_WAIT_MS);
			await Promise.all([...leads.values()].map(lead => lead.suspend().catch(debug)));
		},
	};
	instances.set(ctx, registry);
	return registry;
}
