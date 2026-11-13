// A fake OpenCode 2.2.7 host for the Promise plugin API (`@opencode/plugin`, `{ id, setup(ctx) }`).
// Shapes follow the published types (package/dist/promise/*.d.ts) and the v2.2.7 source:
//   packages/core/src/plugin/host.ts        ctx wiring, storage namespace, session/tool/event domains
//   packages/core/src/plugin/hooks.ts       hooks run sequentially in registration order, in place on one event object
//   packages/plugin/src/promise/adapter.ts  Promise ctx, `toolError`, cleanup run when the scope closes
//   packages/core/src/tool.ts               execute.before -> execute -> execute.after, `Tool.Error` handling
//   packages/core/src/tool/runtime.ts       `effectiveName`, `normalizeContent`
// Deviations are listed next to the code that makes them.

type Json = unknown;

export interface OpenCodePlugin {
	readonly id: string;
	readonly setup: (ctx: any) => Promise<(() => Promise<void> | void) | void> | (() => Promise<void> | void) | void;
}

export type ToolExecute = (input: any, context: any) => Promise<any> | any;

export interface BuiltinTool {
	description?: string;
	input?: unknown;
	execute: ToolExecute;
}

export interface OpenCodeHostOptions {
	plugin: OpenCodePlugin;
	/** `ctx.options`. */
	options?: Record<string, unknown>;
	/** `ctx.location.directory`. */
	directory?: string;
	workspaceID?: string;
	/** Tools OpenCode ships (e.g. `shell`, `subagent`, `todowrite`): seeded into the tool editor before plugin transforms run, so a plugin can see and override them. */
	builtins?: Record<string, BuiltinTool>;
	/** How often each rebuild of the tool registry replays the plugin's transform callbacks (the spike saw several). Default 2. */
	replays?: number;
}

export interface FakeSession {
	id: string;
	parentID?: string;
	title?: string;
	location: { directory: string; workspaceID?: string };
	messages: any[];
	created: number;
	/** When the session was archived (`time.archived` of `session.get`); a test sets and clears it. */
	archived?: number;
}

export interface CreateSessionInput {
	id?: string;
	parentID?: string;
	title?: string;
	messages?: any[];
}

export interface ToolCallOptions {
	callID?: string;
	messageID?: string;
	agent?: string;
	/** Executor for this call only; takes precedence over registered and builtin tools. */
	execute?: ToolExecute;
}

export interface ToolCallResult {
	status: "completed" | "error";
	/** Text content of the result, or the error message. */
	text: string;
	output?: unknown;
	content: { type: string; text?: string }[];
	metadata?: unknown;
	error?: { message: string; error?: unknown };
	/** The input the tool ran with (after `execute.before` hooks), or was refused with. */
	input: any;
	/** Whether the tool's execute ran. */
	executed: boolean;
	id: string;
}

export interface RecordedCall {
	tool: string;
	sessionID: string;
	id: string;
	/** Snapshot of the input as the model sent it. */
	originalInput: unknown;
	/** Snapshot of the input the call ended with. */
	input: unknown;
	status: "completed" | "error";
	text: string;
	executed: boolean;
	/** `progress` updates the tool reported. */
	progress: unknown[];
}

interface Shared {
	sessions: Map<string, FakeSession>;
	/** One KV for every plugin and location, like `KV.Service`; survives `restart()`. Values are JSON strings. */
	kv: Map<string, string>;
	counter: { next: number };
}

export interface OpenCodeInstance {
	readonly ctx: any;
	readonly shared: Shared;
	readonly sessions: Map<string, FakeSession>;
	/** Every call `callTool` made on this instance. */
	readonly calls: RecordedCall[];
	/** Registration errors the tool editor reported (invalid definitions are skipped, like OpenCode). */
	readonly registrationErrors: { name: string; message: string }[];
	/** How many times plugin transform callbacks ran. */
	transformRuns: number;
	/** Registered tools after every transform, keyed by effective name. */
	tools(): Map<string, any>;
	tool(name: string): any | undefined;
	createSession(input?: CreateSessionInput): FakeSession;
	addMessage(sessionID: string, message: any): void;
	/** Appends an assistant message whose content is one text part. */
	addAssistantText(sessionID: string, text: string): void;
	callTool(sessionID: string, toolName: string, input: unknown, options?: ToolCallOptions): Promise<ToolCallResult>;
	/** Runs the `context` hooks; returns the final event and the system text parts. */
	context(sessionID: string, options?: { first?: boolean; messages?: any[]; system?: any[] }): Promise<{ event: any; system: string[] }>;
	/** Pushes one event to every matching `ctx.event.subscribe` stream and lets consumers run. */
	emit(type: string, data?: Record<string, unknown>): Promise<void>;
	/** `emit("session.created", ...)` with the data taken from the session. */
	emitCreated(sessionID: string): Promise<void>;
	/** Rebuilds the tool registry, as `ctx.tool.reload()` does. */
	reload(): Promise<void>;
	/** Runs the plugin's cleanup, ends event streams and drops its hooks and tools. Idempotent. */
	shutdown(): Promise<void>;
	/** A server restart: shuts this instance down, then runs `setup` again on the same storage and sessions. */
	restart(): Promise<OpenCodeInstance>;
}

