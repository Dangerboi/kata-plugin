import { expect, test } from "bun:test";
import { createKataCore } from "../core/kata-core";
import { nodePlatform } from "../core/node-host";
import { memoryDelegateStore } from "./kata-fixture";
import { trustedInbox } from "../core/inbox";
import { statusText } from "../core/session-status";

function fixture(hook: () => Promise<string> = async () => "contract", issue?: () => { status: string; owner?: string }) {
  const calls: string[][] = [];
  const ctx = { cwd: "/tmp/kata-status-fixture", hasUI: true, ui: { setStatus: (_key: string, _value: string | undefined) => {} } };
  const core = createKataCore({ platform: nodePlatform, appendEntry() {}, delegateStore: memoryDelegateStore(), exec: async (_file, args) => {
    calls.push(args);
    if (args[0] === "version") return { code: 0, stdout: JSON.stringify({ kata_api_version: 1, version: "0.23.0" }), stderr: "" };
    if (args[0] === "show") return { code: 0, stdout: JSON.stringify({ issue: issue?.() }), stderr: "" };
    if (args[0] === "agent-contract-hook") return { code: 0, stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: await hook() } }), stderr: "" };
    if (args[0] === "inbox") return { code: 0, stdout: JSON.stringify({ requests: [{ ref: "p#1", from: "alice", message: "hello" }, { ref: "p#2", from: "other", message: "private" }] }), stderr: "" };
    return { code: 0, stdout: JSON.stringify({ issues: [] }), stderr: "" };
  } }, { namespace: "test", executable: "/tmp/kata-fixture", executableVars: [], explicitRef: () => issue ? "test#one" : undefined, env: name => ({ KATA_AUTHOR: "alice", KATA_INBOX_USER: "alice/worker" } as Record<string, string>)[name] });
  return { core, ctx, calls };
}

test("inspecting the inbox before any prompt publishes its counts and leaves the prompt's inbox", async () => {
  const { core, ctx } = fixture();
  const result = await core.session.inbox(ctx);
  expect(result.counts).toEqual({ trusted: 1, foreign: 1 });
  expect(result.text).toContain("hello");
  expect(result.text).not.toContain("private");
  expect((await core.session.view(ctx))?.counts).toEqual({ trusted: 1, foreign: 1 });
  expect((await core.session.beforePrompt(ctx)).sections.inbox).toContain("hello");
});

test("refresh rejects a stale contract and its finalizer while a new read is running", async () => {
  const first = Promise.withResolvers<string>(), second = Promise.withResolvers<string>();
  let count = 0;
  const { core, ctx } = fixture(() => ++count === 1 ? first.promise : second.promise);
  const old = core.session.beforePrompt(ctx);
  const waitForCount = async (wanted: number) => {
    const deadline = Date.now() + 2_000;
    while (count < wanted && Date.now() < deadline) await Bun.sleep(1);
    expect(count).toBe(wanted);
  };
  try {
    await waitForCount(1);
    core.session.refresh();
    const next = core.session.beforePrompt(ctx);
    await waitForCount(2);
    first.resolve("old");
    await old;
    second.resolve("new");
    expect((await next).sections.contract).toBe("new");
    expect((await core.session.beforePrompt(ctx)).sections.contract).toBe("new");
    expect(count).toBe(2);
  } finally { first.resolve("old"); second.resolve("new"); }
});

test("inbox counts and custom heading share the trusted request filter", async () => {
  const { countInbox } = await import("../core/inbox");
  const requests = [{ ref: "p#1", from: "alice", message: "yes" }, { ref: "p#2", from: "bob", message: "no" }, { from: "bob", message: "invalid" }];
  expect(countInbox(requests, "alice")).toEqual({ trusted: 1, foreign: 1 });
  expect(trustedInbox(requests, "alice", "alice/worker", "Heading")).toStartWith("Heading\n");
});

