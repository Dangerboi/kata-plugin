import { expect, test } from "bun:test";
import { closeEnv, createKata, NO_JOB, type Exec } from "../core/kata-cli";
import { nodePlatform } from "../core/node-host";

// Counts the `kata show` calls that reach Kata, and keeps the context each call was handed; every other call succeeds with an empty issue.
function client() {
  const shows: string[] = [], contexts: unknown[] = [];
  const exec: Exec = async (_file, args, options) => {
    if (args[0] === "version") return { code: 0, stdout: JSON.stringify({ kata_api_version: 1, version: "0.23.0" }) };
    contexts.push(options.ctx);
    if (args[0] === "show") shows.push(args[1]);
    return { code: 0, stdout: JSON.stringify({ issue: { short_id: args[1], revision: shows.length } }) };
  };
  const kata = createKata({ path: nodePlatform.path, exec, executable: "/fixture/kata", teammate: () => undefined, ctx: () => "latest", session: () => "session", debug() {} });
  return { kata, shows, contexts };
}

test("an operation reads an issue once until something in the process writes; outside one, every read reaches Kata", async () => {
  const { kata, shows } = client();
  const other = client().kata;
  await kata.operation(NO_JOB, async job => {
    await kata.show(job, "p#a", "/w");
    await kata.show(job, "p#a", "/w");
    expect(shows).toEqual(["p#a"]);
    await other.run(NO_JOB, ["meta", "set", "p#a", "k", "v"], "/w");
    expect((await kata.show(job, "p#a", "/w")).issue.revision).toBe(2);
    expect((await kata.show(kata.fresh(job), "p#a", "/w")).issue.revision).toBe(3);
  });
  await kata.show(NO_JOB, "p#a", "/w");
  await kata.show(NO_JOB, "p#a", "/w");
  expect(shows).toEqual(["p#a", "p#a", "p#a", "p#a", "p#a"]);
});

test("a job held after its operation ended reads Kata again", async () => {
  const { kata, shows } = client();
  // Like a retry timer armed during a tool call: the callback holds the operation's job.
  const gate = Promise.withResolvers<void>();
  let later!: Promise<unknown>;
  await kata.operation(NO_JOB, async job => {
    await kata.show(job, "p#a", "/w");
    later = gate.promise.then(() => kata.show(job, "p#a", "/w"));
  });
  gate.resolve();
  await later;
  expect(shows).toEqual(["p#a", "p#a"]);
});

test("a call outside an open operation never reuses its reads, and runs with the latest context", async () => {
  const { kata, shows, contexts } = client();
  const gate = Promise.withResolvers<void>();
  const open = kata.operation({ ctx: "call" }, async job => {
    await kata.show(job, "p#a", "/w");
    await gate.promise;
    await kata.show(job, "p#a", "/w");
  });
  // An event handler beside the operation: same issue, another identity.
  await kata.show(NO_JOB, "p#a", "/w");
  gate.resolve();
  await open;
  expect(shows).toEqual(["p#a", "p#a"]);
  expect(contexts).toEqual(["call", "latest"]);
});

test("a call carries the context of its job, kept by an operation started from it", async () => {
  const { kata, contexts } = client();
  await kata.operation({ ctx: "call" }, job => kata.run(job, ["list"], "/w"));
  await kata.run({ ctx: "other" }, ["list"], "/w");
  await kata.run(NO_JOB, ["list"], "/w");
  expect(contexts).toEqual(["call", "other", "latest"]);
});

const env = { get: () => undefined };
test("only a close carries the transcript environment; a close with no known session switches recording off", () => {
  expect(closeEnv(env, ["show", "ab12"], "omp", "child")).toBeUndefined();
  expect(closeEnv(env, ["close", "ab12"], "omp", "child")).toMatchObject({ KATA_TRANSCRIPT_AGENT: "omp", KATA_TRANSCRIPT_SESSION_ID: "child" });
  expect(closeEnv(env, ["close", "ab12"], "omp", undefined)).toEqual({ KATA_CLOSE_TRANSCRIPT_ENABLED: "false" });
  expect(closeEnv(env, ["comment", "ab12"], "omp", undefined)).toBeUndefined();
});
