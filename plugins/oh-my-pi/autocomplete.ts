import { isKataCode, type Kata } from "./kata-cli";

// `#` ticket completion in the host's editor: the provider wrapper and the per-session ticket lists it reads.

export type Ticket = { short_id: string; title: string; qualified_id: string };
type Suggestions = { items: { value: string; label: string; description?: string }[]; prefix: string } | null;
// Structural slice of omp's and pi's autocomplete provider; both hosts share it.
export interface TicketAutocompleteProvider {
	// omp passes the AbortSignal itself plus onPartial; pi passes `{ signal, force }`.
	getSuggestions(lines: string[], cursorLine: number, cursorCol: number, signal?: AbortSignal | { signal?: AbortSignal }, onPartial?: (suggestions: NonNullable<Suggestions>) => void): Promise<Suggestions>;
	applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: { value: string; label: string }, prefix: string): { lines: string[]; cursorLine: number; cursorCol: number };
	// pi only: characters that open the menu, and a veto for file completion.
	triggerCharacters?: string[];
	shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
}

// `#<token>` or `#<project>#<token>` ending at the cursor, after a token boundary
// (the set omp's own `#` completion uses, so `C#12` and URL fragments stay untouched).
const TICKET_TOKEN = /(?:^|[\s"'`(<=])#(?:([^\s#]+)#)?([^\s#]*)$/;
const TICKET_LIMIT = 10;

/**
 * Wraps the host's provider: it always runs, and tickets from `source` whose short
 * id starts with the token or whose title has a word starting with it are appended
 * to its items. A digits-only `#1234` stays GitHub's; `#project#1234` reaches an
 * all-digit Kata id. `source(undefined)` is the folder's bound project. Typing never
 * waits on Kata: an abort, a timeout or a failing source leaves the wrapped items.
 */
export function ticketAutocomplete(current: TicketAutocompleteProvider, source: (project?: string) => Promise<Ticket[]>, options: { defaultProject?: string; timeout?: number } = {}): TicketAutocompleteProvider {
	const ours = new Set<string>();
	async function search(project: string | undefined, token: string, signal: AbortSignal | undefined): Promise<Ticket[]> {
		let resolve!: (value: undefined) => void;
		const gone = new Promise<undefined>(done => { resolve = done; });
		const timer = setTimeout(resolve, options.timeout ?? 400);
		const onAbort = () => resolve(undefined);
		if (signal?.aborted) resolve(undefined); else signal?.addEventListener("abort", onAbort);
		try {
			const all: Ticket[] | undefined = await Promise.race([source(project).catch(() => undefined), gone]);
			const wanted = token.toLowerCase();
			const idMatches = (all ?? []).filter(t => t.short_id.toLowerCase().startsWith(wanted));
			const titleMatches = (all ?? []).filter(t => !idMatches.includes(t) && t.title.toLowerCase().split(/[^\p{L}\p{N}]+/u).some(word => word.startsWith(wanted)));
			return [...idMatches, ...titleMatches];
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	}
	return {
		triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), "#"])],
		shouldTriggerFileCompletion: current.shouldTriggerFileCompletion?.bind(current),
		async getSuggestions(lines, cursorLine, cursorCol, hostOptions, onPartial) {
			const inner = current.getSuggestions(lines, cursorLine, cursorCol, hostOptions, onPartial);
			const signal = hostOptions instanceof AbortSignal ? hostOptions : hostOptions?.signal;
			const match = (lines[cursorLine] ?? "").slice(0, cursorCol).match(TICKET_TOKEN);
			const project = match?.[1], token = match?.[2] ?? "";
			if (!match || (!project && (!token || /^\d+$/.test(token)))) return inner;
			const projects = project ? [project] : [undefined, ...(options.defaultProject ? [options.defaultProject] : [])];
			const [base, ...found] = await Promise.all([inner, ...projects.map(p => search(p, token, signal))]);
			const seen = new Set<string>();
			const tickets = found.flat().filter(t => !seen.has(t.qualified_id) && !!seen.add(t.qualified_id)).slice(0, TICKET_LIMIT);
			if (!tickets.length) return base;
			const prefix = match[0].startsWith("#") ? match[0] : match[0].slice(1);
			if (base?.items.length && base.prefix !== prefix) return base; // one list needs one prefix
			for (const t of tickets) ours.add(t.qualified_id);
			return { prefix, items: [...(base?.items ?? []), ...tickets.map(t => ({ value: t.qualified_id, label: `${t.short_id} ${t.title}`, description: t.qualified_id }))] };
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (!ours.has(item.value)) return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			const line = lines[cursorLine] ?? "";
			const start = cursorCol - prefix.length;
			const inserted = `${item.value} `;
			const next = line.slice(0, start) + inserted + line.slice(cursorCol);
			return { lines: lines.map((l, i) => i === cursorLine ? next : l), cursorLine, cursorCol: start + inserted.length };
		},
	};
}

// Open issues per project for ticket autocomplete: one list per session, served
// from cache and refreshed in the background. Only the first load, or a load
// after a failure, is awaited; the caller bounds that wait.
const TICKET_STALE = 30_000, TICKET_RETRY = 5_000;

// Adds ticket completion to each editor once: omp rebuilds its stack from every registered factory, and a
// session start runs again on every session switch.
export function createTicketCompletion(kata: Kata, scope: () => { session?: string; cwd: string }, debug: (error: unknown) => void) {
	const ticketLists = new Map<string, { at: number; tickets: Ticket[]; pending?: Promise<void>; failedAt?: number; error?: unknown }>();
	function tickets(project?: string): Promise<Ticket[]> {
		const { session, cwd } = scope();
		const key = `${session ?? ""}\0${cwd}\0${project ?? ""}`;
		let entry = ticketLists.get(key);
		if (!entry) ticketLists.set(key, entry = { at: 0, tickets: [] });
		const list = entry;
		if (list.failedAt && Date.now() - list.failedAt < TICKET_RETRY && !list.at) return Promise.reject(list.error);
		if (!list.pending && Date.now() - list.at > TICKET_STALE) {
			list.pending = kata.run(["list", "--limit", "1000", ...(project ? ["--project", project] : [])], cwd, { timeout: 5_000, workspace: !project }).then(out => {
				list.tickets = (JSON.parse(out).issues ?? []).map((i: Ticket) => ({ short_id: i.short_id, title: i.title, qualified_id: i.qualified_id }));
				list.at = Date.now(); delete list.failedAt;
			}, error => {
				// An unregistered folder simply has no bound project to list.
				if (isKataCode(error, "project_not_initialized")) { list.at = Date.now(); list.tickets = []; return; }
				debug(error);
				list.failedAt = Date.now(); list.error = error;
				if (list.at) list.at = Date.now() - TICKET_STALE + TICKET_RETRY; // keep serving the old list, retry soon
			}).finally(() => { list.pending = undefined; });
		}
		if (list.at) return Promise.resolve(list.tickets);
		return list.pending!.then(() => list.at ? list.tickets : Promise.reject(list.error));
	}
	const offered = new WeakSet<object>();
	return (ui: { addAutocompleteProvider?(factory: (current: any) => TicketAutocompleteProvider): void } | undefined) => {
		if (!ui?.addAutocompleteProvider || offered.has(ui)) return;
		offered.add(ui);
		ui.addAutocompleteProvider(current => ticketAutocomplete(current, tickets, { defaultProject: process.env.KATA_DEFAULT_PROJECT?.trim() || undefined }));
	};
}
