import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { v2Fixture } from "./v2-fixture";

const { cwd, host } = v2Fixture();
afterEach(() => { delete process.env.KATA_CONTRACT_SOURCE; });

test("custom contract source is resolved against the session folder", async () => {
  const source = path.join(cwd, "custom-contract.md");
  writeFileSync(source, "Custom contract fixture");
  process.env.KATA_CONTRACT_SOURCE = " custom-contract.md ";
  const app = host();
  await app.event("session_start");
  await app.contractReady;
  expect(app.calls.find((args: string[]) => args[0] === "agent-contract-hook")).toEqual(["agent-contract-hook", "--source", source]);
});

for (const value of [undefined, "   "]) test(`unset or blank source uses the reserved source (${String(value)})`, async () => {
  if (value === undefined) delete process.env.KATA_CONTRACT_SOURCE;
  else process.env.KATA_CONTRACT_SOURCE = value;
  const app = host();
  await app.event("session_start");
  await app.contractReady;
  expect(app.calls.find((args: string[]) => args[0] === "agent-contract-hook")).toEqual(["agent-contract-hook", "--source", "kata-agent-contract-hook"]);
  expect(app.notices.filter((notice: any[]) => notice[1] === "warning")).toEqual([]);
});

test("missing source falls back and warns once even when the contract is fetched again", async () => {
  process.env.KATA_CONTRACT_SOURCE = "missing.md";
  const app = host({ before: (args: string[]) => args[0] === "agent-contract-hook"
    ? { code: 0, stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: "" } }), stderr: "" } : undefined });
  await app.event("session_start");
  await app.contractReady;
  await app.event("before_agent_start", { systemPrompt: [] });
  await app.event("before_agent_start", { systemPrompt: [] });
  expect(app.calls.filter((args: string[]) => args[0] === "agent-contract-hook").length).toBeGreaterThan(1);
  expect(app.calls.filter((args: string[]) => args[0] === "agent-contract-hook").every((args: string[]) => args[2] === "kata-agent-contract-hook")).toBe(true);
  expect(app.notices.filter((notice: any[]) => notice[1] === "warning" && String(notice[0]).includes("contract source"))).toHaveLength(1);
});
