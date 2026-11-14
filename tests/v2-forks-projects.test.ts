import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { later } from "./kata-fixture";
import { v2Fixture } from "./v2-fixture";

// The omp adapter against a real Kata: /tan sub sessions, forks, issues moved between projects and default priority.
const { scratch, env, run, kata, show, issue, unique, host, down, evidence, message, throttledClose, sessionParents } = v2Fixture();

// omp's /tan runs a side conversation in a sub session named Tan-<snowflake>
// that no task spawn created; it keeps the todo tool.
test("an untracked /tan sub session uses omp's native todo and makes no Kata calls", async () => {
  const app = host();
  const received: any[] = [];
  const native = { content: [{ type: "text", text: "native list" }], details: { phases: [] } };
  const tan = host({ agent: { kind: "sub", id: "Tan-7000000000001", parentId: app.ctx.agent.id }, sessionFile: `${scratch}/Tan-7000000000001.jsonl` });
  const ctx = { ...tan.ctx, invokeTool: async (params: any) => { received.push(params); return native; } };
  const params = { op: "init", list: [{ phase: "Side", items: ["Look into the question"] }] };
  const result = await tan.call(params, ctx);
  expect(result).toBe(native);
  expect(received).toEqual([params]);
  expect(tan.calls).toEqual([]);
});

test("a /tan sub session on an omp without invokeTool keeps the assignment error", async () => {
  const tan = host({ agent: { kind: "sub", id: "Tan-7000000000002", parentId: "main" } });
  const result = await tan.call({ op: "view" });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("Kata assignment unavailable");
});

test("a delegate whose assignment failed still gets the assignment error, not the native list", async () => {
  let refuse = false;
  const lead = host({ before: (args: string[]) => refuse && args[0] === "meta" && args[3] === "omp.subagent_id" ? { code: 1, stdout: "", stderr: "meta refused" } : undefined });
  await lead.init(["Delegated plan"]);
  refuse = true;
  const sessionFile = `${scratch}/failed-binding.jsonl`;
  lead.emit("task:subagent:lifecycle", { id: "failed-binding", status: "started", sessionFile, description: "Delegated plan" });
  const worker = host({ sessionFile, agent: { kind: "sub", id: "failed-binding", parentId: lead.ctx.agent.id } });
  let native = 0;
  const result = await worker.call({ op: "view" }, { ...worker.ctx, invokeTool: async () => { native++; return { content: [], details: {} }; } });
  expect(native).toBe(0);
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("Kata assignment failed");
});

