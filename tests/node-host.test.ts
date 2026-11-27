import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { until } from "./kata-fixture";

test("an events follower does not keep its Node host alive", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kata-node-host-"));
  const marker = path.join(dir, "started"), bundle = path.join(dir, "node-host.mjs");
  let host: ReturnType<typeof spawn> | undefined;
  let exited: Promise<number | null> | undefined;
  try {
    const result = await Bun.build({ entrypoints: [path.resolve("core/node-host.ts")], target: "node" });
    expect(result.success).toBe(true);
    writeFileSync(bundle, await result.outputs[0].text());
    const childScript = `const fs = require('node:fs'); fs.writeFileSync(process.argv[1] + '.tmp', String(process.pid)); fs.renameSync(process.argv[1] + '.tmp', process.argv[1]); setTimeout(() => {}, 30000)`;
    const hostScript = `import { spawnEvents } from ${JSON.stringify(pathToFileURL(bundle).href)};
      import { existsSync } from 'node:fs';
      spawnEvents([process.execPath, '-e', ${JSON.stringify(childScript)}, ${JSON.stringify(marker)}], ${JSON.stringify(dir)});
      const wait = setInterval(() => { if (existsSync(${JSON.stringify(marker)})) clearInterval(wait); }, 10);`;
    host = spawn(Bun.which("node")!, ["--input-type=module", "-e", hostScript], { detached: true, stdio: "ignore" });
    exited = new Promise<number | null>((resolve, reject) => { host!.once("error", reject); host!.once("exit", resolve); });
    expect(await until(() => existsSync(marker), 8000)).toBe(true);
    const childPid = Number(readFileSync(marker, "utf8"));
    expect(childPid).toBeGreaterThan(0);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const code = await Promise.race([exited, new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), 5000); })]);
    clearTimeout(timer);
    expect(code).toBe(0);
    expect(() => process.kill(childPid, 0)).not.toThrow();
  } finally {
    if (host?.pid) { try { process.kill(-host.pid, "SIGKILL"); } catch (error: any) { if (error.code !== "ESRCH") throw error; } }
    if (exited) await exited.catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);
