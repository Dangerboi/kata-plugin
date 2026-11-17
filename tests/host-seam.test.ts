import { createHash } from "node:crypto";
import path from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { digest } from "../core/model";
import { sha256Hex } from "../core/sha256";
import * as posix from "../core/posix-path";
import { canonicalPath } from "../core/kata-core";
import { nodePlatform } from "../core/node-host";
import { kataCommands } from "../core/shell";
import { explicitParent } from "../core/plan-parent";
import { slotKey } from "../core/inbox";
import { closeEnv, CORE_ENV, debugTo, waitAtMost, type Timers } from "../core/kata-cli";
import { readEnv } from "../plugins/claude-code/hooks/settings";

test("the pure SHA-256 matches the published vectors", () => {
  expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  expect(sha256Hex("a".repeat(1_000_000))).toBe("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
});

test("digest keeps the idempotency keys it produced: a known literal, and Node's hash over many inputs", () => {
  expect(digest("plan", "phase", "content")).toBe(createHash("sha256").update("plan\u0000phase\u0000content").digest("hex").slice(0, 24));
  expect(digest("abc")).toBe("ba7816bf8f01cfea414140de");
  for (const parts of [[""], ["é", "日本語", "😀"], ["x".repeat(55)], ["x".repeat(56)], ["x".repeat(64)], ["x".repeat(119), "y"], ["a", "b", "c", "d"]]) {
    expect(digest(...parts)).toBe(createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24));
  }
});

test("posix-path agrees with node:path on the inputs the core uses", () => {
  const cases: [string, string][] = [["/a/b", "."], ["/a/b/", "c"], ["/a/b", "../c"], ["/a", "/x/y"], ["/a/b", "./"], ["/", ".."], ["/a//b", "c/../d"]];
  for (const [base, rel] of cases) expect(posix.resolve(base, rel)).toBe(path.posix.resolve(base, rel));
  for (const p of ["/a/b/c.txt", "/a/b/", "/a", "/", "a/b", "c"]) {
    expect(posix.basename(p)).toBe(path.posix.basename(p));
    expect(posix.dirname(p)).toBe(path.posix.dirname(p));
  }
  expect(posix.join("/a/b", "c.txt")).toBe(path.posix.join("/a/b", "c.txt"));
  expect(posix.join("/a/b/..", "c")).toBe("/a/c");
});

test("canonicalPath resolves symlinks through the host's realpath, and a missing file through its folder", async () => {
  const real = async (p: string) => { if (p === "/link/dir") return "/real/dir"; throw new Error("ENOENT"); };
  const host = { path: posix.posixPath, realpath: real };
  expect(await canonicalPath(host, "s.jsonl", "/link/dir")).toBe("/real/dir/s.jsonl");
  expect(await canonicalPath(host, "/nowhere/s.jsonl", "/link/dir")).toBe("/nowhere/s.jsonl");
});

test("a Node host keeps node:path's results, Windows included", async () => {
  expect(nodePlatform.path).toBe(path);
  const win = { path: path.win32, realpath: async (p: string) => { if (p === "C:\\work\\link") return "D:\\real"; throw new Error("ENOENT"); } };
  expect(await canonicalPath(win, "s.jsonl", "C:\\work\\link")).toBe(path.win32.join("D:\\real", "s.jsonl"));
  expect(await canonicalPath(win, "..\\other\\s.jsonl", "C:\\work\\link")).toBe(path.win32.resolve("C:\\work\\link", "..\\other\\s.jsonl"));
  expect(kataCommands(path.win32, "'C:\\tools\\kata' list").map(c => c.words.map(w => w.value))).toEqual([["list"]]);
  expect(kataCommands(posix.posixPath, "'C:\\tools\\kata' list")).toEqual([]);
  expect(explicitParent({ path: path.win32, cwd: "C:\\work\\..\\app", explicit: "p#1" })?.workspace).toBe("C:\\app");
});

test("slotKey is unpadded base64url of the address bytes", () => {
  expect(slotKey("lead/worker")).toBe("notify." + Buffer.from("lead/worker").toString("base64url"));
  expect(slotKey("x".repeat(300_000))).toBe("notify." + Buffer.from("x".repeat(300_000)).toString("base64url"));
  for (const n of [0, 1, 2, 3, 4, 5]) expect(slotKey("a".repeat(n))).toBe("notify." + Buffer.from("a".repeat(n)).toString("base64url"));
  expect(slotKey("ü/日?>")).toBe("notify." + Buffer.from("ü/日?>").toString("base64url"));
});

test("the transcript switch comes from the host's environment, not the process", () => {
  const host = (value?: string) => ({ get: (name: string) => name === "KATA_CLOSE_TRANSCRIPT_ENABLED" ? value : undefined });
  expect(closeEnv(host("false"), ["close", "x"], "claude", "s1")).toMatchObject({ KATA_CLOSE_TRANSCRIPT_ENABLED: "false", KATA_TRANSCRIPT_SESSION_ID: "s1" });
  expect(closeEnv(host(), ["close", "x"], "claude", "s1")).toMatchObject({ KATA_CLOSE_TRANSCRIPT_ENABLED: "true" });
});

test("waitAtMost and debugTo take their timer and file sink from the host", async () => {
  const armed: { fire: () => void; ms: number }[] = [], cleared: unknown[] = [];
  const timers: Timers = { setTimer: (fire, ms) => { armed.push({ fire, ms }); return armed.length; }, clearTimer: handle => cleared.push(handle) };
  const never = new Promise<string>(() => {});
  const waiting = waitAtMost(never, 250, () => {}, timers);
  armed[0].fire();
  expect(await waiting).toBeUndefined();
  expect(armed[0].ms).toBe(250);
  expect(cleared).toEqual([1]);
  const lines: string[] = [];
  debugTo("/log", (file, text) => lines.push(file + text))(new Error("boom"));
  expect(lines[0]).toMatch(/^\/log\S+ Error: boom\n$/);
  debugTo(undefined, () => lines.push("never"))("quiet");
  expect(lines).toHaveLength(1);
});

test("core/ imports nothing from Node, except the Node host module", () => {
  const offenders: string[] = [];
  for (const name of readdirSync("core").filter(n => n.endsWith(".ts") && n !== "node-host.ts")) {
    readFileSync(`core/${name}`, "utf8").split("\n").forEach((line, i) => {
      if (/^\s*\/\//.test(line)) return;
      if (/from "node:|\bprocess\.|\bsetTimeout\b|\bclearTimeout\b|\bBuffer\b/.test(line)) offenders.push(`${name}:${i + 1}: ${line.trim()}`);
    });
  }
  expect(offenders).toEqual([]);
});

test("the Claude Code adapter asks its host for every variable the core reads", async () => {
  const asked: string[] = [];
  await readEnv({ env: { get: async (name: string) => { asked.push(name); return undefined; } } } as any);
  for (const name of CORE_ENV) expect(asked).toContain(name);
});
