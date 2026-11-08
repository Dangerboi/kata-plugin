// Smoke-only omp extension: registers a scripted model provider. Each model call
// answers with the next scripted turn of the agent it belongs to. The turn index
// is the number of assistant messages already in the context, so the provider
// keeps no state of its own. It also records each agent's system prompt as the
// plugin left it and each finished tool call, from the thread the agent runs on,
// in live runs too.
import { appendFileSync } from "node:fs";
import { isMainThread } from "node:worker_threads";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { SCENARIOS, type Block, type Prompt, type TurnContext } from "./smoke-omp-scenarios";
import { linesIn } from "./smoke-jsonl";

export const PROVIDER = "kata-smoke";
export const MODEL = "scripted";

const textOf = (message: any): string => typeof message.content === "string" ? message.content
	: (message.content ?? []).map((part: any) => part.text ?? (part.type === "toolCall" ? JSON.stringify(part.arguments) : "")).join("\n");

export default function (pi: any) {
	const scenario = SCENARIOS.find(s => s.name === process.env.KATA_SMOKE_SCENARIO);
	if (!scenario) throw new Error(`Unknown KATA_SMOKE_SCENARIO ${process.env.KATA_SMOKE_SCENARIO}`);
	// Loaded after the plugin, so this sees the system prompt with the plugin's sections.
	pi.on("before_agent_start", (event: any, ctx: any) => {
		if (process.env.KATA_SMOKE_PROMPTS) appendFileSync(process.env.KATA_SMOKE_PROMPTS, JSON.stringify({ agent: ctx?.agent?.id ?? "", system: [event.systemPrompt].flat().filter(Boolean).join("\n"), mainThread: isMainThread }) + "\n");
	});
	pi.on("tool_result", (event: any, ctx: any) => {
		if (process.env.KATA_SMOKE_TOOLS) appendFileSync(process.env.KATA_SMOKE_TOOLS, JSON.stringify({ agent: ctx?.agent?.id ?? "", tool: event.toolName, op: event.toolName === "todo" ? event.input?.op : undefined, isError: !!event.isError, mainThread: isMainThread }) + "\n");
	});
	let counter = 0;
	pi.registerProvider(PROVIDER, {
		baseUrl: "https://scripted.invalid/",
		apiKey: "unused",
		api: "kata-smoke-api",
		streamSimple(model: any, context: any) {
			const stream = new AssistantMessageEventStream();
			const messages: any[] = context.messages ?? [];
			const first = textOf(messages.find(m => m.role === "user") ?? { content: "" });
			const key = Object.keys(scenario.scripts).find(k => first.includes(k));
			const turnIndex = messages.filter(m => m.role === "assistant").length;
			const turn = key ? scenario.scripts[key][turnIndex] : undefined;
			const ctx: TurnContext = { texts: messages.map(textOf), system: [context.systemPrompt].flat().filter(Boolean).join("\n"), prompts: () => linesIn<Prompt>(process.env.KATA_SMOKE_PROMPTS) };
			if (process.env.KATA_SMOKE_RECORD) appendFileSync(process.env.KATA_SMOKE_RECORD, JSON.stringify({ agent: key ?? "", system: ctx.system, users: messages.filter(m => m.role === "user").map(textOf), roles: messages.map(m => m.role) }) + "\n");
			const blocks: Block[] = turn ? (typeof turn === "function" ? turn(ctx) : turn) : [`(smoke script has no turn ${turnIndex} for ${key ?? "this agent"})`];
			// A hanging turn leaves the model call pending: no events, so the agent stays before any tool call until omp dies.
			if (blocks.some(block => typeof block === "object" && "hang" in block)) return stream;
			const content = blocks.flatMap(block => typeof block === "string" ? [{ type: "text" as const, text: block }]
				: "hang" in block ? [] : [{ type: "toolCall" as const, id: `smoke-${++counter}`, name: block.tool, arguments: block.args }]);
			const hasTool = content.some(c => c.type === "toolCall");
			const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
			const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage, stopReason: hasTool ? "toolUse" : "stop", timestamp: Date.now() } as any;
			// Events must carry the content too: omp assembles messages from them.
			queueMicrotask(() => {
				const partial = { ...message, content: [] as any[] };
				stream.push({ type: "start", partial });
				for (const block of content) {
					partial.content.push(block);
					const contentIndex = partial.content.length - 1;
					if (block.type === "text") {
						stream.push({ type: "text_start", contentIndex, partial });
						stream.push({ type: "text_delta", contentIndex, delta: block.text, partial });
						stream.push({ type: "text_end", contentIndex, content: block.text, partial });
					} else {
						stream.push({ type: "toolcall_start", contentIndex, partial });
						stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(block.arguments), partial });
						stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial });
					}
				}
				stream.push({ type: "done", reason: message.stopReason, message: partial });
			});
			return stream;
		},
		models: [{ id: MODEL, name: "Kata smoke (scripted)", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 8000 }],
	});
}
