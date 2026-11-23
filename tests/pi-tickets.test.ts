import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { isRead } from "../core/kata-cli";
import { piFixture } from "./pi-fixture";

// The pi adapter's todo tool against a real Kata, for ticket items and replacement: what omp's native todo no longer has
// (done with evidence, block, replace, a ticket close held until its open children close) and no other host's test covers.
const { scratch, run, kata, show, issue, unique, host, down, evidence, message, commentsOf, closesOf } = piFixture();
const start = async (options: { sid?: string; entries?: unknown[]; before?: (args: string[], opts: any) => unknown } = {}) => {
  const app = await host(options);
  await app.event("session_start", { reason: options.sid ? "resume" : "startup" });
  return app;
};
const copy = (entries: unknown[]) => JSON.parse(JSON.stringify(entries));
const kataWrites = (calls: string[][]) => calls.filter(args => !isRead(args));
const blockingComments = async (ref: string) => (await commentsOf(ref)).filter(c => /open child|open children/.test(c));
const closeCalls = (app: { calls: string[][] }, ref: string) => app.calls.filter(c => c[0] === "close" && c[1].endsWith(`#${ref}`));
const claimed = async (app: { event: (name: string, data?: unknown) => Promise<unknown> }, title: string) => {
  const ticket = await issue(title); await kata(["claim", ticket, "--json"]);
  await app.event("tool_result", { toolName: "bash", input: { command: `kata claim pitest#${ticket}` }, isError: false, details: { exitCode: 0 } });
  return ticket;
};

test("done on an item of a ticket whose first step was blocked clears the ticket's attention", async () => {
  const app = await start();
  const b = await issue("Ticket B");
  await app.call({ op: "init", items: [`pitest#${b}: first step`, `pitest#${b}: second step`] });
  await app.call({ op: "block", task: `pitest#${b}: first step`, reason: "Waiting on a vendor reply" });
  const done = await app.call({ op: "done", task: `pitest#${b}: first step`, message, evidence });
  expect(done.isError).toBeUndefined();
  const after = (await show(b)).issue;
  expect(after.status).toBe("open");
  expect(after.metadata["work.attention"]).toBe("ok");
  expect(after.metadata["work.attention_msg"]).toBeUndefined();
});

test("a claimed ticket named by an item closes once its plan children close, with the ticket item's evidence", async () => {
  const app = await start();
  const ticket = await claimed(app, "Claimed ticket");
  const init = await app.call({ op: "init", items: [`pitest#${ticket}: write the greeting`, "Add the ignore file"] });
  expect(init.isError, init.content[0].text).toBeUndefined();
  expect(init.details.kata.parent).toBe(`pitest#${ticket}`);
  await app.call({ op: "done", task: `pitest#${ticket}: write the greeting`, message, evidence: ["test:ticket item evidence"] });
  expect((await show(ticket)).issue.status).toBe("open");
  expect(await blockingComments(ticket)).toHaveLength(1);
  expect((await blockingComments(ticket))[0]).toMatch(/closes once that child is closed/);
  const last = await app.call({ op: "done", task: "Add the ignore file", message, evidence });
  expect(last.isError, last.content[0].text).toBeUndefined();
  const closed = await show(ticket);
  expect(closed.issue.status).toBe("closed");
  expect(await closesOf(ticket)).toHaveLength(1);
  expect(JSON.stringify(closed)).toContain("test:ticket item evidence");
  expect(await blockingComments(ticket)).toHaveLength(1);
});

test("an umbrella ticket stays open after its outside children close, even across resume", async () => {
  const app = await start();
  const umbrella = await issue("Umbrella with outside child"), other = await issue("Other ticket");
  const outside = await issue("Outside child", { parent: umbrella });
  await app.call({ op: "init", items: [`pitest#${umbrella}: finish the umbrella`, `pitest#${other}: unrelated step`] });
  await app.call({ op: "done", task: `pitest#${umbrella}: finish the umbrella`, message, evidence });
  expect(await blockingComments(umbrella)).toHaveLength(1);
  expect((await blockingComments(umbrella))[0]).toMatch(/outside this todo plan, so close the ticket yourself/);
  await kata(["close", outside, "--done", "--message", message, "--test", "closed outside", "--json"]);
  await app.call({ op: "done", task: `pitest#${other}: unrelated step`, message, evidence });
  const resumed = await start({ sid: app.sid, entries: copy(app.entries) });
  await resumed.call({ op: "view" }); await resumed.event("session_shutdown", { reason: "quit" });
  expect((await show(umbrella)).issue.status).toBe("open");
  expect(closeCalls(app, umbrella)).toHaveLength(1);
  expect(closeCalls(resumed, umbrella)).toHaveLength(0);
});

