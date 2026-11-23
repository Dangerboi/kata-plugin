import { expect, test } from "bun:test";
import { MESSAGE, realKata, unique } from "./kata-fixture";
import { ompHost } from "./omp-host";

// Who may move a Kata task when omp's native todo list changes: a start the mirror cannot make because another actor, teammate or
// session holds the task leaves its attention and status alone, at every point a handoff can race it; a restart reopens only an owned
// task; session attention follows Kata's own hook. The tool-level start/block/unblock cases live in pi-ownership.test.ts.

const TEAMMATE = { KATA_TEAMMATE: "worker-a" };
const store = realKata({ prefix: "ownership", author: "actor-a", project: "omptest", adopt: true, env: TEAMMATE, process: TEAMMATE });
const { cwd, run, kata, show } = store;
const issue = (meta: string[] = [], parent?: string) => store.issue(`Ownership regression ${unique()}`, { meta, parent });
const issueOf = async (ref: string) => (await show(ref)).issue;
async function set(ref: string, key: string, value: string) { await kata(["meta", "set", ref, key, value, "--json"]); }
async function claim(ref: string, actor = "actor-a") { await kata(["claim", ref, "--as", actor, "--json"]); }

type Before = (args: string[]) => Promise<any>;
function host(parent: string | undefined, before?: Before) {
  const calls: string[][] = [];
  const app = ompHost({
    run: args => run(args), cwd, sid: `ownership-${parent ?? unique()}`, agent: { kind: "main", id: "ownership-main" },
    entries: parent ? [{ type: "custom", customType: "io.kata.omp.parent", data: { parent } }] : [], callId: "test",
    async before(args) {
      // Legacy race hooks target short refs; execution still uses the pinned refs.
      const comparable = args.map(a => a.startsWith("omptest#") ? a.slice(8) : a);
      calls.push(comparable);
      return before?.(comparable);
    },
  });
  // A native start with no task fails in omp and changes nothing, but its `tool_call` event still reaches the core, and awaiting it
  // waits for the session's bind.
  const flush = () => app.call({ op: "start" });
  return {
    calls, get notices() { return app.notices.map(args => args[0] as string); },
    async begin() { await app.event("session_start"); await flush(); },
    async shutdown() { await app.event("session_shutdown"); },
    call: app.call, edit: app.edit, init: app.init, done: app.done, mirrorFailures: app.mirrorFailures,
    input: (text: string) => app.event("input", { text, source: "interactive" }),
    // omp's list holds the plan task `ref` with this status, as a user's /todo edit or the model's call leaves it; the mirror follows.
    async native(ref: string, status: "pending" | "in_progress" | "completed" = "in_progress") {
      await app.edit([{ name: "Tasks", tasks: [{ content: (await issueOf(ref)).title, status }] }]);
    },
  };
}
// The mirror could not make a change in Kata: omp keeps its list and the user is told once.
const refused = (app: { mirrorFailures: () => unknown[] }) => app.mirrorFailures().length > 0;
const workWrites = (app: { calls: string[][] }) => app.calls.filter(args => args[0] === "meta" && args[3]?.startsWith("work."));

