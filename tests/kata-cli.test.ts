import { expect, test } from "bun:test";
import { closeEnv, createKata, type Exec } from "../core/kata-cli";

// Counts the `kata show` calls that reach Kata; every other call succeeds with an empty issue.
function client() {
  const shows: string[] = [];
  const exec: Exec = async (_file, args) => {
    if (args[0] === "version") return { code: 0, stdout: JSON.stringify({ kata_api_version: 1, version: "0.23.0" }) };
    if (args[0] === "show") shows.push(args[1]);
    return { code: 0, stdout: JSON.stringify({ issue: { short_id: args[1], revision: shows.length } }) };
  };
  const kata = createKata({ exec, executable: "/fixture/kata", teammate: () => undefined, ctx: () => undefined, session: () => "session", debug() {} });
  return { kata, shows };
}

test("an operation reads an issue once until something in the process writes; outside one, every read reaches Kata", async () => {
  const { kata, shows } = client();
  const other = client().kata;
  await kata.operation(async () => {
    await kata.show("p#a", "/w");
    await kata.show("p#a", "/w");
    expect(shows).toEqual(["p#a"]);
    await other.run(["meta", "set", "p#a", "k", "v"], "/w");
    expect((await kata.show("p#a", "/w")).issue.revision).toBe(2);
    expect((await kata.fresh(() => kata.show("p#a", "/w"))).issue.revision).toBe(3);
  });
  await kata.show("p#a", "/w");
  await kata.show("p#a", "/w");
  expect(shows).toEqual(["p#a", "p#a", "p#a", "p#a", "p#a"]);
});

test("a callback registered inside an operation that runs after it ended reads Kata again", async () => {
  const { kata, shows } = client();
  // Like a retry timer armed during a tool call: the callback keeps the operation's async context.
  const gate = Promise.withResolvers<void>();
  let later!: Promise<unknown>;
  await kata.operation(async () => {
    await kata.show("p#a", "/w");
    later = gate.promise.then(() => kata.operation(() => kata.show("p#a", "/w")));
  });
  gate.resolve();
  await later;
  expect(shows).toEqual(["p#a", "p#a"]);
});

test("only a close carries the transcript environment; a close with no known session switches recording off", () => {
  expect(closeEnv(["show", "ab12"], "omp", "child")).toBeUndefined();
  expect(closeEnv(["close", "ab12"], "omp", "child")).toMatchObject({ KATA_TRANSCRIPT_AGENT: "omp", KATA_TRANSCRIPT_SESSION_ID: "child" });
  expect(closeEnv(["close", "ab12"], "omp", undefined)).toEqual({ KATA_CLOSE_TRANSCRIPT_ENABLED: "false" });
  expect(closeEnv(["comment", "ab12"], "omp", undefined)).toBeUndefined();
});
