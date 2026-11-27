import { expect, test } from "bun:test";
import { createKataCore } from "../core/kata-core";
import { nodePlatform } from "../core/node-host";
import { memoryDelegateStore } from "./kata-fixture";

test("an unsupported Kata version stays quiet", async () => {
  const warnings: any[] = [];
  const calls: string[] = [];
  const ctx = { cwd: "/tmp", sessionManager: { getSessionId: () => "old-version", getBranch: () => [] }, ui: { notify: (...args: any[]) => warnings.push(args) } };
  const core = createKataCore({ platform: nodePlatform, appendEntry() {}, delegateStore: memoryDelegateStore(), exec: async (_file, args) => {
    calls.push(args[0]);
    return { code: 0, stdout: JSON.stringify({ kata_api_version: 1, version: "0.22.0" }) };
  } }, { namespace: "omp", executable: "fixture", executableVars: [] });
  expect((await core.session.beforePrompt(ctx)).sections.contract).toBeUndefined();
  expect(warnings).toEqual([]);
  expect(calls).not.toContain("agent-contract-hook");
});
