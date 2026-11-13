import { assertIsolated } from "./isolation";
import { adoptIsolatedKata, isolatedKata } from "./kata-fixture";
import { ompHost } from "./omp-host";
assertIsolated();
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import path from "node:path";

// Two lead sessions of one user, no KATA_TEAMMATE: same actor, same empty teammate. Only the session marker tells them apart.
const binary = process.env.KATA_TEST_EXECUTABLE;
if (!binary || !path.isAbsolute(binary)) throw new Error("Set KATA_TEST_EXECUTABLE to an absolute kata-main binary path.");
const scratch = mkdtempSync(path.join(process.env.KATA_TEST_ROOT!, "omp-kata-session-owner-"));
const cwd = path.join(scratch, "workspace");
mkdirSync(cwd);
const env: Record<string, string | undefined> = { ...process.env, KATA_HOME: path.join(scratch, "khome"), KATA_AUTHOR: "actor-a" };
for (const key of ["KATA_SERVER", "KATA_DAEMON", "KATA_AUTH_TOKEN", "KATA_REF", "KATA_SESSION_ID", "KATA_INBOX_USER", "KATA_TEAMMATE"]) delete env[key];
process.env.KATA_AUTHOR = "actor-a";
for (const key of ["KATA_TEAMMATE", "KATA_REF", "KATA_INBOX_USER"]) delete process.env[key];

const run = isolatedKata(binary, env, cwd, 15000);
async function kata(args: string[]) {
  const out = await run(args);
  if (out.code !== 0) throw new Error(`${args.join(" ")}: ${out.stderr}`);
  return JSON.parse(out.stdout);
}
let sequence = 0;
async function issue(meta: string[] = [], parent?: string) {
  const args = ["create", `Session owner ${++sequence}`, "--force-new", "--json"];
  if (parent) args.push("--parent", parent);
  for (const value of meta) args.push("--meta", value);
  return (await kata(args)).issue.short_id as string;
}
const shown = async (ref: string) => kata(["show", ref, "--json"]);
const meta = async (ref: string) => (await shown(ref)).issue.metadata ?? {};

// A lead session on `parent`; `header` makes it a fork of another session.
function lead(sid: string, parent: string, header?: unknown) {
  const app = ompHost({ run: args => run(args), cwd, sid, agent: { kind: "main", id: `main-${sid}` }, header,
    entries: [{ type: "custom", customType: "io.kata.omp.parent", data: { parent } }] });
  return {
    entries: app.entries,
    async begin() { await app.event("session_start"); await app.call({ op: "view" }); },
    call: (params: any) => app.call(params),
    command: async (text: string) => { await app.event("input", { text, source: "interactive" }); return app.notices.at(-1)?.[0] as string; },
    shutdown: () => app.event("session_shutdown"),
    // The same process switches to another session (omp /new or /resume).
    switchTo: (next: string) => app.event("session_switch", {}, { ...app.ctx, sessionManager: { ...app.ctx.sessionManager, getSessionId: () => next } }),
  };
}
const proof = { message: "Finished the step and checked the result with the session test.", evidence: ["test:session-owner"] };

beforeAll(async () => {
  const result = await run(["init", "--project", "omptest"]);
  if (result.code !== 0) throw new Error(result.stderr);
}, 20000);
afterAll(async () => { await run(["daemon", "stop"]); });
let restore: (() => void) | undefined;
beforeEach(() => { restore = adoptIsolatedKata(binary!, env.KATA_HOME!); });
afterEach(() => restore?.());

test("a task one lead started is refused to another lead of the same actor and teammate", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const a = lead("session-a", parent), b = lead("session-b", parent);
  await a.begin();
  expect((await a.call({ op: "start", task: ref })).isError).toBeUndefined();
  expect((await meta(ref))["todo.session"]).toBe("session-a");
  await b.begin();
  for (const params of [{ op: "start", task: ref }, { op: "done", task: ref, ...proof }, { op: "drop", task: ref, message: "not needed" }, { op: "block", task: ref, reason: "waiting" }]) {
    const result = await b.call(params);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("started by another session (session-a)");
  }
  const after = await shown(ref);
  expect(after.issue.status).toBe("open");
  expect(after.issue.metadata["todo.status"]).toBe("in_progress");
  expect(after.issue.metadata["todo.session"]).toBe("session-a");
  // The first session keeps working its task.
  expect((await a.call({ op: "done", task: ref, ...proof })).isError).toBeUndefined();
  expect((await shown(ref)).issue.status).toBe("closed");
}, 30000);

test("takeover moves the task to the new session and records both sessions on the issue", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const a = lead("session-a", parent), b = lead("session-b", parent);
  await a.begin();
  await a.call({ op: "start", task: ref });
  await b.begin();
  expect((await b.call({ op: "start", task: ref, takeover: true })).isError).toBeUndefined();
  const after = await shown(ref);
  expect(after.issue.metadata["todo.session"]).toBe("session-b");
  expect(after.issue.metadata["todo.status"]).toBe("in_progress");
  expect((after.comments ?? []).map((c: { body: string }) => c.body)).toContain("Taken over by session session-b from session session-a, which started it.");
  // Now the first session is the other one.
  const refused = await a.call({ op: "done", task: ref, ...proof });
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toContain("started by another session (session-b)");
}, 30000);

