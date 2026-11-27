// omp-kata: Kata mirrors oh-my-pi's todo list.
//
// omp's own `todo` tool, `/todo`, HUD and reminders stay. This extension plugs into them:
//   - a todo backend (`registerTodoBackend`) that mirrors the whole list into Kata after omp saves it, with every
//     task a Kata child issue. It works once `todo.backend` is `kata` (/settings → Tools → Todos); with another
//     backend selected the plugin leaves todos alone and says so once per session;
//   - a `tool_call` guard that refuses todo calls Kata's rules forbid (a done on a task still open in Kata, an init that
//     leaves open tasks out, a task another session holds), so the model gets the reason as the tool's error;
//   - `/todo takeover` and `/todo ref`, intercepted on input; every other `/todo` is omp's;
//   - the todo rules in the system prompt, cached Kata contracts, guarded main-session attention, and delegate identity.
//
// Plan items are children carrying `todo.phase`; other children participate in
// parent closure. A folder with no Kata project plans in KATA_DEFAULT_PROJECT
// (labeled with the repo) or in its inferred project, registered on first use.
// The plan is session-local only while Kata is unreachable, then it replays.

import { spawn } from "node:child_process";
import { BroadcastChannel, isMainThread, threadId } from "node:worker_threads";
import { closeSync, openSync, readSync } from "node:fs";
import { createInterface } from "node:readline";
import { createKataCore, NATIVE_TODO_COMMANDS, PROMPT_TAGS, snapshotEntry, tagged, type Known } from "./kata-core";
import { execKata, exportTranscriptSession, nodePlatform, sessionKey } from "./node-host";
import { closeEnv, debugTo, NO_JOB } from "./kata-cli";
import { delegateCommand, kataCommands as parseKataCommands } from "./shell";
import { FINAL, isUntracked, Refusal, teammateFor } from "./delegates";
import { textOf } from "./model";
import type { DelegateOutcome, DelegateRecord, Delegates, DelegateStore } from "./delegates";
import type { Setting } from "@oh-my-pi/pi-coding-agent/config/registry";
import type { InboxStream } from "./inbox";

// What the lead's Delegates takes from an adapter other than the lead itself: a delegate's next use runs in the lead's queue.
type DelegateEvents = Pick<Delegates, "apply" | "start">;

const NAMESPACE = "omp";
const BACKEND_ID = "kata";
const EXECUTABLE = process.env.KATA_OMP_EXECUTABLE || "kata";
const EXECUTABLE_VARS = ["KATA_OMP_EXECUTABLE"];
export const kataCommands = (command: string) => parseKataCommands(nodePlatform.path, command, EXECUTABLE, EXECUTABLE_VARS);

// How a finished task job or lifecycle status ends its delegate; a status not listed is still running.
const OUTCOME: Readonly<Record<string, DelegateOutcome>> = { completed: "completed", failed: "failed", aborted: "aborted", cancelled: "aborted" };

// The texts of a task call's spawns, for the delegates it starts. The entry lasts as long as the core keeps what the spawns
// reserved (see Delegates.check): until the call is over, which is its result for a call that ran its spawns inside it, and
// the end of its background jobs for an async one (`jobs` holds their ids), whose spawns may start after the result.
type TaskCall = { texts: string[]; jobs?: Set<string> };

// OMP rebinds extension factories in the same module graph, so every instance on a thread shares the delegate records and
// the lead Delegates that own them. A delegate's session file is the correlation key: agent names alone can collide across simultaneous sessions.
const recordsBySession = new Map<string, DelegateRecord>();
const leads = new Map<string, DelegateEvents>();
// The refs and learned projects each lead session works, read by the ref guard of a delegate on a worker thread (see askRefs).
const leadRefs = new Map<string, () => Known | undefined>();