test("a ticket whose open child is named by another plan item closes after that child closes", async () => {
  const app = await start();
  const parent = await issue("Parent ticket");
  const child = await issue("Named child", { parent });
  await app.call({ op: "init", items: [`pitest#${parent}: finish the parent`, `pitest#${child}: finish the child`] });
  await app.call({ op: "done", task: `pitest#${parent}: finish the parent`, message, evidence: ["test:parent item evidence"] });
  expect(await blockingComments(parent)).toHaveLength(1);
  expect((await blockingComments(parent))[0]).toMatch(/closes once that child is closed/);
  const last = await app.call({ op: "done", task: `pitest#${child}: finish the child`, message, evidence });
  expect(last.isError, last.content[0].text).toBeUndefined();
  expect((await show(child)).issue.status).toBe("closed");
  const closed = await show(parent);
  expect(closed.issue.status).toBe("closed");
  expect(JSON.stringify(closed)).toContain("test:parent item evidence");
  expect(await blockingComments(parent)).toHaveLength(1);
});

test("an umbrella ticket whose open child is outside the plan stays open without repeated close attempts or comments", async () => {
  const app = await start();
  const umbrella = await issue("Umbrella"), other = await issue("Other ticket");
  await issue("Outside child", { parent: umbrella });
  await app.call({ op: "init", items: [`pitest#${umbrella}: finish the umbrella`, `pitest#${other}: unrelated step`] });
  await app.call({ op: "done", task: `pitest#${umbrella}: finish the umbrella`, message, evidence });
  await app.call({ op: "done", task: `pitest#${other}: unrelated step`, message, evidence });
  await app.call({ op: "view" });
  await app.event("session_shutdown", { reason: "quit" });
  expect((await show(umbrella)).issue.status).toBe("open");
  expect((await show(other)).issue.status).toBe("closed");
  expect(await blockingComments(umbrella)).toHaveLength(1);
  expect(closeCalls(app, umbrella)).toHaveLength(1);
});

test("a pending ticket close survives resume and closes once the children close", async () => {
  const first = await start();
  const ticket = await claimed(first, "Resumed ticket");
  await first.call({ op: "init", items: [`pitest#${ticket}: ship it`, "Plain step"] });
  await first.call({ op: "done", task: `pitest#${ticket}: ship it`, message, evidence: ["test:survives resume"] });
  const resumed = await start({ sid: first.sid, entries: copy(first.entries) });
  const child = (await show(ticket)).children[0].short_id;
  await kata(["close", child, "--done", "--message", message, "--test", "closed outside", "--json"]);
  await resumed.event("session_shutdown", { reason: "quit" });
  const closed = await show(ticket);
  expect(closed.issue.status).toBe("closed");
  expect(JSON.stringify(closed)).toContain("test:survives resume");
  expect(await blockingComments(ticket)).toHaveLength(1);
});

test("a done replayed after the close failed leaves one comment and closes once", async () => {
  let outage = true;
  const app = await start({ before: (args: string[]) => args[0] === "close" && outage ? down() : undefined });
  const a = await issue("Ticket A");
  await app.call({ op: "init", items: [`pitest#${a}: only step`] });
  const failed = await app.call({ op: "done", message, evidence });
  expect(failed.isError).toBe(true);
  expect(await commentsOf(a)).toHaveLength(1);
  outage = false;
  const replayed = await app.call({ op: "done", task: `pitest#${a}: only step`, message, evidence });
  expect(replayed.isError).toBeUndefined();
  expect(await commentsOf(a)).toHaveLength(1);
  expect((await show(a)).issue.status).toBe("closed");
  expect(await closesOf(a)).toHaveLength(1);
});

