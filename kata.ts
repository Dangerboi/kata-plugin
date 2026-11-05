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

import { closeSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { createKataCore, DESCRIPTION, sessionKey, render, matchDelegation, namedTargets,
	kataCommands as parseKataCommands, teammateFor, ticketAutocomplete, delegateCommand, delegateContext, untrackedDelegateContext, type Binding, type Task } from "./core/kata-core";

const EXECUTABLE = process.env.KATA_OMP_EXECUTABLE || "kata";
const EXECUTABLE_VARS = ["KATA_OMP_EXECUTABLE"];
export const kataCommands = (command: string) => parseKataCommands(command, EXECUTABLE, EXECUTABLE_VARS);

type Delegate = {
	id: string; teammate: string; sessionFile?: string; parentAgentId?: string;
	state: string; planRef?: string; ticket?: boolean; untracked?: boolean; label?: string; text?: string; single?: boolean; ref?: string; binding?: Binding; ready?: Promise<void>; prepareError?: string; reported?: string;
	coordinator: Coordinator;
};
type Coordinator = {
	id: string; records: Map<string, Delegate>;
	prepare: (record: Delegate) => Promise<void>;
	settle: (record: Delegate) => Promise<void>;
};
// OMP rebinds extension factories in the same module graph. Session file is the
// correlation key: agent names alone can collide across simultaneous sessions.
// What a task call asked for: names and texts per spawn; once a plan or ticket
// was seen, the ref each spawn works and which of those are named tickets.
type Assignment = { labels: string[]; texts: string[]; refs?: (string | undefined)[]; tickets?: Set<string> };

const delegatesBySession = new Map<string, Delegate>();

export default function ompKata(pi: any) {
	const z = pi.zod;
	const main = (ctx: any) => ctx?.agent?.kind === "main";
	let attentionSession: { id: string; cwd: string; ref?: string } | undefined;
	let coordinator: Coordinator | undefined;
	// Spawn text per task tool call; refs once a plan existed when it was seen.
	const assignments = new Map<string, Assignment>();
	const core = createKataCore({
		// omp's exec spawns with the environment it captured at startup, not later process.env changes.
		exec: async (file, args, options) => {
			const { KATA_TRANSCRIPT_AGENT: agent, KATA_TRANSCRIPT_SESSION_ID: session } = process.env;
			if (!agent || !session || args[0] !== "close") return pi.exec(file, args, options);
			const result = await pi.exec("env", [`KATA_TRANSCRIPT_AGENT=${agent}`, `KATA_TRANSCRIPT_SESSION_ID=${session}`, file, ...args], options);
			// env exits 127 when it cannot run the executable; Kata never does. Report it as the spawn failure an unwrapped call would raise.
			if (result.code === 127) throw Object.assign(new Error(`Executable not found in $PATH: "${file}"`), { code: "ENOENT", path: file });
			return result;
		},
		appendEntry: (...args) => pi.appendEntry(...args),
		getSessionName: () => pi.getSessionName?.(),
		isMain: main,
		async binding(ctx) {
			if (main(ctx)) return;
			const record = self(ctx);
			if (!record) throw new Error("Kata worker binding unavailable; the coordinator must assign this session an issue before using todo.");
			if (!record.ref || !record.binding) throw new Error(`Kata worker binding failed: ${record.prepareError || "no issue was assigned"}`);
			return { ref: record.ref, workspace: record.binding.workspace, teammate: record.teammate };
		},
		// A finished delegate that left its task open hands it back once settled.
		isDelegated: ref => [...(coordinator?.records.values() ?? [])].some(record => (record.ref || record.planRef) === ref && (record.state === "started" || record.reported !== record.state)),
		beforeReconcile: syncSnapshots,
		delegatedRunning: () => [...(coordinator?.records.values() ?? [])].some(record => record.state === "started" || (!record.ref && !record.untracked) || record.ready) ||
			(core.currentCtx?.getAsyncJobSnapshot?.()?.running ?? []).some((job: any) => job.type === "task"),
	}, { namespace: "omp", executable: EXECUTABLE, executableVars: EXECUTABLE_VARS, delegateKeys: ["omp.subagent_id"], debugFile: process.env.KATA_OMP_DEBUG });
	// /tan runs a side conversation in a sub session whose agent id omp mints as
	// `Tan-<snowflake>`; task spawns get ids from the task name or a generated name,
	// never that prefix. The id is known at the very first todo call, unlike a
	// delegate's lifecycle record, so it cannot misroute a delegate that is still
	// being registered. A record, if present, always wins.
	const untrackedTan = (ctx: any) => ctx?.agent?.kind === "sub" && /^Tan-/.test(ctx.agent.id ?? "") && !self(ctx);
	const { serial, bounded, debug, kata, actor, owned, load, bind, reconcile } = core;
	const warm = (ctx: any) => core.warm(ctx, self(ctx)?.binding?.workspace || ctx.cwd);
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
			// A delegate that matched no plan item or ticket has no issue; omp's own list serves it.
			const record = !main(ctx) ? self(ctx) : undefined;
			if (record) await prepare(record);
			if ((untrackedTan(ctx) || record?.untracked) && typeof ctx.invokeTool === "function") return ctx.invokeTool(params, { signal, onUpdate });
			if (record?.untracked) return { content: [{ type: "text" as const, text: `Subagent ${record.id} matched no plan item or ticket, so it has no Kata issue and no todo list.` }], details: { op: params.op, kata: {} }, isError: true };
			return core.execute(params, ctx);
		},
	});

	// OMP reserves built-in command names; intercept /todo before its dispatcher.
	pi.on("input", async (event: any, ctx: any) => {
		if (!main(ctx)) return;
		const match = /^\/todo(?:\s+([\s\S]*))?$/.exec(event.text.trim());
		if (!match) {
			if (event.source === "interactive" && !event.text.trim().startsWith("/")) core.resetReminders();
			return;
		}
		ctx.ui?.notify?.(await core.command(match[1] || "", ctx), "info");
		return { handled: true };
	});
	// --------------------------------------------------------------- delegates

	function self(ctx: any): Delegate | undefined {
		const file = ctx.sessionManager?.getSessionFile?.();
		const record = file ? delegatesBySession.get(sessionKey(file, ctx.cwd)) : undefined;
		return record?.id === ctx.agent?.id ? record : undefined;
	}

	function root(ctx: any): Coordinator | undefined {
		if (!main(ctx)) return self(ctx)?.coordinator;
		const id = ctx.sessionManager?.getSessionId?.();
		if (!id) return;
		if (coordinator?.id === id) return coordinator;
		if (coordinator) assignments.clear(); // a previous session's spawns
		coordinator = {
			id, records: new Map(),
			prepare: record => serial(async () => {
				// todo init and task often share one batch, so the plan may not have
				// existed when the task call was seen. Only a plan item or a named ticket
				// gets an issue; any other spawn gets none.
				const text = (record.text || record.label)?.trim();
				if (!record.ticket && !record.planRef && text) {
					await load(core.plan.workspace || ctx.cwd);
					const item = matchDelegation(core.plan.tasks, record.text ?? "", { unavailable: reserved(record), single: record.single, label: record.label });
					if (item?.ticket) { record.planRef = item.ticket; record.ticket = true; }
					else if (item) {
						// An offline plan cannot bind yet: stay undecided so a later todo call binds the replayed item.
						if (core.plan.local) return;
						record.planRef = item.ref;
					}
				}
				if (!record.planRef) { record.untracked = true; return; }
				if (!record.ticket && (!core.plan.parent || core.plan.local)) return;
				const binding: Binding = record.ticket
					? { parent: record.planRef, workspace: core.plan.workspace || ctx.cwd, sessionId: id }
					: { parent: core.plan.parent!, workspace: core.plan.workspace!, sessionId: id, auto: core.plan.auto, label: core.plan.label };
				record.binding = binding;
				const ref = record.planRef;
				let issue = JSON.parse(await kata(["show", ref, "--json"], binding.workspace)).issue;
				// Retry an interrupted transfer only if it is already ours.
				if (issue.metadata?.teammate !== record.teammate || issue.owner !== await actor(binding.workspace)) {
					issue = await owned(ref, binding.workspace, true);
					await kata(["meta", "set", ref, "teammate", record.teammate, "--if-match", String(issue.revision)], binding.workspace);
				}
				if (issue.status !== "open") throw new Error(`Delegated task ${ref} is already closed.`);
				for (const [key, value] of Object.entries({ "omp.subagent_id": record.id, "omp.session_id": id, "omp.parent_agent_id": record.parentAgentId || "main", "omp.status": "running", "todo.status": "in_progress" })) {
					await kata(["meta", "set", ref, key, value], binding.workspace);
				}
				record.ref = ref;
			}),
			settle: record => serial(async () => { await settleRecord(record); await reconcile(); }),
		};
		return coordinator;
	}

	async function settleRecord(record: Delegate) {
		if (!record.ref || !record.binding || record.state === "started" || record.reported === record.state) return;
		const cwd = record.binding.workspace;
		const view = JSON.parse(await kata(["show", record.ref, "--json"], cwd));
		if (view.issue.status !== "closed") {
			// Only observation metadata belongs to the parent; delegate work.* stays untouched.
			if (view.issue.metadata?.["omp.status"] !== record.state) await kata(["meta", "set", record.ref, "omp.status", record.state, "--if-match", String(view.issue.revision)], cwd);
			await kata(["comment", record.ref, "--idempotency-key", `omp-settle:${record.coordinator.id}:${record.id}:${record.state}`,
				"--body", `Subagent ${record.id} ${record.state} without closing its Kata issue. Review the work and supply evidence before closing.`], cwd);
			await core.handBack(record.ref, cwd, { id: record.id, teammate: record.teammate, lead: process.env.KATA_TEAMMATE || "", state: record.state, planTask: !!record.planRef });
		}
		record.reported = record.state;
	}

	async function syncSnapshots() {
		const snapshot = core.currentCtx?.getAsyncJobSnapshot?.();
		if (!coordinator || !snapshot) return;
		for (const job of snapshot.recent ?? []) {
			if (job.type !== "task" || !["completed", "failed", "aborted", "cancelled"].includes(job.status)) continue;
			const record = coordinator.records.get(job.id) || coordinator.records.get(job.agentId);
			if (!record || (snapshot.running ?? []).some((r: any) => r.id === job.id || r.agentId === record.id)) continue;
			record.state = job.status === "cancelled" ? "aborted" : job.status;
		}
		for (const record of coordinator.records.values()) {
			if (record.state !== "started" && !record.ready) {
				try { await settleRecord(record); } catch (error) { debug(error); }
			}
		}
	}

	// Unstarted assignments and running delegates hold their tasks; a settled
	// delegate has handed its task back.
	function reserved(except?: Delegate): Set<string> {
		const refs = [...assignments.values()].flatMap(a => a.refs ?? []);
		for (const record of coordinator?.records.values() ?? []) if (record !== except && (record.state === "started" || record.reported !== record.state)) refs.push(record.ref || record.planRef);
		return new Set(refs.filter((ref): ref is string => !!ref));
	}

	function prepare(record: Delegate) {
		if (record.ref || record.untracked || record.ready) return record.ready;
		record.prepareError = undefined;
		record.ready = record.coordinator.prepare(record).catch(error => {
			record.prepareError = error instanceof Error ? error.message : String(error);
			debug(error);
		}).finally(() => { record.ready = undefined; });
		return record.ready;
	}

	pi.events?.on("task:subagent:lifecycle", (event: any) => {
		if (!core.currentCtx || !event?.id) return;
		const owner = root(core.currentCtx);
		if (!owner) return;
		let record = owner.records.get(event.id);
		if (event.status === "started") {
			if (!record) {
				const assignment = main(core.currentCtx) ? assignments.get(event.parentToolCallId) : undefined;
				const text = [assignment?.texts[event.index ?? 0], event.description].filter(Boolean).join("\n");
				const planRef = assignment?.refs?.[event.index ?? 0];
				const ticket = !!planRef && !!assignment?.tickets?.has(planRef);
				if (assignment?.refs) assignment.refs[event.index ?? 0] = undefined; // the record holds it now
				record = { id: event.id, planRef, ticket, label: assignment?.labels[event.index ?? 0], text, single: (assignment?.texts.length ?? 1) === 1, teammate: teammateFor(event.id, owner.id), parentAgentId: core.currentCtx.agent?.id, sessionFile: event.sessionFile, state: "started", coordinator: owner };
				owner.records.set(event.id, record);
			}
			record.state = "started";
			record.reported = undefined;
			if (event.sessionFile) delegatesBySession.set(sessionKey(event.sessionFile, core.currentCtx.cwd), record);
			void prepare(record);
		} else if (record && ["completed", "failed", "aborted"].includes(event.status)) {
			record.state = event.status;
			const ready = prepare(record);
			if (ready) void ready.then(() => owner.settle(record!)).catch(debug);
			else void owner.settle(record).catch(debug);
		}
	});

	pi.on("tool_call", async (event: any, ctx: any) => {
		// OMP's advisor can call this main-session handler with a sub identity.
		// Keep the session coordinator attached to the actual main context.
		if (main(ctx) || !core.currentCtx || !main(core.currentCtx)) core.currentCtx = ctx;
		if (main(ctx) && event.toolName === "task" && event.toolCallId) {
			const items: any[] = Array.isArray(event.input?.tasks) ? event.input.tasks : [event.input];
			// omp's short task name is the clearest signal; the task text is the fallback.
			const labels = items.map(item => typeof item?.name === "string" ? item.name : "");
			const texts = items.map(item => [item?.task, item?.description].filter(value => typeof value === "string").join("\n"));
			const assignment: Assignment = { labels, texts };
			assignments.set(event.toolCallId, assignment);
			return serial(async () => {
				// Items that name a ticket are bindable without a plan parent.
				const planned = (!!core.plan.parent && !core.plan.local) || core.plan.tasks.some(t => t.ticket);
				if (planned) await load(core.plan.workspace || ctx.cwd);
				const tasks: Task[] = planned ? core.plan.tasks.filter(t => !core.plan.local || t.ticket) : [];
				const workspace = core.plan.workspace || ctx.cwd;
				const taken = reserved();
				const projects = await core.projectNames(workspace);
				const refs: (string | undefined)[] = [], tickets = new Set<string>();
				for (const [index, text] of texts.entries()) {
					const { tasks: named, tickets: others } = namedTargets(tasks, `${labels[index]}\n${text}`, projects, core.plan.parent);
					const targets = [...new Set([...named.map(t => t.ticket ?? t.ref), ...others])];
					if (targets.length > 1) throw new Error(`Task ${index + 1} names more than one ticket or plan item (${targets.join(", ")}). Name one ticket per task and split the work across tasks.`);
					let ticket: string;
					const direct = others[0] ?? named[0]?.ticket;
					if (direct) ticket = direct;
					else {
						if (named[0] && (taken.has(named[0].ref) || named[0].delegated)) throw new Error(`Plan task ${named[0].ref} is already delegated.`);
						const selected = planned ? matchDelegation(tasks, text, { unavailable: taken, single: texts.length === 1, label: labels[index] }) : undefined;
						if (!selected?.ticket) {
							if (selected) taken.add(selected.ref);
							refs.push(selected?.ref);
							continue;
						}
						ticket = selected.ticket;
					}
					if (taken.has(ticket)) throw new Error(`Ticket ${ticket} is already delegated.`);
					try { await owned(ticket, workspace, "check"); }
					catch (error) { throw new Error(`Task ${index + 1} names ${ticket}, which cannot be delegated: ${error instanceof Error ? error.message : error}`); }
					taken.add(ticket); tickets.add(ticket); refs.push(ticket);
				}
				assignment.refs = refs; assignment.tickets = tickets;
			}).catch(error => { assignments.delete(event.toolCallId); return { block: true, reason: String(error) }; });
		}
		if (ctx.agent?.kind !== "sub" || event.toolName !== "bash" || typeof event.input?.command !== "string") return;
		const commands = kataCommands(event.input.command);
		if (!commands.length) return;
		const record = self(ctx);
		const teammate = record?.teammate || teammateFor(ctx.agent.id);
		try { return { input: { ...event.input, command: delegateCommand(event.input.command, EXECUTABLE, EXECUTABLE_VARS, teammate, record?.binding, childSession(record)) } }; }
		catch (error) { return { block: true, reason: String(error) }; }
	});

	// A delegate's session file starts with a header carrying its own session id, the one AgentsView lists it under.
	const childSessions = new Map<string, string>();
	function childSession(record?: { sessionFile?: string }) {
		const file = record?.sessionFile;
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

	pi.on("tool_result", (event: any, ctx: any) => {
		// Started delegates hold their own tasks; a denied or partial spawn releases
		// the rest. The text stays for a delegate whose start is reported late.
		const assignment = event.toolName === "task" ? assignments.get(event.toolCallId) : undefined;
		if (assignment) assignment.refs = undefined;
		return core.observeToolResult(event, ctx);
	});
	pi.on("session_stop", async (event: any, ctx: any) => {
		const additionalContext = await core.remind(event.messages ?? [], ctx);
		if (additionalContext) return { continue: true, additionalContext };
	});

	async function prepareIfTracked(ctx: any) { const record = self(ctx); if (record) await prepare(record); }

	pi.on("before_agent_start", async (event: any, ctx: any) => {
		// omp discards the result of a revive and nothing needs the work.
		if (event.reason === "revive") return;
		await bounded(Promise.all([
			main(ctx) && core.currentId !== ctx.sessionManager?.getSessionId?.() ? serial(() => bind(ctx)) : undefined,
			(async () => { if (!main(ctx)) await prepareIfTracked(ctx); await warm(ctx); })(),
		]), main(ctx) ? 250 : 3000); // a delegate cannot learn its issue later
		const base = (Array.isArray(event.systemPrompt) ? event.systemPrompt : [event.systemPrompt || ""]).filter((s: string) => !/^<kata_(contract|todo|inbox|binding)>/.test(s));
		const sections: string[] = [];
		// Something else (an earlier injection, another installer) may already carry the contract.
		const contract = core.cache.contract;
		if (contract && !base.some((s: string) => s.includes(contract.slice(0, 80)))) sections.push(`<kata_contract>\n${contract}\n</kata_contract>`);
		const delegate = !main(ctx) ? self(ctx) : undefined;
		if (delegate?.ref && delegate.binding) {
			sections.push(`<kata_binding>\n${delegateContext(EXECUTABLE, ctx.agent.id, delegate.ref, delegate.teammate, delegate.binding)}\n</kata_binding>`);
		} else if (delegate?.untracked) {
			sections.push(`<kata_binding>\n${untrackedDelegateContext(ctx.agent.id)}\n</kata_binding>`);
		}
		if (core.cache.inbox) sections.push(`<kata_inbox>\n${core.cache.inbox}\n</kata_inbox>`);
		if (main(ctx) && (core.plan.parent || core.plan.tasks.some(t => t.ticket))) sections.push(`<kata_todo>\nThe todo tool is backed by Kata. Current plan:\n${render(core.plan)}\n</kata_todo>`);
		if (!sections.length) return;
		return { systemPrompt: [...base, sections.join("\n\n")] };
	});

	// --------------------------------------------------------------- attention

	// Kata owns session attention semantics. It has no omp harness yet; pi is the
	// closest, and the name only selects payload parsing and the session token.
	async function attention(mode: "start" | "end", session: { id: string; cwd: string; ref?: string }) {
		const ref = session.ref;
		if (!ref) return;
		try {
			// The native hook guards revisions, not the actor or teammate.
			await owned(ref, session.cwd);
			await kata(["agent-hook", "attention-native", "pi", mode, "--session", session.id, "--host-pid", String(process.pid), "--ref", ref], session.cwd, mode === "start" ? 3000 : 1500);
		} catch (err) {
			debug(`Kata attention skipped: ${(err as Error).message}`);
		}
	}

	// One provider per editor: omp rebuilds its stack from every registered factory,
	// and begin runs again on every session switch.
	const typeahead = new WeakSet<object>();
	function offerTickets(ctx: any) {
		if (!ctx.ui?.addAutocompleteProvider || typeahead.has(ctx.ui)) return;
		typeahead.add(ctx.ui);
		core.currentCtx = ctx;
		ctx.ui.addAutocompleteProvider((current: any) => ticketAutocomplete(current, core.tickets, { defaultProject: process.env.KATA_DEFAULT_PROJECT?.trim() || undefined }));
	}

	async function begin(ctx: any) {
		if (!main(ctx)) { core.currentCtx = ctx; void prepareIfTracked(ctx).then(() => warm(ctx)).catch(debug); return; }
		offerTickets(ctx);
		const explicit = process.env.KATA_REF;
		const previous = attentionSession;
		const id = ctx.sessionManager?.getSessionId?.();
		// Inherited by bash-tool and plugin closes so Kata records this omp session.
		if (id) { process.env.KATA_TRANSCRIPT_AGENT = "omp"; process.env.KATA_TRANSCRIPT_SESSION_ID = id; }
		void warm(ctx);
		await bounded(serial(async () => {
			await bind(ctx, explicit);
			core.resetReminders();
			if (!id || previous?.id === id) return;
			if (previous) await attention("end", previous);
			attentionSession = { id, cwd: core.plan.workspace || path.resolve(ctx.cwd), ref: explicit && core.plan.parent };
			await attention("start", attentionSession);
		}));
	}

	pi.on("session_start", (_event: any, ctx: any) => begin(ctx));
	pi.on("session_switch", (_event: any, ctx: any) => begin(ctx));
	pi.on("session_branch", (_event: any, ctx: any) => main(ctx) ? bounded(serial(() => bind(ctx))) : undefined);
	pi.on("session_tree", (_event: any, ctx: any) => main(ctx) ? bounded(serial(() => bind(ctx))) : undefined);
	// The transcript pair is left for the next session_start to overwrite: clearing after a slow cleanup could delete the pair of an instance omp already started in this process.
	pi.on("session_shutdown", async (_event: any, ctx: any) => {
		if (!main(ctx)) return;
		const session = attentionSession;
		attentionSession = undefined;
		// After reconcile: the automatic parent's close still records this session.
		await bounded(serial(async () => { await reconcile(); if (session) await attention("end", session); }));
	});
}
