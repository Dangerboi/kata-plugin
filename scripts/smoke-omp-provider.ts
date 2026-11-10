// Smoke-only omp extension: registers a scripted model provider. Each model call
// answers with the next scripted turn of the agent it belongs to. The turn index
// is the number of assistant messages already in the context, so the provider
// keeps no state of its own. It also records each agent's system prompt as the
// plugin left it and each finished tool call, from the thread the agent runs on,
// in live runs too.
import { appendFileSync } from "node:fs";
import { isMainThread } from "node:worker_threads";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { SCENARIOS, type Prompt, type TurnContext } from "./smoke-omp-scenarios";
import { linesIn } from "./smoke-jsonl";
import { registerSmokeProvider } from "./smoke-provider";

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
	registerSmokeProvider(pi, AssistantMessageEventStream, (context: any) => {
		const messages: any[] = context.messages ?? [];
		const first = textOf(messages.find(m => m.role === "user") ?? { content: "" });
		const key = Object.keys(scenario.scripts).find(k => first.includes(k));
		const turnIndex = messages.filter(m => m.role === "assistant").length;
		const turn = key ? scenario.scripts[key][turnIndex] : undefined;
		const ctx: TurnContext = { texts: messages.map(textOf), system: [context.systemPrompt].flat().filter(Boolean).join("\n"), prompts: () => linesIn<Prompt>(process.env.KATA_SMOKE_PROMPTS) };
		if (process.env.KATA_SMOKE_RECORD) appendFileSync(process.env.KATA_SMOKE_RECORD, JSON.stringify({ agent: key ?? "", system: ctx.system, users: messages.filter(m => m.role === "user").map(textOf), roles: messages.map(m => m.role) }) + "\n");
		return turn ? (typeof turn === "function" ? turn(ctx) : turn) : [`(smoke script has no turn ${turnIndex} for ${key ?? "this agent"})`];
	}, PROVIDER, MODEL);
}
