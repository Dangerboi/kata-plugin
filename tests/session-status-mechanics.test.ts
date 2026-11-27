import { expect, test } from "bun:test";
import { createKataCore } from "../core/kata-core";
import { nodePlatform } from "../core/node-host";
import { memoryDelegateStore } from "./kata-fixture";
import { trustedInbox } from "../core/inbox";

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

test("a requested status reconciliation sees a newly closed ref inside the throttle window", async () => {
  let status = "open";
  const { core, ctx } = fixture(undefined, () => ({ status }));
  expect((await core.session.view(ctx, { reconcile: true }))?.refs).toEqual(["test#one"]);
  status = "closed";
  expect((await core.session.view(ctx, { reconcile: true }))?.refs).toEqual([]);
});

test("reading the inbox before any prompt publishes its counts for inspection", async () => {
  const { core, ctx } = fixture();
  await core.session.inbox(ctx);
  expect((await core.session.view(ctx))?.counts).toEqual({ trusted: 1, foreign: 1 });
  expect((await core.session.beforePrompt(ctx)).sections.inbox).toContain("hello");
});

test("session inspection reads the inbox without consuming prompt state", async () => {
  const { core, ctx } = fixture();
  const before = await core.session.beforePrompt(ctx);
  const result = await core.session.inbox(ctx);
  expect(result.counts).toEqual({ trusted: 1, foreign: 1 });
  expect(result.text).toContain("hello");
  expect(result.text).not.toContain("private");
  expect((await core.session.beforePrompt(ctx)).sections.inbox).toEqual(before.sections.inbox);
  expect((await core.session.view(ctx))?.counts).toEqual({ trusted: 1, foreign: 1 });
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
