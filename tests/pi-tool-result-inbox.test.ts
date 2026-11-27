import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { eventually, settle, until } from "./kata-fixture";
import { piFixture } from "./pi-fixture";
const pi = piFixture();

test("pi child receives its own inbox on a tool result", async () => {
  process.env.KATA_INBOX_USER = "pi-builder/lead-result";
  process.env.KATA_INBOX_POLL_SECONDS = "0";
  const parent = await pi.host(); await parent.event("session_start", { reason: "startup" });
  await parent.init(["Pi result child"]);
  pi.asChild();
  const child = await pi.host(); await child.event("session_start", { reason: "startup" });
  const prompt: any = { prompt: "Pi result child", systemPromptOptions: { sections: {} } };
  await child.event("before_agent_start", prompt);
  const record = child.entries.filter((e: any) => e.customType === "io.kata.pi.delegate").at(-1)?.data;
  expect(record?.teammate).toBeTruthy();
  const ref = await pi.issue("Pi result request");
  await pi.kata(["notify", ref, "--to", `pi-builder/${record.teammate}`, "--message", "pi-mid-run-96", "--json"]);
  let delivered: any;
  await eventually(async () => {
    delivered = await child.event("tool_result", { toolName: "read", content: [{ type: "text", text: "original" }], isError: false });
    return JSON.stringify(delivered ?? {}).includes("pi-mid-run-96");
  }, true);
  expect(delivered.content[0].text).toBe("original");
  expect(delivered.content[1].text).toContain("<kata_inbox>");
});

test("a pi main with an active native contract receives a mid-run request", async () => {
  process.env.KATA_INBOX_USER = "pi-builder/native-result";
  process.env.KATA_INBOX_POLL_SECONDS = "0";
  await pi.text(["agent-hook", "install", "pi", "--scope", "project", "--contract-only", "--executable", pi.binary]);
  pi.globalRegistry[pi.nativeKey] = { adapters: new Map(), active: new Map() };
  const cwd = realpathSync(pi.cwd);
  const app = await pi.host({ nativeOrder: "native-first", cwd });
  await app.event("session_start", { reason: "startup" });
  const adapters = [...pi.globalRegistry[pi.nativeKey].adapters.values()] as any[];
  expect(adapters.length).toBeGreaterThan(0);
  expect(adapters.some(adapter => adapter.options.contract && adapter.options.workspace === cwd)).toBe(true);
  await app.event("before_agent_start", { prompt: "work", systemPromptOptions: { sections: {} } });
  const ref = await pi.issue("native request");
  await pi.kata(["notify", ref, "--to", "pi-builder/native-result", "--message", "native-midrun", "--json"]);
  const structuredContent = { answer: 42 };
  const event = { toolName: "task", content: [{ type: "text", text: "original" }], structuredContent, isError: false };
  let result: any;
  await eventually(async () => { result = await app.event("tool_result", event); return JSON.stringify(result ?? {}).includes("native-midrun"); }, true);
  expect(result.content[0].text).toBe("original");
  expect(result.content[1].text).toContain("<kata_inbox>");
  expect(result.structuredContent).toEqual(structuredContent);
});


test("native pi prompt deduplicates only its shown snapshot in either load order", async () => {
  process.env.KATA_INBOX_POLL_SECONDS = "0";
  await pi.text(["agent-hook", "install", "pi", "--scope", "project", "--contract-only", "--executable", pi.binary]);
  for (const [order, shown] of [["native-first", true], ["plugin-first", true], ["native-first", false]] as const) {
    process.env.KATA_INBOX_USER = `pi-builder/native-${pi.unique()}`;
    const address = process.env.KATA_INBOX_USER;
    pi.globalRegistry[pi.nativeKey] = { adapters: new Map(), active: new Map() };
    const app = await pi.host({ nativeOrder: order, cwd: realpathSync(pi.cwd) });
    await app.event("session_start", { reason: "startup" });
    const ref = await pi.issue("native shown request");
    await pi.kata(["notify", ref, "--to", address, "--message", "already-shown <&>", "--json"]);
    const prompt = { prompt: "work", systemPromptOptions: { sections: {} as Record<string, string> } };
    app.ctx.getSystemPrompt = () => shown ? `<kata_inbox>\n${prompt.systemPromptOptions.sections.kata_inbox ?? ""}\n</kata_inbox>` : "forced prompt without inbox";
    await app.event("before_agent_start", prompt);
    expect(prompt.systemPromptOptions.sections.kata_inbox).toContain("already-shown");
    const priorReads = app.calls.filter((args: string[]) => args[0] === "inbox").length;
    const event = { toolName: "read", content: [{ type: "text", text: "original" }], isError: false };
    expect(await app.event("tool_result", event)).toBeUndefined();
    expect(await until(() => app.calls.filter((args: string[]) => args[0] === "inbox").length > priorReads)).toBe(true);
    await settle();
    const result = await app.event("tool_result", event);
    if (shown) {
      expect(result).toBeUndefined();
      await pi.kata(["notify", ref, "--to", address, "--message", "new-after-prompt", "--json"]);
      let changed: any;
      await eventually(async () => { changed = await app.event("tool_result", event); return JSON.stringify(changed ?? {}).includes("new-after-prompt"); }, true);
    } else {
      expect(JSON.stringify(result)).toContain("already-shown &lt;&amp;&gt;");
    }
  }
});