test("footer does no work without a UI and shutdown suppresses a pending redraw", async () => {
  const { core, ctx, calls } = fixture();
  await core.session.footer({ ...ctx, hasUI: false }, "force", () => "footer");
  expect(calls).toHaveLength(0);
  const writes: (string | undefined)[] = [];
  const visible = { ...ctx, ui: { setStatus: (_key: string, value: string | undefined) => writes.push(value) } };
  const drawing = core.session.footer(visible, "force", () => "footer");
  await core.session.shutdown(visible);
  await drawing;
  expect(writes).not.toContain("footer");
});
test("configured ref reappears after external reopen", async () => {
  let status = "open";
  const { core, ctx, calls } = fixture(undefined, () => ({ status }));
  expect((await core.session.view(ctx, { reconcile: true }))?.refs).toEqual(["test#one"]);
  status = "closed";
  expect((await core.session.view(ctx, { reconcile: true }))?.refs).toEqual([]);
  status = "open";
  expect((await core.session.view(ctx, { reconcile: true }))?.refs).toEqual(["test#one"]);
});

test("forced status includes a slow close", async () => {
  let status = "open", slow = false;
  const ctx = { cwd: "/tmp/kata-review-synthetic", hasUI: true };
  const core = createKataCore({ platform: nodePlatform, appendEntry() {}, delegateStore: memoryDelegateStore(), exec: async (_file, args) => {
    if (args[0] === "version") return { code: 0, stdout: JSON.stringify({ kata_api_version: 1, version: "0.23.0" }), stderr: "" };
    if (args[0] === "show") { if (slow) await Bun.sleep(350); return { code: 0, stdout: JSON.stringify({ issue: {status} }), stderr: "" }; }
    return { code: 0, stdout: JSON.stringify({ issues: [] }), stderr: "" };
  } }, { namespace: "test", executable: "/tmp/kata-fixture", executableVars: [], explicitRef: () => "test#one", env: name => name === "KATA_AUTHOR" ? "alice" : undefined });
  expect((await core.session.view(ctx, {reconcile:true}))?.refs).toEqual(["test#one"]);
  status = "closed"; slow = true;
  expect((await core.session.view(ctx, {reconcile:true}))?.refs).toEqual([]);
});

test("unrelated claim while checking several refs does not hide a closure", async () => {
  const ctx = { cwd: "/tmp/kata-review-synthetic", hasUI: true };
  const gate = Promise.withResolvers<void>();
  let hold = false;
  const core = createKataCore({ platform: nodePlatform, appendEntry() {}, delegateStore: memoryDelegateStore(), exec: async (_file, args) => {
    if (args[0] === "version") return { code: 0, stdout: JSON.stringify({ kata_api_version: 1, version: "0.23.0" }), stderr: "" };
    if (args[0] === "show") { if (hold) await gate.promise; return { code: 0, stdout: JSON.stringify({ issue: { status: args[1] === "test#abcd" && hold ? "closed" : "open" } }), stderr: "" }; }
    return { code: 0, stdout: JSON.stringify({ issues: [] }), stderr: "" };
  } }, { namespace: "test", executable: "/tmp/kata-fixture", executableVars: [], explicitRef: () => "test#one", env: name => name === "KATA_AUTHOR" ? "alice" : undefined });
  const claim = (ref: string) => core.tools.result(ctx, {toolName:"bash", input:{command:`kata claim ${ref}`}});
  await claim("test#abcd"); await claim("test#efgh");
  expect((await core.session.view(ctx, { reconcile: true }))?.refs).toEqual(["test#one", "test#abcd", "test#efgh"]);
  hold = true;
  const checking = core.session.view(ctx, { reconcile: true });
  await Bun.sleep(20);
  await claim("test#jkmn");
  gate.resolve();
  const view = await checking;
  expect(view?.refs).not.toContain("test#abcd");
});

