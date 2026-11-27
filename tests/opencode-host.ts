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

export interface OpenCodeHostOptions {
	plugin: OpenCodePlugin;
	/** `ctx.options`. */
	options?: Record<string, unknown>;
	/** `ctx.location.directory`. */
	directory?: string;
	/** Settles once the plugin set up with `ctx` has handled the events emitted so far, for a plugin whose consumer takes the next event before it has handled the last. `emit` waits for it. */
	eventsHandled?: (ctx: any) => Promise<void>;
}

export interface FakeSession {
	id: string;
	parentID?: string;
	title?: string;
	location: { directory: string };
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
	codemode?: boolean;
	/** Executor for this call only; takes precedence over the registered tool. */
	execute?: ToolExecute;
}

export interface ToolCallResult {
	status: "completed" | "error";
	/** Text content of the result, or the error message. */
	text: string;
	/** What the tool returned as `metadata`, after `execute.after` hooks. */
	metadata?: unknown;
	/** The input the tool ran with (after `execute.before` hooks), or was refused with. */
	input: any;
	/** Whether the tool's execute ran. */
	executed: boolean;
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
	/** Registration errors the tool editor reported (invalid definitions are skipped, like OpenCode). */
	readonly registrationErrors: { name: string; message: string }[];
	/** Registered tools after the plugin's transforms, keyed by effective name. */
	tools(): Map<string, any>;
	tool(name: string): any | undefined;
	createSession(input?: CreateSessionInput): FakeSession;
	addMessage(sessionID: string, message: any): void;
	/** Appends an assistant message whose content is one text part. */
	addAssistantText(sessionID: string, text: string): void;
	callTool(sessionID: string, toolName: string, input: unknown, options?: ToolCallOptions): Promise<ToolCallResult>;
	/** Runs the `context` hooks; returns the system text parts they left. */
	context(sessionID: string): Promise<{ system: string[] }>;
	/** Pushes one event to every matching `ctx.event.subscribe` stream and lets consumers run. `created`: when OpenCode made the event; default now. */
	emit(type: string, data?: Record<string, unknown>, created?: number): Promise<void>;
	/** Runs the plugin's cleanup, ends event streams and drops its hooks and tools. Idempotent. */
	shutdown(): Promise<void>;
	/** A server restart: shuts this instance down, then runs `setup` again on the same storage and sessions. */
	restart(): Promise<OpenCodeInstance>;
}

function assistantMessage(text: string) {
	return { type: "assistant", agent: "build", model: { providerID: "fake", id: "fake" }, content: [{ type: "text", text }], time: { created: 0 } };
}

