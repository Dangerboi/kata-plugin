import { expect, test } from "bun:test";
import { piFixture } from "./pi-fixture";

// The todo tool's block, unblock and restart ops and the /todo start command, which pi, OpenCode and Claude Code still have and omp no
// longer does (omp's own todo has no blocked status): they refuse a task another actor or teammate owns, and they leave attention
// alone at every point a handoff can race them. Moved from the omp ownership tests.

const ACTOR = "pi-builder";
const { kata, show, host: piHost, issue: makeIssue, unique, evidence, message } = piFixture();
const issue = (meta: string[] = [], parent?: string) => makeIssue(`Pi ownership regression ${unique()}`, { meta, parent });
const issueOf = async (ref: string) => (await show(ref)).issue;
async function set(ref: string, key: string, value: string) { await kata(["meta", "set", ref, key, value, "--json"]); }
async function claim(ref: string, actor = ACTOR) { await kata(["claim", ref, "--as", actor, "--json"]); }

type Before = (args: string[]) => Promise<any>;
async function host(parent: string, before?: Before) {
  const calls: string[][] = [];
  const app = await piHost({
    async before(args: string[]) {
      // Race hooks target short refs; execution still uses the pinned refs.
      const comparable = args.map(a => a.startsWith("pitest#") ? a.slice(7) : a);
      calls.push(comparable);
      return before?.(comparable);
    },
  });
  return {
    calls, call: app.call, command: app.command,
    get texts() { return [...app.messages.map(args => String(args[0]?.content)), ...app.notices.map(args => String(args[0]))]; },
    async begin() {
      await claim(parent);
      process.env.KATA_REF = parent;
      await app.event("session_start", { reason: "startup" });
      await app.call({ op: "view" });
    },
  };
}

// Removing the ownership gate or swallowing claim failures must fail these.
for (const op of ["block", "unblock"]) {
  for (const foreign of ["actor", "teammate"]) {
    test(`${op} leaves ${foreign}-owned attention unchanged`, async () => {
      const parent = await issue();
      const ref = await issue(["todo.phase=Tasks", `todo.status=${op === "unblock" ? "blocked" : "pending"}`, "work.attention=needs-human", "work.attention_msg=foreign worker note"], parent);
      await claim(ref, foreign === "actor" ? "actor-b" : ACTOR);
      if (foreign === "teammate") await set(ref, "teammate", "worker-b");
      const app = await host(parent);
      await app.begin();
      const result = await app.call({ op, task: ref, reason: "waiting on a service" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/own|teammate/i);
      expect((await issueOf(ref)).metadata["work.attention"]).toBe("needs-human");
      expect((await issueOf(ref)).metadata["work.attention_msg"]).toBe("foreign worker note");
      expect(app.calls.filter(args => args[0] === "meta" && args[3]?.startsWith("work."))).toEqual([]);
    });
  }
}
test("owned tasks can start, block, and unblock using guarded attention writes", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const app = await host(parent);
  await app.begin();
  expect((await app.call({ op: "start", task: ref })).isError).toBeUndefined();
  expect((await issueOf(ref)).owner).toBe(ACTOR);
  expect((await app.call({ op: "block", task: ref, reason: "waiting for review" })).isError).toBeUndefined();
  expect((await issueOf(ref)).metadata["work.attention"]).toBe("stuck");
  expect((await app.call({ op: "unblock", task: ref })).isError).toBeUndefined();
  const final = await issueOf(ref);
  expect(final.metadata["work.attention"]).toBe("ok");
  expect(final.metadata["work.attention_msg"]).toBeUndefined();
});
test("closed task block skips all work metadata writes", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  await claim(ref);
  await kata(["close", ref, "--done", "--message", message, "--evidence", "test:ownership harness", "--json"]);
  const app = await host(parent);
  await app.begin();
  const result = await app.call({ op: "block", task: ref, reason: "too late" });
  expect(result.isError).toBe(true);
  expect((await issueOf(ref)).status).toBe("closed");
  expect((await issueOf(ref)).metadata["work.attention"]).toBeUndefined();
});
test("explicit restart reopens an owned task after start and done", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const app = await host(parent);
  await app.begin();
  expect((await app.call({ op: "start", task: ref })).isError).toBeUndefined();
  expect((await app.call({ op: "done", task: ref, message, evidence })).isError).toBeUndefined();
  expect((await issueOf(ref)).status).toBe("closed");
  expect((await app.call({ op: "start", task: ref })).isError).toBeUndefined();
  const final = await issueOf(ref);
  expect(final.status).toBe("open");
  expect(final.owner).toBe(ACTOR);
  expect(final.metadata["todo.status"]).toBe("in_progress");
  expect(final.metadata["work.attention"]).toBe("ok");
});
for (const op of ["block", "unblock"]) {
  test(`${op} preserves a changed decision before the conditional attention write`, async () => {
    const parent = await issue();
    const status = op === "unblock" ? "blocked" : "pending";
    const ref = await issue(["todo.phase=Tasks", `todo.status=${status}`], parent);
    await claim(ref);
    let raced = false;
    const app = await host(parent, async args => {
      if (!raced && args[0] === "meta" && args[2] === ref) {
        raced = true;
        await set(ref, "work.attention", "stuck");
        await set(ref, "work.attention_msg", "new task blocker before conditional write");
      }
    });
    await app.begin();
    expect((await app.call({ op, task: ref, reason: "replace the blocker" })).isError).toBe(true);
    expect(raced).toBe(true);
    const final = await issueOf(ref);
    expect(final.metadata["work.attention"]).toBe("stuck");
    expect(final.metadata["work.attention_msg"]).toBe("new task blocker before conditional write");
    expect(final.metadata["todo.status"]).toBe(status);
  });
}
test("an attention message race cannot be cleared during unblock", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=blocked", "work.attention=stuck", "work.attention_msg=old blocker"], parent);
  await claim(ref);
  let raced = false;
  const app = await host(parent, async args => {
    if (!raced && args[0] === "meta" && args[1] === "unset" && args[3] === "work.attention_msg") {
      raced = true;
      await set(ref, "work.attention_msg", "new blocker from another writer");
    }
  });
  await app.begin();
  const result = await app.call({ op: "unblock", task: ref });
  expect(result.isError).toBe(true);
  expect((await issueOf(ref)).metadata["work.attention_msg"]).toBe("new blocker from another writer");
});
test("slash command start reports ownership failure without attention writes", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending", "work.attention=stuck"], parent);
  await claim(ref, "actor-b");
  const app = await host(parent);
  await app.begin();
  await app.command(`start ${ref}`);
  expect(app.texts.some(text => /not owned/.test(text))).toBe(true);
  expect((await issueOf(ref)).metadata["work.attention"]).toBe("stuck");
});
