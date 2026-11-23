import { beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { EVIDENCE as evidence, MESSAGE as message, realKata, unique } from "./kata-fixture";
import { daemonUnavailable, missingExecutable } from "./kata-errors";
import { ompHost } from "./omp-host";

// Where omp's native todo plans when the folder is no Kata workspace (an inferred project, KATA_DEFAULT_PROJECT, a plain folder), one
// automatic parent per session, the local plan and its replay while Kata is unreachable, and the contract in the system prompt.
const { scratch, run, text, kata, show } = realKata({ prefix: "takeover", author: "v2-builder", adopt: true });
const projects = async () => (await kata(["projects", "list", "--json"])).projects.map((p: any) => p.name).sort();
const issues = async (project: string) => (await kata(["list", "--project", project, "--status", "all", "--limit", "100", "--json"])).issues;
// The session's automatic parent in `project`, read from Kata (the folders here are not workspaces `kata list` could resolve itself).
const parentOf = async (project: string, app: { sid?: string }) =>
  (await kata(["list", "--project", project, "--status", "all", "--meta", `omp.session_id=${app.sid}`, "--label", "omp-session", "--limit", "5", "--json"])).issues[0]?.qualified_id as string;
// The agent's close of `task` in Kata, then omp's native done.
async function finish(app: { call(params: object): Promise<{ isError?: boolean }> }, parent: string, task: string) {
  const project = parent.split("#")[0];
  const child = (await show(parent)).children.find((c: any) => c.title === task);
  await kata(["close", `${project}#${child.short_id}`, "--done", "--message", message, ...evidence.flatMap(e => ["--evidence", e]), "--json"]);
  return app.call({ op: "done", task });
}
function repo(name: string, remote = `https://github.com/someone/${name}.git`) {
  const dir = path.join(scratch, `r${unique()}`, name);
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  git("init", "-q"); if (remote) git("remote", "add", "origin", remote);
  return dir;
}
const status = (dir: string) => execFileSync("git", ["status", "--porcelain", "--ignored"], { cwd: dir }).toString();
function host(options: any = {}) {
  const sid = `takeover-${unique()}`;
  return ompHost({ run: (args, opts) => run(args, opts.cwd, opts.timeout), cwd: options.cwd, sid, sessionFile: `${scratch}/${sid}.jsonl`, before: options.before, callId: "takeover" });
}
const warnings = (app: { notices: any[][] }) => app.notices.filter(n => n[1] === "warning");
const tasks = (...contents: string[]) => [{ name: "Tasks", tasks: contents.map((content, i) => ({ content, status: i === 0 ? "in_progress" as const : "pending" as const })) }];
beforeAll(async () => { await text(["projects", "create", "takeover-home"]); });

test("an unregistered git repo registers its inferred project and plans there without touching the repo", async () => {
  const dir = repo("takeoverrepo"), before = status(dir);
  const app = host({ cwd: dir }); await app.event("session_start");
  const result = await app.call({ op: "init", items: ["Plan the change", "Verify the change"] });
  expect(result.isError).toBeUndefined();
  expect(await projects()).toContain("takeoverrepo");
  const parent = await parentOf("takeoverrepo", app);
  expect(parent).toMatch(/^takeoverrepo#/);
  const shown = await show(parent);
  expect(shown.children.map((c: any) => c.title).sort()).toEqual(["Plan the change", "Verify the change"]);
  expect(shown.issue.metadata["omp.auto_parent"]).toBe(true);
  expect(status(dir)).toBe(before);
  expect(existsSync(path.join(dir, ".kata.toml"))).toBe(false);
  for (const task of ["Plan the change", "Verify the change"]) expect((await finish(app, parent, task)).isError).toBeUndefined();
  await app.event("session_shutdown");
  expect((await show(parent)).issue.status).toBe("closed");
});

test("the inferred project keeps the repo's case", async () => {
  const app = host({ cwd: repo("MixedCaseRepo") });
  await app.event("session_start");
  await app.call({ op: "init", items: ["Case step"] });
  expect(await parentOf("MixedCaseRepo", app)).toMatch(/^MixedCaseRepo#/);
});

test("a folder without git uses its basename", async () => {
  const dir = path.join(scratch, "plainfolder"); mkdirSync(dir);
  const app = host({ cwd: dir });
  await app.event("session_start");
  await app.call({ op: "init", items: ["Only step"] });
  expect(await parentOf("plainfolder", app)).toMatch(/^plainfolder#/);
});

test("KATA_DEFAULT_PROJECT collects the issues with a repo label and registers nothing", async () => {
  process.env.KATA_DEFAULT_PROJECT = "takeover-home";
  const dir = repo("Label.Repo_X");
  const before = await projects();
  const app = host({ cwd: dir });
  await app.event("session_start");
  const result = await app.call({ op: "init", items: ["Labeled step", "Second step"] });
  expect(result.isError).toBeUndefined();
  const parent = await parentOf("takeover-home", app);
  expect(parent).toMatch(/^takeover-home#/);
  expect(await projects()).toEqual(before);
  const mine = (await issues("takeover-home")).filter((i: any) => ["Labeled step", "Second step"].includes(i.title) || i.short_id === parent.split("#")[1]);
  expect(mine).toHaveLength(3);
  for (const issue of mine) expect((issue.labels ?? []).map((l: any) => typeof l === "string" ? l : l.label)).toContain("label.repo_x");
});

test("an initialized repo keeps its own project and gets no repo label", async () => {
  process.env.KATA_DEFAULT_PROJECT = "takeover-home";
  const dir = repo("initrepo");
  expect((await run(["init", "--project", "takeinit"], dir)).code).toBe(0);
  const app = host({ cwd: dir });
  await app.event("session_start");
  await app.call({ op: "init", items: ["Own project step"] });
  expect(await parentOf("takeinit", app)).toMatch(/^takeinit#/);
  const labels = (await issues("takeinit")).flatMap((i: any) => (i.labels ?? []).map((l: any) => typeof l === "string" ? l : l.label));
  expect(labels).not.toContain("initrepo");
});

test("a session that never plans leaves no issue and no project; its first list makes one parent", async () => {
  const dir = repo("lazyrepo");
  const app = host({ cwd: dir });
  await app.event("session_start"); await app.event("before_agent_start", { systemPrompt: [""] });
  await app.event("session_stop", { messages: [] }); await app.event("session_shutdown");
  expect(await projects()).not.toContain("lazyrepo");
  await app.call({ op: "init", items: ["One"] });
  await app.call({ op: "append", items: ["Two"] });
  await app.call({ op: "init", items: ["One", "Two", "Three"] });
  const all = await issues("lazyrepo");
  expect(all.filter((i: any) => i.metadata?.["omp.auto_parent"] === true)).toHaveLength(1);
  expect(all).toHaveLength(4);
});

test("an unreachable Kata keeps omp's list and a local plan, and replays the plan when Kata returns", async () => {
  const dir = repo("outagerepo");
  let down = true;
  const app = host({ cwd: dir, before: () => down ? daemonUnavailable() : undefined });
  await app.event("session_start");
  const first = await app.call({ op: "init", items: ["Written offline", "Also offline"] });
  expect(first.isError).toBeUndefined();
  await app.call({ op: "done", task: "Written offline" });
  expect(app.list()[0].tasks.map(t => t.status)).toEqual(["completed", "in_progress"]);
  expect(warnings(app)).toHaveLength(1);
  expect(warnings(app)[0][0]).toContain("Kata is unreachable");
  expect(await projects()).not.toContain("outagerepo");
  down = false;
  // The next change of omp's list reaches Kata and brings the local plan with it.
  await app.call({ op: "append", items: ["Online again"] });
  const parent = await parentOf("outagerepo", app);
  expect(parent).toMatch(/^outagerepo#/);
  const shown = await show(parent);
  expect(shown.children.map((c: any) => c.title).sort()).toEqual(["Also offline", "Online again", "Written offline"]);
  // Completed while Kata was away, with no evidence: the replay cannot close it.
  expect(shown.children.find((c: any) => c.title === "Written offline").status).toBe("open");
  expect(warnings(app)).toHaveLength(1);
});

test("a replay that fails partway keeps the local plan and finishes on the next change", async () => {
  let down = true, flaky = false;
  const app = host({ cwd: repo("flakyreplay"), before: (a: string[]) => down ? daemonUnavailable()
    : flaky && a[0] === "create" && a.includes("--parent") ? { code: 1, stdout: "", stderr: "storage hiccup" } : undefined });
  await app.event("session_start");
  await app.call({ op: "init", items: ["Kept one", "Kept two"] });
  down = false; flaky = true;
  expect((await app.call({ op: "append", items: ["Kept three"] })).isError).toBeUndefined();
  expect(app.notices.some(n => /could not be replayed/.test(String(n[0])))).toBe(true);
  flaky = false;
  await app.call({ op: "start", task: "Kept two" });
  const shown = await show(await parentOf("flakyreplay", app));
  // omp's list is the truth: what the failed change left out comes with the next one.
  expect(shown.children.map((c: any) => c.title).sort()).toEqual(["Kept one", "Kept three", "Kept two"]);
});

test("a resumed session replays a local plan even after a partly failed replay", async () => {
  let down = true, flaky = false;
  const dir = repo("resumereplay");
  const before = (a: string[]) => down ? daemonUnavailable()
    : flaky && a[0] === "create" && a.includes("--parent") ? { code: 1, stdout: "", stderr: "storage hiccup" } : undefined;
  const first = host({ cwd: dir, before });
  await first.event("session_start");
  await first.call({ op: "init", items: ["Survives one", "Survives two"] });
  down = false; flaky = true;
  await first.call({ op: "append", items: ["Survives three"] });
  expect(first.notices.some(n => /could not be replayed/.test(String(n[0])))).toBe(true);
  flaky = false;
  const resumed = host({ cwd: dir, before });
  resumed.entries.push(...JSON.parse(JSON.stringify(first.entries)));
  Object.assign(resumed.ctx.sessionManager, { getSessionId: () => first.sid });
  await resumed.event("session_start");
  // The resumed session's list holds what the local plan held; its first change reaches Kata and replays the plan.
  await resumed.edit(tasks("Survives one", "Survives two"));
  const shown = await show(await parentOf("resumereplay", first));
  expect(shown.children.map((c: any) => c.title).sort()).toEqual(["Survives one", "Survives two"]);
});

test("a daemon that dies after a client-side refusal still yields a local plan", async () => {
  const dir = path.join(scratch, "nogit-outage"); mkdirSync(dir);
  const app = host({ cwd: dir, before: (a: string[]) => a[0] === "projects" || a[0] === "create" ? daemonUnavailable() : undefined });
  await app.event("session_start");
  const result = await app.call({ op: "init", items: ["Offline in a plain folder"] });
  expect(result.isError).toBeUndefined();
  expect(app.list()[0].tasks.map(t => t.content)).toEqual(["Offline in a plain folder"]);
  expect(warnings(app)).toHaveLength(1);
  expect(warnings(app)[0][0]).toContain("Kata is unreachable");
});

test("a missing executable is an outage too", async () => {
  const app = host({ cwd: repo("noexec"), before: () => { throw missingExecutable(); } });
  await app.event("session_start");
  await app.call({ op: "init", items: ["No binary"] });
  expect(app.list()[0].tasks.map(t => t.content)).toEqual(["No binary"]);
  expect(warnings(app)).toHaveLength(1);
});

test("the contract is injected once even when something already put it in the prompt", async () => {
  const dir = repo("contractrepo");
  expect((await run(["init", "--project", "contractrepo"], dir)).code).toBe(0);
  const app = host({ cwd: dir });
  await app.event("session_start");
  const first = await app.event("before_agent_start", { systemPrompt: ["base"] });
  const contract = /<kata_contract>\n([\s\S]*?)\n<\/kata_contract>/.exec(first.systemPrompt.join("\n"))![1];
  const again = await app.event("before_agent_start", { systemPrompt: ["base", contract] });
  // The contract is not added a second time; the todo rules, which the prompt lacks, are.
  const prompt = (again?.systemPrompt ?? ["base", contract]).join("\n");
  expect(prompt.split(contract)).toHaveLength(2);
  expect(prompt).not.toContain("<kata_contract>");
  expect(prompt.split("<kata_todo>")).toHaveLength(2);
});

test("a folder without .kata.toml gets no contract section at all", async () => {
  const app = host({ cwd: repo("nocontractrepo") });
  await app.event("session_start");
  await app.contractReady;
  const result = await app.event("before_agent_start", { systemPrompt: ["base"] });
  expect((result?.systemPrompt ?? ["base"]).join("\n")).not.toContain("kata_contract");
});