test("a user's /todo command takes the task over", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const a = lead("session-a", parent), b = lead("session-b", parent);
  await a.begin();
  await a.call({ op: "start", task: ref });
  await b.begin();
  await b.command(`/todo done ${ref}`);
  const after = await shown(ref);
  expect(after.issue.status).toBe("closed");
  expect((after.comments ?? []).some((c: { body: string }) => c.body.startsWith("Taken over by session session-b"))).toBe(true);
}, 30000);

test("init replace cannot drop a task another session started", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const a = lead("session-a", parent), b = lead("session-b", parent);
  await a.begin();
  await a.call({ op: "start", task: ref });
  await b.begin();
  const result = await b.call({ op: "init", ref: parent, replace: true, items: ["A different plan"] });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("leaves out tasks another session started");
  const after = await shown(parent);
  expect(after.children.map((c: { title: string }) => c.title)).not.toContain("A different plan");
  expect((await shown(ref)).issue.status).toBe("open");
}, 30000);

test("a fork works on what its source started; its source does not get the fork's", async () => {
  const parent = await issue();
  const first = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const second = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const a = lead("session-a", parent);
  await a.begin();
  await a.call({ op: "start", task: first });
  const fork = lead("session-f", parent, { parentSession: "/sessions/2026-11-13T00-00-00_session-a.jsonl" });
  await fork.begin();
  expect((await fork.call({ op: "done", task: first, ...proof })).isError).toBeUndefined();
  expect((await fork.call({ op: "start", task: second })).isError).toBeUndefined();
  expect((await meta(second))["todo.session"]).toBe("session-f");
  const refused = await a.call({ op: "done", task: second, ...proof });
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toContain("started by another session (session-f)");
}, 30000);

test("a resumed session keeps its fork lineage from the snapshot", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const a = lead("session-a", parent);
  await a.begin();
  await a.call({ op: "start", task: ref });
  const fork = lead("session-f", parent, { parentSession: "session-a" });
  await fork.begin();
  const snapshot = fork.entries.findLast(e => e.customType === "io.kata.omp.state")?.data;
  expect(snapshot.owners).toEqual(["session-f", "session-a"]);
  // Resumed with the same branch but no fork header: the saved owners still include the source.
  const resumed = ompHost({ run: args => run(args), cwd, sid: "session-f", agent: { kind: "main", id: "main-session-f" }, entries: [...fork.entries] });
  await resumed.event("session_start");
  expect((await resumed.call({ op: "done", task: ref, ...proof })).isError).toBeUndefined();
}, 30000);

test("pending items and items without the marker keep the actor and teammate rule", async () => {
  const parent = await issue();
  const unmarked = await issue(["todo.phase=Tasks", "todo.status=in_progress"], parent);
  const pending = await issue(["todo.phase=Tasks", "todo.status=pending", "todo.session=session-a"], parent);
  const b = lead("session-b", parent);
  await b.begin();
  expect((await b.call({ op: "done", task: unmarked, ...proof })).isError).toBeUndefined();
  expect((await b.call({ op: "start", task: pending })).isError).toBeUndefined();
  expect((await meta(pending))["todo.session"]).toBe("session-b");
}, 30000);

test("items a lead creates carry its session", async () => {
  const parent = await issue();
  const a = lead("session-a", parent);
  await a.begin();
  expect((await a.call({ op: "append", items: ["A marked item"] })).isError).toBeUndefined();
  const child = (await shown(parent)).children.find((c: { title: string }) => c.title === "A marked item");
  expect(child.metadata["todo.session"]).toBe("session-a");
}, 30000);

test("a bare done never picks this session's task while another session's task is in progress", async () => {
  const parent = await issue();
  const first = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const a = lead("session-a", parent), b = lead("session-b", parent);
  await a.begin();
  await a.call({ op: "start", task: first });
  await b.begin();
  const view = await b.call({ op: "view" });
  expect(view.content[0].text).toContain(`(omptest#${first}) — started by session session-a`);
  // Starting another task leaves two in progress, one of them not this session's.
  const second = (await shown(parent)).children.find((c: { short_id: string }) => c.short_id !== first).short_id;
  expect((await b.call({ op: "start", task: second })).isError).toBeUndefined();
  const refused = await b.call({ op: "done", ...proof });
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toContain("Several tasks are in progress");
  expect((await shown(second)).issue.status).toBe("open");
}, 30000);

test("a lead that shuts down releases its started tasks, so the next session continues them without a takeover", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const a = lead("session-a", parent);
  await a.begin();
  await a.call({ op: "start", task: ref });
  await a.shutdown();
  const released = await meta(ref);
  expect(released["todo.session"]).toBeUndefined();
  expect(released["todo.status"]).toBe("in_progress");
  const b = lead("session-b", parent);
  await b.begin();
  expect((await b.call({ op: "done", ...proof })).isError).toBeUndefined();
  expect((await shown(ref)).issue.status).toBe("closed");
}, 30000);

test("a switch to another session releases the tasks the previous one started", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const a = lead("session-a", parent);
  await a.begin();
  await a.call({ op: "start", task: ref });
  await a.switchTo("session-a2");
  expect((await meta(ref))["todo.session"]).toBeUndefined();
}, 30000);

test("a fork's shutdown leaves its source's started tasks held", async () => {
  const parent = await issue();
  const ref = await issue(["todo.phase=Tasks", "todo.status=pending"], parent);
  const a = lead("session-a", parent);
  await a.begin();
  await a.call({ op: "start", task: ref });
  const fork = lead("session-f", parent, { parentSession: "session-a" });
  await fork.begin();
  await fork.shutdown();
  expect((await meta(ref))["todo.session"]).toBe("session-a");
}, 30000);
