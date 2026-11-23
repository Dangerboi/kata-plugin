import { expect, test } from "bun:test";
import { piFixture } from "./pi-fixture";

// Plan behaviour the omp adapter no longer drives through its own todo tool: blockers in a session-local plan, and the close comment.
const { outside, show, host, down, evidence, message, commentsOf } = piFixture();

test("local plan and blockers survive extension recreation through session entries", async () => {
  const app = await host({ cwd: outside, before: down }); await app.event("session_start", { reason: "startup" });
  await app.init(["Durable local first", "Durable local second"]);
  await app.call({ op: "block", reason: "Waiting on a durable dependency" });
  const entries = JSON.parse(JSON.stringify(app.entries));
  const resumed = await host({ cwd: outside, before: down, sid: app.sid, entries }); await resumed.event("session_start", { reason: "resume" });
  const view = await resumed.call({ op: "view" });
  expect(view.content[0].text).toContain("Waiting on a durable dependency");
  expect(view.details.kata.phases[0].tasks.map((t: any) => t.status)).toEqual(["blocked", "in_progress"]);
  const other = await host({ cwd: outside, before: down, entries }); await other.event("session_start", { reason: "startup" });
  expect((await other.call({ op: "view" })).content[0].text).toContain("No todo plan");
});

test("a done plan task keeps its message and evidence as a comment, not only as the close reason", async () => {
  const app = await host(); await app.event("session_start", { reason: "startup" });
  const ref = await app.init(["Write widget tests"]);
  expect((await app.call({ op: "done", task: "Write widget tests", message, evidence })).isError).toBeUndefined();
  const child = (await show(ref)).children[0];
  expect(child.status).toBe("closed");
  expect(await commentsOf(child.short_id)).toEqual([`Done: ${message}\nEvidence: ${evidence.join(", ")}`]);
});
