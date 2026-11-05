import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createdParentRef, createKataCore, DESCRIPTION, isKataCode, kataCommands, quote, render, SHUTDOWN_BOUND_MS, teammateFor, delegateCommand, delegateContext, untrackedDelegateContext, ticketAutocomplete, type Binding } from "./kata-core";
import type { DelegateRecord, DelegateStore, Reservation } from "./delegates";

// Match the native adapter's capability/scope selection, including a project
// root boundary. Recheck at prompt time: either factory can load first.
export function nativeContractActive(cwd: string): boolean {
	const registry = (globalThis as any)[Symbol.for("kata.pi.native.v1")];
	for (const adapter of registry?.adapters?.values?.() ?? []) {
		const options = adapter?.options;
		if (!options?.contract) continue;
		if (options.scope === "user") return true;
		if (options.scope !== "project" || typeof options.workspace !== "string") continue;
		const relative = path.relative(options.workspace, path.resolve(cwd));
		if (relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))) return true;
	}
	return false;
}

export type PiParent = { pid: number; sessionId: string; ref?: string; workspace: string; label?: string; teammate: string; provider?: string; model?: string; thinking?: string };

// A child pi started without its own model flags runs on the parent's model,
// not on the configured default (which may have no working login).
export function inheritsModel(argv: string[]): { model: boolean; thinking: boolean } {
	return { model: !argv.some(a => /^--(?:model|models|provider)(?:=|$)/.test(a)), thinking: !argv.some(a => /^--thinking(?:=|$)/.test(a)) };
}

const TEAMMATE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// A command that runs pi (by name or path) in command position, after any
// env/nohup-style prefixes and assignments, or at the start of a quoted script
// (`bash -c "pi -p ..."`), may launch a child that needs the lead's parent.
// Arguments such as `grep pi` or `which pi` do not.
const PI_LAUNCH = /(?:^|[;&|(`\n]|\$\(|\b(?:ba|z|da|k)?sh\s+(?:-[a-z]+\s+)*-[a-z]*c\s+['"])\s*(?:(?:env|nohup|exec|command|time|setsid|caffeinate)\s+|[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|[^\s;&|]*)\s+)*(?:[^\s;&|()'"`]*\/)?pi(?=$|[\s;&|)])/;
export const launchesPi = (command: string) => PI_LAUNCH.test(command);

// The native adapter reuses this exact baseline on session_start. Preseed it
// when we run first; leave its captured baseline alone when we run second.
// Clearing KATA_REF is then independent of extension ordering.
export function isolateChildAttention(ctx: ExtensionContext, explicit?: string) {
	const registry = (globalThis as any)[Symbol.for("kata.pi.native.v1")];
	const cwd = path.resolve(ctx.cwd), id = ctx.sessionManager.getSessionId();
	let selected: any;
	for (const adapter of registry?.adapters?.values?.() ?? []) {
		const o = adapter.options;
		if (!o?.attention) continue;
		if (o.scope === "project") {
			const relative = path.relative(o.workspace, cwd);
			if (relative !== "" && (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))) continue;
			if (!selected || selected.options.scope !== "project" || o.workspace.length > selected.options.workspace.length) selected = adapter;
		} else if (!selected) selected = adapter;
	}
	const previous = registry?.active?.get(cwd);
	if (selected && id && (!previous || previous.id !== id || previous.ended)) {
		registry.active.set(cwd, { id, cwd, executable: selected.options.executable, ref: explicit || "", started: false, ended: false, startAttempted: false });
	}
	delete process.env.KATA_REF;
}

