import { snapshotEntry, type Snapshot } from "./kata-core";

// `ctx.storage` is one key-value store per plugin id, shared by every location and kept across server restarts, so every
// key is `session/<sessionID>/<part>`. This file names the parts and is the only one that reads or writes them.

// The namespace of this adapter's cores: it names their saved entries and their Kata metadata keys.
export const NAMESPACE = "opencode";
export type SavedEntry = { type: "custom"; customType: string; data: unknown };
// The `entries` part: a lead's saved entries, and the folder of the location they belong to.
type SavedLead = { directory: string; entries: SavedEntry[] };

// What the core saved for the session: its latest snapshot, with the pending closes and the unfinished delegates.
export const coreState = (entries: SavedEntry[]): Partial<Snapshot> | undefined => entries.find(entry => entry.customType === snapshotEntry(NAMESPACE))?.data as Partial<Snapshot> | undefined;

export interface SessionStorage {
	// `entries`: what the core of a lead of this location saved. A lead resumes from it, never from scratch, and only in its own folder.
	entries(leadID: string): Promise<SavedEntry[] | undefined>;
	saveEntries(leadID: string, entries: SavedEntry[]): Promise<void>;
	// The leads of this location that have saved entries.
	leads(): Promise<{ id: string; entries: SavedEntry[] }[]>;
	// `accepted`: the contents of the last todowrite list Kata accepted from the session (a lead, or a delegate planning under its issue).
	accepted(sessionID: string): Promise<string[]>;
	accept(sessionID: string, contents: string[]): Promise<void>;
	// `ended`: the lead ended (deleted or archived) with work left, which a later end finishes before the session is forgotten.
	// Cleared when the session is seen alive again.
	ended(leadID: string): Promise<boolean>;
	setEnded(leadID: string, ended: boolean): Promise<void>;
	// Forgets every part of the session.
	clear(sessionID: string): Promise<void>;
}

const PREFIX = "session/";
type Part = "entries" | "accepted" | "ended";
type Row = { key: string; value: unknown };
// The part of OpenCode's `ctx.storage` used here.
interface KeyValue {
	get(key: string): Promise<unknown>;
	set(key: string, value: unknown): Promise<void>;
	remove(key: string): Promise<void>;
	scan(input: { prefix: string; after?: string; limit: number }): Promise<{ entries: Row[]; next?: string }>;
}

export function sessionStorage(storage: KeyValue, directory: string): SessionStorage {
	const key = (sessionID: string, part: Part) => `${PREFIX}${sessionID}/${part}`;
	// The entries of a saved lead, when they are this location's.
	const here = (value: unknown) => {
		const saved = value as Partial<SavedLead> | undefined;
		return saved?.directory === directory && Array.isArray(saved.entries) ? saved.entries : undefined;
	};
	async function scan(prefix: string): Promise<Row[]> {
		const rows: Row[] = [];
		for (let after: string | undefined; ;) {
			const page = await storage.scan({ prefix, ...(after ? { after } : {}), limit: 1000 });
			rows.push(...page.entries);
			if (!page.next) return rows;
			after = page.next;
		}
	}
	return {
		entries: async leadID => here(await storage.get(key(leadID, "entries"))),
		saveEntries: (leadID, entries) => storage.set(key(leadID, "entries"), { directory, entries } satisfies SavedLead),
		async leads() {
			return (await scan(PREFIX)).flatMap(row => {
				const [id, part, ...deeper] = row.key.slice(PREFIX.length).split("/");
				const entries = part === ("entries" satisfies Part) && !deeper.length ? here(row.value) : undefined;
				return id && entries ? [{ id, entries }] : [];
			});
		},
		accepted: async sessionID => (await storage.get(key(sessionID, "accepted")) as string[] | undefined) ?? [],
		accept: (sessionID, contents) => storage.set(key(sessionID, "accepted"), contents),
		ended: async leadID => !!await storage.get(key(leadID, "ended")),
		setEnded: (leadID, ended) => ended ? storage.set(key(leadID, "ended"), true) : storage.remove(key(leadID, "ended")),
		async clear(sessionID) {
			for (const row of await scan(`${PREFIX}${sessionID}/`)) await storage.remove(row.key);
		},
	};
}
