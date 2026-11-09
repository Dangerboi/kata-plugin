import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createKataCore, DESCRIPTION, TODO_OPS, TODO_PARAMS, type Lead, type ChildParent } from "./kata-core";
import { delegateCommand, kataCommands, quote } from "./shell";
import type { DelegateRecord, DelegateStore } from "./delegates";
import { textOf } from "./model";

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

export type PiParent = ChildParent & { pid: number; provider?: string; model?: string; thinking?: string };

// A child pi started without its own model flags runs on the parent's model,
// not on the configured default (which may have no working login).
export function inheritsModel(argv: string[]): { model: boolean; thinking: boolean } {
	return { model: !argv.some(a => /^--(?:model|models|provider)(?:=|$)/.test(a)), thinking: !argv.some(a => /^--thinking(?:=|$)/.test(a)) };
}

// A command that runs pi (by name or path) in command position, after any
// env/nohup-style prefixes and assignments, or at the start of a quoted script
// (`bash -c "pi -p ..."`), may launch a child that needs the lead's parent.
// Arguments such as `grep pi` or `which pi` do not.
const PI_LAUNCH = /(?:^|[;&|(`\n]|\$\(|\b(?:ba|z|da|k)?sh\s+(?:-[a-z]+\s+)*-[a-z]*c\s+['"])\s*(?:(?:env|nohup|exec|command|time|setsid|caffeinate)\s+|[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|[^\s;&|]*)\s+)*(?:[^\s;&|()'"`]*\/)?pi(?=$|[\s;&|)])/;
export const launchesPi = (command: string) => PI_LAUNCH.test(command);

