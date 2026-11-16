import { expect, test } from "bun:test";
import { eventually, holdKata, until } from "./kata-fixture";
import { piFixture } from "./pi-fixture";

// Close transcripts and ownership of tasks across leads, reloads and forks.
const { home, events, show, host, evidence, message } = piFixture();

test("pi sets its transcript identity on start, a child replaces the inherited one, a shutdown leaves the next session's", async () => {
  const lead = await host(); await lead.event("session_start", { reason: "startup" });
  expect([process.env.KATA_TRANSCRIPT_AGENT, process.env.KATA_TRANSCRIPT_SESSION_ID]).toEqual(["pi", lead.sid]);
  const child = await host(); await child.event("session_start", { reason: "startup" });
  expect(process.env.KATA_TRANSCRIPT_SESSION_ID).toBe(child.sid);
  await lead.event("session_shutdown", { reason: "new" });
  expect([process.env.KATA_TRANSCRIPT_AGENT, process.env.KATA_TRANSCRIPT_SESSION_ID]).toEqual(["pi", child.sid]);
});

test("pi turns close transcripts on at session start and keeps a user's opt-out", async () => {
  await (await host()).event("session_start", { reason: "startup" });
  expect(process.env.KATA_CLOSE_TRANSCRIPT_ENABLED).toBe("true");
  process.env.KATA_CLOSE_TRANSCRIPT_ENABLED = "false";
  await (await host()).event("session_start", { reason: "startup" });
  expect(process.env.KATA_CLOSE_TRANSCRIPT_ENABLED).toBe("false");
});

test("a close driven through pi's real exec records the pi session when close transcripts are on", async () => {
  const { execCommand } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/exec.js");
  const previousHome = process.env.KATA_HOME; process.env.KATA_HOME = home;
  try {
    const app = await host({ exec: (file: string, args: string[], opts: any) => execCommand(file, args, opts.cwd, opts) });
    await app.event("session_start", { reason: "startup" });
    await app.init(["Real exec transcript task"]);
    const done = await app.call({ op: "done", task: "Real exec transcript task", message, evidence });
    expect(done.isError, done.content?.[0]?.text).toBeUndefined();
    const closes = (await events()).filter((e: any) => e.type === "issue.closed" && e.payload?.transcript?.session_id === app.sid);
    expect(closes.length).toBeGreaterThan(0);
    expect(closes[0].payload.transcript).toMatchObject({ agent: "pi", session_id: app.sid });
  } finally { if (previousHome === undefined) delete process.env.KATA_HOME; else process.env.KATA_HOME = previousHome; }
});

test("a slow shutdown of the old instance does not delete the next session's transcript identity", async () => {
  let slow = false, resumed = 0;
  const held = holdKata(() => slow, () => { resumed++; });
  const lead = await host({ before: held.before });
  await lead.event("session_start", { reason: "startup" }); await lead.init(["Slow shutdown task"]);
  slow = true;
  const shutdown = lead.event("session_shutdown", { reason: "new" });
  await held.entered;
  const next = await host(); await next.event("session_start", { reason: "new" });
  await shutdown;
  held.release(); slow = false;
  expect(await until(() => resumed > 0)).toBe(true);
  await lead.call({ op: "view" }); // drain the background hook
  expect([process.env.KATA_TRANSCRIPT_AGENT, process.env.KATA_TRANSCRIPT_SESSION_ID]).toEqual(["pi", next.sid]);
});

test("a second pi lead on the same parent is refused on the first lead's started task until it takes it over", async () => {
  const first = await host(); await first.event("session_start", { reason: "startup" });
  const parent = await first.init(["Shared pi task", "Later pi task"]);
  const task = (await show(parent)).children.find((c: any) => c.title === "Shared pi task");
  expect(task.metadata["todo.session"]).toBe(first.sid);
  process.env.KATA_REF = parent;
  const second = await host(); await second.event("session_start", { reason: "startup" });
  const refused = await second.call({ op: "done", task: "Shared pi task", message, evidence });
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toContain(`started by another session (${first.sid})`);
  expect((await show(task.qualified_id)).issue.status).toBe("open");
  expect((await second.call({ op: "done", task: "Shared pi task", message, evidence, takeover: true })).isError).toBeUndefined();
  const closed = await show(task.qualified_id);
  expect(closed.issue.status).toBe("closed");
  expect(closed.comments.map((c: any) => c.body)).toContain(`Taken over by session ${second.sid} from session ${first.sid}, which started it.`);
  await first.event("session_shutdown", { reason: "quit" }); await second.event("session_shutdown", { reason: "quit" });
});

test("a forked pi lead works on the tasks its source started; a third pi lead does not", async () => {
  const source = await host(); await source.event("session_start", { reason: "startup" });
  const parent = await source.init(["Forked pi task", "Other forked pi task"]);
  process.env.KATA_REF = parent;
  const fork = await host({ header: { parentSession: source.sid } }); await fork.event("session_start", { reason: "fork" });
  const stranger = await host(); await stranger.event("session_start", { reason: "startup" });
  expect((await stranger.call({ op: "done", task: "Forked pi task", message, evidence })).isError).toBe(true);
  expect((await fork.call({ op: "done", task: "Forked pi task", message, evidence })).isError).toBeUndefined();
  await source.event("session_shutdown", { reason: "quit" }); await fork.event("session_shutdown", { reason: "quit" }); await stranger.event("session_shutdown", { reason: "quit" });
});

