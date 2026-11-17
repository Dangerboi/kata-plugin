import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "bun";
import { assertIsolated } from "./isolation";
import { kataCommands } from "../plugins/oh-my-pi/kata";
import { delegateCommand, kataCommands as coreCommands } from "../core/shell";
import { nodePlatform } from "../core/node-host";
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
  expect(coreCommands(nodePlatform.path, '"$KATA_PI_EXECUTABLE" list', "kata", pi)).toHaveLength(1);
  expect(coreCommands(nodePlatform.path, '"${KATA_PI_EXECUTABLE}" list', "kata", pi)).toHaveLength(1);
});

// A stub `kata` that reports the transcript environment it was started with and its arguments; `$KATA_BIN` names it too.
function execute(command: string, extra: Record<string, string> = {}): string[] {
  const dir = mkdtempSync(join(tmpdir(), "kata-stub-"));
  try {
    writeFileSync(join(dir, "kata"), '#!/bin/sh\necho "$KATA_TRANSCRIPT_AGENT/$KATA_TRANSCRIPT_SESSION_ID/$KATA_CLOSE_TRANSCRIPT_ENABLED $*"\n', { mode: 0o755 });
    const env: Record<string, string | undefined> = { ...process.env, PATH: `${dir}:${process.env.PATH}`, KATA_BIN: join(dir, "kata"), ...extra };
    for (const name of ["KATA_TRANSCRIPT_AGENT", "KATA_TRANSCRIPT_SESSION_ID", "KATA_CLOSE_TRANSCRIPT_ENABLED"]) if (!(name in extra)) delete env[name];
    const out = spawnSync(["bash", "-c", command], { env });
    expect(out.exitCode).toBe(0);
    return out.stdout.toString().trim().split("\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const own = { env: { get: () => undefined }, agent: "omp", id: "child-uuid" };

test("a delegate's own session prefixes only its close", () => {
  const rewritten = delegateCommand(nodePlatform.path, "kata close ab12 --done && kata show ab12", "kata", [], "tm-1", undefined, own);
  expect(execute(rewritten)).toEqual(["omp/child-uuid/true --teammate tm-1 close ab12 --done", "// --teammate tm-1 show ab12"]);
  expect(execute(delegateCommand(nodePlatform.path, "kata close ab12 --done", "kata", [], "tm-1"))).toEqual(["// --teammate tm-1 close ab12 --done"]);
});
test("a delegate whose own session is unknown switches recording off for its close only", () => {
  const rewritten = delegateCommand(nodePlatform.path, "kata close ab12 --done && kata show ab12", "kata", [], "tm-1", undefined, { env: { get: () => undefined }, agent: "omp", id: undefined });
  expect(execute(rewritten, { KATA_TRANSCRIPT_AGENT: "lead", KATA_TRANSCRIPT_SESSION_ID: "lead-uuid" })).toEqual(["lead/lead-uuid/false --teammate tm-1 close ab12 --done", "lead/lead-uuid/ --teammate tm-1 show ab12"]);
});
test("a delegate's close still runs after a skipped prefix word, or through an executable variable", () => {
  for (const input of ["command kata close ab12", "time kata close ab12", "KATA_X=1 kata close ab12"]) {
    expect(execute(delegateCommand(nodePlatform.path, input, "kata", [], "tm-1", undefined, own))).toEqual(["omp/child-uuid/true --teammate tm-1 close ab12"]);
  }
  expect(execute(delegateCommand(nodePlatform.path, '"$KATA_BIN" close ab12', "kata", ["KATA_BIN"], "tm-1", undefined, own))).toEqual(["omp/child-uuid/true --teammate tm-1 close ab12"]);
});