export function userMessage(text: string) {
	return { type: "user", text };
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
	const registrationErrors: { name: string; message: string }[] = [];
	const hooks = { before: [] as ((event: any) => any)[], after: [] as ((event: any) => any)[], context: [] as ((event: any) => any)[] };
	const subscribers = new Set<{ types?: readonly string[]; push: (event: any) => void; end: () => void; idle: () => Promise<void> }>();
	let registry = new Map<string, any>();
	let stopped = false, cleanup: (() => Promise<void> | void) | undefined;

	// Tool.Service state. Deviation: a transform runs once, when the plugin registers it; OpenCode replays transforms on
	// reload and config changes, which no test can observe through a registry keyed by name.
	const transform = (callback: (editor: any) => void) => {
		const tools = registry;
		const editor = {
			add: (tool: any) => {
				const id = effectiveName(tool);
				if (tool.options?.codemode === false && id === "execute")
					return void registrationErrors.push({ name: id, message: 'Tool name "execute" is reserved for CodeMode' });
				if ((typeof tool.input !== "object" && typeof tool.input !== "function") || tool.input === null)
					return void registrationErrors.push({ name: id, message: `Invalid tool definition ${id}: input must be a schema` });
				tools.set(id, { ...tool, id, options: tool.options && { ...tool.options } });
			},
		};
		callback(editor);
	};

	const encodeSession = (session: FakeSession) => ({
		id: session.id,
		...(session.parentID === undefined ? {} : { parentID: session.parentID }),
		time: { created: session.created, updated: session.created, ...(session.archived === undefined ? {} : { archived: session.archived }) },
		...(session.title === undefined ? {} : { title: session.title }),
		location: { directory: session.location.directory },
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

	// Deviation: registering returns no dispose handle; no plugin of ours keeps one.
	const register = <T>(list: T[], item: T) => {
		list.push(item);
		return Promise.resolve();
	};

	const ctx: any = {
		location: { directory, project: { id: "prj_fake", directory, canonical: directory } },
		options: options.options ?? {},
		storage,
		tool: {
			transform: async (callback: (editor: any) => void) => transform(callback),
			hook: (name: string, callback: (event: any) => any) => {
				if (name === "execute.before") return register(hooks.before, callback);
				if (name === "execute.after") return register(hooks.after, callback);
				throw new Error(`fake OpenCode host does not provide tool hook ${name}`);
			},
		},
		session: {
			hook: (name: string, callback: (event: any) => any) => {
				if (name !== "context") throw new Error(`fake OpenCode host does not provide session hook ${name}`);
				return register(hooks.context, callback);
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
		const id = nextID("call");
		const base = { sessionID, agent: "build", messageID: nextID("msg"), id };
		const before = { tool: name, ...base, codemode: opts.codemode === true, input: clone(rawInput) as any };
		const fail = (error: { message: string }, input: unknown, executed: boolean): ToolCallResult =>
			({ status: "error", text: error.message, input, executed });

		// A throw in execute.before ends the call as an error: neither the tool nor execute.after runs (tool.ts `run`).
		try {
			await trigger(hooks.before, before);
		} catch (error) {
			return fail(toolError(error), before.input, false);
		}
		const input = before.input;
		const tool = opts.execute ? { execute: opts.execute } : registry.get(name);
		if (!tool) throw new Error(`fake OpenCode host has no tool ${name}: register it with a plugin or pass execute`);

		// Deviation: the registered input schema is not validated (OpenCode decodes and may fail with a Tool.Error).
		const toolContext = { ...base, signal: new AbortController().signal };
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
		const text = normalizeContent(after.result.content, after.result.output).map((part) => part.text ?? "").join("\n");
		return { status: "completed", text, ...(after.result.metadata === undefined ? {} : { metadata: after.result.metadata }), input, executed: true };
	};

	const self: OpenCodeInstance = {
		ctx: guarded,
		shared,
		sessions: shared.sessions,
		registrationErrors,
		tools: () => new Map(registry),
		tool: (name: string) => registry.get(name),
		createSession(input: CreateSessionInput = {}) {
			const session: FakeSession = {
				id: input.id ?? nextID("ses"),
				...(input.parentID === undefined ? {} : { parentID: input.parentID }),
				...(input.title === undefined ? {} : { title: input.title }),
				location: { directory },
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
		async context(sessionID: string) {
			const session = requireSession(sessionID);
			const event: any = {
				sessionID,
				agent: "build",
				model: { providerID: "fake", id: "fake" },
				tools: {},
				options: {},
				system: [],
				messages: clone(session.messages),
			};
			await trigger(hooks.context, event);
			// system parts are { type: "text", text }; bare strings are tolerated.
			return { system: event.system.map((part: any) => (typeof part === "string" ? part : part.text)) };
		},
		async emit(type: string, data: Record<string, unknown> = {}, created = Date.now()) {
			const event = { id: nextID("evt"), type, created, data: clone(data) };
			const receivers = [...subscribers].filter((subscriber) => !subscriber.types || subscriber.types.includes(type));
			for (const subscriber of receivers) subscriber.push(clone(event));
			// Resolves once every receiving consumer has asked for its next event (or its stream ended) and the plugin says it
			// has handled what it took, so a test can assert on what the plugin's handlers did. A plugin that never gets there
			// has a defect.
			const stuck = Symbol("stuck");
			const timer = Promise.withResolvers<typeof stuck>();
			const handle = setTimeout(() => timer.resolve(stuck), 30_000);
			const handled = Promise.all(receivers.map((subscriber) => subscriber.idle())).then(() => options.eventsHandled?.(guarded));
			const outcome = await Promise.race([handled, timer.promise]);
			clearTimeout(handle);
			if (outcome === stuck) throw new Error(`fake OpenCode host: the plugin did not finish handling ${type} within 30 s`);
			await tick();
		},
		async shutdown() {
			if (stopped) return;
			stopped = true;
			try {
				await cleanup?.();
			} finally {
				for (const subscriber of [...subscribers]) subscriber.end();
				hooks.before.length = hooks.after.length = hooks.context.length = 0;
				registry = new Map();
			}
		},
		async restart() {
			await self.shutdown();
			return start(options, shared);
		},
	};

	// setup may return a cleanup function (adapter.ts acquireRelease).
	const result = await plugin.setup(guarded);
	if (typeof result === "function") cleanup = result;
	return self;
}