test("a claim added during reconciliation leaves the footer throttle open", async () => {
  const gate = Promise.withResolvers<void>();
  let hold = false;
  const shows: string[] = [];
  const ctx = { cwd: "/tmp/kata-review-synthetic", hasUI: true, ui: { setStatus() {} } };
  const core = createKataCore({ platform: nodePlatform, appendEntry() {}, delegateStore: memoryDelegateStore(), exec: async (_file, args) => {
    if (args[0] === "version") return { code: 0, stdout: JSON.stringify({ kata_api_version: 1, version: "0.23.0" }), stderr: "" };
    if (args[0] === "show") { shows.push(args[1]!); if (hold) await gate.promise; return { code: 0, stdout: JSON.stringify({ issue: { status: "open" } }), stderr: "" }; }
    return { code: 0, stdout: JSON.stringify({ issues: [] }), stderr: "" };
  } }, { namespace: "test", executable: "/tmp/kata-fixture", executableVars: [], explicitRef: () => "test#one", env: name => name === "KATA_AUTHOR" ? "alice" : undefined });
  try {
    hold = true;
    const checking = core.session.footer(ctx, "force", () => "");
    const deadline = Date.now() + 2_000;
    while (!shows.length && Date.now() < deadline) await Bun.sleep(1);
    expect(shows).toContain("test#one");
    await core.tools.result(ctx, { toolName: "bash", input: { command: "kata claim test#abcd" } });
    gate.resolve(); await checking; hold = false;
    shows.length = 0;
    await core.session.footer(ctx, "throttle", () => "");
    expect(shows).toContain("test#abcd");
  } finally { gate.resolve(); }
});

test("status exposes an unsupported Kata version even with a configured actor", async () => {
  const core = createKataCore({ platform: nodePlatform, appendEntry() {}, delegateStore: memoryDelegateStore(), exec: async () => ({ code: 0, stdout: JSON.stringify({ kata_api_version: 1, version: "0.22.0" }), stderr: "" }) },
    { namespace: "test", executable: "/tmp/kata-fixture", executableVars: [], env: name => name === "KATA_AUTHOR" ? "alice" : undefined });
  const view = await core.session.view({ cwd: "/tmp/kata-review-synthetic" }, { reconcile: true });
  expect(statusText(view!)).toContain("requires Kata >=0.23.0");
});

test("a configured ref remains visible when owned by another actor", async () => {
  const { core, ctx } = fixture(undefined, () => ({ status: "open", owner: "other" }));
  expect((await core.session.view(ctx, { reconcile: true }))?.refs).toEqual(["test#one"]);
});

test("a parent explicitly named with todo ref is hidden after another actor takes ownership", async () => {
  let owner = "alice";
  const ctx = { cwd: "/tmp/kata-review-synthetic" };
  const core = createKataCore({ platform: nodePlatform, appendEntry() {}, delegateStore: memoryDelegateStore(), exec: async (_file, args) => {
    if (args[0] === "version") return { code: 0, stdout: JSON.stringify({ kata_api_version: 1, version: "0.23.0" }), stderr: "" };
    if (args[0] === "show") return { code: 0, stdout: JSON.stringify({ issue: { short_id: "abcd", project_id: "p1", status: "open", owner, metadata: {}, revision: 1 }, children: [] }), stderr: "" };
    if (args[0] === "projects") return { code: 0, stdout: JSON.stringify({ projects: [{ id: "p1", name: "test" }] }), stderr: "" };
    if (args[0] === "status") return { code: 0, stdout: JSON.stringify({ actor: "alice" }), stderr: "" };
    return { code: 0, stdout: JSON.stringify({ issues: [] }), stderr: "" };
  } }, { namespace: "test", native: true, executable: "/tmp/kata-fixture", executableVars: [], env: name => name === "KATA_AUTHOR" ? "alice" : undefined });
  expect(await core.todo.command(ctx, "ref test#abcd")).toContain("is now this plan's parent");
  expect((await core.session.view(ctx, { reconcile: true }))?.refs).toContain("test#abcd");
  owner = "other";
  expect((await core.session.view(ctx, { reconcile: true }))?.refs).not.toContain("test#abcd");
});