// Removing the ownership gate or swallowing claim failures must fail these.
for (const foreign of ["actor", "teammate"]) {
  test(`a native start leaves ${foreign}-owned attention unchanged`, async () => {
    const parent = await issue();
    const ref = await issue(["todo.phase=Tasks", "todo.status=pending", "work.attention=needs-human", "work.attention_msg=foreign worker note"], parent);
    await claim(ref, foreign === "actor" ? "actor-b" : "actor-a");
    if (foreign === "teammate") await set(ref, "teammate", "worker-b");
    const app = host(parent);
    await app.begin();
    await app.native(ref);
    expect(refused(app)).toBe(true);
    expect((await issueOf(ref)).metadata["work.attention"]).toBe("needs-human");
    expect((await issueOf(ref)).metadata["work.attention_msg"]).toBe("foreign worker note");
    expect((await issueOf(ref)).metadata["todo.status"]).toBe("pending");
    expect(workWrites(app)).toEqual([]);
  });
}
test("a failed claim on an unowned task is reported before attention writes", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const app = host(parent, async args => args[0] === "claim" ? { code: 1, stderr: "claim transport failed", stdout: "" } : undefined);
  await app.begin();
  await app.native(ref);
  expect(refused(app)).toBe(true);
  expect((await issueOf(ref)).metadata["work.attention"]).toBeUndefined();
  expect((await issueOf(ref)).metadata["todo.status"]).toBe("pending");
});
test("a failed parent claim is reported before creating or starting children", async () => {
  let parentRef: string | undefined;
  const app = host(undefined, async args => {
    if (!parentRef && args[0] === "claim") {
      parentRef = args[1];
      return { code: 1, stderr: "parent claim transport failed", stdout: "" };
    }
  });
  await app.begin();
  await app.edit([{ name: "Tasks", tasks: [{ content: "A child that must never start", status: "in_progress" }] }]);
  expect(parentRef).toBeDefined();
  expect(refused(app)).toBe(true);
  expect((await show(parentRef!)).children ?? []).toEqual([]);
  expect(workWrites(app)).toEqual([]);
});
test("the native auto-start of a foreign pending task refuses it and leaves its attention alone", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending", "work.attention=needs-human"], parent);
  await claim(ref, "actor-b");
  const app = host(parent);
  await app.begin();
  // omp starts the first pending task of an init by itself; that is the foreign one.
  await app.call({ op: "init", items: [(await issueOf(ref)).title, "A separate pending plan task"] });
  expect(refused(app)).toBe(true);
  expect((await issueOf(ref)).metadata["work.attention"]).toBe("needs-human");
});
test("a native start of an owned task claims it and sets attention ok", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const app = host(parent);
  await app.begin();
  await app.native(ref);
  expect(refused(app)).toBe(false);
  const started = await issueOf(ref);
  expect(started.owner).toBe("actor-a");
  expect(started.metadata["todo.status"]).toBe("in_progress");
  expect(started.metadata["work.attention"]).toBe("ok");
});
test("a native restart reopens an owned task after start and done", async () => {
  const app = host(undefined);
  await app.begin();
  const parent = await app.init(["Restarted ownership task", "Other ownership task"]);
  const ref = (await show(parent)).children.find((c: any) => c.title === "Restarted ownership task").short_id;
  expect((await app.done("Restarted ownership task")).isError).toBeUndefined();
  expect((await issueOf(ref)).status).toBe("closed");
  expect((await app.call({ op: "start", task: "Restarted ownership task" })).isError).toBeUndefined();
  const final = await issueOf(ref);
  expect(final.status).toBe("open");
  expect(final.owner).toBe("actor-a");
  expect(final.metadata.teammate).toBe("worker-a");
  expect(final.metadata["todo.status"]).toBe("in_progress");
  expect(final.metadata["work.attention"]).toBe("ok");
});
for (const foreign of ["actor", "teammate"]) {
  test(`a native restart refuses a closed ${foreign}-owned task`, async () => {
    const parent = await issue();
    const ref = await issue(["todo.phase=Tasks", "todo.status=pending", "work.attention=stuck"], parent);
    await claim(ref, foreign === "actor" ? "actor-b" : "actor-a");
    if (foreign === "teammate") await set(ref, "teammate", "worker-b");
    await kata(["close", ref, "--wontfix", "--message", "Retired this isolated foreign restart fixture after checking that its worker must retain control.", "--json"]);
    const app = host(parent);
    await app.begin();
    await app.native(ref);
    expect(refused(app)).toBe(true);
    expect((await issueOf(ref)).status).toBe("closed");
    expect((await issueOf(ref)).metadata["work.attention"]).toBe("stuck");
  });
}
for (const race of ["teammate", "metadata"]) {
  test(`a native restart rejects a ${race} change during reopen`, async () => {
    const parent = await issue();
    const ref = await issue(["todo.phase=Tasks", "todo.status=pending", "work.attention=stuck"], parent);
    await claim(ref);
    await kata(["close", ref, "--wontfix", "--message", "Retired this isolated restart fixture to test a concurrent handoff at the reopen boundary.", "--json"]);
    let raced = false;
    const app = host(parent, async args => {
      if (!raced && args[0] === "reopen" && args[1] === ref) {
        raced = true;
        await set(ref, race === "teammate" ? "teammate" : "work.attention_msg", race === "teammate" ? "worker-b" : "new blocker during restart");
      }
    });
    await app.begin();
    await app.native(ref);
    expect(refused(app)).toBe(true);
    expect(raced).toBe(true);
    expect((await issueOf(ref)).metadata["work.attention"]).toBe("stuck");
    expect((await issueOf(ref)).metadata["todo.status"]).toBe("pending");
  });
}
for (const foreign of ["actor", "teammate", "closed"]) {
  test(`session attention skips a ${foreign} parent`, async () => {
    const parent = await issue(["work.attention=needs-human"]);
    await claim(parent, foreign === "actor" ? "actor-b" : "actor-a");
    if (foreign === "teammate") await set(parent, "teammate", "worker-b");
    if (foreign === "closed") await kata(["close", parent, "--wontfix", "--message", "This isolated session attention task is retired because its regression fixture has completed.", "--json"]);
    process.env.KATA_REF = parent;
    const app = host(parent);
    await app.begin();
    expect(app.calls.filter(args => args[0] === "agent-hook" || (args[0] === "meta" && args[3]?.startsWith("work.")))).toEqual([]);
    expect((await issueOf(parent)).metadata["work.attention"]).toBe("needs-human");
    expect(app.notices).toEqual([]);
  });
}
for (const race of ["owner", "teammate", "close", "owner-ABA"]) {
  test(`${race} handoff between ownership read and write prevents attention mutation on a native start`, async () => {
    const parent = await issue();
    const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
    await claim(ref);
    let raced = false;
    const app = host(parent, async args => {
      if (!raced && args[0] === "meta" && args[3] === "work.attention") {
        raced = true;
        if (race === "teammate") await set(ref, "teammate", "worker-b");
        else if (race === "close") await kata(["close", ref, "--wontfix", "--message", "Retired this isolated fixture during the ownership race to verify closed metadata stays untouched.", "--json"]);
        else {
          await kata(["claim", ref, "--as", "actor-b", "--force", "--json"]);
          if (race === "owner-ABA") await kata(["claim", ref, "--as", "actor-a", "--force", "--json"]);
        }
      }
    });
    await app.begin();
    await app.native(ref);
    expect(refused(app)).toBe(true);
    expect((await issueOf(ref)).metadata["work.attention"]).toBeUndefined();
    expect((await issueOf(ref)).metadata["todo.status"]).toBe("pending");
  });
}
test("owned session attention is delegated to Kata's native hook", async () => {
  const parent = await issue();
  await claim(parent);
  process.env.KATA_REF = parent;
  const app = host(parent);
  await app.begin();
  const started = await issueOf(parent);
  expect(started.metadata["work.attention"]).toBe("ok");
  expect(started.metadata["work.attention_session"]).toBeTruthy();
  await app.shutdown();
  const ended = await issueOf(parent);
  expect(ended.metadata["work.attention"]).toBe("needs-human");
  expect(ended.metadata["work.attention_session"]).not.toBe(started.metadata["work.attention_session"]);
  expect(workWrites(app)).toEqual([]);
});
test("session end leaves a blocker set during the session", async () => {
  const parent = await issue();
  await claim(parent);
  process.env.KATA_REF = parent;
  const app = host(parent);
  await app.begin();
  await set(parent, "work.attention", "stuck");
  await set(parent, "work.attention_msg", "waiting on an upstream fix");
  await app.shutdown();
  const final = await issueOf(parent);
  expect(final.metadata["work.attention"]).toBe("stuck");
  expect(final.metadata["work.attention_msg"]).toBe("waiting on an upstream fix");
});
test("session shutdown respects a teammate handoff", async () => {
  const parent = await issue();
  await claim(parent);
  process.env.KATA_REF = parent;
  const app = host(parent);
  await app.begin();
  await set(parent, "teammate", "worker-b");
  await set(parent, "work.attention", "stuck");
  await set(parent, "work.attention_msg", "another worker is investigating");
  const callsBefore = app.calls.length;
  await app.shutdown();
  expect(app.calls.slice(callsBefore).filter(args => args[0] === "meta")).toEqual([]);
  expect((await issueOf(parent)).metadata["work.attention_msg"]).toBe("another worker is investigating");
});
test("a native start preserves a changed decision before the conditional attention write", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  await claim(ref);
  let raced = false;
  const app = host(parent, async args => {
    if (!raced && args[0] === "meta" && args[2] === ref) {
      raced = true;
      await set(ref, "work.attention", "stuck");
      await set(ref, "work.attention_msg", "new task blocker before conditional write");
    }
  });
  await app.begin();
  await app.native(ref);
  expect(refused(app)).toBe(true);
  expect(raced).toBe(true);
  const final = await issueOf(ref);
  expect(final.metadata["work.attention"]).toBe("stuck");
  expect(final.metadata["work.attention_msg"]).toBe("new task blocker before conditional write");
  expect(final.metadata["todo.status"]).toBe("pending");
});
test("a native init's auto-start cannot claim another teammate's task", async () => {
  const parent = await issue();
  const app = host(parent);
  await app.begin();
  const title = "A stable initialized task", other = "A second initialized task";
  expect((await app.call({ op: "init", items: [title, other] })).isError).toBeUndefined();
  const ref = (await show(parent)).children.find((c: { title: string }) => c.title === title).short_id;
  await set(ref, "todo.status", "pending");
  await set(ref, "teammate", "worker-b");
  await set(ref, "work.attention", "needs-human");
  // Starting the other task moves the first back to pending in omp's list; starting the first again is then a real change the mirror applies.
  expect((await app.call({ op: "start", task: other })).isError).toBeUndefined();
  expect(refused(app)).toBe(false);
  expect((await app.call({ op: "start", task: title })).isError).toBeUndefined();
  expect(app.mirrorFailures().length).toBe(1);
  const after = await issueOf(ref);
  expect(after.metadata["work.attention"]).toBe("needs-human");
  expect(after.metadata["todo.status"]).toBe("pending");
});
test("a successful native done does not overwrite the next foreign task", async () => {
  const parent = await issue();
  const first = await issue(["todo.phase=Tasks", "todo.status=in_progress"], parent);
  await claim(first);
  const next = await issue(["todo.phase=Tasks", "todo.status=pending", "work.attention=needs-human"], parent);
  await claim(next, "actor-b");
  const app = host(parent);
  await app.begin();
  const [firstTitle, nextTitle] = [(await issueOf(first)).title, (await issueOf(next)).title];
  await app.edit([{ name: "Tasks", tasks: [{ content: firstTitle, status: "in_progress" }, { content: nextTitle, status: "pending" }] }]);
  await kata(["close", first, "--done", "--message", MESSAGE, "--evidence", "test:ownership harness", "--json"]);
  // omp starts the next pending task when the first is done; that one is another actor's.
  const result = await app.call({ op: "done", task: firstTitle });
  expect(result.isError).toBeUndefined();
  expect(refused(app)).toBe(true);
  expect((await issueOf(first)).status).toBe("closed");
  expect((await issueOf(next)).metadata["work.attention"]).toBe("needs-human");
});
