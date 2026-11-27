import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execOf } from "../plugins/claude-code/hooks/host";
import { writeIdentity } from "../plugins/oh-my-pi/shim";
import { claudeHost } from "./claude-fixture";

test("Claude exec overrides the inherited selector and forwards the close transcript", async () => {
  const root = mkdtempSync(join(tmpdir(), "claude-shim-"));
  const dir = join(root, "shim"), bin = join(dir, "bin"), real = join(root, "real"); mkdirSync(bin, { recursive: true });
  copyFileSync(new URL("../plugins/oh-my-pi/bin/kata", import.meta.url), join(bin, "kata")); chmodSync(join(bin, "kata"), 0o700);
  writeFileSync(real, '#!/bin/sh\nprintf "%s|%s|%s|%s" "$KATA_AUTHOR" "$KATA_TEAMMATE" "$KATA_TRANSCRIPT_AGENT" "$KATA_TRANSCRIPT_SESSION_ID"\n', { mode: 0o700 });
  writeIdentity({ dir, real }, "omp-parent", { KATA_AUTHOR: "omp-actor", KATA_TEAMMATE: "omp-mate", KATA_TRANSCRIPT_AGENT: "omp", KATA_TRANSCRIPT_SESSION_ID: "omp-session" });
  const keys = ["PATH", "KATA_AUTHOR", "KATA_TEAMMATE", "KATA_TRANSCRIPT_AGENT", "KATA_TRANSCRIPT_SESSION_ID", "KATA_OMP_SHIM_DIR", "KATA_OMP_SHIM_REAL", "PI_SESSION_ID"];
  const saved = keys.map(key => [key, process.env[key]] as const);
  const host = claudeHost({ cwd: root, binary: real });
  try {
    Object.assign(process.env, { PATH: `${bin}:/usr/bin:/bin`, KATA_AUTHOR: "claude-actor", KATA_TEAMMATE: "claude-mate", KATA_TRANSCRIPT_AGENT: "omp", KATA_TRANSCRIPT_SESSION_ID: "prior-session", KATA_OMP_SHIM_DIR: dir, KATA_OMP_SHIM_REAL: real, PI_SESSION_ID: "omp-parent" });
    const parent = keys.map(key => process.env[key]);
    const exec = execOf(host.$, new Map(), () => ({ sessionManager: { getSessionId: () => "claude-session" } }) as any);
    const outputs: string[] = [];
    for (const command of ["show", "close"]) {
      const result = await exec("kata", [command], { cwd: root, timeout: 5000 });
      expect(result.code).toBe(0); outputs.push(result.stdout);
    }
    expect(outputs).toEqual(["claude-actor|claude-mate|omp|prior-session", "claude-actor|claude-mate|claude|claude-session"]);
    expect(keys.map(key => process.env[key])).toEqual(parent);
  } finally {
    host.cancelTimers();
    for (const [key, value] of saved) value === undefined ? delete process.env[key] : process.env[key] = value;
    rmSync(root, { recursive: true, force: true });
  }
});
