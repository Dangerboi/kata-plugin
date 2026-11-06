import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { assertIsolated } from "./isolation";
import { adoptIsolatedKata, isolatedKata } from "./kata-fixture";
import { daemonUnavailable, missingExecutable } from "./kata-errors";
import { ompHost } from "./omp-host";
assertIsolated();
const binary = process.env.KATA_TEST_EXECUTABLE!;
if (!binary || !path.isAbsolute(binary)) throw new Error("Set KATA_TEST_EXECUTABLE to the absolute Kata binary.");
const scratch = mkdtempSync(path.join(process.env.KATA_TEST_ROOT!, "takeover-"));
const env = { ...process.env, KATA_HOME: path.join(scratch, "home"), KATA_AUTHOR: "v2-builder" };
for (const key of ["KATA_SERVER", "KATA_DAEMON", "KATA_AUTH_TOKEN", "KATA_REF", "KATA_TEAMMATE", "KATA_INBOX_USER", "KATA_DEFAULT_PROJECT"]) delete env[key];
const run = isolatedKata(binary, env, scratch, 5000);
async function kata(args: string[], workspace = scratch): Promise<any> {
  const out = await run(args, workspace);
  if (out.code) throw new Error(out.stderr);
  return JSON.parse(out.stdout);
}
const projects = async () => (await kata(["projects", "list", "--json"])).projects.map((p: any) => p.name).sort();
const issues = async (project: string) => (await kata(["list", "--project", project, "--status", "all", "--limit", "100", "--json"])).issues;
let sequence = 0;
function repo(name: string, remote = `https://github.com/someone/${name}.git`) {
  const dir = path.join(scratch, `r${++sequence}`, name);
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  git("init", "-q"); if (remote) git("remote", "add", "origin", remote);
  return dir;
}
const status = (dir: string) => execFileSync("git", ["status", "--porcelain", "--ignored"], { cwd: dir }).toString();
const evidence = ["test:bun test takeover"];
const message = "Implemented this takeover fixture and verified it with the isolated suite.";
function host(options: any = {}) {
  const sid = `takeover-${++sequence}`;
  return ompHost({ run: (args, opts) => run(args, opts.cwd, opts.timeout), cwd: options.cwd, sid, sessionFile: `${scratch}/${sid}.jsonl`, before: options.before, callId: "takeover" });
}
beforeAll(async () => { const out = await run(["projects", "create", "takeover-home"]); if (out.code) throw new Error(out.stderr); });
let restore: (() => void) | undefined;
beforeEach(() => { restore = adoptIsolatedKata(binary, env.KATA_HOME); process.env.KATA_AUTHOR = "v2-builder"; for (const key of ["KATA_REF", "KATA_TEAMMATE", "KATA_INBOX_USER", "KATA_DEFAULT_PROJECT"]) delete process.env[key]; });
afterEach(() => restore?.());
afterAll(async () => { await run(["daemon", "stop"]); });

