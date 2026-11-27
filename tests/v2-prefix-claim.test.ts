import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { v2Fixture } from "./v2-fixture";

const { scratch, cwd, kata, show, issue, unique, host } = v2Fixture();

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
