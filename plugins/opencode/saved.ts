import { snapshotEntry, type Snapshot } from "./kata-core";

// `ctx.storage` is one key-value store per plugin id, shared by every location and kept across server restarts, so every
// key here is `session/<sessionID>/<part>`. Parts in use: `entries` (the core's saved state, written by lead.ts) and
// `accepted` (the contents of the last todowrite list Kata accepted) and `ended` (an ended session: deleted or archived
// with work left, which the next setup finishes before it forgets the session; cleared when the session is seen alive again).
// Another module adds its own part name.
// The namespace of this adapter's cores: it names their saved entries and their Kata metadata keys.
export const NAMESPACE = "opencode";
export type SavedEntry = { type: "custom"; customType: string; data: unknown };
export type SavedSession = { directory: string; entries: SavedEntry[] };

// What the core saved for the session: its latest snapshot, with the pending closes and the unfinished delegates.
export const coreState = (entries: SavedEntry[]): Partial<Snapshot> | undefined => entries.find(entry => entry.customType === snapshotEntry(NAMESPACE))?.data as Partial<Snapshot> | undefined;

export interface SessionStorage {
	get<T>(sessionID: string, part: string): Promise<T | undefined>;
	set(sessionID: string, part: string, value: unknown): Promise<void>;
	remove(sessionID: string, part: string): Promise<void>;
	clear(sessionID: string): Promise<void>;
	// The leads this storage holds saved state for (any location: compare `directory`).
	sessions(): Promise<{ id: string; saved: SavedSession }[]>;
}

const PREFIX = "session/";

export function sessionStorage(storage: any): SessionStorage {
	const key = (sessionID: string, part: string) => `${PREFIX}${sessionID}/${part}`;
	async function scan(prefix: string): Promise<{ key: string; value: any }[]> {
		const rows: { key: string; value: any }[] = [];
		for (let after: string | undefined; ;) {
			const page = await storage.scan({ prefix, ...(after ? { after } : {}), limit: 1000 });
			rows.push(...page.entries);
			if (!page.next) return rows;
			after = page.next;
		}
	}
	return {
		get: (sessionID, part) => storage.get(key(sessionID, part)),
		set: (sessionID, part, value) => storage.set(key(sessionID, part), value),
		remove: (sessionID, part) => storage.remove(key(sessionID, part)),
		async clear(sessionID) {
			for (const row of await scan(`${PREFIX}${sessionID}/`)) await storage.remove(row.key);
		},
		async sessions() {
			return (await scan(PREFIX)).flatMap(row => {
				const match = /^session\/([^/]+)\/entries$/.exec(row.key);
				return match && typeof row.value?.directory === "string" && Array.isArray(row.value.entries) ? [{ id: match[1], saved: row.value as SavedSession }] : [];
			});
		},
	};
}