// The `todo.backend` setting, found once per module copy (per thread), and one settings listener that only feeds the
// main session's off-notice through `backendWatchers`. Whether the backend is Kata is read through `setting` against the
// calling instance's own settings each time, so it stays right when the listener's settings object is gone.
let setting: Setting | undefined;
const backendWatchers = new Set<(next: string) => void>();
// One import shared by concurrent callers; kept once the setting is found, dropped when it is not (yet) available so a later call retries.
let following: Promise<void> | undefined;
function followBackend(settings: unknown, debug: (error: unknown) => void): Promise<void> {
	following ??= (async () => {
		try {
			// A static import cannot work: the module resolves only inside omp, and tests mock it after this module loads.
			const { lookup } = await import("@oh-my-pi/pi-coding-agent/config/registry");
			const found = lookup("todo.backend");
			if (!found) { following = undefined; return; }
			found.listen(settings, (next: string) => { for (const watcher of backendWatchers) watcher(next); });
			setting = found;
		} catch (error) { following = undefined; debug(error); }
	})();
	return following;
}

// omp runs a subagent on a worker thread once enough run at once, and loads a separate copy of this module there, so
// the records and lead Delegates above stay on the main thread. A worker's copy asks the main thread's copy over this
// channel (omp's event bus does not cross threads) and keeps the answer in its own map, which its store then reads.
type DelegateWire =
	| { kind: "nextUse"; req: string; key: string; id: string }
	| { kind: "record"; req: string; record?: DelegateRecord }
	| { kind: "refsAsk"; req: string; key: string }
	| { kind: "refsAnswer"; req: string; known?: Known }
	| { kind: "ranTool"; key: string; id: string };