export default async function piKata(pi: ExtensionAPI) {
	// OMP also discovers legacy pi manifests. Do not register a second todo
	// tool there, or even ask its loader to resolve pi's TypeBox dependency.
	if ((pi as any).zod) return;
	let inherited: PiParent | undefined;
	try {
		const marker = JSON.parse(process.env.KATA_PI_PARENT || "null");
		if (marker && Number.isInteger(marker.pid) && marker.pid !== process.pid && typeof marker.sessionId === "string" && typeof marker.workspace === "string" && typeof marker.teammate === "string") inherited = marker;
	} catch { /* An invalid marker grants no parent binding. */ }
	const explicit = inherited ? undefined : process.env.KATA_REF;
	if (inherited) delete process.env.KATA_REF;
	// A child keeps its delegate record in its session branch, so resuming the session keeps its assignment.
	const DELEGATE_ENTRY = "io.kata.pi.delegate";
	let current: DelegateRecord | undefined;
	const savedOf = (ctx: ExtensionContext): (DelegateRecord & { parentMarker?: PiParent }) | undefined =>
		(ctx.sessionManager.getBranch() as any[]).filter(e => e.type === "custom" && e.customType === DELEGATE_ENTRY && e.data?.id === ctx.sessionManager.getSessionId()).at(-1)?.data;
	const store: DelegateStore = {
		records: () => current ? [current] : [],
		get: id => current?.id === id ? current : undefined,
		put: record => { current = record; pi.appendEntry(DELEGATE_ENTRY, { ...record, parentMarker: inherited }); },
		of: ctx => {
			if (current?.sessionId !== ctx.sessionManager.getSessionId()) {
				const saved = savedOf(ctx);
				if (saved) { const { parentMarker: _marker, ...record } = saved; current = record; }
			}
			return current?.sessionId === ctx.sessionManager.getSessionId() ? current : undefined;
		},
	};
	const { Type } = await import("typebox");
	const EXECUTABLE_VARS = ["KATA_PI_EXECUTABLE", "KATA_OMP_EXECUTABLE"];
	const executable = process.env.KATA_PI_EXECUTABLE || process.env.KATA_OMP_EXECUTABLE || "kata";
	const core = createKataCore({
		exec: (...args) => pi.exec(...args),
		appendEntry: (...args) => pi.appendEntry(...args),
		getSessionName: () => pi.getSessionName(),
		allowUI: ctx => ctx.hasUI === true,
		isMain: () => !inherited,
		delegateStore: store,
	}, { namespace: "pi", executable, executableVars: EXECUTABLE_VARS, explicitRef: () => inherited ? undefined : explicit, debugFile: process.env.KATA_PI_DEBUG || process.env.KATA_OMP_DEBUG });

	function exportParent(ctx: ExtensionContext) {
		process.env.KATA_PI_PARENT = JSON.stringify({ pid: process.pid, sessionId: ctx.sessionManager.getSessionId(),
			ref: inherited ? current?.ref : core.plan.parent || explicit,
			workspace: inherited ? current?.binding?.workspace || inherited.workspace : core.plan.workspace || path.resolve(ctx.cwd),
			label: inherited ? current?.binding?.label || inherited.label : core.plan.label,
			teammate: process.env.KATA_TEAMMATE || "",
			...(ctx.model ? { provider: ctx.model.provider, model: ctx.model.id, thinking: pi.getThinkingLevel?.() } : {}) } satisfies PiParent);
	}
	async function prepareDelegate(ctx: ExtensionContext, prompt: string) {
		if (!inherited) return;
		const known = store.of(ctx);
		if (known) {
			process.env.KATA_TEAMMATE = known.teammate;
			process.env.KATA_INBOX_USER = `${await core.actor(known.binding?.workspace ?? inherited.workspace, known.ref ?? inherited.ref)}/${known.teammate}`;
			await core.delegates.apply({ type: "nextUse", id: known.id });
			exportParent(ctx);
			return;
		}
		const id = ctx.sessionManager.getSessionId();
		if (!id) throw new Error("Pi child needs a real session identity before tracking work.");
		if (!inherited.ref) {
			const workspace = inherited.workspace;
			await core.serial(async () => { await core.probe(workspace); }); // after any bind in flight
			const project = core.candidate(workspace).project;
			let found: any[] = [];
			try { found = JSON.parse(await core.kata(["list", "--status", "all", ...(project ? ["--project", project] : []), "--meta", `pi.session_id=${inherited.sessionId}`, "--label", "pi-session", "--limit", "2", "--json"], inherited.workspace)).issues ?? []; }
			catch (error) { if (!project || !isKataCode(error, "project_not_initialized")) throw error; } // the project is not registered yet: no earlier parent
			const parent = found.find((issue: any) => issue.metadata?.["pi.auto_parent"] === true);
			if (parent) inherited.ref = parent.qualified_id;
			else {
				// A session-start extension can spawn before the lead uses todo.
				// Establish only parent identity; the child never writes lead work.*.
				const where = await core.destination(inherited.workspace);
				inherited.label ??= where.label;
				const out = JSON.parse(await core.kata(["create", "Todo plan: tasks", ...(where.project ? ["--project", where.project] : []), ...(where.label ? ["--label", where.label] : []), "--body", `Todo plan from pi session ${inherited.sessionId}.`,
					"--teammate", inherited.teammate,
					"--meta", `pi.session_id=${inherited.sessionId}`, "--meta", `pi.workspace=${inherited.workspace}`, "--label", "pi-session",
					"--idempotency-key", `pi-session:${inherited.sessionId}`, "--force-new", "--json"], inherited.workspace));
				inherited.ref = createdParentRef(out);
				if (!out.issue.owner) await core.kata(["claim", inherited.ref!, "--if-unowned", "--teammate", inherited.teammate], inherited.workspace);
				await core.kata(["meta", "set", inherited.ref!, "pi.auto_parent", "true", "--json-value"], inherited.workspace);
			}
		}
		if (!inherited.ref) throw new Error("Pi child parent identity is unavailable.");
		// The lead may have moved the parent since it exported this marker: the child's issue goes where the parent lives now.
		const binding: Binding = { parent: await core.pin(inherited.ref, inherited.workspace), workspace: inherited.workspace, sessionId: inherited.sessionId, auto: false, label: inherited.label };
		// Keep a teammate the lead chose for this child; otherwise derive a distinct one.
		const chosen = process.env.KATA_TEAMMATE || "";
		const teammate = chosen && chosen !== inherited.teammate && TEAMMATE.test(chosen) ? chosen : teammateFor(`${inherited.teammate || "pi"}:${inherited.sessionId}:${id}`);
		process.env.KATA_TEAMMATE = teammate;
		process.env.KATA_INBOX_USER = `${await core.actor(binding.workspace, binding.parent)}/${teammate}`;
		const scope = { parent: binding.parent, workspace: binding.workspace, label: binding.label, leadTeammate: inherited.teammate, teammate };
		// A prompt the assignment rules refuse (two tickets, a taken task) tracks nothing.
		let reserved: Reservation | undefined, untracked = false;
		try { reserved = (await core.delegates.check([{ text: prompt }], [], scope))[0]; }
		catch (error) { core.debug(error); untracked = true; }
		await core.delegates.apply({ type: "started", id, sessionId: id, leadSessionId: inherited.sessionId, leadTeammate: inherited.teammate, teammate, text: prompt, single: true, observesTools: true,
			parent: binding.parent, workspace: binding.workspace, parentLabel: binding.label, reserved, untracked });
		exportParent(ctx);
	}

	pi.registerTool({
		name: "todo",
		label: "Todo (Kata)",
		description: DESCRIPTION,
		executionMode: "sequential",
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
		parameters: Type.Object({
			op: Type.Union(["init", "start", "done", "rm", "drop", "block", "unblock", "append", "view"].map(op => Type.Literal(op))),
			list: Type.Optional(Type.Array(Type.Object({ phase: Type.String(), items: Type.Array(Type.String(), { minItems: 1 }) }), { description: "phases for init" })),
			task: Type.Optional(Type.String({ description: "verbatim task content or Kata ref" })),
			phase: Type.Optional(Type.String()),
			items: Type.Optional(Type.Array(Type.String(), { description: "tasks for flat init or append" })),
			reason: Type.Optional(Type.String({ description: "blocker note for block" })),
			ref: Type.Optional(Type.String({ description: "existing Kata issue this plan serves (init)" })),
			replace: Type.Optional(Type.Boolean({ description: "init: replace a plan that still has open tasks (they close as wontfix); without it init refuses" })),
			message: Type.Optional(Type.String({ description: "done: changes and verification (40+ characters); drop/rm: reason; init without ref: title for the automatic parent" })),
			evidence: Type.Optional(Type.Array(Type.String(), { description: "required for done: commit:<sha>, test:<cmd>, pr:<url>, reviewed-paths:<path>" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (inherited && current) await core.delegates.apply({ type: "nextUse", id: current.id });
			const result = await core.execute(params, ctx);
			if (!inherited) exportParent(ctx);
			return result;
		},
	});

	pi.registerCommand("todo", {
		description: "View or update the Kata plan: start, done, drop, rm, append, block, unblock",
		async handler(args, ctx) {
			const text = await core.command(args, ctx);
			// Custom messages remain observable in print/JSON as well as the TUI.
			pi.sendMessage({ customType: "kata.todo.command", content: text, display: true }, { triggerTurn: false });
		},
	});
	pi.on("input", async (event) => {
		if (event.source === "interactive" && !event.text.trim().startsWith("/")) core.resetReminders();
	});

	pi.on("tool_call", async (event, ctx) => {
		if (inherited) { if (current) void core.delegates.apply({ type: "ranTool", id: current.id }); }
		else if (event.toolName === "bash" && typeof event.input.command === "string" && launchesPi(event.input.command)) {
			await core.serial(async () => { await core.ensureParent({}, ctx); exportParent(ctx); });
		} else exportParent(ctx);
		if (event.toolName !== "bash" || typeof event.input.command !== "string") return;
		let command = event.input.command;
		if (inherited) {
			if (!current) return { block: true, reason: "Kata child binding is unavailable; retry after parent startup." };
			try { command = delegateCommand(command, executable, EXECUTABLE_VARS, current.teammate, current.binding); }
			catch (error) { return { block: true, reason: String(error) }; }
		}
		for (const invocation of kataCommands(command, executable, EXECUTABLE_VARS).reverse()) {
			if (invocation.executable.value !== "kata" || executable === "kata") continue;
			command = command.slice(0, invocation.executable.start) + quote(executable) + command.slice(invocation.executable.end);
		}
		event.input.command = command;
	});
	pi.on("tool_result", (event, ctx) => core.observeToolResult({ ...event, details: undefined }, ctx));

	pi.on("before_agent_start", async (event, ctx) => {
		if (inherited) await prepareDelegate(ctx, event.prompt || "");
		else exportParent(ctx);
		const native = !inherited && nativeContractActive(ctx.cwd);
		await core.bounded(Promise.all([
			core.currentId !== ctx.sessionManager.getSessionId() ? core.serial(() => core.bind(ctx, explicit)) : undefined,
			native ? undefined : core.warm(ctx, current?.binding?.workspace || ctx.cwd),
		]));
		const sections = event.systemPromptOptions.sections;
		if (!native) {
			if (core.cache.contract) sections.kata_contract = core.cache.contract;
			if (core.cache.inbox) sections.kata_inbox = core.cache.inbox;
		}
		const assigned = inherited ? core.delegates.assignment(ctx) : undefined;
		if (assigned) sections.kata_binding = delegateContext(executable, current!.id, assigned.ref, assigned.teammate, assigned.binding);
		else if (current?.state === "untracked") sections.kata_binding = untrackedDelegateContext(current.id);
		if (core.plan.parent || core.plan.tasks.some(t => t.ticket)) sections.kata_todo = `The todo tool is backed by Kata. Current plan:\n${render(core.plan)}`;
		else delete sections.kata_todo;
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		if (event.outcome !== "completed") return;
		const content = await core.remind(event.context.contextMessages, ctx);
		if (!content) return;
		return {
			entries: [...event.entries, { type: "custom_message" as const, customType: "kata.todo.reminder", content, display: false }],
			continue: true,
		};
	});

	const bind = (ctx: ExtensionContext) => core.bounded(core.serial(async () => {
		await core.bind(ctx, explicit);
		if (!inherited) exportParent(ctx);
		core.resetReminders();
	}));
	const typeahead = new WeakSet<object>();
	pi.on("session_start", async (_event, ctx) => {
		// Closes from this process (or its bash tool) record this pi session; a child replaces the pair it inherited.
		process.env.KATA_TRANSCRIPT_AGENT = "pi";
		process.env.KATA_TRANSCRIPT_SESSION_ID = ctx.sessionManager.getSessionId();
		const saved = savedOf(ctx);
		if (saved?.parentMarker && (!explicit || inherited)) {
			const { parentMarker, ...record } = saved;
			inherited = parentMarker;
			current = record as DelegateRecord;
			process.env.KATA_TEAMMATE = saved.teammate;
			delete process.env.KATA_REF;
		}
		if (inherited && !inherited.ref && !await core.probe(inherited.workspace)) inherited = undefined;
		if (inherited?.provider && inherited.model) {
			const inherit = inheritsModel(process.argv);
			const model = inherit.model ? ctx.modelRegistry?.find(inherited.provider, inherited.model) : undefined;
			const same = !!model && ctx.model?.provider === model.provider && ctx.model?.id === model.id;
			const switched = same || (!!model && await pi.setModel(model).catch(error => { core.debug(error); return false; }));
			// The parent's thinking level only fits the parent's model.
			if (switched && inherit.thinking && inherited.thinking) pi.setThinkingLevel(inherited.thinking as any);
		}
		// Only the interactive main session has an editor; session_start fires again per session.
		if (!inherited && ctx.hasUI && ctx.ui.addAutocompleteProvider && !typeahead.has(ctx.ui)) {
			typeahead.add(ctx.ui);
			core.currentCtx = ctx;
			ctx.ui.addAutocompleteProvider(current => ticketAutocomplete(current, core.tickets, { defaultProject: process.env.KATA_DEFAULT_PROJECT?.trim() || undefined }));
		}
		isolateChildAttention(ctx, inherited ? undefined : explicit);
		return bind(ctx);
	}); // startup/reload/new/resume/fork
	pi.on("session_tree", (_event, ctx) => core.bounded(core.serial(async () => {
		await core.bind(ctx, explicit);
		if (!inherited) exportParent(ctx);
		await core.drain();
	})));
	// A child's shutdown is its last act; give its own issue cleanup time to finish.
	// A reload continues the same session, so it is not an ending.
	pi.on("session_shutdown", async (event, ctx) => {
		// The transcript pair is not cleared here: pi fires this on the old instance for reload/new/resume/fork, then the new instance's session_start in the same process, and a slow cleanup would delete the new pair. session_start overwrites it and process exit ends the rest.
		const record = inherited ? current : undefined;
		await core.bounded((async () => {
			await core.serial(async () => {
				await core.load(core.plan.workspace || ctx.cwd);
				await core.drain();
			});
			if (record && event?.reason !== "reload") await core.delegates.apply({ type: "exited", id: record.id, outcome: "ended" });
		})(), record ? 3000 : SHUTDOWN_BOUND_MS);
	});
}
