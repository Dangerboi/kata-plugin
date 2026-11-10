// Shared credential-free scripted provider. Hosts supply their maintained stream class.
/** `{ hang: true }` never answers: the model call stays pending (no events) until the host dies, so the agent never reaches a tool call. */
export type SmokeBlock = string | { tool: string; args: Record<string, unknown> } | { hang: true };
export function registerSmokeProvider(pi: any, Stream: new () => any, turn: (context: any) => SmokeBlock[], provider = "kata-smoke", model = "scripted") {
  let counter = 0;
  pi.registerProvider(provider, {
    baseUrl: "https://scripted.invalid/", apiKey: "unused", api: "kata-smoke-api",
    streamSimple(model: any, context: any) {
      const stream = new Stream(), blocks = turn(context);
      const answer = blocks.filter((block): block is Exclude<SmokeBlock, { hang: true }> => typeof block === "string" || !("hang" in block));
      if (answer.length < blocks.length) return stream;
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
