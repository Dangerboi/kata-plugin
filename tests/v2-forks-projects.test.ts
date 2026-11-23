import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { eventually } from "./kata-fixture";
import { v2Fixture } from "./v2-fixture";

// The omp adapter against a real Kata, driven by omp's native todo: /tan sub sessions, forks, issues moved between projects and default priority.
const { scratch, home, run, kata, show, issue, unique, host, down, evidence, message, throttledClose, sessionParents } = v2Fixture();

// omp's /tan runs a side conversation in a sub session named Tan-<snowflake>
// that no task spawn created; it keeps omp's native todo.
test("an untracked /tan sub session's native todo makes no Kata calls", async () => {
  const app = host();
  const tan = host({ agent: { kind: "sub", id: "Tan-7000000000001", parentId: app.ctx.agent.id }, sessionFile: `${scratch}/Tan-7000000000001.jsonl` });
  const result = await tan.call({ op: "init", list: [{ phase: "Side", items: ["Look into the question"] }] });
  expect(result.isError).toBeUndefined();
  expect(tan.list()[0].tasks.map(t => t.content)).toEqual(["Look into the question"]);
  expect(tan.calls).toEqual([]);
});

test("a delegate spawned under a Tan- name keeps its record and the Kata path", async () => {
  const lead = host(); await lead.event("session_start");
  await lead.init(["Plan one"]);
  const sessionFile = `${scratch}/Tan-named.jsonl`;
  lead.emit("task:subagent:lifecycle", { id: "Tan-named", agent: "scout", status: "started", sessionFile, description: "Plan one" });
  const worker = host({ sessionFile, agent: { kind: "sub", id: "Tan-named", parentId: lead.ctx.agent.id } });
  await worker.event("session_start");
  const result = await worker.call({ op: "init", items: ["Delegated step"] });
  expect(result.isError).toBeUndefined();
  await eventually(async () => (await kata(["list", "--status", "all", "--limit", "0", "--json"])).issues.some((i: any) => i.title === "Delegated step"), true);
});

// An omp fork gets a new session id and copies the source's entries (and so its todo list): the fork shares the source's work.
function fork(source: ReturnType<typeof host>, form: "id" | "file", options: any = {}) {
  const parentSession = form === "id" ? source.sid : `/sessions/2026-11-02T10-00-00-000Z_${source.sid}.jsonl`;
  return host({ entries: structuredClone(source.entries), header: { parentSession }, ...options });
}
// A fork that starts holding the source's native list, as omp's fork copies it.
async function forkWithList(source: ReturnType<typeof host>, form: "id" | "file") {
  const next = fork(source, form);
  await next.event("session_start");
  await next.edit(source.list());
  return next;
}
const closeRef = (ref: string) => kata(["close", ref, "--done", "--message", message, ...evidence.flatMap(e => ["--evidence", e]), "--json"]);
async function closeChild(parent: string, title: string) {
  const child = (await show(parent)).children.find((c: any) => c.title === title);
  await closeRef(`${parent.split("#")[0]}#${child.short_id}`);
}
for (const form of ["id", "file"] as const) test(`a fork (parentSession as ${form}) keeps the source plan and makes no new parent`, async () => {
  const source = host(); await source.event("session_start"); const parent = await source.init(["Shared alpha", "Shared beta"]);
  const next = await forkWithList(source, form);
  expect((await next.call({ op: "append", items: ["Fork gamma"] })).isError).toBeUndefined();
  expect(await sessionParents(next.sid)).toEqual([]);
  expect((await show(parent)).children.map((c: any) => c.title).sort()).toEqual(["Fork gamma", "Shared alpha", "Shared beta"]);
});

test("a fork does not replay the source's pending close retries", async () => {
  const { app: source, lift } = throttledClose();
  await source.event("session_start");
  const parent = await source.init(["Throttled shared"]);
  // Dropping the task makes the plugin close it as wontfix; the throttle holds that close back, so a retry is pending.
  await source.call({ op: "drop", task: "Throttled shared" });
  expect((await show(parent)).children.map((c: any) => c.status)).toEqual(["open"]);
  lift();
  const next = fork(source, "id"); await next.event("session_start");
  await next.call({ op: "view" });
  expect((await show(parent)).children.map((c: any) => c.status)).toEqual(["open"]);
  expect(next.calls.some(a => a[0] === "close")).toBe(false);
});