test("an unregistered git repo registers its inferred project and plans there without touching the repo", async () => {
  const dir = repo("takeoverrepo"), before = status(dir);
  const app = host({ cwd: dir }); await app.event("session_start");
  const result = await app.call({ op: "init", items: ["Plan the change", "Verify the change"] });
  expect(result.isError).toBeUndefined();
  expect(result.content[0].text).not.toContain("Session-local");
  expect(await projects()).toContain("takeoverrepo");
  const parent = result.details.kata.parent as string;
  expect(parent).toMatch(/^takeoverrepo#/);
  const shown = await kata(["show", parent, "--json"]);
  expect(shown.children.map((c: any) => c.title)).toEqual(["Plan the change", "Verify the change"]);
  expect(shown.issue.metadata["omp.auto_parent"]).toBe(true);
  expect(status(dir)).toBe(before);
  expect(existsSync(path.join(dir, ".kata.toml"))).toBe(false);
  expect(app.calls.some(a => a[0] === "init")).toBe(false);
  for (const task of ["Plan the change", "Verify the change"]) expect((await app.call({ op: "done", task, message, evidence })).isError).toBeUndefined();
  expect((await kata(["show", parent, "--json"])).issue.status).toBe("closed");
});

test("the inferred project keeps the repo's case", async () => {
  const result = await host({ cwd: repo("MixedCaseRepo") }).call({ op: "init", items: ["Case step"] });
  expect(result.details.kata.parent).toMatch(/^MixedCaseRepo#/);
});

test("a folder without git uses its basename", async () => {
  const dir = path.join(scratch, "plainfolder"); mkdirSync(dir);
  const app = host({ cwd: dir });
  const result = await app.call({ op: "init", items: ["Only step"] });
  expect(result.details.kata.parent).toMatch(/^plainfolder#/);
});

test("KATA_DEFAULT_PROJECT collects the issues with a repo label and registers nothing", async () => {
  process.env.KATA_DEFAULT_PROJECT = "takeover-home";
  const dir = repo("Label.Repo_X");
  const before = await projects();
  const app = host({ cwd: dir });
  const result = await app.call({ op: "init", items: ["Labeled step", "Second step"] });
  expect(result.isError).toBeUndefined();
  expect(result.details.kata.parent).toMatch(/^takeover-home#/);
  expect(await projects()).toEqual(before);
  const mine = (await issues("takeover-home")).filter((i: any) => ["Labeled step", "Second step"].includes(i.title) || i.short_id === result.details.kata.parent.split("#")[1]);
  expect(mine).toHaveLength(3);
  for (const issue of mine) expect((issue.labels ?? []).map((l: any) => typeof l === "string" ? l : l.label)).toContain("label.repo_x");
  expect((await app.call({ op: "view" })).details.kata.parent).toBe(result.details.kata.parent);
});

test("an initialized repo keeps its own project and gets no repo label", async () => {
  process.env.KATA_DEFAULT_PROJECT = "takeover-home";
  const dir = repo("initrepo");
  expect((await run(["init", "--project", "takeinit"], dir)).code).toBe(0);
  const app = host({ cwd: dir });
  const result = await app.call({ op: "init", items: ["Own project step"] });
  expect(result.details.kata.parent).toMatch(/^takeinit#/);
  const labels = (await issues("takeinit")).flatMap((i: any) => (i.labels ?? []).map((l: any) => typeof l === "string" ? l : l.label));
  expect(labels).not.toContain("initrepo");
});

test("a session that never plans leaves no issue and no project; the first call makes one parent", async () => {
  const dir = repo("lazyrepo");
  const app = host({ cwd: dir });
  await app.event("session_start"); await app.event("before_agent_start", { systemPrompt: [""] });
  expect((await app.call({ op: "view" })).content[0].text).toContain("No todo plan");
  await app.event("session_stop", { messages: [] }); await app.event("session_shutdown");
  expect(await projects()).not.toContain("lazyrepo");
  await app.call({ op: "init", items: ["One"] });
  await app.call({ op: "append", items: ["Two"] });
  await app.call({ op: "init", items: ["One", "Two", "Three"] });
  const all = await issues("lazyrepo");
  expect(all.filter((i: any) => i.metadata?.["omp.auto_parent"] === true)).toHaveLength(1);
  expect(all).toHaveLength(4);
});

test("todo results leave omp's native todo tracker nothing to track", async () => {
  const app = host({ cwd: repo("nativerepo") });
  for (const result of [await app.call({ op: "init", items: ["A native check"] }), await app.call({ op: "view" })]) {
    expect(result.details.phases).toBeUndefined();
    expect(result.details.kata.phases[0].tasks[0].content).toBe("A native check");
  }
});

test("an unreachable Kata keeps a visible local plan and replays it when Kata returns", async () => {
  const dir = repo("outagerepo");
  let down = true;
  const app = host({ cwd: dir, before: () => down ? daemonUnavailable() : undefined });
  await app.event("session_start");
  const first = await app.call({ op: "init", items: ["Written offline", "Also offline"] });
  expect(first.isError).toBeUndefined();
  expect(first.content[0].text).toContain("Session-local");
  expect(first.content[0].text).toContain("Kata is unreachable");
  await app.call({ op: "done", task: "Written offline", message, evidence });
  await app.call({ op: "view" });
  expect(app.notices.filter(n => n[1] === "warning")).toHaveLength(1);
  expect(await projects()).not.toContain("outagerepo");
  down = false;
  const back = await app.call({ op: "view" });
  expect(back.content[0].text).not.toContain("Session-local");
  const parent = back.details.kata.parent as string;
  expect(parent).toMatch(/^outagerepo#/);
  const shown = await kata(["show", parent, "--json"]);
  expect(shown.children.map((c: any) => c.title).sort()).toEqual(["Also offline", "Written offline"]);
  const done = shown.children.find((c: any) => c.title === "Written offline");
  expect(done.status).toBe("closed");
  expect(back.content[0].text).toContain("1/2 done");
  expect(app.notices.filter(n => n[1] === "warning")).toHaveLength(1);
});

test("a replay that fails partway keeps the local plan and finishes on the next call", async () => {
  let down = true, flaky = false;
  const app = host({ cwd: repo("flakyreplay"), before: (a: string[]) => down ? daemonUnavailable()
    : flaky && a[0] === "create" && a.includes("--parent") ? { code: 1, stdout: "", stderr: "storage hiccup" } : undefined });
  await app.call({ op: "init", items: ["Kept one", "Kept two"] });
  down = false; flaky = true;
  const failed = await app.call({ op: "append", items: ["Kept three"] });
  expect(failed.isError).toBe(true);
  expect(failed.content[0].text).toContain("could not be replayed");
  flaky = false;
  const ok = await app.call({ op: "view" });
  expect(ok.content[0].text).not.toContain("could not be replayed");
  expect(ok.isError).toBeUndefined();
  const shown = await kata(["show", ok.details.kata.parent, "--json"]);
  expect(shown.children.map((c: any) => c.title).sort()).toEqual(["Kept one", "Kept two"]);
  expect((await app.call({ op: "view" })).content[0].text).not.toContain("Session-local");
});

test("a resumed session replays a local plan even after a partly failed replay", async () => {
  let down = true, flaky = false;
  const dir = repo("resumereplay");
  const before = (a: string[]) => down ? daemonUnavailable()
    : flaky && a[0] === "create" && a.includes("--parent") ? { code: 1, stdout: "", stderr: "storage hiccup" } : undefined;
  const first = host({ cwd: dir, before });
  await first.call({ op: "init", items: ["Survives one", "Survives two"] });
  down = false; flaky = true;
  expect((await first.call({ op: "append", items: ["Survives three"] })).isError).toBe(true);
  flaky = false;
  const resumed = host({ cwd: dir, before });
  resumed.entries.push(...JSON.parse(JSON.stringify(first.entries)));
  Object.assign(resumed.ctx.sessionManager, { getSessionId: () => first.sid });
  await resumed.event("session_start");
  const view = await resumed.call({ op: "view" });
  const shown = await kata(["show", view.details.kata.parent, "--json"]);
  expect(shown.children.map((c: any) => c.title).sort()).toEqual(["Survives one", "Survives two"]);
});

test("a daemon that dies after a client-side refusal still yields a local plan", async () => {
  const dir = path.join(scratch, "nogit-outage"); mkdirSync(dir);
  const app = host({ cwd: dir, before: (a: string[]) => a[0] === "projects" || a[0] === "create" ? daemonUnavailable() : undefined });
  const result = await app.call({ op: "init", items: ["Offline in a plain folder"] });
  expect(result.isError).toBeUndefined();
  expect(result.content[0].text).toContain("Session-local");
  expect(app.notices.filter(n => n[1] === "warning")).toHaveLength(1);
});

test("a missing executable is an outage too", async () => {
  const app = host({ cwd: repo("noexec"), before: () => { throw missingExecutable(); } });
  const first = await app.call({ op: "init", items: ["No binary"] });
  expect(first.content[0].text).toContain("Session-local");
  expect(app.notices.filter(n => n[1] === "warning")).toHaveLength(1);
});

test("project_not_initialized never produces a local plan", async () => {
  const app = host({ cwd: repo("neverlocal") });
  expect((await app.call({ op: "init", items: ["Hosted"] })).content[0].text).not.toMatch(/Session-local/);
});

test("the contract is injected once even when something already put it in the prompt", async () => {
  const app = host({ cwd: repo("contractrepo") });
  await app.event("session_start");
  const first = await app.event("before_agent_start", { systemPrompt: ["base"] });
  const contract = /<kata_contract>\n([\s\S]*?)\n<\/kata_contract>/.exec(first.systemPrompt.join("\n"))![1];
  const again = await app.event("before_agent_start", { systemPrompt: ["base", contract] });
  // Nothing to add: the prompt already carries the contract exactly once.
  expect(again).toBeUndefined();
});