export function assistantMessage(text: string, extra: Record<string, unknown> = {}) {
	return { type: "assistant", agent: "build", model: { providerID: "fake", id: "fake" }, content: [{ type: "text", text }], time: { created: 0 }, ...extra };
}

export function userMessage(text: string, extra: Record<string, unknown> = {}) {
	return { type: "user", text, ...extra };
}

/** Loads the plugin against a fresh fake host and runs its `setup`. */
export async function openCodeHost(options: OpenCodeHostOptions): Promise<OpenCodeInstance> {
	return start(options, { sessions: new Map(), kv: new Map(), counter: { next: 1 } });
}

const clone = <T>(value: T): T => (value === undefined ? value : structuredClone(value));
const json = (value: unknown) => JSON.stringify(value);
const stringify = (value: unknown) => (typeof value === "string" ? value : (JSON.stringify(value) ?? String(value)));

// tool/runtime.ts `effectiveName` (normalizedName is not applied: it only matters for names with unusual characters).
const effectiveName = (tool: { name: string; options?: { namespace?: string } }) =>
	tool.options?.namespace === undefined ? tool.name : `${tool.options.namespace.replaceAll(".", "_")}_${tool.name}`;

// tool/runtime.ts `normalizeContent`
const normalizeContent = (value: unknown, output?: unknown): { type: string; text?: string }[] => {
	if (typeof value === "string") return [{ type: "text", text: value }];
	if (Array.isArray(value) && value.length > 0) return [...value];
	return [{ type: "text", text: stringify(output) }];
};

// plugin/src/promise/adapter.ts `toolError`
const toolError = (error: any) => ({ message: error instanceof Error ? error.message : String(error), error });

const tick = () => {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
};

const unsupported = (name: string) => {
	throw new Error(`fake OpenCode host does not provide ctx.${name}`);
};

