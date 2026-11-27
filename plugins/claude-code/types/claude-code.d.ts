// The part of Claude Code's plugin API ('claude-code' and 'claude-code/testing') that this plugin and its tests use, as
// declared by Claude Code 2.1.332. The names and shapes are the engine's own, trimmed; nothing here is invented, but it is
// no more than a subset, so `bun run typecheck` can run without the `claude` binary.
//
// The engine's full declaration is early-access, about 26,500 lines, and rewritten into .claude-plugin/types/ (gitignored)
// each time a mod loads. It is not the check on this file: `claude plugin validate plugins/claude-code` and
// `claude plugin test plugins/claude-code` are. They read the plugin against the real API, so a name or shape that
// drifted from it fails there. A hook that needs more of the API adds its declaration here, copied from the real one.
//
// The plugin's own state contract is types/index.d.ts, which fills `PluginState` below.

declare module "claude-code" {
	// ----------------------------------------------------------------------------------------------------------- events

	export type PluginOptions = Readonly<Record<string, string | number | boolean | readonly string[]>>;

	export type ToolInfo = {
		name: string;
		description: string;
		mcp: boolean;
		// On an entry a `tool.list` hook adds: a JSON schema object for the input.
		inputSchema?: Record<string, unknown>;
	};

	export type AgentSpawnResult =
		| { model: string; agentId?: string; teammateId?: string; deny?: undefined }
		| { deny: string; model?: undefined; agentId?: undefined; teammateId?: undefined };

