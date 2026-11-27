import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import opencode from "../plugins/opencode/kata";
import { writeIdentity } from "../plugins/oh-my-pi/shim";
import { realKata } from "./kata-fixture";
import { openCodeHost } from "./opencode-host";

const store = realKata({ prefix: "opencode-inherited-shim", author: "actor-a", project: "omptest" });

test("OpenCode activation prevents inherited omp identity from overriding its own Kata calls", async () => {
  const { cwd, scratch, binary, env, events } = store;
  const dir = join(scratch, "shim"), bin = join(dir, "bin"); mkdirSync(bin, { recursive: true });
  copyFileSync(new URL("../plugins/oh-my-pi/bin/kata", import.meta.url), join(bin, "kata")); chmodSync(join(bin, "kata"), 0o700);
  writeIdentity({ dir, real: binary }, "omp-parent", { KATA_AUTHOR: "mallory", KATA_TEAMMATE: "outer" });
  const keys = ["PATH", "KATA_HOME", "KATA_AUTHOR", "KATA_TEAMMATE", "KATA_OMP_SHIM_DIR", "KATA_OMP_SHIM_REAL", "KATA_OMP_SHIM_PID", "PI_SESSION_ID"];
  const saved = keys.map(key => [key, process.env[key]] as const);
  let host: Awaited<ReturnType<typeof openCodeHost>> | undefined;
  try {
    Object.assign(process.env, { PATH: `${bin}:/usr/bin:/bin`, KATA_HOME: env.KATA_HOME, KATA_AUTHOR: "actor-a", KATA_OMP_SHIM_DIR: dir, KATA_OMP_SHIM_REAL: binary, KATA_OMP_SHIM_PID: "1", PI_SESSION_ID: "omp-parent" });
    delete process.env.KATA_TEAMMATE;
    host = await openCodeHost({ plugin: opencode, directory: cwd, options: { author: "actor-a" } });
    const session = host.createSession({ id: "oc-inherited-shim" });
    const result = await host.callTool(session.id, "todowrite", { todos: [{ content: "Synthetic task", status: "pending" }] });
    expect(result.status, result.text).toBe("completed");
    const created = (await events()).filter((event: any) => event.type === "issue.created");
    expect(created.length).toBeGreaterThan(0);
    expect(created.every((event: any) => event.actor === "actor-a")).toBe(true);
  } finally {
    await host?.shutdown();
    for (const [key, value] of saved) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
}, 60000);
