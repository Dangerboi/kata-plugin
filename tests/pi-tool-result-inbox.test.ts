import { afterEach, expect, test } from "bun:test";
import { eventually } from "./kata-fixture";
import { piFixture } from "./pi-fixture";
const pi = piFixture();
afterEach(() => { delete process.env.KATA_INBOX_POLL_SECONDS; });

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


test("native pi main leaves result inbox delivery to the native adapter", async () => {
  process.env.KATA_INBOX_USER = "pi-builder/native-result";
  process.env.KATA_INBOX_POLL_SECONDS = "0";
  pi.globalRegistry[pi.nativeKey].adapters.set("native", { options: { scope: "project", workspace: pi.cwd, contract: true } });
  const app = await pi.host();
  await app.event("session_start", { reason: "startup" });
  const before = app.calls.filter((a: string[]) => a[0] === "inbox").length;
  expect(await app.event("tool_result", { toolName: "read", content: [{ type: "text", text: "original" }], structuredContent: { x: 1 }, isError: false })).toBeUndefined();
  expect(app.calls.filter((a: string[]) => a[0] === "inbox")).toHaveLength(before);
});