test("a slow footer reconciliation redraws after it completes", async () => {
  const gate = Promise.withResolvers<void>();
  let status = "open", hold = false;
  const writes: string[] = [];
  const ctx = { cwd: "/tmp/kata-review-synthetic", hasUI: true, ui: { setStatus: (_key: string, value: string | undefined) => writes.push(value ?? "") } };
  const core = createKataCore({ platform: nodePlatform, appendEntry() {}, delegateStore: memoryDelegateStore(), exec: async (_file, args) => {
    if (args[0] === "version") return { code: 0, stdout: JSON.stringify({ kata_api_version: 1, version: "0.23.0" }), stderr: "" };
    if (args[0] === "show") { if (hold) await gate.promise; return { code: 0, stdout: JSON.stringify({ issue: { status } }), stderr: "" }; }
    return { code: 0, stdout: JSON.stringify({ issues: [] }), stderr: "" };
  } }, { namespace: "test", executable: "/tmp/kata-fixture", executableVars: [], explicitRef: () => "test#one", env: name => name === "KATA_AUTHOR" ? "alice" : undefined });
  try {
    await core.session.footer(ctx, "force", view => view.refs.join(","));
    status = "closed"; hold = true;
    await core.session.footer(ctx, "force", view => view.refs.join(","));
    expect(writes.at(-1)).toBe("test#one");
    gate.resolve();
    const deadline = Date.now() + 2_000;
    while (writes.at(-1) !== "" && Date.now() < deadline) await Bun.sleep(1);
    expect(writes.at(-1)).toBe("");
  } finally { gate.resolve(); }
});

test("status reports a failed live inbox read", async () => {
  const stopped = Promise.withResolvers<void>();
  const ctx = { cwd: "/tmp/kata-review-synthetic" };
  const core = createKataCore({ platform: nodePlatform, appendEntry() {}, delegateStore: memoryDelegateStore(),
    liveInbox: { deliver() {}, spawn: () => ({ lines: (async function* () { await stopped.promise; })(), exited: stopped.promise, kill: () => stopped.resolve() }) },
    exec: async (_file, args) => {
      if (args[0] === "version") return { code: 0, stdout: JSON.stringify({ kata_api_version: 1, version: "0.23.0" }), stderr: "" };
      if (args[0] === "inbox") return { code: 1, stdout: "", stderr: "inbox read failed" };
      if (args[0] === "events") return { code: 0, stdout: JSON.stringify({ events: [], next_after_id: 0 }), stderr: "" };
      return { code: 0, stdout: JSON.stringify({ issues: [], projects: [] }), stderr: "" };
    } }, { namespace: "test", executable: "/tmp/kata-fixture", executableVars: [], env: name => ({ KATA_AUTHOR: "alice", KATA_INBOX_USER: "alice/worker" } as Record<string, string>)[name] });
  try {
    await core.session.start(ctx, { wait: 0 });
    const deadline = Date.now() + 2_000;
    let view = await core.session.view(ctx);
    while (view?.inbox.delivery !== "failed" && Date.now() < deadline) { await Bun.sleep(1); view = await core.session.view(ctx); }
    expect(view?.inbox.delivery).toBe("failed");
    expect(view?.inboxFailed).toContain("inbox read failed");
  } finally { await core.session.shutdown(ctx); stopped.resolve(); }
});

