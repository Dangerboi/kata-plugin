import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "bun";
import { assertIsolated } from "./isolation";
import { kataCommands } from "../plugins/oh-my-pi/kata";
import { delegateCommand, kataCommands as coreCommands, shellOptions, transcriptCommand } from "../core/shell";
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


test("claim positions prove success only through a top-level && suffix", () => {
  for (const [command, proven] of [
    ["cd x && kata claim abcd", true], ["make; kata claim abcd", true],
    ["kata claim abcd && kata show abcd", true], ["kata claim abcd && kata claim efgh", true],
    ["kata claim abcd; kata show abcd", false], ["kata claim abcd || true", false],
    ["true || kata claim abcd", false], ["true ||\n kata claim abcd", false], ["true |\n kata claim abcd", false], ["true &&\n kata claim abcd", true], ["kata claim abcd | tee log", false],
    ["kata claim abcd &", false], ["kata claim abcd --comment \\>& true", false], ["kata claim abcd --comment \\>| tee x", false], ["kata claim abcd --comment '>'", true], ["kata claim abcd |& tee log", false], ["true || printf ignored |& kata claim abcd", false],
    ["kata claim abcd >| /dev/null", true], ["kata claim abcd 2>| /dev/null", true], ["true &&\\\n kata claim abcd", true], ["true ||\\\n kata claim abcd", false],
    ["kata claim abcd 2>&1", true], ["kata claim abcd >/dev/null 2>&1", true], ["kata claim abcd &>/dev/null", true],
    ["kata claim abcd >&2", true], ["kata claim abcd <&0", true], ["kata claim abcd && echo ok 2>&1", true],
    ["kata claim abcd && (( $(kata show abcd) + 1 ))", true], ["kata claim abcd && echo $(date)", true], ["kata claim abcd && (true)", true], ["kata claim abcd && echo $(date) && true", true], ["kata claim abcd && echo $(date) || true", false], ["kata claim abcd && (true) &", false], ["kata claim abcd; (true)", false],
    ["kata claim abcd && (( 1 || 0 ))", true], ["kata claim abcd && (( 1 & 1 ))", true], ["kata claim abcd; (( 1 ))", false], ["kata claim abcd && (( 1 ))", true], ["kata claim abcd;", true], ["kata claim abcd\n", true], ["kata claim abcd; # done\n", true],
    ["kata claim abcd --comment '!'", true], ["((kata claim abcd) && echo)", false], ["(kata claim abcd)", false], ["{ echo hi; kata claim abcd; }", false],
    ["if true; then kata claim abcd; fi", false], ["while true; do kata claim abcd; done", false],
    ["for x in a; do kata claim abcd; done", false], ["if true; then if true; then echo x; fi; kata claim abcd; fi", false], ["! kata claim abcd", false],
  ] as const) {
    const claims = coreCommands(nodePlatform.path, command).filter(c => shellOptions(c.words).args[0] === "claim");
    expect(claims.length, command).toBeGreaterThan(0);
    expect(claims.every(c => c.proven), command).toBe(proven);
  }
});

test("arithmetic shifts and CRLF leave later Kata commands visible", () => {
  for (const command of ["(( x << 1 ))\nkata claim abcd", "for (( i = 1; i < 9; i <<= 1 )); do echo x; done\nkata claim abcd", "echo x\r\nkata claim abcd"]) {
    expect(coreCommands(nodePlatform.path, command).map(c => shellOptions(c.words).args)).toEqual([["claim", "abcd"]]);
  }
  expect(coreCommands(nodePlatform.path, "((unterminated\nkata claim abcd").map(c => shellOptions(c.words).args)).toEqual([["claim", "abcd"]]);
  expect(delegateCommand(nodePlatform.path, "(( x << 1 ))\nkata claim abcd", "kata", [], "worker")).toContain("kata --teammate 'worker' claim abcd");
  expect(shellOptions(coreCommands(nodePlatform.path, "kata claim --ttl 2h abcd")[0].words).args).toEqual(["claim", "abcd"]);
});


test("arithmetic substitutions retain executable commands and heredoc data", () => {
  const input = "(( $(kata claim abcd >/dev/null; printf 1) ))";
  const invocations = coreCommands(nodePlatform.path, input);
  expect(invocations.map(c => [shellOptions(c.words).args[0], c.proven])).toEqual([["claim", false]]);
  expect(delegateCommand(nodePlatform.path, input, "kata", [], "worker")).toContain("kata --teammate 'worker' claim abcd");
  expect(() => delegateCommand(nodePlatform.path, "(( $(kata --as other claim abcd; printf 1) ))", "kata", [], "worker")).toThrow("--as");
  expect(transcriptCommand(nodePlatform.path, "(( $(kata close abcd; printf 1) ))", "kata", [], own)).toContain("KATA_TRANSCRIPT_SESSION_ID='child-uuid'");
  const heredoc = "(( $(cat <<EOF\nkata claim hidden\nEOF\n) ))\nkata claim abcd";
  expect(coreCommands(nodePlatform.path, heredoc).map(c => shellOptions(c.words).args)).toEqual([["claim", "abcd"]]);
  expect(delegateCommand(nodePlatform.path, heredoc, "kata", [], "worker")).toContain("\nkata claim hidden\n");
  expect(coreCommands(nodePlatform.path, "(( (x << 2) ))\nkata claim abcd")).toHaveLength(1);
  const nested = coreCommands(nodePlatform.path, "kata claim abcd && (( $(kata show abcd) + 1 ))");
  expect(nested.map(c => c.proven)).toEqual([true, false]);
});


test("nested arithmetic keeps later delegate commands visible", () => {
  const command = "(( $(printf %s $((1 << 1))) ))\nkata claim abcd && kata claim efgh";
  expect(coreCommands(nodePlatform.path, command).map(c => shellOptions(c.words).args)).toEqual([["claim", "abcd"], ["claim", "efgh"]]);
  expect(delegateCommand(nodePlatform.path, command, "kata", [], "worker").match(/--teammate 'worker'/g)).toHaveLength(2);
});

test("ANSI-C quoted text cannot introduce a shell command", () => {
  const command = String.raw`echo $'\'; kata claim abcd'`;
  expect(execute(command)).toEqual(["'; kata claim abcd"]);
  expect(coreCommands(nodePlatform.path, command)).toEqual([]);
});