const delegateChannel = new BroadcastChannel("kata-plugin:omp-delegates:1");
// Never keep omp alive for the channel.
delegateChannel.unref();
// How long the main thread waits for a lead's started event that has not arrived yet, and a worker for an answer.
const RECORD_WAIT_MS = 3000;
const ANSWER_WAIT_MS = 30_000;
// A worker's ref guard gives up on the lead's refs after this; the core asks inside its own 2 s bound, and only for a call that adds text.
const REFS_WAIT_MS = 1000;
const arrivals = new Map<string, (() => void)[]>();
function putRecord(record: DelegateRecord) {
	recordsBySession.set(record.sessionId, record);
	for (const arrived of arrivals.get(record.sessionId) ?? []) arrived();
	arrivals.delete(record.sessionId);
}
function recordArrival(key: string): Promise<void> {
	return new Promise(resolve => {
		const arrived = () => { clearTimeout(timer); resolve(); };
		// A wait that times out drops only itself; later waits for the same session keep theirs.
		const timer = setTimeout(() => {
			const rest = (arrivals.get(key) ?? []).filter(wait => wait !== arrived);
			if (rest.length) arrivals.set(key, rest); else arrivals.delete(key);
			resolve();
		}, RECORD_WAIT_MS);
		timer.unref?.();
		arrivals.set(key, [...(arrivals.get(key) ?? []), arrived]);
	});
}
async function answerWorker(message: DelegateWire) {
	if (message.kind === "record" || message.kind === "refsAnswer") return;
	if (!recordsBySession.has(message.key)) await recordArrival(message.key);
	const record = recordsBySession.get(message.key);
	if (message.kind === "refsAsk") return delegateChannel.postMessage({ kind: "refsAnswer", req: message.req, known: record ? leadRefs.get(record.leadSessionId)?.() : undefined } satisfies DelegateWire);
	if (record?.id !== message.id) return message.kind === "nextUse" ? delegateChannel.postMessage({ kind: "record", req: message.req } satisfies DelegateWire) : undefined;
	await leads.get(record.leadSessionId)?.apply({ type: message.kind, id: message.id }, NO_JOB);
	if (message.kind === "nextUse") delegateChannel.postMessage({ kind: "record", req: message.req, record: recordsBySession.get(message.key) } satisfies DelegateWire);
}
let requestCount = 0;
// A worker's questions by request id, until the main thread answers; a wait that gave up keeps its entry, so a late answer still lands.
const awaitingAnswer = new Map<string, (record: DelegateRecord | undefined) => void>();
// The latest question a worker's copy has out per delegate session: a tool call waits for its answer before reading the record.
const latestQuestion = new Map<string, Promise<void>>();
// A worker's copy: the lead's queue runs the delegate's next use, and the record it answers with replaces this thread's copy.
function askMain(key: string, id: string): Promise<void> {
	const req = `${threadId}:${++requestCount}`;
	const answered = new Promise<void>(resolve => {
		const timer = setTimeout(resolve, ANSWER_WAIT_MS);
		timer.unref?.();
		awaitingAnswer.set(req, record => {
			clearTimeout(timer);
			if (record) recordsBySession.set(key, record); else recordsBySession.delete(key);
			resolve();
		});
		delegateChannel.postMessage({ kind: "nextUse", req, key, id } satisfies DelegateWire);
	});
	latestQuestion.set(key, answered);
	void answered.then(() => { if (latestQuestion.get(key) === answered) latestQuestion.delete(key); });
	return answered;
}
delegateChannel.onmessage = (event: { data: unknown }) => {
	// Only this module's copies post on this channel.
	const message = event.data as DelegateWire;
	if (isMainThread) void answerWorker(message).catch(() => { /* the worker's wait ends on its own */ });
	else if (message.kind === "record") { awaitingAnswer.get(message.req)?.(message.record); awaitingAnswer.delete(message.req); }
	else if (message.kind === "refsAnswer") { awaitingRefs.get(message.req)?.(message.known); awaitingRefs.delete(message.req); }
};
const awaitingRefs = new Map<string, (known?: Known) => void>();
// A worker's copy knows only its delegate's own issue; the lead's refs (its plan and its other delegates) and learned projects come from the main thread. Nothing when it does not answer in time.
function askRefs(key: string): Promise<Known | undefined> {
	const req = `${threadId}:${++requestCount}`;
	return new Promise(resolve => {
		const timer = setTimeout(() => { awaitingRefs.delete(req); resolve(undefined); }, REFS_WAIT_MS);
		timer.unref?.();
		awaitingRefs.set(req, known => { clearTimeout(timer); resolve(known); });
		delegateChannel.postMessage({ kind: "refsAsk", req, key } satisfies DelegateWire);
	});
}

// ------------------------------------------------------------- live inbox stream feed