test("a fork does not adopt the source's local plan", async () => {
  const source = host({ before: (a: string[]) => a[0] !== "init" && a[0] !== "projects" ? down() : undefined });
  await source.event("session_start");
  await source.call({ op: "init", items: ["Offline only"] });
  const next = fork(source, "id"); await next.event("session_start");
  await next.call({ op: "init", items: ["Online only"] });
  const titles = (await kata(["list", "--status", "all", "--limit", "0", "--json"])).issues.map((i: any) => i.title);
  expect(titles).toContain("Online only");
  expect(titles).not.toContain("Offline only");
});

test("shutting down either session keeps the shared parent open until every task is closed", async () => {
  const source = host(); await source.event("session_start"); const parent = await source.init(["Shared one", "Shared two"]);
  const next = await forkWithList(source, "id");
  await source.event("session_shutdown");
  await next.event("session_shutdown");
  expect((await show(parent)).issue.status).toBe("open");
  for (const title of ["Shared one", "Shared two"]) {
    await closeChild(parent, title);
    expect((await next.call({ op: "done", task: title })).isError).toBeUndefined();
  }
  await next.event("session_shutdown");
  expect((await show(parent)).issue.status).toBe("closed");
  await source.event("session_shutdown");
  expect((await show(parent)).issue.status).toBe("closed");
});

test("a restarted fork still owns the shared parent", async () => {
  const source = host(); await source.event("session_start"); const parent = await source.init(["Shared once"]);
  const next = await forkWithList(source, "id");
  const resumed = host({ sid: next.sid, entries: next.entries, header: next.ctx.sessionManager.getHeader() });
  await resumed.event("session_start");
  await resumed.edit(source.list());
  await closeChild(parent, "Shared once");
  expect((await resumed.call({ op: "done", task: "Shared once" })).isError).toBeUndefined();
  await resumed.event("session_shutdown");
  expect((await show(parent)).issue.status).toBe("closed");
});

test("a session without parentSession ignores another session's entries", async () => {
  const source = host(); await source.event("session_start"); const parent = await source.init(["Not shared"]);
  const next = host({ entries: structuredClone(source.entries), header: {} }); await next.event("session_start");
  const own = await next.init(["Own task"]);
  expect(own).not.toBe(parent);
  expect((await show(parent)).children.map((c: any) => c.title)).toEqual(["Not shared"]);
  expect((await show(parent)).issue.status).toBe("open");
});

// ------------------------------------------------------- issues moved between projects
async function otherProject() { const name = `v2moved${unique()}`; await kata(["projects", "create", name, "--json"]); return name; }

test("a plan whose parent moved to another project creates new items there and rebinds the parent", async () => {
  const app = host(); await app.event("session_start"); const parent = await app.init(["Before the move"]);
  const target = await otherProject(), short = parent.split("#")[1];
  await kata(["move", parent, target, "--json"]);
  expect((await app.call({ op: "append", items: ["After the move"] })).isError).toBeUndefined();
  const moved = await show(`${target}#${short}`);
  expect(moved.children.map((c: any) => c.title).sort()).toEqual(["After the move", "Before the move"]);
  expect(moved.children.every((c: any) => c.project_id === moved.issue.project_id)).toBe(true);
  await app.close("Before the move");
  expect((await app.call({ op: "done", task: "Before the move" })).isError).toBeUndefined();
  const stale = moved.children.find((c: any) => c.title === "Before the move");
  expect((await show(`${target}#${stale.short_id}`)).issue.status).toBe("closed");
  expect(app.entries.filter(e => e.customType === "io.kata.omp.parent").at(-1)!.data.parent).toBe(`${target}#${short}`);
  const resumed = host({ sid: app.sid, entries: structuredClone(app.entries) }); await resumed.event("session_start");
  expect((await resumed.call({ op: "append", items: ["After the resume"] })).isError).toBeUndefined();
  expect((await show(`${target}#${short}`)).children.map((c: any) => c.title).sort()).toEqual(["After the move", "After the resume", "Before the move"]);
  // sessionParents lists the workspace's own project; the moved parent now lives in the target, so ask every project.
  const recorded: { short_id: string }[] = (await kata(["list", "--all", "--status", "all", "--meta", `omp.session_id=${app.sid}`, "--json"])).issues;
  expect(recorded.map(i => i.short_id)).toEqual([short]);
});

