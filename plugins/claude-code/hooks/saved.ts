import { owes, snapshotEntry, type Snapshot } from "../core/kata-core";
import { OPEN } from "../core/model";
import type { Engine } from "./engine";

// `$.store` is one JSON file for every Claude session on the machine, 4 MiB in all, and reading then writing a key is not
// atomic. So each session keeps everything it saves under one key of its own, `session/<id>`, which only that session
// writes, and ended sessions are pruned at the next start.

export const NAMESPACE = "claude";
export type SavedEntry = { type: "custom"; customType: string; data: unknown };
export type SavedSession = {
	directory: string;
	// The core's latest entry of each type (its snapshot and its parent binding).
	entries: SavedEntry[];
	updatedAt: number;
	// Set when the process ended the session: nothing more runs in it unless it is resumed.
	endedAt?: number;
};

const PREFIX = "session/";
export const keyOf = (id: string) => `${PREFIX}${id}`;
// An ended session is kept this long (a resume finishes what it owed); any session untouched this long is dropped.
export const ENDED_KEEP_MS = 7 * 86_400_000;
export const STALE_MS = 30 * 86_400_000;
// Pruning also keeps the saved sessions together under this many bytes of JSON, well inside the store's 4 MiB.
export const STORE_BUDGET = 2 * 1024 * 1024;

export const coreState = (saved: SavedSession | undefined): Partial<Snapshot> | undefined =>
	saved?.entries.find(entry => entry.customType === snapshotEntry(NAMESPACE))?.data as Partial<Snapshot> | undefined;

// Whether a saved session has work a resume would take up: what the core owes (closes, delegates) or a plan that still has
// open tasks, whatever holds it (an automatic parent, an explicit one, named tickets or a session-local plan).
export const hasWork = (snapshot: Partial<Snapshot> | undefined): boolean =>
	owes(snapshot) || [...(snapshot?.plan?.tasks ?? []), ...(snapshot?.named ?? [])].some(task => OPEN.has(task.status));

export async function loadSession($: Engine, id: string): Promise<SavedSession | undefined> {
	const value = (await $.store.get(keyOf(id))) as Partial<SavedSession> | undefined;
	return value && typeof value.directory === "string" && Array.isArray(value.entries) ? (value as SavedSession) : undefined;
}

// One session's saved record, written after each change the core appends, one write at a time.
export function sessionWriter($: Engine, id: string, now: () => Promise<number>) {
	let record: SavedSession | undefined;
	let writing: Promise<unknown> = Promise.resolve();
	const flush = () => {
		const body = structuredClone(record!);
		writing = writing
			.then(async () => {
				body.updatedAt = await now();
				await $.store.set(keyOf(id), body);
			})
			.catch(() => undefined);
		return writing;
	};
	return {
		// `seed`: the entries a fork copies from its source when it has no record of its own.
		start(saved: SavedSession | undefined, directory: string, seed?: readonly SavedEntry[]) {
			record = saved ? structuredClone(saved) : { directory, entries: seed ? structuredClone([...seed]) : [], updatedAt: 0 };
			record.directory = directory;
		},
		get entries() {
			return record?.entries ?? [];
		},
		append(customType: string, data: unknown) {
			if (!record) return;
			record.entries = [...record.entries.filter(entry => entry.customType !== customType), { type: "custom", customType, data: structuredClone(data) }];
			delete record.endedAt;
			void flush();
		},
		// The session ended. `owed`: the core still owes closes; a plan with open tasks keeps the record too, for a resume.
		// Else its record goes.
		async end(owed: boolean, at: number) {
			if (!record) return;
			if (owed || hasWork(coreState(record))) {
				record.endedAt = at;
				await flush();
				await writing;
			} else {
				await writing;
				await $.store.delete(keyOf(id));
			}
		},
		settled: () => writing
	};
}

// Drops what no later start can use: records past their keep time, then the oldest ended ones while the store is over budget.
// The session `except` (the one starting) stays. A session that owes closes or has open tasks is kept until it is stale, not just ended.
export async function pruneSessions($: Engine, now: number, except?: string): Promise<number> {
	const rows: { key: string; at: number; ended: boolean; size: number }[] = [];
	for (const key of (await $.store.keys()).filter(key => key.startsWith(PREFIX) && key !== keyOf(except ?? ""))) {
		const record = (await $.store.get(key)) as Partial<SavedSession> | undefined;
		if (!record || !Array.isArray(record.entries)) {
			rows.push({ key, at: 0, ended: true, size: 0 });
			continue;
		}
		const owing = hasWork(coreState(record as SavedSession));
		const at = record.endedAt ?? record.updatedAt ?? 0;
		const expired = record.endedAt !== undefined ? now - at > (owing ? STALE_MS : ENDED_KEEP_MS) : now - at > STALE_MS;
		rows.push({ key, at: expired ? 0 : at, ended: record.endedAt !== undefined, size: JSON.stringify(record).length });
	}
	const dropped = new Set(rows.filter(row => row.at === 0).map(row => row.key));
	let total = rows.filter(row => !dropped.has(row.key)).reduce((sum, row) => sum + row.size, 0);
	for (const row of rows.filter(row => row.ended && !dropped.has(row.key)).sort((a, b) => a.at - b.at)) {
		if (total <= STORE_BUDGET) break;
		dropped.add(row.key);
		total -= row.size;
	}
	for (const key of dropped) await $.store.delete(key);
	return dropped.size;
}
