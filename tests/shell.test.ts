import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "bun";
import { assertIsolated } from "./isolation";
import { kataCommands } from "../plugins/oh-my-pi/kata";
import { delegateCommand, kataCommands as coreCommands } from "../core/shell";
assertIsolated();

test("only command positions are Kata invocations", () => {
  const command = `echo 'kata --as actor-b'; KATA_HOME=/tmp/store kata claim abc && command '/opt/homebrew/bin/kata' list`;
  expect(kataCommands(command).map(c => c.words.map(w => w.value))).toEqual([["claim", "abc"], ["list"]]);
});
test("quoted heredoc text is never a Kata command", () => {
  const command = "cat <<'DOC'\nkata --as fake claim xyz\nDOC\nkata list";
  expect(kataCommands(command).map(c => c.words.map(w => w.value))).toEqual([["list"]]);
});
test("the configured executable variable is recognized without evaluating shell code", () => {
  expect(kataCommands('"$KATA_OMP_EXECUTABLE" list')).toHaveLength(1);
  expect(kataCommands('"${KATA_OMP_EXECUTABLE}" list')).toHaveLength(1);
});
test("each adapter recognizes only its own executable variables", () => {
  const pi = ["KATA_PI_EXECUTABLE", "KATA_OMP_EXECUTABLE"];
  expect(kataCommands('"$KATA_PI_EXECUTABLE" list')).toHaveLength(0);
  expect(kataCommands('"${KATA_PI_EXECUTABLE}" list')).toHaveLength(0);
  expect(coreCommands('"$KATA_PI_EXECUTABLE" list', "kata", pi)).toHaveLength(1);
  expect(coreCommands('"${KATA_PI_EXECUTABLE}" list', "kata", pi)).toHaveLength(1);
});

test("a delegate's own session prefixes only its close", () => {
  const own = { agent: "omp", id: "child-uuid" };
  expect(delegateCommand("kata close ab12 --done && kata show ab12", "kata", [], "tm-1", undefined, own))
    .toBe("env KATA_TRANSCRIPT_AGENT='omp' KATA_TRANSCRIPT_SESSION_ID='child-uuid' kata --teammate 'tm-1' close ab12 --done && kata --teammate 'tm-1' show ab12");
  expect(delegateCommand("kata close ab12 --done", "kata", [], "tm-1")).toBe("kata --teammate 'tm-1' close ab12 --done");
});
test("a delegate's close still runs after a skipped prefix word", () => {
  const own = { agent: "omp", id: "child-uuid" };
  const dir = mkdtempSync(join(tmpdir(), "kata-stub-"));
  try {
    writeFileSync(join(dir, "kata"), '#!/bin/sh\necho "$KATA_TRANSCRIPT_AGENT/$KATA_TRANSCRIPT_SESSION_ID $*"\n', { mode: 0o755 });
    for (const [input, prefix] of [["command kata close ab12", "command env "], ["time kata close ab12", "time env "], ['KATA_X=1 kata close ab12', "KATA_X=1 env "]]) {
      const rewritten = delegateCommand(input, "kata", [], "tm-1", undefined, own);
      expect(rewritten.startsWith(`${prefix}KATA_TRANSCRIPT_AGENT='omp'`)).toBe(true);
      const out = spawnSync(["bash", "-c", rewritten], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
      expect([out.exitCode, out.stdout.toString().trim()]).toEqual([0, "omp/child-uuid --teammate tm-1 close ab12"]);
    }
    const viaVariable = delegateCommand('"$KATA_BIN" close ab12', "kata", ["KATA_BIN"], "tm-1", undefined, own);
    expect(viaVariable).toBe(`env KATA_TRANSCRIPT_AGENT='omp' KATA_TRANSCRIPT_SESSION_ID='child-uuid' "$KATA_BIN" --teammate 'tm-1' close ab12`);
    const out = spawnSync(["bash", "-c", viaVariable], { env: { ...process.env, KATA_BIN: join(dir, "kata") } });
    expect([out.exitCode, out.stdout.toString().trim()]).toEqual([0, "omp/child-uuid --teammate tm-1 close ab12"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