	export type SpawnChunk = { stream: "stdout" | "stderr"; text: string };
	export type RunResult = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean };
	export type FileStat = { kind: "file" | "dir" | "other"; size: number; mtimeMs: number; isLink: boolean; realPath?: string };
	export type PromptSubmitInput = {
		text: string;
		origin: { kind: string };
		isMeta?: boolean;
		// Hidden context sent after the text.
		context?: readonly string[];
	};
	export type ToolCallResult = { result?: unknown; isError?: boolean; deny?: string; context?: readonly string[] };
	export type Suggestion = { text: string; label?: string; description?: string };

	// The call's tool arguments sit beside `tool` and `tool_use_id`; they are the tool's own JSON, whose names the engine does not fix.
	export type ToolCallEvent = { tool: string; tool_use_id: string; agentId?: string; [argument: string]: any };
	// `tool.check`: the engine's permission decision for a call. The tool and its input are the question and are pinned: a hook
	// answers `{ decision }`, it does not change the call. `input` is the tool's arguments (`{ command }` for Bash).
	export type ToolCheckDecision = "allow" | "ask" | "deny";
	export type ToolCheckInput = { tool: string; input: unknown; tool_use_id?: string; agentId?: string };
	// `hook`: the classic hook event that decided or asked (`PreToolUse`); `plugin`: the plugin whose hook made an ask. Both
	// absent on the engine's own verdict.
	export type ToolCheckResult = { decision: ToolCheckDecision; reason?: string; hook?: string; plugin?: string };

	// One entry per event the plugin hooks, or a test answers: [what `e` is, what the hook answers].
	export interface EventTable {
		"session.start": [{ cwd: string; surface: string; isInteractive: boolean }, { cwd: string }];
		"classic.SessionStart": [{ source: "startup" | "resume" | "clear" | "fork" | "compact" }, Record<string, unknown>];
		"session.end": [{ reason: "clear" | "resume" | "logout" | "prompt_input_exit" | "other" }, Record<string, unknown>];
		"session.compact": [Record<string, unknown>, Record<string, unknown>];
		"session.id": [Record<string, never>, { value: string }];
		"session.cwd": [Record<string, never>, { value: string }];
		"tool.list": [Record<string, never>, { value?: ToolInfo[] }];
		"tool.call": [ToolCallEvent, ToolCallResult];
		"tool.check": [ToolCheckInput, ToolCheckResult];
		"agent.spawn": [
			{
				prompt: string;
				description: string;
				name?: string;
				subagentType?: string;
				fork?: boolean;
				tool_use_id?: string;
				resume?: { agentId: string };
				workflow?: { runId: string; agentIndex: number };
				parentAgentId?: string;
				permissionMode?: string;
			},
			AgentSpawnResult
		];
		"prompt.submit": [PromptSubmitInput, { text: string; context?: readonly string[] } | { drop: string }];
		"prompt.autocomplete": [{ text: string; cursor: number; token: string; start: number }, { suggestions: Suggestion[] }];
		"turn.start": [{ agentId?: string }, Record<string, unknown>];
		"turn.complete": [
			{ turnId: string; answer: string; reason: string; durationMs: number; isAborted: boolean; usage: unknown; agentId?: string },
			{ text?: string }
		];
		"classic.Stop": [{ agent_id?: string; last_assistant_message?: string }, { block?: string }];
		"command.run": [{ command: string; args: string }, { text?: string; isTextDisplayOnly?: boolean }];
		"command.register": [{ name: string; description: string; argumentHint?: string }, { value: undefined }];
		"ui.render": [never, RenderElement];
		"store.get": [{ key: string }, { value: unknown }];
		"store.set": [{ key: string; value: unknown }, { value: undefined }];
		"store.delete": [{ key: string }, { value: undefined }];
		"store.keys": [Record<string, never>, { value: string[] }];
		"state.get": [{ plugin: string; key: string; id?: string }, { value: { value: unknown; version: number } }];
		"fs.stat": [{ path: string; resolve?: boolean }, { value: FileStat }];
		"env.get": [{ name: string }, { value: string | undefined }];
		"process.run": [{ argv: string[]; cwd?: string; env?: Record<string, string>; timeoutMs?: number }, { value: RunResult }];
		"process.spawn": [{ argv: string[]; cwd?: string }, AsyncGenerator<SpawnChunk, { value: { code: number; signal: string | null } }, unknown>];
	}
	export type EventName = keyof EventTable;

	// `E`'s `e`, and what a hook for it answers.
	type Args<E extends EventName> = EventTable[E][0];
	type EventResult<E extends EventName> = EventTable[E][1];

	export type Next<E extends EventName = EventName> = {
		(e: Args<E>): Promise<EventResult<E>>;
		// Aborts when the call is abandoned: the user interrupted, or the hook ran out of budget.
		readonly signal: AbortSignal;
		// What a `session.end` chain has left.
		readonly budget: { readonly remainingMs: number };
	};

	export type Hook<E extends EventName = EventName> = E extends "ui.render"
		? RenderHook<keyof RenderPropsOf>
		: E extends "process.spawn"
			? ($: EngineInterface, e: Args<E>, next: Next<E>) => AsyncGenerator<SpawnChunk, { value: { code: number; signal: string | null } }, unknown>
			: ($: EngineInterface, e: Args<E>, next: Next<E>) => EventResult<E> | Promise<EventResult<E>>;

	// ------------------------------------------------------------------------------------------------------------ the UI

	export type RenderElement = { readonly type: unknown; readonly props: unknown };
	export interface RenderPropsOf {
		AbovePrompt: { hasSurvey: boolean; isCollapsed: boolean; isWorking: boolean; maxRows: number; bodyColumns: number };
		ToolUse: { tool_use_id: string; tool: string; input: unknown; isRunning: boolean; isErrored: boolean; isInterrupted: boolean };
		ToolResult: { tool_use_id: string; tool: string; output: unknown; isErrored: boolean };
	}
	export type RenderSurface = "terminal" | "desktop" | "vscode" | "mobile";
	export type RenderEvent<C extends keyof RenderPropsOf> = { component: C; requestId: string; props: RenderPropsOf[C] };
	export type RenderHook<C extends keyof RenderPropsOf> = (
		$: EngineInterface,
		e: RenderEvent<C>,
		next: (e: RenderEvent<C>) => Promise<RenderElement>
	) => RenderElement | Promise<RenderElement>;

	type Colored = { color?: string; dimColor?: boolean; bold?: boolean; strikethrough?: boolean };
	type Elements = {
		Box: (props: { flexDirection?: "row" | "column"; key?: string; children?: unknown }) => RenderElement;
		Text: (props: Colored & { key?: string; children?: unknown }) => RenderElement;
		Progress: (props: { label?: string; value: number; max: number; valueText?: string }) => RenderElement;
	};

	// ------------------------------------------------------------------------------------------------------------ `$`

	// What each plugin keeps in `$.state`, declared by the plugin's own contract: `PluginState['<plugin>'][key]`.
	export interface PluginState {}
	// A value kept once per id: `$.state.get({ plugin, key, id })` reads `T`.
	export type StateFamily<T> = { readonly byId: T };
	type StateValue<P extends keyof PluginState, K extends keyof PluginState[P]> = PluginState[P][K] extends StateFamily<infer T> ? T : PluginState[P][K];
	type StateAddress<P extends keyof PluginState, K extends keyof PluginState[P]> = { readonly plugin: P; readonly key: K; readonly id?: string };

	export interface EngineInterface {
		// `check` asks the engine's permission decision for a call now: the other hooks run, nothing runs, no dialog opens.
		tool: { check(input: Pick<ToolCheckInput, "tool" | "input">): Promise<ToolCheckResult> };
		env: { get(name: string): Promise<string | undefined> };
		state: {
			get<P extends keyof PluginState, K extends keyof PluginState[P]>(address: StateAddress<P, K>): Promise<{ value: StateValue<P, K>; version: number }>;
			set<P extends keyof PluginState, K extends keyof PluginState[P]>(address: StateAddress<P, K>, value: StateValue<P, K>): Promise<unknown>;
		};
		store: {
			get(key: string): Promise<unknown>;
			set(key: string, value: unknown): Promise<unknown>;
			delete(key: string): Promise<unknown>;
			keys(): Promise<string[]>;
		};
		fs: {
			stat(path: string, options?: { resolve?: boolean }): Promise<FileStat>;
			read(path: string): Promise<string | Uint8Array>;
			write(path: string, text: string): Promise<unknown>;
		};
		process: {
			run(argv: readonly string[], options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<RunResult>;
			spawn(options: { argv: string[]; cwd?: string }): AsyncIterable<SpawnChunk>;
		};
		clock: {
			now(): Promise<number>;
			after(ms: number, fire: () => void): { cancel(): void };
		};
		session: {
			id(): Promise<string>;
			cwd(): Promise<string>;
			append(input: { message: { type: "user"; content: { type: "text"; text: string }[] } }): Promise<{ deny?: string }>;
		};
		prompt: { submit(input: { text: string }): Promise<{ text: string } | { drop: string }> };
		ui: {
			toast(message: string): void;
			// The element table of the surface `e` is drawn on.
			resolve(e: RenderEvent<keyof RenderPropsOf>): Elements;
		};
		command: { register(command: { name: string; description: string; argumentHint?: string }): Promise<unknown> };
	}

	// ----------------------------------------------------------------------------------------------------- registration

	type Matcher = { readonly [field: string]: string | RegExp | readonly string[] };
	type HookFor<P extends EventName, M> = P extends "ui.render"
		? M extends { readonly component: infer C extends keyof RenderPropsOf }
			? RenderHook<C>
			: never
		: Hook<P>;
	// `Hook<'ui.render'>` narrowed to one component: `on('ui.render', { component }, hook)`.
	export type MatchedHook<P extends EventName, M> = HookFor<P, M>;

	export type On = {
		<P extends EventName>(pattern: P, hook: Hook<P>): unknown;
		<P extends EventName, const M extends Matcher>(pattern: P, matcher: M, hook: MatchedHook<P, M>): unknown;
	};
	export type Register = (on: On, options: PluginOptions) => unknown;
}

