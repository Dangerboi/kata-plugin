import type { EngineInterface } from "claude-code";
import { holdsWork, savedSnapshot, withEntry, type SavedEntry } from "../core/kata-core";
import { NAMESPACE } from "./settings";

// `$.store` is one JSON file for every Claude session on the machine, 4 MiB in all, and reading then writing a key is not
// atomic. So each session keeps everything it saves under one key of its own, `session/<id>`, which only that session
// writes, and ended sessions are pruned at the next start.

type SavedSession = {
	// The core's latest entry of each type (its snapshot and its parent binding).
	entries: SavedEntry[];
	updatedAt: number;
	// Set when the process ended the session: nothing more runs in it unless it is resumed.
	endedAt?: number;
};

const PREFIX = "session/";
const keyOf = (id: string) => `${PREFIX}${id}`;
// An ended session is kept this long (a resume finishes what it owed); any session untouched this long is dropped.
const ENDED_KEEP_MS = 7 * 86_400_000;
const STALE_MS = 30 * 86_400_000;
// Pruning also keeps the saved sessions together under this many bytes of JSON (counted as UTF-8, as the store holds them), well inside the store's 4 MiB.
const STORE_BUDGET = 2 * 1024 * 1024;
const encoder = new TextEncoder();

export async function loadSession($: EngineInterface, id: string): Promise<SavedSession | undefined> {
	const value = (await $.store.get(keyOf(id))) as Partial<SavedSession> | undefined;
	return value && Array.isArray(value.entries) ? (value as SavedSession) : undefined;
}

// `debug` gets the errors of a write: a record that was not saved must not fail the call that changed it. `saved`: the
// session's record when it has one; `seed`: the entries a fork copies from its source when it has none.
export function sessionWriter($: EngineInterface, id: string, now: () => Promise<number>, debug: (error: unknown) => void, saved: SavedSession | undefined, seed?: readonly SavedEntry[]) {
	const record: SavedSession = saved ? structuredClone(saved) : { entries: seed ? structuredClone([...seed]) : [], updatedAt: 0 };
	let writing: Promise<unknown> = Promise.resolve();
	// Set by `end`: a write that lands later (a job of the session still queued) leaves the record ended.
	let endedAt: number | undefined;
	const flush = () => {
		const body = structuredClone(record);
		writing = writing
			.then(async () => {
				body.updatedAt = await now();
				await $.store.set(keyOf(id), body);
			})
			.catch(debug);
		return writing;
	};
	return {
		get entries() {
			return record.entries;
		},
		append(customType: string, data: unknown) {
			record.entries = withEntry(record.entries, customType, data);
			if (endedAt === undefined) delete record.endedAt;
			else record.endedAt = endedAt;
			void flush();
		},
		// The session ended. `owed`: the core still owes closes; a plan with open tasks keeps the record too, for a resume.
		// Else its record goes.
		async end(owed: boolean) {
			const at = await now();
			endedAt = at;
			if (owed || holdsWork(savedSnapshot(record.entries, NAMESPACE))) {
				record.endedAt = at;
				await flush();
			} else {
				await writing;
				await $.store.delete(keyOf(id));
			}
		},
		settled: () => writing
	};
}

// Drops what no later start can use: records past their keep time, then, oldest first, while the store is over budget: ended
// sessions that owe nothing, then ended ones that owe work, then ones that never ended (a killed process). A session that owes
// work is otherwise kept until it is stale, but a store over its limit fails the current session's saves, which costs more
// than an old session's debts; a session still running elsewhere writes its whole record again at its next change.
// The session `except` (the one starting) stays.
export async function pruneSessions($: EngineInterface, now: number, except?: string): Promise<number> {
	const rows: { key: string; at: number; ended: boolean; owing: boolean; size: number }[] = [];
	for (const key of (await $.store.keys()).filter(key => key.startsWith(PREFIX) && key !== keyOf(except ?? ""))) {
		const record = (await $.store.get(key)) as Partial<SavedSession> | undefined;
		if (!record || !Array.isArray(record.entries)) {
			rows.push({ key, at: 0, ended: true, owing: false, size: 0 });
			continue;
		}
		const owing = holdsWork(savedSnapshot((record as SavedSession).entries, NAMESPACE));
		const at = record.endedAt ?? record.updatedAt ?? 0;
		const expired = record.endedAt !== undefined ? now - at > (owing ? STALE_MS : ENDED_KEEP_MS) : now - at > STALE_MS;
		rows.push({ key, at: expired ? 0 : at, ended: record.endedAt !== undefined, owing, size: encoder.encode(JSON.stringify(record)).length });
	}
	const dropped = new Set(rows.filter(row => row.at === 0).map(row => row.key));
	let total = rows.filter(row => !dropped.has(row.key)).reduce((sum, row) => sum + row.size, 0);
	const tier = (row: (typeof rows)[number]) => (!row.ended ? 2 : row.owing ? 1 : 0);
	const evictable = rows.filter(row => !dropped.has(row.key)).sort((a, b) => tier(a) - tier(b) || a.at - b.at);
	for (const row of evictable) {
		if (total <= STORE_BUDGET) break;
		dropped.add(row.key);
		total -= row.size;
	}
	for (const key of dropped) await $.store.delete(key);
	return dropped.size;
}
