import { expect, test } from "bun:test";
import { piFixture } from "./pi-fixture";

// Closes driven through pi's own todo tool: a ticket-only plan, an explicit parent whose close Kata rejects, and wontfix floors.
// omp no longer has a todo tool of its own, so these ran against it before and now run here.
const { issue, show, host, unique, evidence, message } = piFixture();

test("a plan of only ticket items reports an id-shaped task that names no issue as a Kata error, as a plan with a parent does", async () => {
  const app = await host(); await app.event("session_start", { reason: "startup" });
  const a = await issue(`Ticket A ${unique()}`);
  await app.call({ op: "init", items: [`pitest#${a}: only step`] });
  const result = await app.call({ op: "done", task: "0123456789abcdefghjkmnpqrs", message, evidence });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("issue not found");
});

test("an explicit parent is never auto-closed and a close Kata rejects leaves the task active", async () => {
  const ref = await issue(`Explicit parent ${unique()}`); process.env.KATA_REF = ref;
  let deny = true;
  const app = await host({ before: (a: string[]) => a[0] === "close" && deny ? { code: 1, stderr: "evidence denied", stdout: "" } : undefined });
  await app.event("session_start", { reason: "startup" }); await app.init(["A guarded task"]);
  expect((await app.call({ op: "done", message, evidence })).isError).toBe(true);
  expect((await show(ref)).children[0].metadata["todo.status"]).toBe("in_progress");
  deny = false; expect((await app.call({ op: "done", message, evidence })).isError).toBeUndefined();
  expect((await show(ref)).issue.status).toBe("open");
});

test("wontfix floors and the /todo done command pass real Kata guards", async () => {
  const app = await host(); await app.event("session_start", { reason: "startup" });
  const ref = await app.init(["x", "y", "z"]);
  expect((await app.call({ op: "drop", task: "x", message: "no" })).isError).toBeUndefined();
  await app.command("done");
  await app.command("done");
  expect((await show(ref)).children.every((c: any) => c.status === "closed")).toBe(true);
});