// The kit a plugin's *.test.ts files import under `claude plugin test`.
declare module "claude-code/testing" {
	import type { AgentSpawnResult, On, PluginOptions, Register, RenderSurface, Suggestion, ToolCallResult } from "claude-code";

	export type FoundElement = { type: string; key: string | undefined; props: Record<string, unknown>; text: string; children: unknown[] };
	export type ElementQuery = { type?: string; key?: string; text?: string | RegExp; in?: string };
	export type Mounted = {
		readonly surface: RenderSurface;
		find(query: ElementQuery): Promise<FoundElement | undefined>;
		findAll(query: ElementQuery): Promise<FoundElement[]>;
		redraw(props?: Record<string, unknown>): Promise<void>;
		unmount(): Promise<void>;
	};
	export type MountTarget = { plugin: string; surface: RenderSurface; component: string; props: Record<string, unknown>; requestId?: string };

	// The engine's own `$`, as a test drives it: each event of the engine is a call.
	export type Engine = {
		session: { start(e: { surface: string; isInteractive: boolean; cwd: string }): Promise<{ cwd: string }> };
		turn: {
			complete(e: {
				turnId: string;
				answer: string;
				reason?: string;
				durationMs: number;
				isAborted: boolean;
				usage: unknown;
				agentId?: string;
			}): Promise<{ text?: string }>;
		};
		agent: { spawn(e: { prompt: string; description: string; name?: string; subagentType?: string }): Promise<AgentSpawnResult> };
		tool: { call(e: { tool: string; agentId?: string; [argument: string]: unknown }): Promise<ToolCallResult> };
		command: { run(e: { command: string; args: string }): Promise<{ text?: string; isTextDisplayOnly?: boolean }> };
		prompt: {
			autocomplete(e: { text: string; cursor: number; token: string; start: number }): Promise<{ suggestions: Suggestion[] }>;
			submit(e: { text: string }): Promise<{ text: string } | { drop: string }>;
		};
		ui: { mount(target: MountTarget): Promise<Mounted> };
	};