function spawnEvents([file, ...args]: string[], cwd: string): InboxStream {
	const proc = spawn(file, args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
	const exited = new Promise<void>(resolve => { proc.on("error", () => resolve()); proc.on("close", () => resolve()); });
	// Never keep omp alive for the stream.
	proc.unref();
	if ("unref" in proc.stdout! && typeof proc.stdout.unref === "function") proc.stdout.unref();
	return { lines: createInterface({ input: proc.stdout! }), exited, kill: () => { proc.kill("SIGKILL"); } };
}

export default function ompKata(pi: any) {
	const debug = debugTo(process.env.KATA_OMP_DEBUG, nodePlatform.appendFile);
	const main = (ctx: any) => ctx?.agent?.kind === "main";
	const sessionId = (ctx: any): string | undefined => ctx?.sessionManager?.getSessionId?.();
	// A delegate's correlation key: its session file, resolved against its cwd.
	const sessionKeyOf = (ctx: { cwd: string; sessionManager?: { getSessionFile?(): string | undefined } } | undefined): string | undefined => {
		const file = ctx?.sessionManager?.getSessionFile?.();
		return file ? sessionKey(file, ctx!.cwd) : undefined;
	};
	// The context of the latest event: the lifecycle bus carries none. A sub identity that reaches a main-session handler (omp's advisor) never replaces the main one.
	let seen: any;
	const see = (ctx: any) => {
		if (main(ctx) || !seen || !main(seen)) seen = ctx;
		// Only a main session shows the off-notice: sub-agent instances never subscribe, so nothing holds their context.
		if (main(ctx)) backendWatchers.add(offWatcher);
	};
	const leadSession = () => seen && main(seen) ? sessionId(seen) : undefined;
	const store: DelegateStore = {
		records: () => [...recordsBySession.values()].filter(record => record.leadSessionId === leadSession()),
		get: id => store.records().find(record => record.id === id),
		put: putRecord,
		of: ctx => {
			const key = sessionKeyOf(ctx);
			const record = key ? recordsBySession.get(key) : undefined;
			return record?.id === ctx.agent?.id ? record : undefined;
		},
	};
	const core = createKataCore({
		platform: nodePlatform,
		// omp's timers, contained in the session and cleared at its shutdown.
		contextTimers: ctx => typeof ctx?.setTimeout === "function" && typeof ctx.clearTimer === "function" ? { setTimer: (fire, ms) => ctx.setTimeout(fire, ms), clearTimer: handle => ctx.clearTimer(handle) } : undefined,
		// omp's exec spawns with the environment it captured at startup and ignores an env option, so
		// a close that must carry the transcript identity is spawned here, without a shell or an env program.
		// A delegate runs in the lead's process: its closes carry its own session, never the lead's.
		exec: (file, args, { ctx, ...options }) => {
			const pair = transcriptPairOf(ctx);
			const env = pair && closeEnv(nodePlatform.env, args, pair.agent, pair.id);
			return env ? execKata(file, args, { ...options, env }) : pi.exec(file, args, options);
		},
		appendEntry: (type, data) => {
			// A snapshot the core writes for a session that is no longer omp's live main session would land in the live
			// session's file. Skip it: the core re-derives its state from the branch on resume.
			const session = (data as { sessionId?: string } | undefined)?.sessionId;
			const live = leadSession();
			if (type === snapshotEntry(NAMESPACE) && live && session !== live) { debug(`skipped snapshot for ${session}: live session is ${live}`); return; }
			pi.appendEntry(type, data);
		},
		getSessionName: () => pi.getSessionName?.(),
		isMain: main,
		delegateStore: store,
		// Live delivery needs the aside delivery, and no opt-out (tern-kata delivers for the agents it starts).
		get liveInbox() {
			if (process.env.KATA_OMP_LIVE_INBOX === "0" || typeof pi.sendUserMessage !== "function") return undefined;
			return { spawn: spawnEvents, deliver: (text: string) => pi.sendUserMessage(text, { deliverAs: "aside", attribution: "agent" }) };
		},
	}, { namespace: NAMESPACE, executable: EXECUTABLE, executableVars: EXECUTABLE_VARS, debugFile: process.env.KATA_OMP_DEBUG, attentionHarness: "pi", prefetch: true,
		native: true });
	// The task calls of the lead session `callsLead` that are not over yet.
	const taskCalls = new Map<string, TaskCall>();
	let callsLead: string | undefined;
	const over = (call: string) => { taskCalls.delete(call); core.delegates.release(call); };
	const forLead = (id: string | undefined) => {
		if (callsLead === id) return;
		for (const call of [...taskCalls.keys()]) over(call);
		callsLead = id;
	};

	// Delegates whose end the lifecycle events missed: the async-job snapshot says they finished. Read in memory before every session or tool event.
	async function syncJobs(ctx: any) {
		const snapshot = ctx?.getAsyncJobSnapshot?.();
		if (!snapshot) return;
		const running: any[] = snapshot.running ?? [], records = store.records();
		for (const [call, { jobs }] of taskCalls) {
			if (jobs && !running.some(job => jobs.has(job.id) || jobs.has(job.agentId))) over(call);
		}
		for (const job of snapshot.recent ?? []) {
			const outcome = job.type === "task" ? OUTCOME[job.status] : undefined;
			if (!outcome) continue;
			const record = records.find(r => r.id === job.id || r.id === job.agentId);
			if (!record || record.exited || running.some(r => r.id === job.id || r.agentId === record.id)) continue;
			void core.delegates.apply({ type: "exited", id: record.id, outcome }, NO_JOB);
		}
	}
	const enter = async (ctx: any) => { see(ctx); await syncJobs(ctx); };

	// omp's context and session manager are class instances with private fields: a method only works called on the
	// original, so the view is a plain object (never Object.create or a spread). The branch and header are captured
	// by the caller before its first await, since the originals answer for omp's CURRENT session and leaf (a /new, a resume or
	// a /tree move changes them); the view answers from those copies, except `getEntries`, the one live read.
	type Header = { parentSession?: unknown } | null | undefined;
	const boundContext = (ctx: any, id: string | undefined, captured: { branch: unknown[]; header: Header }) => {
		const bind = (owner: any, name: string) => typeof owner?.[name] === "function" ? owner[name].bind(owner) : undefined;
		return {
			cwd: ctx?.cwd, agent: ctx?.agent, ui: ctx?.ui,
			setTimeout: bind(ctx, "setTimeout"), clearTimer: bind(ctx, "clearTimer"),
			sessionManager: {
				getSessionId: () => id,
				getBranch: () => captured.branch,
				getHeader: () => captured.header,
				getEntries: bind(ctx?.sessionManager, "getEntries"),
			},
		};
	};

	// omp's own `todo` tool runs; Kata mirrors its list through this backend after omp has saved it. A throw only
	// reports an extension error, so nothing here rejects.
	pi.registerTodoBackend({
		id: BACKEND_ID,
		label: "Kata",
		description: "Mirrors the todo list into Kata issues",
		async replace(phases: any, ctx: any) {
			// Read before the first await: a later /new changes what the session manager answers.
			const id = sessionId(ctx);
			const sm = ctx?.sessionManager;
			const captured = {
				branch: [...(sm?.getBranch?.() ?? [])] as unknown[],
				header: sm?.getHeader?.() as Header,
			};
			try {
				await enter(ctx);
				await core.todo.mirror(boundContext(ctx, id, captured), phases);
			} catch (error) { debug(error); }
		},
	});

	// Which backend omp has selected is read lazily (see `followBackend`), from this instance's own settings.
	let noticeFor: string | undefined;
	async function kataBackend(): Promise<string | undefined> {
		await followBackend(pi.pi.settings, debug);
		return setting?.get(pi.pi.settings);
	}
	// Once per session, main session only: with another backend selected nothing reaches Kata.
	function offNotice(ctx: any, backend: string | undefined) {
		if (!main(ctx) || backend === undefined || backend === BACKEND_ID) return;
		const id = sessionId(ctx);
		if (!id || noticeFor === id) return;
		noticeFor = id;
		ctx.ui?.notify?.(`Kata is not tracking your todo list: omp's todo backend is "${backend}". Pick Kata under /settings → Tools → Todos → Todo Backend.`, "warning");
	}
	function offWatcher(next: string) { if (seen) offNotice(seen, next); }

	// /todo is built in and omp reserves its name; intercept the Kata subcommands before its dispatcher. Every other /todo is omp's.
	pi.on("input", async (event: any, ctx: any) => {
		if (!main(ctx)) return;
		const text = event.text.trim();
		const match = /^\/todo\s+(\S+)(?:\s+([\s\S]*))?$/.exec(text);
		if (match && (NATIVE_TODO_COMMANDS as readonly string[]).includes(match[1]!)) {
			if (await kataBackend() === BACKEND_ID) {
				ctx.ui?.notify?.(await core.todo.command(ctx, `${match[1]} ${match[2] ?? ""}`.trim()), "info");
				return { handled: true };
			}
		}
	});

	// The Delegates that owns a delegate's record is the lead's, on the main thread; a worker's copy reaches it over the channel.
	const nextUseOf = (ctx: any): Promise<void> | undefined => {
		if (!isMainThread) {
			const key = ctx?.agent?.kind === "sub" ? sessionKeyOf(ctx) : undefined;
			return key ? askMain(key, ctx.agent.id) : undefined;
		}
		const record = store.of(ctx);
		return record ? leads.get(record.leadSessionId)?.apply({ type: "nextUse", id: record.id }, NO_JOB) : undefined;
	};
	const ranTool = (record: DelegateRecord) => {
		if (isMainThread) void leads.get(record.leadSessionId)?.apply({ type: "ranTool", id: record.id }, NO_JOB);
		else delegateChannel.postMessage({ kind: "ranTool", key: record.sessionId, id: record.id } satisfies DelegateWire);
	};
	// A worker's copy holds a delegate's record only once the main thread answered: wait for an answer still on its way,
	// or a tool call made before it is neither reported nor attributed to the delegate's teammate.
	const recordOf = async (ctx: any) => {
		const key = isMainThread ? undefined : sessionKeyOf(ctx);
		if (key) await latestQuestion.get(key);
		return store.of(ctx);
	};

	// The lead Delegates that the delegates started from `ctx` report to: this session's own (registered here for its
	// delegates' later events, and for worker threads), or a nested delegate's lead.
	const leadOf = (ctx: any): { id: string; delegates?: DelegateEvents } | undefined => {
		if (main(ctx)) {
			const id = sessionId(ctx);
			if (id) { leads.set(id, core.delegates); leadRefs.set(id, () => { try { return core.tools.refs(seen); } catch (error) { debug(error); return undefined; } }); return { id, delegates: core.delegates }; }
			return undefined;
		}
		const owner = store.of(ctx);
		return owner ? { id: owner.leadSessionId, delegates: leads.get(owner.leadSessionId) } : undefined;
	};

	pi.events?.on("task:subagent:lifecycle", (event: any) => {
		const ctx = seen;
		if (!ctx || !event?.id) return;
		const lead = leadOf(ctx);
		if (!lead?.delegates) return;
		if (event.status === "started") {
			forLead(lead.id);
			for (const [key, record] of recordsBySession) if (record.leadSessionId !== lead.id && record.exited && FINAL.has(record.state)) recordsBySession.delete(key);
			const index = event.index ?? 0;
			void lead.delegates.start({
				id: event.id, sessionId: event.sessionFile ? sessionKey(event.sessionFile, ctx.cwd) : `${lead.id}:${event.id}`, leadSessionId: lead.id,
				text: [taskCalls.get(event.parentToolCallId)?.texts[index], event.description].filter(Boolean).join("\n"),
				agent: typeof event.agent === "string" && event.agent ? event.agent : undefined, parentAgentId: ctx.agent?.id, call: event.parentToolCallId, index,
			}, NO_JOB);
		} else if (OUTCOME[event.status]) {
			void lead.delegates.apply({ type: "exited", id: event.id, outcome: OUTCOME[event.status]! }, NO_JOB);
		}
	});

	// Every event of a delegate's session, worker threads included, reaches the main thread here. Its report is its last
	// assistant text, or what it yielded; streaming events are dropped first, since they arrive per token.
	pi.events?.on("task:subagent:event", (payload: any) => {
		const event = payload?.event, type = event?.type;
		if (type !== "message_end" && type !== "tool_execution_start") return;
		let text: string | undefined;
		if (type === "message_end" && event.message?.role === "assistant") text = textOf(event.message.content);
		// A yield whose `type` is a non-empty list is one section of an incremental result, not the whole report; a string
		// or null (strict-mode providers) type is terminal.
		else if (type === "tool_execution_start" && event.toolName === "yield" && !(Array.isArray(event.args?.type) && event.args.type.length > 0)) {
			// Data wins: backends fill the optional `error` with "" or a placeholder beside real data.
			const { data, error } = event.args ?? {};
			text = data !== undefined && data !== null ? (typeof data === "string" ? data : JSON.stringify(data, null, 2))
				: typeof error === "string" && error.trim() ? `Failed: ${error.trim()}` : undefined;
		}
		if (!text?.trim() || !seen || typeof payload.id !== "string") return;
		void leadOf(seen)?.delegates?.apply({ type: "reported", id: payload.id, text }, NO_JOB);
	});

	pi.on("tool_call", async (event: any, ctx: any) => {
		await enter(ctx);
		await core.tools.call(ctx);
		const record = ctx.agent?.kind === "sub" ? await recordOf(ctx) : undefined;
		if (record) ranTool(record);
		const key = !isMainThread && ctx.agent?.kind === "sub" ? sessionKeyOf(ctx) : undefined;
		const refused = await core.tools.guard(ctx, { tool: event.toolName, input: event.input, id: event.toolCallId }, () => key ? askRefs(key) : undefined);
		if (refused) return { block: true, reason: refused };
		if (event.toolName === "todo" && await kataBackend() === BACKEND_ID) {
			const owner = main(ctx) ? core : record && !isUntracked(record) ? core.delegate(record.id) : undefined;
			// A delegate's guard waits for its queued next use, inside the guard's own time bound.
			const reason = await owner?.todo.guard(ctx, event.input, !main(ctx) ? nextUseOf(ctx) : undefined);
			if (reason) return { block: true, reason };
		}
		if (main(ctx) && event.toolName === "task" && event.toolCallId) {
			const items: any[] = Array.isArray(event.input?.tasks) ? event.input.tasks : [event.input];
			const texts = items.map(item => [item?.task, item?.description, item?.name].filter(value => typeof value === "string").join("\n"));
			forLead(leadSession());
			taskCalls.set(event.toolCallId, { texts });
			// A spawn Kata could not be asked about runs unreserved: its delegate decides from its text when it starts.
			return core.delegates.check(texts, event.toolCallId, undefined, NO_JOB)
				.then(() => undefined, error => {
					if (!(error instanceof Refusal)) { debug(error); return; }
					over(event.toolCallId);
					return { block: true, reason: String(error) };
				});
		}
		if (ctx.agent?.kind !== "sub" || event.toolName !== "bash" || typeof event.input?.command !== "string") return;
		const commands = kataCommands(event.input.command);
		if (!commands.length) return;
		const teammate = record?.teammate || teammateFor(ctx.agent.id, leadSession());
		const pair = transcriptPairOf(ctx);
		try { return { input: { ...event.input, command: delegateCommand(nodePlatform.path, event.input.command, EXECUTABLE, EXECUTABLE_VARS, teammate, record?.binding, pair && { env: nodePlatform.env, ...pair }) } }; }
		catch (error) { return { block: true, reason: String(error) }; }
	});

	// The session a close made in `ctx` records. A delegate runs in the lead's process, so its closes carry its own session,
	// never the lead's: its id is unknown until its session file has a header, and until then `id` is undefined (its closes
	// record nothing). Undefined for the lead before session start exported its pair: its closes go as omp spawns them.
	function transcriptPairOf(ctx: any): { agent: string; id: string | undefined } | undefined {
		if (!ctx || main(ctx)) {
			const { KATA_TRANSCRIPT_AGENT: agent, KATA_TRANSCRIPT_SESSION_ID: id } = process.env;
			return agent && id ? { agent, id } : undefined;
		}
		return childSession(store.of(ctx)?.sessionId) ?? { agent: NAMESPACE, id: undefined };
	}

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
		return { agent: NAMESPACE, id: childSessions.get(file)! };
	}

	pi.on("tool_result", async (event: any, ctx: any) => {
		await enter(ctx);
		// A call that ran its spawns inside it is over at its result, and so is one that failed (it spawned nothing). An async
		// call's background jobs may start their spawns after this result: it stays until they stop running.
		const call = event.toolName === "task" ? taskCalls.get(event.toolCallId) : undefined;
		if (call && !event.isError && event.details?.async) {
			call.jobs = new Set([event.details.async.jobId, ...(event.details.progress ?? []).map((spawn: any) => spawn?.id)].filter((id): id is string => typeof id === "string"));
			await syncJobs(ctx);
		} else if (call) over(event.toolCallId);
		await core.tools.result(ctx, event);
		// A delegate's todo list is not mirrored by omp (backends are main-session only), so its result carries the list here.
		if (event.toolName === "todo" && !event.isError && ctx.agent?.kind === "sub" && event.details?.op !== "view" && Array.isArray(event.details?.phases) && await kataBackend() === BACKEND_ID) {
			const record = await recordOf(ctx);
			if (record && !isUntracked(record)) {
				await nextUseOf(ctx);
				await core.delegate(record.id).todo.mirror(ctx, event.details.phases);
			}
		}
		const reason = core.tools.warning(event.toolCallId);
		if (reason) return { additionalContext: `Tool call ${JSON.stringify(event.toolCallId)}: ${reason}` };
	});
	// omp's own todo tracker does the reminding; the mirror keeps Kata in step with it.
	pi.on("session_stop", async (event: any, ctx: any) => {
		await enter(ctx);
		await core.session.settle(ctx, event.signal);
	});

	pi.on("before_agent_start", async (event: any, ctx: any) => {
		// omp discards the result of a revive and nothing needs the work.
		if (event.reason === "revive") return;
		await enter(ctx);
		const { sections } = await core.session.beforePrompt(ctx, { after: !main(ctx) ? nextUseOf(ctx) : undefined });
		const ours = new RegExp(`^<(${Object.values(PROMPT_TAGS).join("|")})>`);
		const base = (Array.isArray(event.systemPrompt) ? event.systemPrompt : [event.systemPrompt || ""]).filter((s: string) => !ours.test(s));
		const out: string[] = [];
		// Something else (an earlier injection, another installer) may already carry the contract.
		if (sections.contract && !base.some((s: string) => s.includes(sections.contract!.slice(0, 80)))) out.push(tagged("contract", sections.contract));
		if (sections.assignment) out.push(tagged("assignment", sections.assignment));
		if (sections.inbox) out.push(tagged("inbox", sections.inbox));
		const backend = await kataBackend();
		offNotice(ctx, backend);
		if (main(ctx) && backend === BACKEND_ID && sections.todo) out.push(tagged("todo", sections.todo));
		if (!out.length) return;
		return { systemPrompt: [...base, out.join("\n\n")] };
	});

	async function begin(ctx: any) {
		await enter(ctx);
		if (!main(ctx)) { await core.session.start(ctx, { after: nextUseOf(ctx) }); return; }
		core.offerTickets(ctx.ui);
		exportTranscriptSession(NAMESPACE, sessionId(ctx));
		const backend = await kataBackend();
		await core.session.start(ctx);
		offNotice(ctx, backend);
	}

	pi.on("session_start", (_event: any, ctx: any) => begin(ctx));
	pi.on("session_switch", (_event: any, ctx: any) => begin(ctx));
	pi.on("session_branch", async (_event: any, ctx: any) => { await enter(ctx); await core.session.branch(ctx); });
	pi.on("session_tree", async (_event: any, ctx: any) => { await enter(ctx); await core.session.tree(ctx); });
	// The transcript pair is left for the next session_start to overwrite: clearing after a slow cleanup could delete the pair of an instance omp already started in this process.
	pi.on("session_shutdown", async (_event: any, ctx: any) => {
		await enter(ctx);
		await core.session.shutdown(ctx);
		backendWatchers.delete(offWatcher);
	});
}