test("refresh withholds the old inbox on failure and rejects an older in-flight read", async () => {
  const held = Promise.withResolvers<void>();
  let reads = 0;
  const ctx = { cwd: "/tmp/kata-review-synthetic" };
  const core = createKataCore({ platform: nodePlatform, appendEntry() {}, delegateStore: memoryDelegateStore(), exec: async (_file, args) => {
    if (args[0] === "version") return { code: 0, stdout: JSON.stringify({ kata_api_version: 1, version: "0.23.0" }), stderr: "" };
    if (args[0] === "inbox") {
      const n = ++reads;
      if (n === 2) await held.promise;
      if (n >= 3) return { code: 1, stdout: "", stderr: "unavailable" };
      return { code: 0, stdout: JSON.stringify({ requests: [{ ref: "test#abcd", from: "alice", message: "old" }] }), stderr: "" };
    }
    return { code: 0, stdout: JSON.stringify({ issues: [], hookSpecificOutput: { additionalContext: "contract" } }), stderr: "" };
  } }, { namespace: "test", executable: "/tmp/kata-fixture", executableVars: [], env: name => ({ KATA_AUTHOR: "alice", KATA_INBOX_USER: "alice/worker" } as Record<string, string>)[name] });
  try {
    expect((await core.session.beforePrompt(ctx)).sections.inbox).toContain("old");
    const previous = core.session.beforePrompt(ctx);
    const deadline = Date.now() + 2_000;
    while (reads < 2 && Date.now() < deadline) await Bun.sleep(1);
    expect(reads).toBe(2);
    const queued = core.session.beforePrompt(ctx);
    await Bun.sleep(0);
    core.session.refresh();
    expect((await core.session.beforePrompt(ctx)).sections.inbox).toBeUndefined();
    held.resolve(); await Promise.all([previous, queued]);
    expect(reads).toBe(3);
    expect((await core.session.beforePrompt(ctx)).sections.inbox).toBeUndefined();
  } finally { held.resolve(); }
});

test("an inspection started before refresh cannot restore stale counts", async () => {
  const gate = Promise.withResolvers<void>();
  let started = false;
  const ctx = { cwd: "/tmp/kata-review-synthetic" };
  const core = createKataCore({ platform: nodePlatform, appendEntry() {}, delegateStore: memoryDelegateStore(), exec: async (_file, args) => {
    if (args[0] === "version") return { code: 0, stdout: JSON.stringify({ kata_api_version: 1, version: "0.23.0" }), stderr: "" };
    if (args[0] === "inbox") { started = true; await gate.promise; return { code: 0, stdout: JSON.stringify({ requests: [{ ref: "test#abcd", from: "alice", message: "old" }] }), stderr: "" }; }
    return { code: 0, stdout: JSON.stringify({ issues: [] }), stderr: "" };
  } }, { namespace: "test", executable: "/tmp/kata-fixture", executableVars: [], env: name => ({ KATA_AUTHOR: "alice", KATA_INBOX_USER: "alice/worker" } as Record<string, string>)[name] });
  try {
    const inspecting = core.session.inbox(ctx);
    const deadline = Date.now() + 2_000;
    while (!started && Date.now() < deadline) await Bun.sleep(1);
    expect(started).toBe(true);
    core.session.refresh(); gate.resolve(); await inspecting;
    expect((await core.session.view(ctx))?.counts).toBeUndefined();
  } finally { gate.resolve(); }
});

test("native inbox is explicit and hides plugin counts from the view", async () => {
  const { core, ctx } = fixture();
  await core.session.inbox(ctx);
  expect((await core.session.view(ctx, { context: false }))?.inbox.delivery).toBe("per prompt");
  const view = await core.session.view(ctx, { nativeInbox: true });
  expect(view?.inbox.delivery).toBe("kata"); expect(view?.counts).toBeUndefined();
  expect((await core.session.inbox(ctx, { nativeInbox: true })).native).toBe(true);
});

test("refresh preserves a personal-inbox warning and clears cached delegate contracts", async () => {
  const warnings: string[] = [];
  let hooks = 0;
  const ctx = { cwd: "/tmp/kata-review-synthetic", ui: { notify: (message: string) => warnings.push(message) } };
  const core = createKataCore({ platform: nodePlatform, appendEntry() {}, delegateStore: memoryDelegateStore(), exec: async (_file, args) => {
    if (args[0] === "version") return { code: 0, stdout: JSON.stringify({ kata_api_version: 1, version: "0.23.0" }), stderr: "" };
    if (args[0] === "agent-contract-hook") return { code: 0, stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: `contract ${++hooks}` } }), stderr: "" };
    return { code: 0, stdout: JSON.stringify({ issues: [] }), stderr: "" };
  } }, { namespace: "test", executable: "/tmp/kata-fixture", executableVars: [], env: name => ({ KATA_AUTHOR: "alice", KATA_INBOX_USER: "alice" } as Record<string, string>)[name] });
  const delegate = core.delegate("worker");
  expect((await core.session.beforePrompt(ctx)).sections.contract).toBe("contract 1");
  expect((await delegate.session.beforePrompt(ctx)).sections.contract).toBe("contract 2");
  core.session.refresh();
  expect((await core.session.beforePrompt(ctx)).sections.contract).toBe("contract 3");
  expect((await delegate.session.beforePrompt(ctx)).sections.contract).toBe("contract 4");
  expect(warnings).toHaveLength(1);
});

