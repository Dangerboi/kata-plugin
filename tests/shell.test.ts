import { expect, test } from "bun:test";
import { assertIsolated } from "./isolation";
import { kataCommands } from "../kata";
import { delegateCommand, kataCommands as coreCommands } from "../core/kata-core";
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
    .toBe("KATA_TRANSCRIPT_AGENT='omp' KATA_TRANSCRIPT_SESSION_ID='child-uuid' kata --teammate 'tm-1' close ab12 --done && kata --teammate 'tm-1' show ab12");
  expect(delegateCommand("kata close ab12 --done", "kata", [], "tm-1")).toBe("kata --teammate 'tm-1' close ab12 --done");
});
