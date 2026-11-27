import { expect, test } from "bun:test";
import { createKataCore } from "../core/kata-core";
import { nodePlatform } from "../core/node-host";
import { memoryDelegateStore } from "./kata-fixture";

test("a delayed failure warns before another prompt even when the next fetch recovers", async () => {
  const gate = Promise.withResolvers<void>(), warned = Promise.withResolvers<void>();
  const warnings: string[] = [];
  let attempts = 0;
  const ctx = { cwd: "/tmp", sessionManager: { getSessionId: () => "delayed-failure", getBranch: () => [] }, ui: { notify: (message: string) => { warnings.push(message); warned.resolve(); } } };
  const platform = { ...nodePlatform, env: { get: () => undefined, set: () => {} } };
  const core = createKataCore({ platform, appendEntry() {}, delegateStore: memoryDelegateStore(), exec: async (_file, args) => {
    if (args[0] === "version") return { code: 0, stdout: JSON.stringify({ kata_api_version: 1, version: "0.24.0" }) };
    if (args[0] === "agent-contract-hook") {
      if (++attempts === 1) { await gate.promise; return { code: 1, stdout: "", stderr: "boom" }; }
      return { code: 0, stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: "recovered contract" } }) };
    }
    return { code: 0, stdout: "{}" };
  } }, { namespace: "omp", executable: "fixture", executableVars: [] });
  expect((await core.session.beforePrompt(ctx)).sections.contract).toBeUndefined();
  gate.resolve();
  await warned.promise;
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("boom");
  // Let the failed read's finally release its pending slot before the next turn.
  await new Promise<void>(resolve => setImmediate(resolve));
  expect((await core.session.beforePrompt(ctx)).sections.contract).toBe("recovered contract");
  expect(warnings).toHaveLength(1);
});

test("an unreachable probe reports the outage and retries", async () => {
  const warnings: string[] = [];
  let down = true;
  const ctx = { cwd: "/tmp", sessionManager: { getSessionId: () => "outage", getBranch: () => [] }, ui: { notify: (message: string) => warnings.push(message) } };
  const platform = { ...nodePlatform, env: { get: () => undefined, set: () => {} } };
  const core = createKataCore({ platform, appendEntry() {}, delegateStore: memoryDelegateStore(), exec: async (_file, args) => {
    if (args[0] === "version") return { code: 0, stdout: JSON.stringify({ kata_api_version: 1, version: "0.24.0" }) };
    if (args[0] === "list" && down) return { code: 7, stdout: "", stderr: "daemon unavailable" };
    if (args[0] === "agent-contract-hook") return { code: 0, stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: "recovered contract" } }) };
    return { code: 0, stdout: "{}" };
  } }, { namespace: "omp", executable: "fixture", executableVars: [] });
  expect((await core.session.beforePrompt(ctx)).sections.contract).toContain("daemon unavailable");
  expect(warnings).toHaveLength(1);
  down = false;
  expect((await core.session.beforePrompt(ctx)).sections.contract).toBe("recovered contract");
  expect(warnings).toHaveLength(1);
});

test("a delegate receives a failed fetch stub without a warning", async () => {
  const warnings: string[] = [];
  const ctx = { cwd: "/tmp", sessionManager: { getSessionId: () => "delegate", getBranch: () => [] }, ui: { notify: (message: string) => warnings.push(message) } };
  const platform = { ...nodePlatform, env: { get: () => undefined, set: () => {} } };
  const core = createKataCore({ platform, appendEntry() {}, delegateStore: memoryDelegateStore(), isMain: () => false, exec: async (_file, args) => {
    if (args[0] === "version") return { code: 0, stdout: JSON.stringify({ kata_api_version: 1, version: "0.24.0" }) };
    if (args[0] === "agent-contract-hook") return { code: 1, stdout: "", stderr: "boom" };
    return { code: 0, stdout: "{}" };
  } }, { namespace: "omp", executable: "fixture", executableVars: [] });
  for (let i = 0; i < 2; i++) expect((await core.session.beforePrompt(ctx)).sections.contract).toContain("boom");
  expect(warnings).toEqual([]);
});

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