test("a delegate spawned under a Tan- name keeps its record and the Kata path", async () => {
  const lead = host();
  await lead.init(["Plan one"]);
  const sessionFile = `${scratch}/Tan-named.jsonl`;
  lead.emit("task:subagent:lifecycle", { id: "Tan-named", status: "started", sessionFile, description: "Plan one" });
  const worker = host({ sessionFile, agent: { kind: "sub", id: "Tan-named", parentId: lead.ctx.agent.id } });
  let native = 0;
  const result = await worker.call({ op: "init", items: ["Delegated step"] }, { ...worker.ctx, invokeTool: async () => { native++; return { content: [], details: {} }; } });
  expect(native).toBe(0);
  expect(result.details.kata.parent).toMatch(/^v2test#/);
});

// An omp fork gets a new session id and copies the source's entries: the fork shares the source's work.
function fork(source: ReturnType<typeof host>, form: "id" | "file", options: any = {}) {
  const parentSession = form === "id" ? source.sid : `/sessions/2026-11-02T10-00-00-000Z_${source.sid}.jsonl`;
  return host({ entries: structuredClone(source.entries), header: { parentSession }, ...options });
}
for (const form of ["id", "file"] as const) test(`a fork (parentSession as ${form}) keeps the source plan and makes no new parent`, async () => {
  const source = host(); const parent = await source.init(["Shared alpha", "Shared beta"]);
  const next = fork(source, form); await next.event("session_start");
  const view = await next.call({ op: "view" });
  expect(view.details.kata.parent).toBe(parent);
  expect(view.content[0].text).toContain("Shared alpha");
  expect((await next.call({ op: "append", items: ["Fork gamma"] })).isError).toBeUndefined();
  await next.call({ op: "view" });
  expect(await sessionParents(next.sid)).toEqual([]);
  expect((await show(parent)).children.map((c: any) => c.title).sort()).toEqual(["Fork gamma", "Shared alpha", "Shared beta"]);
});

test("a fork does not replay the source's pending close retries", async () => {
  const { app: source, lift } = throttledClose();
  const parent = await source.init(["Throttled shared"]);
  await source.call({ op: "done", message, evidence });
  expect((await show(parent)).issue.status).toBe("open");
  lift();
  const next = fork(source, "id"); await next.event("session_start");
  expect((await next.call({ op: "view" })).details.kata.parent).toBe(parent);
  expect((await show(parent)).children.map((c: any) => c.status)).toEqual(["open"]);
  expect(next.calls.some(a => a[0] === "close")).toBe(false);
});

test("a fork does not adopt the source's local plan", async () => {
  const source = host({ before: (a: string[]) => a[0] !== "init" && a[0] !== "projects" ? down() : undefined });
  await source.event("session_start");
  await source.call({ op: "init", items: ["Offline only"] });
  expect((await source.call({ op: "view" })).content[0].text).toContain("Offline only");
  const next = fork(source, "id"); await next.event("session_start");
  expect((await next.call({ op: "view" })).content[0].text).not.toContain("Offline only");
});

test("shutting down either session keeps the shared parent open until every task is closed", async () => {
  const source = host(); const parent = await source.init(["Shared one", "Shared two"]);
  const next = fork(source, "id"); await next.event("session_start");
  await source.event("session_shutdown");
  await next.event("session_shutdown");
  expect((await show(parent)).issue.status).toBe("open");
  await next.call({ op: "done", message, evidence });
  await next.call({ op: "done", message, evidence });
  expect((await show(parent)).issue.status).toBe("closed");
  await source.event("session_shutdown");
  expect((await show(parent)).issue.status).toBe("closed");
});

test("a restarted fork still owns the shared parent", async () => {
  const source = host(); const parent = await source.init(["Shared once"]);
  const next = fork(source, "id"); await next.event("session_start");
  await next.call({ op: "view" });
  const resumed = host({ sid: next.sid, entries: next.entries, header: next.ctx.sessionManager.getHeader() });
  await resumed.event("session_start");
  expect((await resumed.call({ op: "view" })).details.kata.parent).toBe(parent);
  await resumed.call({ op: "done", message, evidence });
  expect((await show(parent)).issue.status).toBe("closed");
});

test("a session without parentSession ignores another session's entries", async () => {
  const source = host(); const parent = await source.init(["Not shared"]);
  const next = host({ entries: structuredClone(source.entries), header: {} }); await next.event("session_start");
  expect((await next.call({ op: "view" })).details.kata.parent).toBeUndefined();
  expect((await show(parent)).issue.status).toBe("open");
});

// ------------------------------------------------------- issues moved between projects
async function otherProject() { const name = `v2moved${unique()}`; await kata(["projects", "create", name, "--json"]); return name; }

test("a plan whose parent moved to another project creates new items there and rebinds the parent", async () => {
  const app = host(); const parent = await app.init(["Before the move"]);
  const target = await otherProject(), short = parent.split("#")[1];
  await kata(["move", parent, target, "--json"]);
  expect((await app.call({ op: "append", items: ["After the move"] })).isError).toBeUndefined();
  const view = await app.call({ op: "view" });
  expect(view.details.kata.parent).toBe(`${target}#${short}`);
  const moved = await show(`${target}#${short}`);
  expect(moved.children.map((c: any) => c.title).sort()).toEqual(["After the move", "Before the move"]);
  expect(moved.children.every((c: any) => c.project_id === moved.issue.project_id)).toBe(true);
  const stale = moved.children.find((c: any) => c.title === "Before the move");
  const closedByOldRef = await app.call({ op: "done", task: `${parent.split("#")[0]}#${stale.short_id}`, message, evidence });
  expect(closedByOldRef.isError, closedByOldRef.content[0].text).toBeUndefined();
  expect((await show(`${target}#${stale.short_id}`)).issue.status).toBe("closed");
  expect(app.entries.filter(e => e.customType === "io.kata.omp.parent").at(-1)!.data.parent).toBe(`${target}#${short}`);
  const resumed = host({ sid: app.sid, entries: structuredClone(app.entries) }); await resumed.event("session_start");
  expect((await resumed.call({ op: "view" })).details.kata.parent).toBe(`${target}#${short}`);
});

test("a ticket item naming a moved ticket is pinned and closed in its current project", async () => {
  const app = host(); await app.event("session_start");
  const ticket = await issue("Moving ticket"), target = await otherProject();
  await kata(["move", `v2test#${ticket}`, target, "--json"]);
  expect((await app.call({ op: "init", items: [`v2test#${ticket}: finish the move`] })).isError).toBeUndefined();
  const done = await app.call({ op: "done", task: `v2test#${ticket}: finish the move`, message, evidence });
  expect(done.isError, done.content[0].text).toBeUndefined();
  expect(done.content[0].text).toContain(`(${target}#${ticket})`);
  expect((await show(`${target}#${ticket}`)).issue.status).toBe("closed");
});

test("a parent moved once or twice is not re-adopted by every later todo call through the original ref", async () => {
  // One session measures an unmoved call as the baseline; a call after each move must cost the same.
  const parent = `v2test#${await issue()}`; process.env.KATA_REF = parent;
  const short = parent.split("#")[1];
  const app = host(); await app.event("session_start"); await app.init(["First"]);
  const shows = () => app.calls.filter(a => a[0] === "show" && a[1].endsWith(`#${short}`)).length;
  const replace = async (item: string) => {
    const before = shows();
    expect((await app.call({ op: "init", replace: true, items: [item] })).isError).toBeUndefined();
    return shows() - before;
  };
  await replace("Second");
  const baseline = await replace("Third");
  const second = await otherProject(), third = await otherProject();
  await kata(["move", parent, second, "--json"]);
  await replace("Fourth");
  expect(await replace("Fifth")).toBe(baseline);
  await kata(["move", `${second}#${short}`, third, "--json"]);
  await replace("Sixth");
  expect((await app.call({ op: "view" })).details.kata.parent).toBe(`${third}#${short}`);
  expect(await replace("Seventh")).toBe(baseline);
});

test("an item or plan title that reads like a flag is data, not a Kata option", async () => {
  const app = host(); await app.event("session_start");
  const result = await app.call({ op: "init", items: ["--json"], message: "--json" });
  expect(result.isError, result.content[0].text).toBeUndefined();
  expect(result.details.kata.phases[0].tasks.map((t: any) => t.content)).toEqual(["--json"]);
  expect((await show(result.details.kata.parent)).issue.title).toBe("--json");
});

test("a ticket in another project is never taken for a plan item by its short id", async () => {
  const app = host(); await app.event("session_start");
  const foreign = await otherProject();
  const ticket = (await kata(["create", "--project", foreign, "Foreign ticket", "--force-new", "--json"])).issue.short_id;
  await app.init(["Plain item"]);
  const result = await app.call({ op: "done", task: `${foreign}#${ticket}`, message, evidence });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("No task");
});

test("a project renamed mid-session is found by the very next call using the new name", async () => {
  const app = host(); await app.event("session_start");
  const project = await otherProject(), renamed = `${project}x`;
  const first = (await kata(["create", "--project", project, "First in renamed", "--force-new", "--json"])).issue.short_id;
  const second = (await kata(["create", "--project", project, "Second in renamed", "--force-new", "--json"])).issue.short_id;
  await app.init(["Plain item"]);
  expect((await app.call({ op: "append", items: [`${project}#${first}: first`] })).isError).toBeUndefined();
  // Drop the old-name item so no background refresh of it fails first and clears the cached project list.
  expect((await app.call({ op: "drop", task: `${project}#${first}: first`, message: "Not needed." })).isError).toBeUndefined();
  await kata(["projects", "rename", project, renamed, "--json"]);
  const result = await app.call({ op: "append", items: [`${renamed}#${second}: second`] });
  expect(result.isError, result.content[0].text).toBeUndefined();
  expect(result.content[0].text).toContain(`${renamed}#${second}`);
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
  await app.call({ op: "init", replace: true, items: ["Second"] });
  await app.call({ op: "init", replace: true, ref: parent, items: ["Third"] });
  expect(parentEntries()).toBe(before);
});

test("free text containing # is never shown as a Kata ref", async () => {
  const app = host(); await app.init(["Plain task"]);
  for (const target of ["Fix C# parser", "Fix #12 bug", "-flag#abc"]) {
    expect((await app.call({ op: "done", task: target, message, evidence })).isError).toBe(true);
    expect(app.calls.some(a => a[0] === "show" && a[1] === target)).toBe(false);
  }
});

async function withDefaultPriority(fn: () => Promise<void>): Promise<void> {
  const config = path.join(env.KATA_HOME, "config.toml");
  writeFileSync(config, "[create]\ndefault_priority = 2\n");
  try { await fn(); } finally { writeFileSync(config, ""); }
}

test("plan tasks and automatic parents take no default priority", () => withDefaultPriority(async () => {
  const parent = await host().init(["Fresh priority child"]);
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
  const app = host({ before: earlier.before }); const parent = await app.init(["Legacy sibling"]);
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
  expect(result.details.kata.parent).toBe(`v2test#${earlier.made.issue?.short_id}`);
  expect((await kata(["list", "--status", "all", "--meta", `omp.session_id=${sid}`, "--json"])).issues).toHaveLength(1);
}));

test("omp reports an old Kata as an upgrade error, never a local plan", async () => {
  const app = host({ before: (args: string[]) => args[0] === "version" ? { code: 0, stdout: '{"kata_api_version":1,"version":"0.22.9"}' } : undefined });
  await app.event("session_start");
  const result = await app.call({ op: "init", items: ["Must upgrade first"] });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("requires Kata >=0.23.0");
  await app.event("session_shutdown");
});
