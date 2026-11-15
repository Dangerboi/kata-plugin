// Scripted OpenAI-compatible provider for the OpenCode smoke test (scripts/smoke-opencode.ts).
// OpenCode 2.2.7 sends `POST /v1/chat/completions` with `stream: true` (SSE, `stream_options.include_usage`).
// Requests without `tools` are title generation and get a fixed answer. Every other request belongs to an agent and
// gets that agent's next scripted turn (`pickTurn`; a subagent's first message is OpenCode's subagent preamble followed
// by its prompt), so the server keeps no per-conversation state.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { answerOf, pickTurn, type SmokeContext, type SmokeTurn } from "./smoke-provider";

export type Turn = SmokeTurn<SmokeContext>;
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
type ChatMessage = { role: string; content?: string | { text?: string }[]; tool_calls?: { function?: { name?: string; arguments?: string } }[] };
type ChatRequest = { model: string; messages?: ChatMessage[]; tools?: { function?: { name?: string } }[] };

export const PROVIDER = "smoke";
export const MODEL = "scripted";
export const TITLE = "Kata smoke session";

const textOf = (message: ChatMessage): string => {
	const content = typeof message.content === "string" ? message.content
		: Array.isArray(message.content) ? message.content.map(part => part.text ?? "").join("\n") : "";
	const calls = (message.tool_calls ?? []).map(call => `${call.function?.name}(${call.function?.arguments})`);
	return [content, ...calls].filter(Boolean).join("\n");
};

export type Provider = { url: string; requests: Request[]; stop(): void };

/** Starts the server on a free local port. `scripts` maps an agent marker to its turns. */
export async function startProvider(scripts: Record<string, Turn[]>): Promise<Provider> {
	const requests: Request[] = [];
	let counter = 0;
	/** The stream chunks that answer a request; undefined for a turn that hangs. */
	const answer = (body: ChatRequest): unknown[] | undefined => {
		const base = { id: `chatcmpl-smoke-${++counter}`, object: "chat.completion.chunk", created: 0, model: body.model };
		const delta = (d: unknown, finish: string | null = null) => ({ ...base, choices: [{ index: 0, delta: d, finish_reason: finish }] });
		const usage = { ...base, choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
		if (!body.tools?.length) return [delta({ role: "assistant", content: "" }), delta({ content: TITLE }), delta({}, "stop"), usage];

		const messages = (body.messages ?? []).map(m => ({ role: m.role, text: textOf(m) }));
		const textsOf = (role: string) => messages.filter(m => m.role === role).map(m => m.text);
		const system = textsOf("system").join("\n");
		const { agent, blocks } = pickTurn(scripts, messages);
		requests.push({ agent, system, users: textsOf("user"), roles: messages.map(m => m.role), toolResults: textsOf("tool"), tools: body.tools.map(t => t.function?.name ?? "") });
		const turn = answerOf(blocks({ texts: messages.map(m => m.text), system }));
		if (!turn) return undefined;
		const chunks: unknown[] = [delta({ role: "assistant", content: "" })];
		let tools = 0;
		for (const block of turn) {
			if (typeof block === "string") chunks.push(delta({ content: block }));
			else chunks.push(delta({ tool_calls: [{ index: tools++, id: `call_smoke_${++counter}`, type: "function", function: { name: block.tool, arguments: JSON.stringify(block.args) } }] }));
		}
		return [...chunks, delta({}, tools ? "tool_calls" : "stop"), usage];
	};
	const server = createServer(async (req, res) => {
		try {
			if (!new URL(req.url ?? "", "http://localhost").pathname.endsWith("/chat/completions")) { res.writeHead(404).end("not found"); return; }
			req.setEncoding("utf8");
			let body = "";
			for await (const chunk of req) body += chunk;
			const chunks = answer(JSON.parse(body));
			// `{ hang: true }` never answers: the model call stays pending until the run is killed.
			if (!chunks) return;
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" }).end(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n");
		} catch (error) {
			res.writeHead(500).end(String(error));
		}
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests,
		stop() { server.closeAllConnections(); server.close(); },
	};
}