for (const outcome of ["success", "failure", "shutdown"] as const) test(`slow per-prompt inbox ${outcome} updates only a running footer`, async () => {
  const gate = Promise.withResolvers<void>();
  const writes: string[] = [];
  const ctx = { cwd: "/tmp/kata-review-synthetic", hasUI: true, ui: { setStatus: (_key: string, value: string | undefined) => writes.push(value ?? "") } };
  const core = createKataCore({ platform: nodePlatform, appendEntry() {}, delegateStore: memoryDelegateStore(), exec: async (_file, args) => {
    if (args[0] === "version") return { code: 0, stdout: JSON.stringify({ kata_api_version: 1, version: "0.23.0" }), stderr: "" };
    if (args[0] === "inbox") { await gate.promise; return outcome === "failure" ? { code: 1, stdout: "", stderr: "read failed" } : { code: 0, stdout: JSON.stringify({ requests: [{ ref: "test#abcd", from: "alice", message: "one" }] }), stderr: "" }; }
    return { code: 0, stdout: JSON.stringify({ issues: [], hookSpecificOutput: { additionalContext: "contract" } }), stderr: "" };
  } }, { namespace: "test", executable: "/tmp/kata-fixture", executableVars: [], env: name => ({ KATA_AUTHOR: "alice", KATA_INBOX_USER: "alice/worker" } as Record<string, string>)[name] });
  try {
    await core.session.beforePrompt(ctx);
    await core.session.footer(ctx, "force", v => v.inbox.delivery === "failed" ? "failed" : `inbox ${v.counts?.trusted ?? 0}`);
    expect(writes.at(-1)).toBe("inbox 0");
    if (outcome === "shutdown") await core.session.shutdown(ctx);
    gate.resolve();
    const expected = outcome === "shutdown" ? "" : outcome === "failure" ? "failed" : "inbox 1";
    const deadline = Date.now() + 2_000;
    if (outcome === "shutdown") await Bun.sleep(30);
    else while (writes.at(-1) !== expected && Date.now() < deadline) await Bun.sleep(1);
    expect(writes.at(-1)).toBe(expected);
  } finally { gate.resolve(); if (outcome !== "shutdown") await core.session.shutdown(ctx); }
});

test("forced status callers share a fresh read after an older reconciliation", async () => {
  const gate = Promise.withResolvers<void>();
  let started = false, closed = false, shows = 0;
  const ctx = { cwd: "/tmp/kata-status-race", hasUI: true, ui: { setStatus() {} } };
  const core = createKataCore({ platform: nodePlatform, appendEntry() {}, delegateStore: memoryDelegateStore(), exec: async (_file, args) => {
    if (args[0] === "version") return { code: 0, stdout: JSON.stringify({ kata_api_version: 1, version: "0.24.0" }), stderr: "" };
    if (args[0] === "show") { const snapshot = closed ? "closed" : "open"; if (++shows === 1) { started = true; await gate.promise; } return { code: 0, stdout: JSON.stringify({ issue: { status: snapshot } }), stderr: "" }; }
    return { code: 0, stdout: JSON.stringify({ issues: [] }), stderr: "" };
  } }, { namespace: "test", executable: "/tmp/kata-fixture", executableVars: [], explicitRef: () => "test#one", env: n => n === "KATA_AUTHOR" ? "alice" : undefined });
  try {
    const old = core.session.footer(ctx, "throttle", v => v.refs.join(","));
    const deadline = Date.now() + 2000;
    while (!started && Date.now() < deadline) await Bun.sleep(1);
    expect(started).toBe(true);
    closed = true;
    const first = core.session.view(ctx, { reconcile: true }), second = core.session.view(ctx, { reconcile: true });
    await Bun.sleep(10); gate.resolve();
    expect((await first)?.refs).toEqual([]);
    expect((await second)?.refs).toEqual([]);
    await old;
    expect(shows).toBe(2);
  } finally { gate.resolve(); }
});

