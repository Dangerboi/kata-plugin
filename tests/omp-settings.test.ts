import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { realKata } from "./kata-fixture";
import { ompHost, setPluginSettings } from "./omp-host";
import { loadPluginSettings, resolveSettings } from "../plugins/oh-my-pi/settings";

const store = realKata({ prefix: "omp-settings", author: "actor-a", project: "omptest" });
const { cwd, run } = store;
test("stored refGuard off permits a write containing a known plan ref", async () => {
  setPluginSettings(() => ({ refGuard: "off" }));
  try {
    const app = ompHost({ cwd, run: args => run(args), sid: "settings-guard" });
    await app.event("session_start");
    const ref = await app.init(["Guarded settings task"]);
    expect(await app.event("tool_call", { toolName: "write", input: { path: `${cwd}/note.ts`, content: `// ${ref}` } })).toBeUndefined();
  } finally { setPluginSettings(() => ({})); }
});

test("a padded legacy guard variable overrides a stored block setting", async () => {
  setPluginSettings(() => ({ refGuard: "block" }));
  process.env.KATA_REF_GUARD = " OFF ";
  try {
    const app = ompHost({ cwd, run: args => run(args), sid: "settings-padded" });
    await app.event("session_start");
    const ref = await app.init(["Padded guard task"]);
    expect(await app.event("tool_call", { toolName: "write", input: { path: `${cwd}/padded.ts`, content: ref } })).toBeUndefined();
    expect(resolveSettings({ refGuard: "block" }, { KATA_REF_GUARD: "false" }).env("KATA_REF_GUARD")).toBe("block");
  } finally { delete process.env.KATA_REF_GUARD; setPluginSettings(() => ({})); }
});


test("resolution preserves text and falls through unreadable values", () => {
  const stored = { defaultProject: " Mixed Project ", liveInbox: "false", refGuard: "off" };
  const value = resolveSettings(stored, { KATA_OMP_LIVE_INBOX: "bad", KATA_REF_GUARD: "on" });
  expect(value.liveInbox).toBe(false);
  expect(value.env("KATA_DEFAULT_PROJECT")).toBe(" Mixed Project ");
  expect(value.env("KATA_REF_GUARD")).toBe("off");
  expect(resolveSettings(stored, { KATA_DEFAULT_PROJECT: "", KATA_REF_GUARD: " OFF ", KATA_OMP_LIVE_INBOX: " ON " }).env("KATA_DEFAULT_PROJECT")).toBe("");
  expect(resolveSettings(stored, { KATA_REF_GUARD: " OFF " }).env("KATA_REF_GUARD")).toBe("off");
  expect(resolveSettings(stored, { KATA_OMP_LIVE_INBOX: " ON " }).liveInbox).toBe(true);
  for (const guard of ["1", "true", "on", "yes"]) expect(resolveSettings({ refGuard: "off" }, { KATA_REF_GUARD: guard }).env("KATA_REF_GUARD")).toBe("off");
  for (const [input, expected] of [["0",false],["false",false],["off",false],["1",true],["true",true],["on",true]] as const) expect(resolveSettings({ liveInbox: input }, {}).liveInbox).toBe(expected);
});

test("loader ignores malformed results and errors", async () => {
  try {
    for (const result of [null, "invalid", [], undefined]) { setPluginSettings(() => result); expect(await loadPluginSettings(cwd)).toEqual({}); }
    setPluginSettings(() => { throw new Error("unavailable"); });
    expect(await loadPluginSettings(cwd)).toEqual({});
  } finally { setPluginSettings(() => ({})); }
});

test("switch and branch reload settings, while tree keeps the current values", async () => {
  let guard = "off", reads = 0;
  setPluginSettings(() => { reads++; return { refGuard: guard }; });
  try {
    const app = ompHost({ cwd, run: args => run(args), sid: "settings-switch" });
    await app.event("session_start");
    const ref = await app.init(["Settings refresh task"]);
    const write = () => app.event("tool_call", { toolName: "write", input: { path: `${cwd}/note.ts`, content: ref } });
    expect(await write()).toBeUndefined();
    guard = "block";
    await app.event("session_tree");
    expect(reads).toBe(1);
    expect(await write()).toBeUndefined();
    await app.event("session_branch", { reason: "fork" });
    expect(await write()).toMatchObject({ block: true });
    guard = "off";
    await app.switchSession("settings-next");
    const next = await app.init(["Settings next task"]);
    expect(await app.event("tool_call", { toolName: "write", input: { path: `${cwd}/note.ts`, content: next } })).toBeUndefined();
    expect(reads).toBe(3);
  } finally { setPluginSettings(() => ({})); }
});

test("stored default project collects plans from an unregistered folder", async () => {
  const folder = path.join(store.scratch, "unregistered-settings-folder");
  mkdirSync(folder, { recursive: true });
  setPluginSettings(() => ({ defaultProject: "omptest" }));
  try {
    const app = ompHost({ cwd: folder, sid: "settings-project", run: (args, opts) => run(args, opts.cwd, opts.timeout) });
    await app.event("session_start");
    await app.call({ op: "init", items: ["Stored project item"] });
    const found = await store.kata(["list", "--project", "omptest", "--status", "all", "--json"]);
    expect(found.issues.some((issue: any) => issue.title === "Stored project item")).toBe(true);
    await app.event("session_shutdown");
  } finally { setPluginSettings(() => ({})); }
});