test("a ticket item naming a moved ticket is pinned and closed in its current project", async () => {
  const app = host(); await app.event("session_start");
  const ticket = await issue("Moving ticket"), target = await otherProject();
  await kata(["move", `v2test#${ticket}`, target, "--json"]);
  const item = `v2test#${ticket}: finish the move`;
  expect((await app.call({ op: "init", items: [item] })).isError).toBeUndefined();
  await closeRef(`${target}#${ticket}`);
  const done = await app.call({ op: "done", task: item });
  expect(done.isError, done.content[0].text).toBeUndefined();
  expect((await show(`${target}#${ticket}`)).issue.status).toBe("closed");
});

test("a parent moved once or twice is not re-adopted by every later todo call through the original ref", async () => {
  // One session measures an unmoved call as the baseline; a call after each move must cost the same.
  const parent = `v2test#${await issue()}`; process.env.KATA_REF = parent;
  const short = parent.split("#")[1];
  const app = host(); await app.event("session_start"); await app.init(["First"]);
  const shows = () => app.calls.filter(a => a[0] === "show" && a[1].endsWith(`#${short}`)).length;
  const more = async (item: string) => {
    const before = shows();
    expect((await app.call({ op: "append", items: [item] })).isError).toBeUndefined();
    return shows() - before;
  };
  await more("Second");
  const baseline = await more("Third");
  const second = await otherProject(), third = await otherProject();
  await kata(["move", parent, second, "--json"]);
  await more("Fourth");
  expect(await more("Fifth")).toBe(baseline);
  await kata(["move", `${second}#${short}`, third, "--json"]);
  await more("Sixth");
  expect((await show(`${third}#${short}`)).children.map((c: any) => c.title)).toContain("Sixth");
  expect(await more("Seventh")).toBe(baseline);
  expect((await show(`${third}#${short}`)).children.map((c: any) => c.title)).toContain("Seventh");
});

test("a ticket in another project is never taken for a plan item by its short id", async () => {
  const app = host(); await app.event("session_start");
  const foreign = await otherProject();
  const ticket = await issue("Foreign ticket", { project: foreign });
  await app.init(["Plain item"]);
  const result = await app.call({ op: "done", task: `${foreign}#${ticket}` });
  expect(result.isError).toBe(true);
  expect((await show(`${foreign}#${ticket}`)).issue.status).toBe("open");
});

test("a project renamed mid-session is found by the very next call using the new name", async () => {
  const app = host(); await app.event("session_start");
  const project = await otherProject(), renamed = `${project}x`;
  const first = await issue("First in renamed", { project });
  const second = await issue("Second in renamed", { project });
  await app.init(["Plain item"]);
  expect((await app.call({ op: "append", items: [`${project}#${first}: first`] })).isError).toBeUndefined();
  // Drop the old-name item so no background refresh of it fails first and clears the cached project list.
  expect((await app.call({ op: "drop", task: `${project}#${first}: first` })).isError).toBeUndefined();
  await kata(["projects", "rename", project, renamed, "--json"]);
  const item = `${renamed}#${second}: second`;
  expect((await app.call({ op: "append", items: [item] })).isError).toBeUndefined();
  const started = await app.call({ op: "start", task: item });
  expect(started.isError, started.content[0].text).toBeUndefined();
  expect((await show(`${renamed}#${second}`)).issue.owner).toBe("v2-builder");
  expect(app.mirrorFailures()).toEqual([]);
});

test("unmoved refs are pinned from the cached project list without another projects call", async () => {
  const ref = await issue(); process.env.KATA_REF = ref;
  const app = host(); await app.event("session_start");
  const listed = () => app.calls.filter(a => a[0] === "projects" && a[1] === "list").length;
  await app.init(["Cached lookup"]);
  const before = listed();
  expect(before).toBeLessThanOrEqual(1);
  for (const task of ["Second cached", "Third cached"]) await app.call({ op: "append", items: [task] });
  await app.call({ op: "view" });
  expect(listed()).toBe(before);
});

test("re-binding the bound parent appends no further parent state entry", async () => {
  const parent = `v2test#${await issue()}`; process.env.KATA_REF = parent;
  const app = host(); await app.event("session_start"); await app.init(["First"]);
  const parentEntries = () => app.entries.filter(e => e.customType === "io.kata.omp.parent").length;
  const before = parentEntries();
  await app.call({ op: "append", items: ["Second"] });
  await app.event("input", { text: `/todo ref ${parent}`, source: "interactive" });
  await app.call({ op: "append", items: ["Third"] });
  expect(parentEntries()).toBe(before);
});

