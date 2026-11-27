import { afterEach, beforeEach, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { eventually } from "./kata-fixture";
import { piFixture } from "./pi-fixture";
const pi = piFixture();
const envKeys = ["KATA_INBOX_POLL_SECONDS", "KATA_INBOX_USER", "KATA_PI_PARENT", "KATA_TEAMMATE"] as const;
let previous: (string | undefined)[];
beforeEach(() => { previous = envKeys.map(key => process.env[key]); });
afterEach(() => { envKeys.forEach((key, i) => previous[i] === undefined ? delete process.env[key] : process.env[key] = previous[i]); });

test("pi child appends the inbox while preserving structured content", async () => {
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
  const structuredContent = { answer: 42 };
  let delivered: any;
  await eventually(async () => {
    delivered = await child.event("tool_result", { toolName: "read", content: [{ type: "text", text: "original" }], structuredContent, isError: false });
    return JSON.stringify(delivered ?? {}).includes("pi-mid-run-96");
  }, true);
  expect(delivered.structuredContent).toEqual(structuredContent);
  expect(delivered.content[0].text).toBe("original");
  expect(delivered.content[1].text).toContain("<kata_inbox>");
  expect(delivered.additionalContext).toBeUndefined();
});



test("a pi custom task tool carries a mid-run request", async () => {
  process.env.KATA_INBOX_USER = "pi-builder/review-task";
  process.env.KATA_INBOX_POLL_SECONDS = "0";
  const app = await pi.host(); await app.event("session_start", { reason: "startup" });
  await app.event("before_agent_start", { prompt: "work", systemPromptOptions: { sections: {} } });
  const ref = await pi.issue("task tool request");
  await pi.kata(["notify", ref, "--to", "pi-builder/review-task", "--message", "task-request", "--json"]);
  const event = { toolName: "task", content: [{ type: "text", text: "normal custom task output" }], isError: false };
  let result: any;
  await eventually(async () => { result = await app.event("tool_result", event); return JSON.stringify(result ?? {}).includes("task-request"); }, true);
  expect(result.content[0].text).toBe("normal custom task output");
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
  const event = { toolName: "read", content: [{ type: "text", text: "original" }], structuredContent: { answer: 7 }, isError: false };
  let result: any;
  await eventually(async () => { result = await app.event("tool_result", event); return JSON.stringify(result ?? {}).includes("native-midrun"); }, true);
  expect(result.structuredContent).toEqual({ answer: 7 });
});
