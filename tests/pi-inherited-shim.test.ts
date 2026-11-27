import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execCommand } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/exec.js";
import piKata from "../plugins/pi/kata";
import { writeIdentity } from "../plugins/oh-my-pi/shim";
import { fakeHost, realKata } from "./kata-fixture";

const store = realKata({ prefix: "pi-inherited-shim", author: "actor-a", project: "pitest" });

test("native Pi activation keeps its own identity for internal Kata calls", async () => {
  const { cwd, scratch, binary, env, run, events } = store;
  const dir = join(scratch, "shim"), bin = join(dir, "bin"); mkdirSync(bin, { recursive: true });
  copyFileSync(new URL("../plugins/oh-my-pi/bin/kata", import.meta.url), join(bin, "kata")); chmodSync(join(bin, "kata"), 0o700);
  writeIdentity({ dir, real: binary }, "omp-parent", { KATA_AUTHOR: "mallory", KATA_TEAMMATE: "outer", KATA_TRANSCRIPT_AGENT: "omp", KATA_TRANSCRIPT_SESSION_ID: "omp-parent" });
  const keys = ["PATH", "KATA_HOME", "KATA_AUTHOR", "KATA_TEAMMATE", "KATA_OMP_SHIM_DIR", "KATA_OMP_SHIM_REAL", "KATA_OMP_SHIM_PID", "PI_SESSION_ID", "KATA_PI_EXECUTABLE", "KATA_OMP_EXECUTABLE", "KATA_TRANSCRIPT_AGENT", "KATA_TRANSCRIPT_SESSION_ID", "KATA_CLOSE_TRANSCRIPT_ENABLED"];
  const saved = keys.map(key => [key, process.env[key]] as const);
  const make = (sid = "pi-shim-session") => {
    const app = fakeHost({ cwd, sid, run: args => run(args), exec: (file, args, options) => execCommand(file, args, options.cwd, options) });
    const api: any = { ...app.api, registerCommand() {}, getSessionName() {} };
    return { app, api };
  };
  try {
    Object.assign(process.env, { PATH: `${bin}:/usr/bin:/bin`, KATA_HOME: env.KATA_HOME, KATA_AUTHOR: "actor-a", KATA_TEAMMATE: "child", KATA_OMP_SHIM_DIR: dir, KATA_OMP_SHIM_REAL: binary, KATA_OMP_SHIM_PID: "1", PI_SESSION_ID: "omp-parent" });
    delete process.env.KATA_PI_EXECUTABLE; delete process.env.KATA_OMP_EXECUTABLE;
    const guarded = make(); await piKata({ ...guarded.api, zod: {} } as any); expect(process.env.PI_SESSION_ID).toBe("omp-parent");
    delete process.env.KATA_OMP_SHIM_DIR;
    const ordinary = make(); await piKata(ordinary.api); expect(process.env.PI_SESSION_ID).toBe("omp-parent");
    process.env.KATA_OMP_SHIM_DIR = dir; process.env.KATA_OMP_SHIM_PID = String(process.pid);
    const same = make(); await piKata(same.api); expect(process.env.PI_SESSION_ID).toBe("omp-parent");
    for (const pid of ["1", undefined]) {
      if (pid === undefined) delete process.env.KATA_OMP_SHIM_PID; else process.env.KATA_OMP_SHIM_PID = pid;
      process.env.PI_SESSION_ID = "omp-parent";
      const sid = `pi-shim-${pid ?? "missing"}`;
      const { app, api } = make(sid); await piKata(api);
      await app.event("session_start");
      const result = await app.call({ op: "init", items: [`Synthetic task ${pid ?? "missing"}`] });
      const created = (await events()).filter((event: any) => event.type === "issue.created");
      expect(created.length).toBeGreaterThan(0);
      expect(created.every((event: any) => event.actor === "actor-a")).toBe(true);
      if (result.isError) throw new Error(`init failed: ${JSON.stringify(result)}`);
      expect(process.env.PI_SESSION_ID).toBeUndefined();
      expect(process.env.KATA_TRANSCRIPT_AGENT).toBe("pi"); expect(process.env.KATA_TRANSCRIPT_SESSION_ID).toBe(sid);
    }
    const created = (await events()).filter((event: any) => event.type === "issue.created");
    expect(created.length).toBeGreaterThan(0);
    expect(created.every((event: any) => event.actor === "actor-a")).toBe(true);
  } finally { for (const [key, value] of saved) value === undefined ? delete process.env[key] : process.env[key] = value; }
}, 60000);
