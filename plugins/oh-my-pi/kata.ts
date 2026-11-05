// Generated from root kata.ts by bun run build:plugins.
// omp-kata: Kata replaces oh-my-pi's todo tracker.
//
// Installing the plugin is the whole setup: omp lets an extension re-register a
// built-in tool by name, so this `todo` replaces the native one. Results keep the
// plan under details.kata (not details.phases), so omp's native todo tracker has
// nothing to remind or render. `todo.enabled: false` still works. This extension owns:
//   - the `todo` tool (same ops as omp's: init, start, done, drop, rm, block,
//     unblock, append, view), with every task stored as a Kata child issue;
//   - `/todo`, intercepted on input before omp's built-in command;
//   - a progress widget and a stop reminder while tasks remain open;
//   - cached Kata contracts, guarded main-session attention, and delegate identity.
//
// Plan items are children carrying `todo.phase`; other children participate in
// parent closure. A folder with no Kata project plans in KATA_DEFAULT_PROJECT
// (labeled with the repo) or in its inferred project, registered on first use.
// The plan is session-local only while Kata is unreachable, then it replays.

import { execFile, spawn } from "node:child_process";
import { closeSync, openSync, readSync } from "node:fs";
import { createInterface } from "node:readline";
import { createKataCore, DESCRIPTION, sessionKey, kataCommands as parseKataCommands, teammateFor, ticketAutocomplete, delegateCommand } from "./kata-core";
import type { DelegateEvent, DelegateRecord, DelegateStore, Reservation } from "./delegates";
import type { InboxStream } from "./inbox";

// What the lead's Delegates takes from an adapter other than the lead itself: a delegate's next use runs in the lead's queue.
type DelegateEvents = { apply(event: DelegateEvent): Promise<void> };

const EXECUTABLE = process.env.KATA_OMP_EXECUTABLE || "kata";
const EXECUTABLE_VARS = ["KATA_OMP_EXECUTABLE"];
export const kataCommands = (command: string) => parseKataCommands(command, EXECUTABLE, EXECUTABLE_VARS);

// What a task call asked for: names and texts per spawn; once a plan or ticket was seen, what each spawn is matched to.
// The entry goes once every spawn has started or the call failed.
type Assignment = { labels: string[]; texts: string[]; reserved?: (Reservation | undefined)[]; started: Set<number> };

// OMP rebinds extension factories in the same module graph, so every instance shares the delegate records and the lead
// Delegates that own them. A delegate's session file is the correlation key: agent names alone can collide across simultaneous sessions.
const recordsBySession = new Map<string, DelegateRecord>();
const leads = new Map<string, DelegateEvents>();
const SETTLED = new Set(["handed-back", "settled", "untracked"]);


// Runs Kata directly with the transcript identity in its environment. Like pi.exec, a non-zero exit or
// any spawn failure other than a missing executable is a result, a timeout or abort reports killed,
// and ENOENT rejects.
function execWithTranscript(file: string, args: string[], options: { cwd: string; timeout: number; signal?: AbortSignal }, agent: string, session: string) {
	return new Promise<{ code: number; stdout: string; stderr: string; killed: boolean }>((resolve, reject) => {
		execFile(file, args, { cwd: options.cwd, timeout: options.timeout, signal: options.signal, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
			env: { ...process.env, KATA_TRANSCRIPT_AGENT: agent, KATA_TRANSCRIPT_SESSION_ID: session } },
			(error, stdout, stderr) => {
				if (!error) return resolve({ code: 0, stdout, stderr, killed: false });
				const failure = error as NodeJS.ErrnoException & { killed?: boolean };
				if (failure.code === "ENOENT") return reject(error);
				resolve({ code: typeof failure.code === "number" ? failure.code : 1, stdout, stderr, killed: failure.name === "AbortError" || !!failure.killed });
			});
	});
}

// ------------------------------------------------------------- live inbox stream feed