	export type Plugin = { name: string; register: Register };
	export type TestOptions = { plugins?: readonly Plugin[]; timeoutMs?: number; options?: PluginOptions };
	export type TestBody = ($: Engine, on: On) => unknown;
	export const test: {
		(name: string, body: TestBody): void;
		(name: string, options: TestOptions, body: TestBody): void;
	};

	type Matchers = {
		toBe(expected: unknown): void;
		toEqual(expected: unknown): void;
		toMatchObject(expected: object): void;
		toContain(item: unknown): void;
		toHaveLength(length: number): void;
		toBeUndefined(): void;
		toBeDefined(): void;
		toBeGreaterThan(bound: number | bigint): void;
		toMatch(pattern: string | RegExp): void;
	};
	export const expect: (received: unknown, message?: string) => Matchers & { not: Matchers };

	export type MockClock = {
		now(): number;
		advance(ms: number): Promise<void>;
		set(ms: number): Promise<void>;
		settle(): Promise<void>;
		sleep(ms: number): Promise<void>;
	};
	// Each answers the noun beneath the plugins, from memory.
	export const mock: {
		clock(on: On, options?: { now?: number }): MockClock;
		store(on: On, entries?: Readonly<Record<string, unknown>>): void;
		env(on: On, variables: Readonly<Record<string, string>>): void;
	};
}

// What a hooks module's JSX compiles against (`jsx: react`, factory `h`).
declare function h(type: unknown, props: unknown, ...children: unknown[]): import("claude-code").RenderElement;
declare const Fragment: unique symbol;
declare namespace JSX {
	type Element = import("claude-code").RenderElement;
	interface ElementChildrenAttribute {
		children: {};
	}
	interface IntrinsicAttributes {
		key?: string | number;
	}
}

// The web APIs of the hooks environment (no DOM, no Node) that the plugin and its core use.
interface AbortSignal {
	readonly aborted: boolean;
	addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
	removeEventListener(type: "abort", listener: () => void): void;
}
declare class TextEncoder {
	encode(text?: string): Uint8Array;
}
declare class TextDecoder {
	decode(bytes?: Uint8Array): string;
}
declare function structuredClone<T>(value: T): T;
declare function btoa(text: string): string;
declare const performance: { now(): number };
