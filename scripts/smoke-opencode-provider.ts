// Scripted OpenAI-compatible provider for the OpenCode smoke test (scripts/smoke-opencode.ts).
// OpenCode 2.2.7 sends `POST /v1/chat/completions` with `stream: true` (SSE, `stream_options.include_usage`).
// Requests without `tools` are title generation and get a fixed answer. Every other request belongs to an agent,
// found by the longest scenario marker contained in its first user message (a subagent's first message is
// "You are a subagent spawned by another session.\n" + its prompt). The agent's next turn is the one after the
// assistant messages already in the request, so the server keeps no per-conversation state.
import type { SmokeBlock } from "./smoke-provider";

export type Block = SmokeBlock;
export type TurnContext = {
	/** Text of every message so far (tool calls and tool results included), oldest first. */
	texts: string[];
	/** System prompt text, as OpenCode sent it (plugin sections included). */
	system: string;
	/** Run variables the scenario's setup returned (ticket ids). */
	vars: Record<string, string>;
	/** Every request recorded so far, this one included. */
	requests(): Request[];
};
export type Turn = Block[] | ((ctx: TurnContext) => Block[]);
/** One model request as the provider saw it. */
export type Request = {
	/** The scenario marker that identified the agent; "" for an unscripted agent. */
	agent: string;
	system: string;
	/** Text of every user-role message. */
	users: string[];
	/** Role of every message, in order. */
	roles: string[];
	/** Content of every tool-role message (tool results), in order. */
	toolResults: string[];
	/** Names of the tools offered. */
	tools: string[];
};

export const PROVIDER = "smoke";
export const MODEL = "scripted";
export const TITLE = "Kata smoke session";

const textOf = (message: any): string => {
	const content = typeof message.content === "string" ? message.content
		: Array.isArray(message.content) ? message.content.map((part: any) => part.text ?? "").join("\n") : "";
	const calls = (message.tool_calls ?? []).map((call: any) => `${call.function?.name}(${call.function?.arguments})`);
	return [content, ...calls].filter(Boolean).join("\n");
};

const sse = (chunks: unknown[]) => new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });

export type Provider = { url: string; requests: Request[]; stop(): void };

/** Starts the server on a free local port. `scripts` maps an agent marker to its turns; `vars()` is read at each request. */
export function startProvider(scripts: Record<string, Turn[]>, vars: () => Record<string, string> = () => ({})): Provider {
	const requests: Request[] = [];
	let counter = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1", port: 0, idleTimeout: 255,
		async fetch(req) {
			if (!new URL(req.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
			const body: any = await req.json();
			const id = `chatcmpl-smoke-${++counter}`, base = { id, object: "chat.completion.chunk", created: 0, model: body.model };
			const delta = (d: unknown, finish: string | null = null) => ({ ...base, choices: [{ index: 0, delta: d, finish_reason: finish }] });
			const usage = { ...base, choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
			const messages: any[] = body.messages ?? [];
			if (!body.tools?.length) return sse([delta({ role: "assistant", content: "" }), delta({ content: TITLE }), delta({}, "stop"), usage]);

			const first = textOf(messages.find(m => m.role === "user") ?? {});
			const key = Object.keys(scripts).filter(k => first.includes(k)).sort((a, b) => b.length - a.length)[0];
			const system = messages.filter(m => m.role === "system").map(textOf).join("\n");
			requests.push({
				agent: key ?? "", system, users: messages.filter(m => m.role === "user").map(textOf), roles: messages.map(m => m.role),
				toolResults: messages.filter(m => m.role === "tool").map(textOf), tools: body.tools.map((t: any) => t.function?.name),
			});
			const index = messages.filter(m => m.role === "assistant").length;
			const turn = key ? scripts[key][index] : undefined;
			const ctx: TurnContext = { texts: messages.map(textOf), system, vars: vars(), requests: () => requests };
			const blocks = turn ? (typeof turn === "function" ? turn(ctx) : turn) : [`(smoke script has no turn ${index} for ${key ?? "this agent"})`];
			// `{ hang: true }` never answers: the model call stays pending until the run is killed.
			if (blocks.some(b => typeof b !== "string" && "hang" in b)) return new Promise<Response>(() => {});
			const answer = blocks.filter((b): b is Exclude<SmokeBlock, { hang: true }> => typeof b === "string" || !("hang" in b));
			const chunks: unknown[] = [delta({ role: "assistant", content: "" })];
			let tools = 0;
			for (const block of answer) {
				if (typeof block === "string") chunks.push(delta({ content: block }));
				else chunks.push(delta({ tool_calls: [{ index: tools++, id: `call_smoke_${++counter}`, type: "function", function: { name: block.tool, arguments: JSON.stringify(block.args) } }] }));
			}
			chunks.push(delta({}, tools ? "tool_calls" : "stop"), usage);
			return sse(chunks);
		},
	});
	return { url: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => void server.stop(true) };
}