test("the item-to-ticket record survives a resumed session", async () => {
  const first = await start();
  const a = await issue("Ticket A");
  await first.call({ op: "init", items: [`pitest#${a}: first step`, `pitest#${a}: second step`] });
  await first.call({ op: "done", task: `pitest#${a}: first step`, message, evidence });
  const resumed = await start({ sid: first.sid, entries: copy(first.entries) });
  const view = (await resumed.call({ op: "view" })).content[0].text;
  expect(view).toContain(`[x] pitest#${a}: first step (pitest#${a})`);
  expect(view).toContain(`pitest#${a}: second step (pitest#${a})`);
  expect((await resumed.call({ op: "done", task: `pitest#${a}: second step`, message, evidence })).isError).toBeUndefined();
  expect((await show(a)).issue.status).toBe("closed");
  expect(await commentsOf(a)).toHaveLength(2);
});

test("view retries a held ticket close in a plan of ticket items alone", async () => {
  const app = await start();
  const parent = await issue("View parent ticket");
  const child = await issue("View child ticket", { parent });
  await app.call({ op: "init", items: [`pitest#${parent}: finish the parent`, `pitest#${child}: finish the child`] });
  await app.call({ op: "done", task: `pitest#${parent}: finish the parent`, message, evidence: ["test:held until view"] });
  expect((await show(parent)).issue.status).toBe("open");
  await kata(["close", child, "--done", "--message", message, "--test", "closed outside", "--json"]);
  const viewed = await app.call({ op: "view" });
  expect(viewed.isError).toBeUndefined();
  expect((await show(parent)).issue.status).toBe("closed");
});

test("init with replace closes the open tasks missing from the new list", async () => {
  const app = await start();
  const parent = await app.init(["Old task", "Kept task"]);
  const result = await app.call({ op: "init", items: ["Kept task", "New task"], replace: true });
  expect(result.isError).toBeUndefined();
  const children = (await show(parent)).children;
  const old = children.find((c: any) => c.title === "Old task");
  expect(old.status).toBe("closed"); expect(old.closed_reason).toBe("wontfix");
  expect(children.find((c: any) => c.title === "Kept task").status).toBe("open");
  expect(children.find((c: any) => c.title === "New task").status).toBe("open");
});

test("init without replace refuses open ticket-named items and writes nothing to Kata", async () => {
  const ticket = `pitest#${await issue("Named work")}`;
  const app = await start();
  await app.call({ op: "init", items: [`${ticket}: do the named work`] });
  const before = await show(ticket);
  const mark = app.calls.length;
  const result = await app.call({ op: "init", items: ["Something else"] });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain(`${ticket}: do the named work`);
  expect(kataWrites(app.calls.slice(mark))).toEqual([]);
  expect(await show(ticket)).toEqual(before);
});

test("init with a bare short id that resolves in the session project refuses to abandon that ticket's open children", async () => {
  const other = path.join(scratch, `other-${unique()}`); mkdirSync(other);
  await kata(["init", "--project", "pialpha", "--json"], other);
  const alpha = await issue("Alpha parent", { workspace: other });
  const beta = await issue("Beta parent");
  await issue("Beta open child", { parent: beta, meta: ["todo.phase=Tasks", "todo.status=pending"] });
  // Short ids are random per project, so route the bare id to the session project's ticket.
  const app = await start({ before: (args: string[], opts: any) => args.includes(alpha) ? run(args.map(a => a === alpha ? `pitest#${beta}` : a), opts.cwd, opts.timeout) : undefined });
  await app.call({ op: "init", ref: `pialpha#${alpha}`, items: ["Alpha child"] });
  const mark = app.calls.length;
  const result = await app.call({ op: "init", ref: alpha, items: ["Alpha child"] });
  expect(result.isError).toBe(true);
  expect(kataWrites(app.calls.slice(mark))).toEqual([]);
  expect((await show(beta)).children.map((c: any) => c.status)).toEqual(["open"]);
});
