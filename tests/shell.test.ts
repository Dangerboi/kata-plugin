import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "bun";
import { assertIsolated } from "./isolation";
import { kataCommands } from "../plugins/oh-my-pi/kata";
import { delegateCommand, delegateRouted, kataCommands as coreCommands, transcriptCommand } from "../core/shell";
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
    const env: Record<string, string | undefined> = { ...process.env, PATH: `${dir}:${process.env.PATH}`, KATA_BIN: join(dir, "kata"), KATA_STUB_DIR: dir, ...extra };
    for (const name of ["KATA_TRANSCRIPT_AGENT", "KATA_TRANSCRIPT_SESSION_ID", "KATA_CLOSE_TRANSCRIPT_ENABLED"]) if (!(name in extra)) delete env[name];
    const out = spawnSync(["bash", "-c", command], { env });
    expect(out.exitCode).toBe(0);
    return out.stdout.toString().trim().split("\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const own = { env: { get: () => undefined }, agent: "omp", id: "child-uuid" };

test("command positions behind shell prefixes and their options", () => {
  const prefixes = ["", "X=1 ", "time nohup ", "( ", "{ ", "while ", "until ", "time -p ", "env -u FOO ", "env -iu FOO ", "env -iC /tmp ", "env -iCu/tmp ", "env -i PATH=/usr/bin ", "env - PATH=/usr/bin ", "env -a name ", "env -aname ", "env --argv0 name ", "env --argv0=name ", "env --unset=FOO -C /tmp -- ", "exec -a name ", "command -p ", "timeout -s TERM -k 1 30 "];
  for (const prefix of prefixes) {
    const input = `${prefix}kata claim abcd`;
    expect(coreCommands(nodePlatform.path, input).map(c => c.words.map(w => w.value)), input).toEqual([["claim", "abcd"]]);
    expect(delegateCommand(nodePlatform.path, input, "kata", [], "dev-1", { workspace: "/w", parent: "proj#abcd" }), input).toContain("kata --teammate 'dev-1' --workspace '/w' --project 'proj' claim abcd");
  }
  for (const input of ["command -v kata", "command -V kata", "command -pv kata", "command -pV kata", "env -S echo kata claim abcd", "env -Secho kata claim abcd", "env -iSecho kata claim abcd", "env --split-string=echo kata claim abcd", "timeout --help 30 kata --as boss", "timeout --version 30 kata --as boss", "env --help kata --as boss", "nohup --version kata --as boss", "env -P /some/bin kata claim abcd", "env -Pkata kata claim abcd", "env -iP/some/bin kata claim abcd", "exec -c kata close ab12", "exec -cl kata close ab12", "builtin kata claim abcd"]) {
    expect(coreCommands(nodePlatform.path, input), input).toEqual([]);
    expect(delegateCommand(nodePlatform.path, input, "kata", [], "dev-1"), input).toBe(input);
  }
  expect(() => delegateCommand(nodePlatform.path, "nohup kata --as boss comment abcd -m hi", "kata", [], "dev-1")).toThrow("--as is not permitted");
});

test("rewritten closes execute through each prefix", () => {
  for (const prefix of ["env -u FOO", 'env -iu FOO PATH="$PATH"', 'env -iC /tmp PATH="$PATH"', 'env -i PATH="$PATH"', "env -C /tmp --", "command -p", "exec -a name", "time -p", "nohup", ...(Bun.which("timeout") ? ["timeout -s TERM -k 1 30"] : []), "time nohup"]) {
    const input = `${prefix} kata close ab12`;
    expect(execute(delegateCommand(nodePlatform.path, input, "kata", [], "tm-1", undefined, own)), input).toEqual(["omp/child-uuid/true --teammate tm-1 close ab12"]);
  }
  const lead = transcriptCommand(nodePlatform.path, "nohup kata close ab12", "kata", [], own);
  expect(execute(lead)).toEqual(["omp/child-uuid/true close ab12"]);
});

test("a cleared PATH containing only Kata still runs the rewritten close", () => {
  const input = 'env -i PATH="$KATA_STUB_DIR" kata close ab12';
  const rewritten = delegateCommand(nodePlatform.path, input, "kata", [], "tm-1", undefined, own);
  expect(execute(rewritten)).toEqual(["omp/child-uuid/true --teammate tm-1 close ab12"]);
  expect(delegateRouted(nodePlatform.path, rewritten, "kata", [], "tm-1", undefined, own)).toBe(true);
  const lead = transcriptCommand(nodePlatform.path, input, "kata", [], own);
  expect(execute(lead)).toEqual(["omp/child-uuid/true close ab12"]);
  expect(transcriptCommand(nodePlatform.path, lead, "kata", [], own)).toBe(lead);
});

test("transcript assignments account for env clearing and unsetting in order", () => {
  const assignments = "KATA_TRANSCRIPT_AGENT=omp KATA_TRANSCRIPT_SESSION_ID=child-uuid KATA_CLOSE_TRANSCRIPT_ENABLED=true";
  for (const prefix of [`${assignments} env -i PATH="$PATH"`, `${assignments} env - PATH="$PATH"`, `${assignments} env -u KATA_TRANSCRIPT_AGENT`, `${assignments} env -u KATA_TRANSCRIPT_SESSION_ID`, `${assignments} env -i PATH="$PATH" env KATA_TRANSCRIPT_AGENT=omp`]) {
    const input = `${prefix} kata close ab12`;
    expect(execute(transcriptCommand(nodePlatform.path, input, "kata", [], own)), input).toEqual(["omp/child-uuid/true close ab12"]);
    expect(execute(delegateCommand(nodePlatform.path, input, "kata", [], "tm-1", undefined, own)), input).toEqual(["omp/child-uuid/true --teammate tm-1 close ab12"]);
  }
  const restored = `${assignments} env -i PATH="$PATH" ${assignments} kata close ab12`;
  expect(transcriptCommand(nodePlatform.path, restored, "kata", [], own)).toBe(restored);
  expect(transcriptCommand(nodePlatform.path, `${assignments} env --unset=KATA_TRANSCRIPT_AGENT kata close ab12`, "kata", [], own)).toContain("/usr/bin/env KATA_TRANSCRIPT_AGENT=");
  const cleared = "exec -c kata close ab12";
  for (const command of [transcriptCommand(nodePlatform.path, cleared, "kata", [], own), delegateCommand(nodePlatform.path, cleared, "kata", [], "tm-1", undefined, own)]) {
    expect(command).toBe(cleared);
    expect(execute(command)).toEqual(["// close ab12"]);
  }
});

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