test("a shell close invalidates the footer while retaining the claim", async () => {
  let closed = false;
  const { core, ctx } = fixture(undefined, () => ({ status: closed ? "closed" : "open" }));
  await core.tools.result(ctx, { toolName: "bash", input: { command: "kata claim test#abcd" } });
  const writes: string[] = [];
  const visible = { ...ctx, ui: { setStatus: (_key: string, value: string | undefined) => writes.push(value ?? "") } };
  await core.session.footer(visible, "force", view => view.refs.join(","));
  expect(writes.at(-1)).toContain("test#abcd");
  closed = true;
  await core.tools.result(ctx, { toolName: "bash", input: { command: "kata close test#abcd --done --message x" } });
  await core.session.footer(visible, "throttle", view => view.refs.join(","));
  expect(writes.at(-1)).not.toContain("test#abcd");
  expect(core.tools.refs(ctx)).toContain("test#abcd");
});

test("diagnostic reconciliation bounds each show call", async () => {
  const timeouts: number[] = [];
  const core = createKataCore({ platform: nodePlatform, appendEntry() {}, delegateStore: memoryDelegateStore(), exec: async (_file, args, options) => {
    if (args[0] === "show") timeouts.push(options.timeout);
    return { code: 0, stdout: JSON.stringify(args[0] === "version" ? { kata_api_version: 1, version: "0.24.0" } : { issue: { status: "open" } }), stderr: "" };
  } }, { namespace: "test", executable: "/tmp/kata-fixture", executableVars: [], explicitRef: () => "test#one", env: n => n === "KATA_AUTHOR" ? "alice" : undefined });
  await core.session.view({ cwd: "/tmp/kata-status-timeout" }, { reconcile: true });
  expect(timeouts).toEqual([3000]);
});

test("refresh cancels a forced reconcile queued behind an older read", async () => {
  const gate = Promise.withResolvers<void>();
  let started = false, shows = 0;
  const ctx = { cwd: "/tmp/kata-status-refresh-race", hasUI: true, ui: { setStatus() {} } };
  const core = createKataCore({ platform: nodePlatform, appendEntry() {}, delegateStore: memoryDelegateStore(), exec: async (_file, args) => {
    if (args[0] === "version") return { code: 0, stdout: JSON.stringify({ kata_api_version: 1, version: "0.24.0" }), stderr: "" };
    if (args[0] === "show") { shows++; started = true; await gate.promise; return { code: 0, stdout: JSON.stringify({ issue: { status: "open" } }), stderr: "" }; }
    return { code: 0, stdout: JSON.stringify({ issues: [] }), stderr: "" };
  } }, { namespace: "test", executable: "/tmp/kata-fixture", executableVars: [], explicitRef: () => "test#one", env: n => n === "KATA_AUTHOR" ? "alice" : undefined });
  try {
    const old = core.session.footer(ctx, "throttle", v => v.refs.join(","));
    const deadline = Date.now() + 2000;
    while (!started && Date.now() < deadline) await Bun.sleep(1);
    expect(started).toBe(true);
    const queued = core.session.view(ctx, { reconcile: true });
    await Bun.sleep(10); core.session.refresh(); gate.resolve();
    await Promise.all([old, queued]);
    expect(shows).toBe(1);
  } finally { gate.resolve(); }
});