// A child's report: the text of its last assistant message that has any (a failed or cut-off turn can end on one without).
function lastAssistantText(ctx: ExtensionContext): string | undefined {
	return (ctx.sessionManager.getBranch() as any[]).filter(e => e.type === "message" && e.message?.role === "assistant")
		.map(e => textOf(e.message.content).trim()).filter(Boolean).at(-1);
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
	// An inherited lead ref is not the child's assigned issue. Keep this binding
	// isolation separate from the native adapter's session-attention ownership.
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
		exec: (file, args, { ctx: _ctx, ...options }) => pi.exec(file, args, options),
		appendEntry: (...args) => pi.appendEntry(...args),
		getSessionName: () => pi.getSessionName(),
		allowUI: ctx => ctx.hasUI === true,
		isMain: () => !inherited,
		delegateStore: store,
	}, { namespace: "pi", executable, executableVars: EXECUTABLE_VARS, explicitRef: () => inherited ? undefined : explicit, debugFile: process.env.KATA_PI_DEBUG || process.env.KATA_OMP_DEBUG });

	// Where the lead's plan lives, as the latest core call reported it.
	let lead: Lead = { workspace: path.resolve(process.cwd()) };
	// The lead moved: the main session exports where its plan lives now.
	function follow(next: Lead, ctx: ExtensionContext) {
		if (!inherited) { lead = next; exportParent(ctx); }
	}
	function exportParent(ctx: ExtensionContext) {
		if (inherited && !current?.ref) { process.env.KATA_PI_PARENT = JSON.stringify({ ...inherited, via: process.env.KATA_TEAMMATE }); return; }
		process.env.KATA_PI_PARENT = JSON.stringify({ pid: process.pid, sessionId: ctx.sessionManager.getSessionId(),
			ref: inherited ? current?.ref : lead.parent || explicit,
			workspace: inherited ? current?.binding?.workspace || inherited.workspace : lead.workspace || path.resolve(ctx.cwd),
			label: inherited ? current?.binding?.label || inherited.label : lead.label,
			teammate: process.env.KATA_TEAMMATE || "",
			...(ctx.model ? { provider: ctx.model.provider, model: ctx.model.id, thinking: pi.getThinkingLevel?.() } : {}) } satisfies PiParent);
	}

	pi.registerTool({
		name: "todo",
		label: "Todo (Kata)",
		description: DESCRIPTION,
		executionMode: "sequential",
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
		parameters: Type.Object({
			op: Type.Union(TODO_OPS.map(op => Type.Literal(op))),
			list: Type.Optional(Type.Array(Type.Object({ phase: Type.String(), items: Type.Array(Type.String(), { minItems: 1 }) }), { description: TODO_PARAMS.list })),
			task: Type.Optional(Type.String({ description: TODO_PARAMS.task })),
			phase: Type.Optional(Type.String()),
			items: Type.Optional(Type.Array(Type.String(), { description: TODO_PARAMS.items })),
			reason: Type.Optional(Type.String({ description: TODO_PARAMS.reason })),
			ref: Type.Optional(Type.String({ description: TODO_PARAMS.ref })),
			replace: Type.Optional(Type.Boolean({ description: TODO_PARAMS.replace })),
			message: Type.Optional(Type.String({ description: TODO_PARAMS.message })),
			evidence: Type.Optional(Type.Array(Type.String(), { description: TODO_PARAMS.evidence })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (inherited && current) await core.delegates.apply({ type: "nextUse", id: current.id });
			const result = await core.todo.apply(ctx, params.op, params);
			if (!inherited) {
				const plan = result.details.kata as Partial<Lead>;
				if (plan.workspace) lead = { parent: plan.parent, workspace: plan.workspace, label: plan.label };
				exportParent(ctx);
			}
			return result;
		},
	});

	pi.registerCommand("todo", {
		description: "View or update the Kata plan: start, done, drop, rm, append, block, unblock",
		async handler(args, ctx) {
			const text = await core.todo.command(ctx, args);
			// Custom messages remain observable in print/JSON as well as the TUI.
			pi.sendMessage({ customType: "kata.todo.command", content: text, display: true }, { triggerTurn: false });
		},
	});
	pi.on("input", async (event) => {
		if (event.source === "interactive" && !event.text.trim().startsWith("/")) core.session.input();
	});

	pi.on("tool_call", async (event, ctx) => {
		if (inherited && current) void core.delegates.apply({ type: "ranTool", id: current.id });
		const bash = event.toolName === "bash" && typeof event.input.command === "string";
		// A bash command that launches pi may start a child that needs the lead's parent.
		const next = await core.tools.call(ctx, { startsChild: !inherited && bash && launchesPi(event.input.command as string) });
		follow(next, ctx);
		if (!bash) return;
		let command = event.input.command as string;
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
	pi.on("tool_result", async (event, ctx) => {
		const next = await core.tools.result(ctx, { ...event, details: undefined });
		if (!inherited) lead = next;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		// A child joins the session that started it before its first prompt runs.
		if (inherited) await core.delegates.join(ctx, inherited, event.prompt || "");
		exportParent(ctx);
		const native = !inherited && nativeContractActive(ctx.cwd);
		const { sections: text, lead: next } = await core.session.beforePrompt(ctx, { context: !native });
		if (!inherited) lead = next;
		const sections = event.systemPromptOptions.sections;
		if (text.contract) sections.kata_contract = text.contract;
		if (text.inbox) sections.kata_inbox = text.inbox;
		if (text.assignment) sections.kata_binding = text.assignment;
		if (text.todo) sections.kata_todo = text.todo;
		else delete sections.kata_todo;
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		if (event.outcome !== "completed") return;
		const content = await core.session.stop(ctx, event.context.contextMessages);
		if (!content) return;
		return {
			entries: [...event.entries, { type: "custom_message" as const, customType: "kata.todo.reminder", content, display: false }],
			continue: true,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		// Closes from this process (or its bash tool) record this pi session; a child replaces the pair it inherited.
		process.env.KATA_TRANSCRIPT_AGENT = "pi";
		process.env.KATA_TRANSCRIPT_SESSION_ID = ctx.sessionManager.getSessionId();
		// A value the user already set, such as `false`, stays.
		process.env.KATA_CLOSE_TRANSCRIPT_ENABLED ??= "true";
		const saved = savedOf(ctx);
		if (saved?.parentMarker && (!explicit || inherited)) {
			const { parentMarker, ...record } = saved;
			inherited = parentMarker;
			current = record as DelegateRecord;
			process.env.KATA_TEAMMATE = saved.teammate;
			delete process.env.KATA_REF;
		}
		let next = await core.session.start(ctx, { child: inherited && !inherited.ref ? inherited.workspace : undefined });
		if (!next) { inherited = undefined; next = await core.session.start(ctx) as Lead; } // Kata does not answer from the child's workspace
		if (inherited?.provider && inherited.model) {
			const inherit = inheritsModel(process.argv);
			const model = inherit.model ? ctx.modelRegistry?.find(inherited.provider, inherited.model) : undefined;
			const same = !!model && ctx.model?.provider === model.provider && ctx.model?.id === model.id;
			const switched = same || (!!model && await pi.setModel(model).catch(() => false));
			// The parent's thinking level only fits the parent's model.
			if (switched && inherit.thinking && inherited.thinking) pi.setThinkingLevel(inherited.thinking as any);
		}
		// Only the interactive main session has an editor; session_start fires again per session.
		if (!inherited && ctx.hasUI) core.offerTickets(ctx.ui);
		follow(next, ctx);
	}); // startup/reload/new/resume/fork
	pi.on("session_tree", async (_event, ctx) => {
		follow(await core.session.tree(ctx), ctx);
	});
	// A child's shutdown is its last act; give its own issue cleanup time to finish.
	// A reload continues the same session, so it is not an ending.
	pi.on("session_shutdown", async (event, ctx) => {
		// The transcript pair is not cleared here: pi fires this on the old instance for reload/new/resume/fork, then the new instance's session_start in the same process, and a slow cleanup would delete the new pair. session_start overwrites it and process exit ends the rest.
		const record = inherited ? current : undefined;
		await core.session.shutdown(ctx, record ? { delegate: { id: record.id, ended: event?.reason !== "reload", report: lastAssistantText(ctx) } } : {});
	});
}