/** `kata events --tail` as a child of this process: no shell, the process environment, no stdin. */
function spawnEvents(cwd: string, cursor: number | undefined): InboxStream {
	const args = ["events", "--tail", "--json", "--workspace", cwd, ...(cursor ? ["--last-event-id", String(cursor)] : [])];
	const proc = spawn(EXECUTABLE, args, { cwd, env: { ...process.env }, stdio: ["ignore", "pipe", "ignore"] });
	const exited = new Promise<void>(resolve => { proc.on("error", () => resolve()); proc.on("close", () => resolve()); });
	// Never keep omp alive for the stream.
	proc.unref();
	if ("unref" in proc.stdout! && typeof proc.stdout.unref === "function") proc.stdout.unref();
	return { lines: createInterface({ input: proc.stdout! }), exited, kill: () => { proc.kill("SIGKILL"); } };
}

export default function ompKata(pi: any) {
	const z = pi.zod;
	const main = (ctx: any) => ctx?.agent?.kind === "main";
	const sessionId = (ctx: any): string | undefined => ctx?.sessionManager?.getSessionId?.();
	// The context of the latest event: the lifecycle bus carries none. A sub identity that reaches a main-session handler (omp's advisor) never replaces the main one.
	let seen: any;
	const see = (ctx: any) => { if (main(ctx) || !seen || !main(seen)) seen = ctx; };
	// The lead session the assignments below belong to.
	let assignmentsLead: string | undefined;
	const assignments = new Map<string, Assignment>();
	const leadSession = () => seen && main(seen) ? sessionId(seen) : undefined;
	const store: DelegateStore = {
		records: () => [...recordsBySession.values()].filter(record => record.leadSessionId === leadSession()),
		get: id => store.records().find(record => record.id === id),
		put: record => { recordsBySession.set(record.sessionId, record); },
		of: ctx => {
			const file = ctx.sessionManager?.getSessionFile?.();
			const record = file ? recordsBySession.get(sessionKey(file, ctx.cwd)) : undefined;
			return record?.id === ctx.agent?.id ? record : undefined;
		},
	};
	const core = createKataCore({
		// omp's exec spawns with the environment it captured at startup and ignores an env option, so
		// a close that must carry the transcript identity is spawned here, without a shell or an env program.
		// A delegate runs in the lead's process: its closes carry its own session, never the lead's.
		exec: (file, args, { ctx, ...options }) => {
			const transcript = !ctx || main(ctx) ? undefined : childSession(store.of(ctx)?.sessionId) ?? null;
			const pair = transcript === undefined ? { agent: process.env.KATA_TRANSCRIPT_AGENT, id: process.env.KATA_TRANSCRIPT_SESSION_ID } : transcript ?? undefined;
			return pair?.agent && pair.id && args[0] === "close" ? execWithTranscript(file, args, options, pair.agent, pair.id) : pi.exec(file, args, options);
		},
		appendEntry: (...args) => pi.appendEntry(...args),
		getSessionName: () => pi.getSessionName?.(),
		isMain: main,
		delegateStore: store,
		// Live delivery needs the aside delivery, and no opt-out (tern-kata delivers for the agents it starts).
		get liveInbox() {
			if (process.env.KATA_OMP_LIVE_INBOX === "0" || typeof pi.sendUserMessage !== "function") return undefined;
			return { spawn: spawnEvents, deliver: text => pi.sendUserMessage(text, { deliverAs: "aside", attribution: "agent" }) };
		},
	}, { namespace: "omp", executable: EXECUTABLE, executableVars: EXECUTABLE_VARS, debugFile: process.env.KATA_OMP_DEBUG, attentionHarness: "pi", prefetch: true });
	// /tan runs a side conversation in a sub session whose agent id omp mints as
	// `Tan-<snowflake>`; task spawns get ids from the task name or a generated name,
	// never that prefix. The id is known at the very first todo call, unlike a
	// delegate's lifecycle record, so it cannot misroute a delegate that is still
	// being registered. A record, if present, always wins.
	const untrackedTan = (ctx: any) => ctx?.agent?.kind === "sub" && /^Tan-/.test(ctx.agent.id ?? "") && !store.of(ctx);

	// Delegates whose end the lifecycle events missed: the async-job snapshot says they finished. Read in memory before every session or tool event.
	async function syncJobs(ctx: any) {
		const snapshot = ctx?.getAsyncJobSnapshot?.();
		if (!snapshot) return;
		const running: any[] = snapshot.running ?? [], records = store.records();
		for (const job of snapshot.recent ?? []) {
			if (job.type !== "task" || !["completed", "failed", "aborted", "cancelled"].includes(job.status)) continue;
			const record = records.find(r => r.id === job.id || r.id === job.agentId);
			if (!record || record.exited || running.some(r => r.id === job.id || r.agentId === record.id)) continue;
			await core.delegates.apply({ type: "exited", id: record.id, outcome: job.status === "cancelled" ? "aborted" : job.status });
		}
	}
	// A handler's entry: remember the context and bring delegate state up to date.
	const enter = async (ctx: any) => { see(ctx); await syncJobs(ctx); };

	pi.registerTool({
		name: "todo",
		label: "Todo (kata カタ)",
		description: DESCRIPTION,
		approval: "read",
		parameters: z.object({
			op: z.enum(["init", "start", "done", "rm", "drop", "block", "unblock", "append", "view"]),
			list: z.array(z.object({ phase: z.string(), items: z.array(z.string()).min(1) })).optional().describe("phases for init"),
			task: z.string().optional().describe("verbatim task content or Kata ref"),
			phase: z.string().optional(),
			items: z.array(z.string()).optional().describe("tasks for flat init or append"),
			reason: z.string().optional().describe("blocker note for block"),
			ref: z.string().optional().describe("existing Kata issue this plan serves (init)"),
			replace: z.boolean().optional().describe("init: replace a plan that still has open tasks (they close as wontfix); without it init refuses"),
			message: z.string().optional().describe("done: what changed and how it was verified (40+ chars); drop/rm: reason; init without ref: title for the new Kata parent"),
			evidence: z.array(z.string()).optional().describe("required for done: commit:<sha>, test:<cmd>, pr:<url>, reviewed-paths:<path>"),
		}),
		async execute(_id: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
			await enter(ctx);
			const record = !main(ctx) ? store.of(ctx) : undefined;
			if (record) await nextUse(record);
			if ((untrackedTan(ctx) || record?.state === "untracked") && typeof ctx.invokeTool === "function") return ctx.invokeTool(params, { signal, onUpdate });
			return core.todo.apply(ctx, params.op, params);
		},
	});

	// OMP reserves built-in command names; intercept /todo before its dispatcher.
	pi.on("input", async (event: any, ctx: any) => {
		if (!main(ctx)) return;
		const match = /^\/todo(?:\s+([\s\S]*))?$/.exec(event.text.trim());
		if (!match) {
			if (event.source === "interactive" && !event.text.trim().startsWith("/")) core.session.input();
			return;
		}
		ctx.ui?.notify?.(await core.todo.command(ctx, match[1] || ""), "info");
		return { handled: true };
	});
	// --------------------------------------------------------------- delegates

	// The Delegates that owns a delegate's record is the lead's.
	const nextUse = (record: DelegateRecord) => leads.get(record.leadSessionId)?.apply({ type: "nextUse", id: record.id });
	const nextUseOf = (ctx: any) => { const record = store.of(ctx); return record ? nextUse(record) : undefined; };

	pi.events?.on("task:subagent:lifecycle", (event: any) => {
		const ctx = seen;
		if (!ctx || !event?.id) return;
		let lead: { id: string; delegates?: DelegateEvents } | undefined;
		if (main(ctx)) {
			const id = sessionId(ctx);
			if (id) { leads.set(id, core.delegates); lead = { id, delegates: core.delegates }; }
		} else {
			const owner = store.of(ctx);
			if (owner) lead = { id: owner.leadSessionId, delegates: leads.get(owner.leadSessionId) };
		}
		if (!lead?.delegates) return;
		if (event.status === "started") {
			if (assignmentsLead !== lead.id) { assignments.clear(); assignmentsLead = lead.id; } // a previous session's spawns
			for (const [key, record] of recordsBySession) if (record.leadSessionId !== lead.id && SETTLED.has(record.state)) recordsBySession.delete(key);
			const index = event.index ?? 0;
			const assignment = main(ctx) ? assignments.get(event.parentToolCallId) : undefined;
			const reserved = assignment?.reserved?.[index];
			if (assignment?.reserved) assignment.reserved[index] = undefined; // the record holds it now
			if (assignment) {
				assignment.started.add(index);
				if (assignment.started.size >= assignment.texts.length) assignments.delete(event.parentToolCallId);
			}
			void lead.delegates.apply({
				type: "started", id: event.id, sessionId: event.sessionFile ? sessionKey(event.sessionFile, ctx.cwd) : `${lead.id}:${event.id}`,
				leadSessionId: lead.id, leadTeammate: process.env.KATA_TEAMMATE || "", teammate: teammateFor(event.id, lead.id),
				text: [assignment?.texts[index], event.description].filter(Boolean).join("\n"), label: assignment?.labels[index],
				single: (assignment?.texts.length ?? 1) === 1, observesTools: true, parentAgentId: ctx.agent?.id, reserved,
			});
		} else if (["completed", "failed", "aborted"].includes(event.status)) {
			void lead.delegates.apply({ type: "exited", id: event.id, outcome: event.status });
		}
	});

	pi.on("tool_call", async (event: any, ctx: any) => {
		await enter(ctx);
		await core.tools.call(ctx);
		const record = ctx.agent?.kind === "sub" ? store.of(ctx) : undefined;
		if (record) void leads.get(record.leadSessionId)?.apply({ type: "ranTool", id: record.id });
		if (main(ctx) && event.toolName === "task" && event.toolCallId) {
			const items: any[] = Array.isArray(event.input?.tasks) ? event.input.tasks : [event.input];
			// omp's short task name is the clearest signal; the task text is the fallback.
			const labels = items.map(item => typeof item?.name === "string" ? item.name : "");
			const texts = items.map(item => [item?.task, item?.description].filter(value => typeof value === "string").join("\n"));
			const id = leadSession();
			if (assignmentsLead !== id) { assignments.clear(); assignmentsLead = id; }
			const held = [...assignments.values()].flatMap(a => (a.reserved ?? []).map(reservation => reservation?.ref)).filter((ref): ref is string => !!ref);
			const assignment: Assignment = { labels, texts, started: new Set() };
			assignments.set(event.toolCallId, assignment);
			return core.delegates.check(texts.map((text, index) => ({ text, label: labels[index] })), held)
				.then(reserved => { assignment.reserved = reserved; })
				.catch(error => { assignments.delete(event.toolCallId); return { block: true, reason: String(error) }; });
		}
		if (ctx.agent?.kind !== "sub" || event.toolName !== "bash" || typeof event.input?.command !== "string") return;
		const commands = kataCommands(event.input.command);
		if (!commands.length) return;
		const teammate = record?.teammate || teammateFor(ctx.agent.id);
		try { return { input: { ...event.input, command: delegateCommand(event.input.command, EXECUTABLE, EXECUTABLE_VARS, teammate, record?.binding, childSession(record?.sessionId)) } }; }
		catch (error) { return { block: true, reason: String(error) }; }
	});

	// A delegate's session file starts with a header carrying its own session id, the one AgentsView lists it under.
	const childSessions = new Map<string, string>();
	function childSession(file?: string) {
		if (!file) return undefined;
		if (!childSessions.has(file)) {
			let id = "";
			try {
				const fd = openSync(file, "r"), buffer = Buffer.alloc(4096);
				let length: number;
				try { length = readSync(fd, buffer, 0, buffer.length, 0); } finally { closeSync(fd); }
				for (const line of buffer.toString("utf8", 0, length).split("\n")) {
					const header = line.startsWith('{"type":"session"') ? JSON.parse(line) : undefined;
					if (header) { id = typeof header.id === "string" ? header.id : ""; break; }
				}
			} catch { /* the file may not be flushed yet; try again on the next close */ }
			if (!id) return undefined;
			childSessions.set(file, id);
		}
		return { agent: "omp", id: childSessions.get(file)! };
	}

	pi.on("tool_result", async (event: any, ctx: any) => {
		await enter(ctx);
		// Started delegates hold their own tasks; a denied or partial spawn releases the rest. The text stays for a delegate
		// whose start is reported late, until every spawn has started (a call that failed spawned nothing).
		const assignment = event.toolName === "task" ? assignments.get(event.toolCallId) : undefined;
		if (assignment) {
			assignment.reserved = undefined;
			if (event.isError || assignment.started.size >= assignment.texts.length) assignments.delete(event.toolCallId);
		}
		await core.tools.result(ctx, event);
	});
	pi.on("session_stop", async (event: any, ctx: any) => {
		await enter(ctx);
		const additionalContext = await core.session.stop(ctx, event.messages ?? []);
		if (additionalContext) return { continue: true, additionalContext };
	});

	pi.on("before_agent_start", async (event: any, ctx: any) => {
		// omp discards the result of a revive and nothing needs the work.
		if (event.reason === "revive") return;
		await enter(ctx);
		const { sections } = await core.session.beforePrompt(ctx, { after: !main(ctx) ? nextUseOf(ctx) : undefined });
		const base = (Array.isArray(event.systemPrompt) ? event.systemPrompt : [event.systemPrompt || ""]).filter((s: string) => !/^<kata_(contract|todo|inbox|binding)>/.test(s));
		const out: string[] = [];
		const tag = (name: string, text: string) => out.push(`<kata_${name}>\n${text}\n</kata_${name}>`);
		// Something else (an earlier injection, another installer) may already carry the contract.
		if (sections.contract && !base.some((s: string) => s.includes(sections.contract!.slice(0, 80)))) tag("contract", sections.contract);
		if (sections.assignment) tag("binding", sections.assignment);
		if (sections.inbox) tag("inbox", sections.inbox);
		if (main(ctx) && sections.todo) tag("todo", sections.todo);
		if (!out.length) return;
		return { systemPrompt: [...base, out.join("\n\n")] };
	});

	// One provider per editor: omp rebuilds its stack from every registered factory,
	// and begin runs again on every session switch.
	const typeahead = new WeakSet<object>();
	function offerTickets(ctx: any) {
		if (!ctx.ui?.addAutocompleteProvider || typeahead.has(ctx.ui)) return;
		typeahead.add(ctx.ui);
		ctx.ui.addAutocompleteProvider((current: any) => ticketAutocomplete(current, core.tickets, { defaultProject: process.env.KATA_DEFAULT_PROJECT?.trim() || undefined }));
	}

	async function begin(ctx: any) {
		await enter(ctx);
		if (!main(ctx)) { await core.session.start(ctx, { after: nextUseOf(ctx) }); return; }
		offerTickets(ctx);
		const id = sessionId(ctx);
		// Inherited by bash-tool and plugin closes so Kata records this omp session.
		if (id) { process.env.KATA_TRANSCRIPT_AGENT = "omp"; process.env.KATA_TRANSCRIPT_SESSION_ID = id; }
		await core.session.start(ctx);
	}

	pi.on("session_start", (_event: any, ctx: any) => begin(ctx));
	pi.on("session_switch", (_event: any, ctx: any) => begin(ctx));
	pi.on("session_branch", async (_event: any, ctx: any) => { await enter(ctx); await core.session.branch(ctx); });
	pi.on("session_tree", async (_event: any, ctx: any) => { await enter(ctx); await core.session.tree(ctx); });
	// The transcript pair is left for the next session_start to overwrite: clearing after a slow cleanup could delete the pair of an instance omp already started in this process.
	pi.on("session_shutdown", async (_event: any, ctx: any) => {
		await enter(ctx);
		await core.session.shutdown(ctx);
	});
}