test("free text containing # is never shown as a Kata ref", async () => {
  const app = host(); await app.event("session_start"); await app.init(["Plain task"]);
  for (const target of ["Fix C# parser", "Fix #12 bug", "-flag#abc"]) {
    expect((await app.call({ op: "done", task: target })).isError).toBe(true);
    expect(app.calls.some(a => a[0] === "show" && a[1] === target)).toBe(false);
  }
});

async function withDefaultPriority(fn: () => Promise<void>): Promise<void> {
  const config = path.join(home, "config.toml");
  writeFileSync(config, "[create]\ndefault_priority = 2\n");
  try { await fn(); } finally { writeFileSync(config, ""); }
}

test("plan tasks and automatic parents take no default priority", () => withDefaultPriority(async () => {
  const app = host(); await app.event("session_start");
  const parent = await app.init(["Fresh priority child"]);
  // Kata leaves `priority` out of the issue when it has none.
  expect((await show(parent)).issue.priority).toBeUndefined();
  const child = (await show(parent)).children.find((c: any) => c.title === "Fresh priority child");
  expect((await show(`v2test#${child.short_id}`)).issue.priority).toBeUndefined();
}));

// Just before the plugin's first create that `matches`, runs that create as an earlier version did: without `--priority`,
// so the issue takes the default. A person then changes its priority, as people may.
function earlierVersion(matches: (args: string[]) => boolean) {
  const made: { issue?: { short_id: string; priority?: number } } = {};
  const before = async (args: string[], opts: { cwd: string }) => {
    if (made.issue || args[0] !== "create" || !matches(args)) return;
    const at = args.indexOf("--priority");
    const out = await run([...args.slice(0, at), ...args.slice(at + 2)], opts.cwd);
    if (out.code) throw new Error(out.stderr);
    const issue: { short_id: string; priority?: number } = JSON.parse(out.stdout).issue;
    made.issue = issue;
    await kata(["edit", `v2test#${issue.short_id}`, "--priority", "1", "--json"]);
  };
  return { made, before };
}

test("a plan task an earlier version created under a default priority replays", () => withDefaultPriority(async () => {
  const earlier = earlierVersion(args => args.includes("Legacy item"));
  const app = host({ before: earlier.before }); await app.event("session_start"); const parent = await app.init(["Legacy sibling"]);
  const again = await app.call({ op: "append", items: ["Legacy item"] });
  expect(again.isError, again.content?.[0]?.text).toBeUndefined();
  expect(earlier.made.issue?.priority).toBe(2);
  expect((await show(parent)).children.filter((c: any) => c.title === "Legacy item").map((c: any) => c.short_id)).toEqual([earlier.made.issue?.short_id]);
}));

test("an automatic parent an earlier version created under a default priority is adopted", () => withDefaultPriority(async () => {
  const sid = `v2-legacy-parent-${unique()}`;
  const earlier = earlierVersion(args => args.includes(`omp.session_id=${sid}`));
  const app = host({ sid, before: earlier.before }); await app.event("session_start");
  const result = await app.call({ op: "init", items: ["Adopt me"] });
  expect(result.isError, result.content?.[0]?.text).toBeUndefined();
  expect(earlier.made.issue?.priority).toBe(2);
  const parents = await sessionParents(sid);
  expect(parents.map((p: any) => p.short_id)).toEqual([earlier.made.issue?.short_id]);
}));

test("omp reports an old Kata as an upgrade notice, never a local plan", async () => {
  const app = host({ before: (args: string[]) => args[0] === "version" ? { code: 0, stdout: '{"kata_api_version":1,"version":"0.22.9"}' } : undefined });
  await app.event("session_start");
  const result = await app.call({ op: "init", items: ["Must upgrade first"] });
  expect(result.isError).toBeUndefined();
  expect(JSON.stringify(app.notices)).toContain("requires Kata >=0.23.0");
  expect(await sessionParents(app.sid)).toEqual([]);
  expect(app.list()[0].tasks.map(t => t.content)).toEqual(["Must upgrade first"]);
  await app.event("session_shutdown");
});
