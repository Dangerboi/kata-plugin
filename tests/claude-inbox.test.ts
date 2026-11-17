import { expect, test } from "bun:test";
import { claudeKata, PROJECT } from "./claude-fixture";
import { eventually, settle, unique, until } from "./kata-fixture";

// Live inbox delivery in the Claude mod, against a real Kata: a `kata notify` reaches the follower the mod starts through
// `$.process.spawn`, and leaves through `$.prompt.submit` (idle) or `$.session.append` (the lead's turn is running).
// The framing and the trust rule are the core's (live-inbox.test.ts); these tests pin the Claude wiring around them.
const { host, kata, issue, author, binary } = claudeKata("claude-inbox");
const newIssue = () => issue(`Live inbox ${unique()}`);
const addressOf = (name: string) => `${author}/${name}-${unique()}`;
const live = (address: string, extra: Record<string, unknown> = {}, options: Record<string, unknown> = {}) =>
  host({ env: { KATA_INBOX_USER: address, ...extra }, options: { kataExecutable: binary, ...options } });
const children = (workspace: string) => Bun.spawnSync(["pgrep", "-f", `events --tail --json --workspace ${workspace}`]).stdout.toString().split("\n").filter(Boolean);
const notify = (ref: string, address: string, message: string, as?: string) =>
  kata(["notify", ref, "--to", address, "--message", message, "--json"], undefined, as ? { KATA_AUTHOR: as } : undefined);
const clear = (ref: string, address: string) => kata(["notify", ref, "--to", address, "--clear", "--json"]);
const texts = (list: any[]) => list.map(a => a.text ?? a.message.content[0].text);

test("a notify sent while the session is idle starts a turn: submitted with the untrusted-data framing and the clear command", async () => {
  const address = addressOf("idle");
  const h = live(address);
  await h.start();
  expect(await until(() => h.spawned.length === 1)).toBe(true);
  expect(h.spawned[0].argv.slice(0, 5)).toEqual([binary, "events", "--tail", "--json", "--workspace"]);
  const ref = await newIssue();
  await notify(ref, address, "idle-ping-4410");
  expect(await until(() => h.submitted.length === 1)).toBe(true);
  const [text] = texts(h.submitted);
  expect(text).toContain("idle-ping-4410");
  expect(text).toContain("untrusted data");
  expect(text).toContain(`kata notify ${PROJECT}#${ref} --to ${address} --clear`);
  expect(h.appended).toEqual([]);
  await clear(ref, address);
});

test("a notify sent while the lead's turn is running is appended to the turn, and one after it ends is submitted again", async () => {
  const address = addressOf("busy");
  const h = live(address);
  await h.start();
  expect(await until(() => h.spawned.length === 1)).toBe(true);
  const ref = await newIssue();
  await h.turnStart();
  await notify(ref, address, "busy-ping-7731");
  expect(await until(() => h.appended.length === 1)).toBe(true);
  expect(h.appended[0].message.type).toBe("user");
  expect(texts(h.appended)[0]).toContain("busy-ping-7731");
  expect(h.submitted).toEqual([]);
  await h.turnComplete();
  const second = await newIssue();
  await notify(second, address, "after-turn-2096");
  expect(await until(() => h.submitted.length === 1)).toBe(true);
  expect(texts(h.submitted)[0]).toContain("after-turn-2096");
  expect(h.appended).toHaveLength(1);
  await clear(ref, address);
  await clear(second, address);
});

test("a subagent's turn does not make the lead busy", async () => {
  const address = addressOf("sub");
  const h = live(address);
  await h.start();
  expect(await until(() => h.spawned.length === 1)).toBe(true);
  await h.turnStart("agent-1");
  const ref = await newIssue();
  await notify(ref, address, "while-sub-turn-3318");
  expect(await until(() => h.submitted.length === 1)).toBe(true);
  expect(h.appended).toEqual([]);
  await clear(ref, address);
});

test("only the session's own actor is delivered, each request once, and a clear delivers nothing", async () => {
  const address = addressOf("trust");
  const h = live(address);
  await h.start();
  expect(await until(() => h.spawned.length === 1)).toBe(true);
  const ref = await newIssue();
  await notify(ref, address, "from-someone-else-5521", "someone-else");
  await notify(ref, address, "own-request-6602");
  await notify(ref, address, "own-request-6602");
  await clear(ref, address);
  // The stream is ordered: the sentinel arrives after everything above was processed.
  const sentinel = await newIssue();
  await notify(sentinel, address, "sentinel-9970");
  expect(await until(() => h.submitted.length >= 2)).toBe(true);
  await settle(300);
  expect(texts(h.submitted).map(t => /(from-someone-else-5521|own-request-6602|sentinel-9970)/.exec(t)![1])).toEqual(["own-request-6602", "sentinel-9970"]);
  await clear(sentinel, address);
});

test("with the contract option the live section follows the stream: shown while requested, gone after the clear", async () => {
  const address = addressOf("section");
  const h = live(address, {}, { contract: true });
  await h.start();
  expect(await until(() => h.spawned.length === 1)).toBe(true);
  const ref = await newIssue();
  await notify(ref, address, "section-note-8814");
  expect(await until(() => h.submitted.length === 1)).toBe(true);
  const contextOf = async () => ((await h.prompt("go")).context ?? []).join("\n");
  expect(await contextOf()).toContain("section-note-8814");
  await clear(ref, address);
  await eventually(async () => (await contextOf()).includes("section-note-8814"), false);
});

test("KATA_CLAUDE_LIVE_INBOX=0 and the liveInbox option follow no stream, and the per-prompt section stays", async () => {
  for (const [extra, options] of [[{ KATA_CLAUDE_LIVE_INBOX: "0" }, {}], [{}, { liveInbox: false }]] as const) {
    const address = addressOf("off");
    const h = live(address, extra, { contract: true, ...options });
    await h.start();
    const ref = await newIssue();
    await notify(ref, address, "per-prompt-only-1175");
    expect(((await h.prompt("go")).context ?? []).join("\n")).toContain("per-prompt-only-1175");
    await settle(300);
    expect(h.spawned).toEqual([]);
    expect(h.submitted).toEqual([]);
    await clear(ref, address);
  }
});

test("a person's bare address starts no follower", async () => {
  const h = live(author);
  await h.start();
  await settle(300);
  expect(h.spawned).toEqual([]);
});

test("the stream child ends with the session", async () => {
  const address = addressOf("end");
  const h = live(address);
  await h.start();
  expect(await until(() => h.spawned.length === 1)).toBe(true);
  const workspace = h.spawned[0].argv[5];
  expect(await until(() => children(workspace).length === 1)).toBe(true);
  await h.end();
  expect(await until(() => children(workspace).length === 0)).toBe(true);
  const ref = await newIssue();
  await notify(ref, address, "after-end-4402");
  await settle(500);
  expect(h.submitted).toEqual([]);
  await clear(ref, address);
});
