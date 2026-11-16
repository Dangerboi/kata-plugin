// Shared credential-free scripted provider. Hosts supply their maintained stream class.
// pi and omp load this file inside the host, so it imports nothing.
export const PROVIDER = "kata-smoke", MODEL = "scripted";
/** `{ hang: true }` never answers: the model call stays pending (no events) until the host dies, so the agent never reaches a tool call. */
export type SmokeBlock = string | { tool: string; args: Record<string, unknown> } | { hang: true };
/** What every scripted turn can read; each host adds its own fields. */
export type SmokeContext = {
  /** Text of every message so far (tool calls and tool results included), oldest first. */
  texts: string[];
  /** System prompt text as the host sent it, plugin sections included. */
  system: string;
};
export type SmokeTurn<C extends SmokeContext> = SmokeBlock[] | ((ctx: C) => SmokeBlock[]);
type Answer = Exclude<SmokeBlock, { hang: true }>;

/**
 * The agent a model request belongs to and its next turn. The agent is the longest script marker its first user message
 * contains. Its next turn is the one after the assistant messages already in the request, so a provider keeps no state
 * per conversation.
 */
export function pickTurn<C extends SmokeContext>(scripts: Record<string, SmokeTurn<C>[]>, messages: { role: string; text: string }[]) {
  const first = messages.find(m => m.role === "user")?.text ?? "";
  const marker: string | undefined = Object.keys(scripts).filter(key => first.includes(key)).sort((a, b) => b.length - a.length)[0];
  const index = messages.filter(m => m.role === "assistant").length;
  const turn = marker === undefined ? undefined : scripts[marker][index];
  return {
    /** The marker that identified the agent; "" for an unscripted agent. */
    agent: marker ?? "",
    blocks: (ctx: C): SmokeBlock[] => typeof turn === "function" ? turn(ctx) : turn ?? [`(smoke script has no turn ${index} for ${marker ?? "this agent"})`],
  };
}

/** The blocks to answer with; undefined for a turn that hangs. */
export function answerOf(blocks: SmokeBlock[]): Answer[] | undefined {
  const answer = blocks.filter((block): block is Answer => typeof block === "string" || !("hang" in block));
  return answer.length < blocks.length ? undefined : answer;
}

export function registerSmokeProvider(pi: any, Stream: new () => any, turn: (context: any) => SmokeBlock[], provider = PROVIDER, model = MODEL) {
  let counter = 0;
  pi.registerProvider(provider, {
    baseUrl: "https://scripted.invalid/", apiKey: "unused", api: "kata-smoke-api",
    streamSimple(model: any, context: any) {
      const stream = new Stream(), answer = answerOf(turn(context));
      if (!answer) return stream;
      const content = answer.map(block => typeof block === "string" ? { type: "text" as const, text: block }
        : { type: "toolCall" as const, id: `smoke-${++counter}`, name: block.tool, arguments: block.args });
      const hasTool = content.some(c => c.type === "toolCall");
      const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage, stopReason: hasTool ? "toolUse" : "stop", timestamp: Date.now() };
      // Events carry the content too: OMP assembles messages from them.
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
    models: [{ id: model, name: "Kata smoke (scripted)", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 8000 }],
  });
}