test("a pi reload, or a fork into a saved session, keeps the tasks its session holds; quitting releases them", async () => {
  const app = await host(); await app.event("session_start", { reason: "startup" });
  const parent = await app.init(["Held across reload", "Later reload task"]);
  const task = (await show(parent)).children.find((c: any) => c.title === "Held across reload");
  // A fork into a saved session hands the tasks over later, so the source keeps them until then.
  for (const event of [{ reason: "reload" }, { reason: "fork", targetSessionFile: "/sessions/2026-11-13T00-00-00_fork.jsonl" }]) {
    await app.event("session_shutdown", event);
    expect((await show(task.qualified_id)).issue.metadata["todo.session"]).toBe(app.sid);
  }
  await app.event("session_shutdown", { reason: "quit" });
  expect((await show(task.qualified_id)).issue.metadata["todo.session"]).toBeUndefined();
});

test("a pi /fork inherits the tasks its source held; quitting the fork releases them", async () => {
  const source = await host(); await source.event("session_start", { reason: "startup" });
  const parent = await source.init(["Handed to the fork", "Later fork task"]);
  const task = (await show(parent)).children.find((c: any) => c.title === "Handed to the fork");
  await source.event("session_shutdown", { reason: "fork", targetSessionFile: "/sessions/2026-11-13T00-00-00_fork.jsonl" });
  process.env.KATA_REF = parent;
  const fork = await host({ header: { parentSession: source.sid } }); await fork.event("session_start", { reason: "fork" });
  await eventually(async () => (await show(task.qualified_id)).issue.metadata["todo.session"], fork.sid);
  await fork.event("session_shutdown", { reason: "quit" });
  expect((await show(task.qualified_id)).issue.metadata["todo.session"]).toBeUndefined();
});

test("a pi fork into an in-memory session releases the source's tasks, since no header names the source", async () => {
  const app = await host(); await app.event("session_start", { reason: "startup" });
  const parent = await app.init(["Released for an in-memory fork", "Later in-memory task"]);
  const task = (await show(parent)).children.find((c: any) => c.title === "Released for an in-memory fork");
  await app.event("session_shutdown", { reason: "fork" });
  expect((await show(task.qualified_id)).issue.metadata["todo.session"]).toBeUndefined();
});

test("a pi /fork whose history predates the plan releases the source's tasks", async () => {
  const source = await host(); await source.event("session_start", { reason: "startup" });
  const parent = await source.init(["Released for an early fork", "Later early-fork task"]);
  const task = (await show(parent)).children.find((c: any) => c.title === "Released for an early fork");
  await source.event("session_shutdown", { reason: "fork", targetSessionFile: "/sessions/2026-11-13T00-00-00_early.jsonl" });
  expect((await show(task.qualified_id)).issue.metadata["todo.session"]).toBe(source.sid);
  // No KATA_REF and a fresh branch: the fork forked before the plan existed, so it has no plan parent.
  const fork = await host({ header: { parentSession: source.sid } }); await fork.event("session_start", { reason: "fork" });
  await eventually(async () => (await show(task.qualified_id)).issue.metadata["todo.session"], undefined);
  await fork.event("session_shutdown", { reason: "quit" });
});

test("a pi fork that starts before its source's shutdown finished still inherits the source's tasks", async () => {
  const source = await host(); await source.event("session_start", { reason: "startup" });
  const parent = await source.init(["Inherited despite a slow shutdown", "Later slow task"]);
  const task = (await show(parent)).children.find((c: any) => c.title === "Inherited despite a slow shutdown");
  // The source's shutdown is still running (not awaited) when the fork starts.
  const shutdown = source.event("session_shutdown", { reason: "fork", targetSessionFile: "/sessions/2026-11-13T00-00-00_slow.jsonl" });
  process.env.KATA_REF = parent;
  const fork = await host({ header: { parentSession: source.sid } }); await fork.event("session_start", { reason: "fork" });
  await shutdown;
  await eventually(async () => (await show(task.qualified_id)).issue.metadata["todo.session"], fork.sid);
  await fork.event("session_shutdown", { reason: "quit" });
});

test("a pi fork that finds nothing left by its source still inherits the tasks the source holds in its plan", async () => {
  const source = await host(); await source.event("session_start", { reason: "startup" });
  const parent = await source.init(["Inherited without a hand-off", "Later fallback task"]);
  const task = (await show(parent)).children.find((c: any) => c.title === "Inherited without a hand-off");
  // The source's shutdown never ran, so no hand-off was left: the fork reads the tasks from the plan it binds.
  process.env.KATA_REF = parent;
  const fork = await host({ header: { parentSession: source.sid } }); await fork.event("session_start", { reason: "fork" });
  await eventually(async () => (await show(task.qualified_id)).issue.metadata["todo.session"], fork.sid);
  await fork.event("session_shutdown", { reason: "quit" });
});
