import type { SavedDelegate } from "./delegates";
import type { SettlementSnapshot } from "./settlement";

// `ctx.storage` is one key-value store per plugin id, shared by every location and kept across server restarts, so every
// key here is `session/<sessionID>/<part>`. Parts in use: `entries` (the core's saved state, written by lead.ts) and
// `accepted` (the contents of the last todowrite list Kata accepted) and `settled` (the delegate records that ended with
// an issue, kept so a later follow-up still finds its issue) and `ended` (an ended session: deleted or archived with work
// left, which the next setup finishes before it forgets the session; cleared when the session is seen alive again).
// Another module adds its own part name.
// The core's state entry: `io.kata.<namespace>.state`, written by the core with the pending closes and unfinished delegates.
const STATE_ENTRY = "io.kata.opencode.state";
export type SavedEntry = { type: "custom"; customType: string; data: unknown };
export type SavedSession = { directory: string; entries: SavedEntry[] };

// What the core saved in its state entry. This is the one reader of it.
export type CoreState = Partial<SettlementSnapshot> & { delegates?: SavedDelegate[] };
export const coreState = (entries: SavedEntry[]): CoreState | undefined => entries.find(entry => entry.customType === STATE_ENTRY)?.data as CoreState | undefined;
// Whether a resumed lead has closes or delegates to finish: what a new instance binds a saved lead for.
export function holdsWork(entries: SavedEntry[]): boolean {
	const state = coreState(entries);
	return !!(state?.retries?.length || state?.pendingCloses?.length || state?.delegates?.length);
}

export interface SessionStorage {
	get<T>(sessionID: string, part: string): Promise<T | undefined>;
	set(sessionID: string, part: string, value: unknown): Promise<void>;
	remove(sessionID: string, part: string): Promise<void>;
	// Every part of the session.
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
