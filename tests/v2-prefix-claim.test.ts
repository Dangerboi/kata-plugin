import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { v2Fixture } from "./v2-fixture";

const { scratch, cwd, kata, show, issue, unique, host } = v2Fixture();

test.each(["env -C", "kata --workspace"])("a claim using %s with a home folder is adopted", async prefix => {
  const name = `kata-claim-${unique()}`, other = path.join(process.env.HOME!, name);
  mkdirSync(other, { recursive: true });
  try {
    await kata(["init", "--project", "v2other", "--json"], other);
    const target = await issue("Claimed issue", { workspace: other });
    const app = host(); await app.event("session_start");
    await app.init(["Original task"]);
    await kata(["claim", target, "--json"], other);
    const command = prefix === "env -C" ? `env -C ~/${name} kata claim ${target}` : `kata --workspace ~/${name} claim ${target}`;
    await app.event("tool_result", { toolName: "bash", input: { command, cwd }, isError: false, details: { exitCode: 0 } });
    expect((await app.call({ op: "append", items: ["Target-project task"] })).isError).toBeUndefined();
    const view = await kata(["show", target, "--json"], other);
    expect((view.children ?? []).map((child: any) => child.title)).toContain("Target-project task");
    await app.event("session_shutdown");
  } finally { rmSync(other, { recursive: true, force: true }); }
});

test("a claim resolves its workspace after ordered env directory changes", async () => {
  const other = path.join(scratch, `other-${unique()}`), nested = path.join(other, "nested");
  mkdirSync(nested, { recursive: true });
  await kata(["init", "--project", "v2other", "--json"], other);
  const target = await issue("Claimed issue", { workspace: other });
  const app = host(); await app.event("session_start");
  const original = await app.init(["Original task"]);
  await kata(["claim", target, "--json"], other);
  await app.event("tool_result", { toolName: "bash", input: { command: `env -C '${other}' env --chdir=nested kata --workspace .. claim ${target}`, cwd }, isError: false, details: { exitCode: 0 } });
  expect((await app.call({ op: "append", items: ["Target-project task"] })).isError).toBeUndefined();
  const view = await kata(["show", target, "--json"], other);
  expect((view.children ?? []).map((child: any) => child.title)).toContain("Target-project task");
  expect((await show(original)).issue.status).toBe("open");
  await app.event("session_shutdown");
});