async function start(options: OpenCodeHostOptions, shared: Shared): Promise<OpenCodeInstance> {
	const { plugin } = options;
	const directory = options.directory ?? "/fake/workspace";
	const calls: RecordedCall[] = [], registrationErrors: { name: string; message: string }[] = [];
	const transforms: ((editor: any) => void)[] = [];
	const hooks = { before: [] as ((event: any) => any)[], after: [] as ((event: any) => any)[], context: [] as ((event: any) => any)[] };
	const subscribers = new Set<{ types?: readonly string[]; push: (event: any) => void; end: () => void; idle: () => Promise<void> }>();
	let registry = new Map<string, any>();
	let stopped = false, cleanup: (() => Promise<void> | void) | undefined;
	const instance = { transformRuns: 0 } as { transformRuns: number };

	const seedBuiltins = () => {
		const tools = new Map<string, any>();
		for (const [name, tool] of Object.entries(options.builtins ?? {}))
			tools.set(name, { name, id: name, description: tool.description ?? "", input: tool.input ?? { type: "object" }, execute: tool.execute });
		return tools;
	};

	// Tool.Service state: every rebuild runs all transforms on a fresh editor. Real OpenCode replays them on reload and
	// config changes; the number of replays per rebuild is a guess, the spike only said "several".
	const rebuild = () => {
		let tools = seedBuiltins();
		for (let run = 0; run < (options.replays ?? 2); run++) {
			tools = seedBuiltins();
			const editor = {
				list: () => [...tools.values()],
				get: (id: string) => tools.get(id),
				namespace: () => {},
				add: (tool: any) => {
					const id = effectiveName(tool);
					if (tool.options?.codemode === false && id === "execute")
						return void registrationErrors.push({ name: id, message: 'Tool name "execute" is reserved for CodeMode' });
					if ((typeof tool.input !== "object" && typeof tool.input !== "function") || tool.input === null)
						return void registrationErrors.push({ name: id, message: `Invalid tool definition ${id}: input must be a schema` });
					tools.set(id, { ...tool, id, options: tool.options && { ...tool.options } });
				},
				update: (id: string, update: (tool: any) => void) => {
					const current = tools.get(id);
					if (!current) return;
					const tool = { ...current, options: current.options && { ...current.options } };
					update(tool);
					tool.name = current.name;
					tool.id = id;
					tools.set(id, tool);
				},
				remove: (id: string) => void tools.delete(id),
			};
			for (const transform of [...transforms]) {
				instance.transformRuns++;
				transform(editor);
			}
		}
		registry = tools;
	};

	const registration = <T>(list: T[], item: T, after?: () => void) => {
		list.push(item);
		return Promise.resolve({
			dispose: async () => {
				const index = list.indexOf(item);
				if (index >= 0) list.splice(index, 1);
				after?.();
			},
		});
	};

	const encodeSession = (session: FakeSession) => ({
		id: session.id,
		...(session.parentID === undefined ? {} : { parentID: session.parentID }),
		projectID: "prj_fake",
		cost: 0,
		tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
		time: { created: session.created, updated: session.created, ...(session.archived === undefined ? {} : { archived: session.archived }) },
		...(session.title === undefined ? {} : { title: session.title }),
		location: { directory: session.location.directory, ...(session.location.workspaceID === undefined ? {} : { workspaceID: session.location.workspaceID }) },
	});

	const requireSession = (sessionID: string) => {
		const session = shared.sessions.get(sessionID);
		// The real host (OpenCode 2.2.7) rejects with an Error whose own keys are `_tag` and `sessionID`, `name` equals `_tag` and `message` is empty.
		if (!session) throw Object.assign(new Error(""), { name: "Session.NotFoundError", _tag: "Session.NotFoundError", sessionID });
		return session;
	};

	// host.ts `storage()`: one namespace per plugin id, hex-encoded, in a KV shared by every location.
	const namespace = `plugin:${plugin.id.split("").map((c) => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:`;
	const storage = {
		get: async (key: string) => {
			const value = shared.kv.get(namespace + key);
			return value === undefined ? undefined : JSON.parse(value);
		},
		set: async (key: string, value: Json) => void shared.kv.set(namespace + key, json(value)),
		remove: async (key: string) => void shared.kv.delete(namespace + key),
		scan: async (scan: { prefix: string; after?: string; limit?: number }) => {
			const limit = Number.isNaN(scan.limit) ? 100 : Math.min(Math.max(Math.floor(scan.limit ?? 100), 1), 1000);
			const rows = [...shared.kv.keys()]
				.filter((key) => key.startsWith(namespace + scan.prefix) && (scan.after === undefined || key > namespace + scan.after))
				.sort()
				.map((key) => ({ key: key.slice(namespace.length), value: JSON.parse(shared.kv.get(key)!) }));
			const entries = rows.slice(0, limit);
			return rows.length <= limit ? { entries } : { entries, next: entries[entries.length - 1]!.key };
		},
	};

	const ctx: any = {
		location: { directory, ...(options.workspaceID === undefined ? {} : { workspaceID: options.workspaceID }), project: { id: "prj_fake", directory, canonical: directory } },
		options: options.options ?? {},
		storage,
		tool: {
			transform: (callback: (editor: any) => void) => registration(transforms, callback, rebuild).then((handle) => (rebuild(), handle)),
			reload: async () => rebuild(),
			list: async () => [...registry.values()],
			hook: (name: string, callback: (event: any) => any) => {
				if (name === "execute.before") return registration(hooks.before, callback);
				if (name === "execute.after") return registration(hooks.after, callback);
				throw new Error(`fake OpenCode host does not provide tool hook ${name}`);
			},
		},
		session: {
			hook: (name: string, callback: (event: any) => any) => {
				if (name !== "context") throw new Error(`fake OpenCode host does not provide session hook ${name}`);
				return registration(hooks.context, callback);
			},
			get: async (input: { sessionID: string }) => encodeSession(requireSession(input.sessionID)),
			// SessionDomain.context: the session's messages (SessionMessage.Info[]), the only message read the Promise ctx offers.
			context: async (input: { sessionID: string }) => clone(requireSession(input.sessionID).messages),
		},
		event: {
			// host.ts `event.subscribe`: only the requested types arrive; `types` omitted means every public event.
			// The abort signal ends the stream. No `server.connected` is injected: the host bus never sends it.
			subscribe: (subscribe?: { types?: readonly string[]; signal?: AbortSignal }) => ({
				[Symbol.asyncIterator]() {
					const queue: any[] = [], waiting: ((result: IteratorResult<any>) => void)[] = [], idleWaiters: (() => void)[] = [];
					let done = false;
					// Idle: the consumer has finished its earlier events and asked for the next one (or its stream ended).
					const isIdle = () => done || (waiting.length > 0 && queue.length === 0);
					const wakeIdle = () => { if (isIdle()) for (const wake of idleWaiters.splice(0)) wake(); };
					const end = () => {
						done = true;
						subscribers.delete(entry);
						for (const wake of waiting.splice(0)) wake({ value: undefined, done: true });
						wakeIdle();
					};
					const entry = {
						types: subscribe?.types?.length ? subscribe.types : undefined,
						push: (event: any) => {
							const wake = waiting.shift();
							if (wake) wake({ value: event, done: false });
							else queue.push(event);
						},
						end,
						idle: () => {
							if (isIdle()) return Promise.resolve();
							const { promise, resolve } = Promise.withResolvers<void>();
							idleWaiters.push(resolve);
							return promise;
						},
					};
					if (stopped || subscribe?.signal?.aborted) done = true;
					else {
						subscribers.add(entry);
						subscribe?.signal?.addEventListener("abort", end, { once: true });
					}
					return {
						next: () => {
							if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
							if (done) return Promise.resolve({ value: undefined, done: true });
							const { promise, resolve } = Promise.withResolvers<IteratorResult<any>>();
							waiting.push(resolve);
							wakeIdle();
							return promise;
						},
						return: async () => (end(), { value: undefined, done: true }),
					};
				},
			}),
		},
	};

	// Domains the fake does not model fail loudly instead of returning undefined.
	const guarded = new Proxy(ctx, {
		get: (target, key) => (key in target || typeof key === "symbol" || key === "then" || key === "toJSON" ? target[key] : unsupported(String(key))),
	});

	const nextID = (prefix: string) => `${prefix}_${String(shared.counter.next++).padStart(4, "0")}`;

	// Hooks run one after another on the same event object (hooks.ts `trigger`).
	const trigger = async (list: ((event: any) => any)[], event: any) => {
		for (const hook of [...list]) await hook(event);
		return event;
	};

	const run = async (sessionID: string, name: string, rawInput: unknown, opts: ToolCallOptions = {}): Promise<ToolCallResult> => {
		requireSession(sessionID);
		const id = opts.callID ?? nextID("call");
		const base = { sessionID, agent: opts.agent ?? "build", messageID: opts.messageID ?? nextID("msg"), id };
		const before = { tool: name, ...base, input: clone(rawInput) as any };
		const record: RecordedCall = { tool: name, sessionID, id, originalInput: clone(rawInput), input: undefined, status: "completed", text: "", executed: false, progress: [] };
		calls.push(record);
		const finish = (result: Omit<ToolCallResult, "input" | "id" | "executed"> & { executed?: boolean }, input: unknown): ToolCallResult => {
			record.input = clone(input);
			record.status = result.status;
			record.text = result.text;
			record.executed = result.executed ?? false;
			return { executed: false, ...result, input, id };
		};
		const fail = (error: { message: string; error?: unknown }, input: unknown, executed: boolean) =>
			finish({ status: "error", text: error.message, content: [{ type: "text", text: error.message }], error, executed }, input);

		// A throw in execute.before ends the call as an error: neither the tool nor execute.after runs (tool.ts `run`).
		try {
			await trigger(hooks.before, before);
		} catch (error) {
			return fail(toolError(error), before.input, false);
		}
		const input = before.input;
		const tool = opts.execute ? { execute: opts.execute } : registry.get(name);
		if (!tool) throw new Error(`fake OpenCode host has no tool ${name}: register it with a plugin or pass builtins/execute`);

		// Deviation: the registered input schema is not validated (OpenCode decodes and may fail with a Tool.Error).
		const toolContext = {
			...base,
			signal: new AbortController().signal,
			progress: async (update: unknown) => void record.progress.push(clone(update)),
		};
		let failure: { message: string; error?: unknown } | undefined, result: any;
		try {
			const value = (await tool.execute(clone(input), toolContext)) ?? {};
			// Deviation: a bare string return is accepted as content (the real API requires { content }).
			const raw = typeof value === "string" ? { content: value } : value;
			result = { ...("output" in raw ? { output: raw.output } : {}), content: normalizeContent(raw.content, raw.output), ...(raw.metadata === undefined ? {} : { metadata: raw.metadata }) };
		} catch (error) {
			failure = toolError(error);
		}

		// execute.after runs for both outcomes and may edit `result` or `error`. A throw in it is a defect in OpenCode
		// (`Effect.promise`); here the rejection propagates out of callTool.
		const after: any = failure ? { tool: name, ...base, input, status: "error", error: failure } : { tool: name, ...base, input, status: "completed", result };
		await trigger(hooks.after, after);
		if (after.status === "error") return fail(after.error, input, true);
		const content = normalizeContent(after.result.content, after.result.output);
		const text = content.map((part) => part.text ?? "").join("\n");
		return finish({ status: "completed", text, content, ...("output" in after.result ? { output: after.result.output } : {}), ...(after.result.metadata === undefined ? {} : { metadata: after.result.metadata }), executed: true }, input);
	};

	const self: OpenCodeInstance = Object.assign(instance, {
		ctx: guarded,
		shared,
		sessions: shared.sessions,
		calls,
		registrationErrors,
		tools: () => new Map(registry),
		tool: (name: string) => registry.get(name),
		createSession(input: CreateSessionInput = {}) {
			const session: FakeSession = {
				id: input.id ?? nextID("ses"),
				...(input.parentID === undefined ? {} : { parentID: input.parentID }),
				...(input.title === undefined ? {} : { title: input.title }),
				location: { directory, ...(options.workspaceID === undefined ? {} : { workspaceID: options.workspaceID }) },
				messages: clone(input.messages ?? []),
				created: Date.now(),
			};
			shared.sessions.set(session.id, session);
			return session;
		},
		addMessage: (sessionID: string, message: any) => void requireSession(sessionID).messages.push({ id: nextID("msg"), ...clone(message) }),
		addAssistantText(sessionID: string, text: string) {
			self.addMessage(sessionID, assistantMessage(text));
		},
		callTool: run,
		async context(sessionID: string, opts: { first?: boolean; messages?: any[]; system?: any[] } = {}) {
			const session = requireSession(sessionID);
			// SessionContext (session.d.ts) has no `first`; it is added because the plugin contract asked for it.
			const event: any = {
				sessionID,
				agent: "build",
				model: { providerID: "fake", id: "fake" },
				tools: {},
				options: {},
				system: clone(opts.system ?? []),
				messages: clone(opts.messages ?? session.messages),
				first: opts.first ?? session.messages.length <= 1,
			};
			await trigger(hooks.context, event);
			// system parts are { type: "text", text }; bare strings are tolerated.
			return { event, system: event.system.map((part: any) => (typeof part === "string" ? part : part.text)) };
		},
		async emit(type: string, data: Record<string, unknown> = {}) {
			const event = { id: nextID("evt"), type, created: Date.now(), data: clone(data) };
			const receivers = [...subscribers].filter((subscriber) => !subscriber.types || subscriber.types.includes(type));
			for (const subscriber of receivers) subscriber.push(clone(event));
			// Resolves once every receiving consumer has finished the event and asked for the next one (or its stream ended),
			// so a test can assert on what the plugin's handlers did. A consumer that never asks again is a plugin defect.
			const stuck = Symbol("stuck");
			const timer = Promise.withResolvers<typeof stuck>();
			const handle = setTimeout(() => timer.resolve(stuck), 30_000);
			const outcome = await Promise.race([Promise.all(receivers.map((subscriber) => subscriber.idle())), timer.promise]);
			clearTimeout(handle);
			if (outcome === stuck) throw new Error(`fake OpenCode host: a ${type} consumer did not ask for its next event within 30 s`);
			await tick();
		},
		async emitCreated(sessionID: string) {
			const session = requireSession(sessionID);
			await self.emit("session.created", {
				sessionID,
				projectID: "prj_fake",
				location: session.location,
				...(session.parentID === undefined ? {} : { parentID: session.parentID }),
				slug: session.id,
				...(session.title === undefined ? {} : { title: session.title }),
				version: "2.2.7",
			});
		},
		reload: async () => rebuild(),
		async shutdown() {
			if (stopped) return;
			stopped = true;
			try {
				await cleanup?.();
			} finally {
				for (const subscriber of [...subscribers]) subscriber.end();
				transforms.length = hooks.before.length = hooks.after.length = hooks.context.length = 0;
				registry = new Map();
			}
		},
		async restart() {
			await self.shutdown();
			return start(options, shared);
		},
	});

	// setup may return a cleanup function (adapter.ts acquireRelease).
	const result = await plugin.setup(guarded);
	if (typeof result === "function") cleanup = result;
	return self;
}
