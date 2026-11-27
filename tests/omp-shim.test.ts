import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composePrefix, writeIdentity } from "../plugins/oh-my-pi/shim";

test("nested shells and scripts use the selected identity despite an export", () => {
  const dir = mkdtempSync(join(tmpdir(), "kata-shim-test-"));
  try {
    const bin = join(dir, "bin"); mkdirSync(bin);
    copyFileSync(new URL("../plugins/oh-my-pi/bin/kata", import.meta.url), join(bin, "kata")); chmodSync(join(bin, "kata"), 0o700);
    const real = join(dir, "real"); writeFileSync(real, '#!/bin/sh\nprintf "%s|%s|%s" "$KATA_AUTHOR" "${KATA_TEAMMATE-unset}" "$KATA_INBOX_USER"\n', { mode: 0o700 });
    const shim = { dir, real }; writeIdentity(shim, "child", { KATA_AUTHOR: "O'Reilly", KATA_TEAMMATE: "scout", KATA_INBOX_USER: "actor/scout" });
    const script = join(dir, "script"); writeFileSync(script, '#!/bin/sh\nkata\n', { mode: 0o700 });
    const env = { PATH: `${bin}:/usr/bin:/bin`, KATA_OMP_SHIM_DIR: dir, KATA_OMP_SHIM_REAL: real, PI_SESSION_ID: "child", KATA_SHIM_PROBE: "1" };
    const scriptResult = Bun.spawnSync(["/bin/sh", "-c", `export KATA_AUTHOR=evil; ${script}`], { env });
    expect(scriptResult.exitCode).toBe(0); expect(scriptResult.stdout.toString()).toBe("O'Reilly|scout|actor/scout");
    const prefix = composePrefix(shim, "export USER_PREFIX=ok;");
    const result = Bun.spawnSync(["/bin/sh", "-c", `PATH=/usr/bin:/bin; ${prefix} kata`], { env });
    expect(result.exitCode).toBe(0); expect(result.stdout.toString()).toBe("O'Reilly|scout|actor/scout");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a call declaring a foreign transcript agent keeps its own identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "kata-shim-foreign-"));
  try {
    const bin = join(dir, "bin"), real = join(dir, "real"); mkdirSync(bin);
    copyFileSync(new URL("../plugins/oh-my-pi/bin/kata", import.meta.url), join(bin, "kata")); chmodSync(join(bin, "kata"), 0o700);
    writeFileSync(real, '#!/bin/sh\nprintf "%s|%s|%s|%s|%s" "$KATA_AUTHOR" "$KATA_TEAMMATE" "$KATA_INBOX_USER" "$KATA_TRANSCRIPT_AGENT" "$KATA_TRANSCRIPT_SESSION_ID"\n', { mode: 0o700 });
    writeIdentity({ dir, real }, "omp-child", { KATA_AUTHOR: "omp-actor", KATA_TEAMMATE: "omp-mate", KATA_INBOX_USER: "omp/inbox", KATA_TRANSCRIPT_AGENT: "omp", KATA_TRANSCRIPT_SESSION_ID: "omp-session" });
    const env = { PATH: `${bin}:/usr/bin:/bin`, KATA_OMP_SHIM_DIR: dir, KATA_OMP_SHIM_REAL: real, PI_SESSION_ID: "omp-child", KATA_AUTHOR: "foreign-actor", KATA_TEAMMATE: "foreign-mate", KATA_INBOX_USER: "foreign/inbox" };
    const outputs = ["claude", "other-host"].map(agent => {
      const out = Bun.spawnSync(["/bin/sh", "-c", `${composePrefix({ dir, real })} env KATA_TRANSCRIPT_AGENT=${agent} KATA_TRANSCRIPT_SESSION_ID=foreign-session kata close`], { env });
      expect(out.exitCode).toBe(0); return out.stdout.toString();
    });
    expect(outputs).toEqual(["foreign-actor|foreign-mate|foreign/inbox|claude|foreign-session", "foreign-actor|foreign-mate|foreign/inbox|other-host|foreign-session"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("omp transcript identity applies, including after an inherited foreign prefix", () => {
  const dir = mkdtempSync(join(tmpdir(), "kata-shim-prefix-"));
  try {
    const bin = join(dir, "bin"), real = join(dir, "real"); mkdirSync(bin);
    copyFileSync(new URL("../plugins/oh-my-pi/bin/kata", import.meta.url), join(bin, "kata")); chmodSync(join(bin, "kata"), 0o700);
    writeFileSync(real, '#!/bin/sh\nprintf "%s|%s|%s" "$KATA_AUTHOR" "$KATA_TRANSCRIPT_AGENT" "$KATA_TRANSCRIPT_SESSION_ID"\n', { mode: 0o700 });
    const shim = { dir, real };
    writeIdentity(shim, "omp-child", { KATA_AUTHOR: "omp-actor", KATA_TRANSCRIPT_AGENT: "omp", KATA_TRANSCRIPT_SESSION_ID: "omp-session" });
    const base = { PATH: `${bin}:/usr/bin:/bin`, KATA_OMP_SHIM_DIR: dir, KATA_OMP_SHIM_REAL: real, PI_SESSION_ID: "omp-child", KATA_AUTHOR: "evil" };
    const marked = Bun.spawnSync(["/bin/sh", "-c", "export KATA_AUTHOR=evil; bash -c kata"], { env: { ...base, KATA_TRANSCRIPT_AGENT: "omp" } });
    expect(marked.exitCode).toBe(0); expect(marked.stdout.toString()).toBe("omp-actor|omp|omp-session");
    const env = { ...base, KATA_TRANSCRIPT_AGENT: "pi", KATA_TRANSCRIPT_SESSION_ID: "pi-session" };
    const out = Bun.spawnSync(["/bin/sh", "-c", `${composePrefix(shim)} export KATA_AUTHOR=evil; kata`], { env });
    expect(out.exitCode).toBe(0); expect(out.stdout.toString()).toBe("omp-actor|omp|omp-session");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unknown or invalid sessions do not load identity", () => {
  const root = mkdtempSync(join(tmpdir(), "kata-shim-invalid-")), dir = join(root, "shim");
  try {
    const bin = join(dir, "bin"), real = join(root, "real"); mkdirSync(bin, { recursive: true });
    copyFileSync(new URL("../plugins/oh-my-pi/bin/kata", import.meta.url), join(bin, "kata")); chmodSync(join(bin, "kata"), 0o700);
    writeFileSync(real, '#!/bin/sh\nprintf "%s" "$KATA_AUTHOR"\n', { mode: 0o700 });
    writeFileSync(join(root, "good.env"), "export KATA_AUTHOR=decoy\n");
    writeIdentity({ dir, real }, "../bad", { KATA_AUTHOR: "real" });
    expect(existsSync(join(root, "bad.env"))).toBe(false);
    for (const id of ["../good", "unknown"]) {
      const env = { PATH: `${bin}:/usr/bin:/bin`, KATA_OMP_SHIM_DIR: dir, KATA_OMP_SHIM_REAL: real, PI_SESSION_ID: id, KATA_AUTHOR: "original" };
      const result = Bun.spawnSync([join(bin, "kata")], { env });
      expect(result.exitCode).toBe(0); expect(result.stdout.toString()).toBe("original");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("configured executable basename selects each session identity in nested shells and scripts", () => {
  const modulePath = new URL("../plugins/oh-my-pi/shim.ts", import.meta.url).pathname;
  const script = `import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path"; import { installShim, writeIdentity } from ${JSON.stringify(modulePath)};
    const root = mkdtempSync(join(tmpdir(), "kata-shim-name-")), realBin = join(root, "real-bin"); mkdirSync(realBin);
    try {
      const real = join(realBin, "kata-dev"); writeFileSync(real, '#!/bin/sh\\nprintf "%s|%s|%s" "$KATA_AUTHOR" "$KATA_TEAMMATE" "$KATA_INBOX_USER"\\n', {mode: 0o700});
      process.env.PATH = realBin + ":/usr/bin:/bin";
      const shim = installShim("kata-dev", message => { throw new Error(message); }, {roots: [root]});
      writeIdentity(shim, "lead", {KATA_AUTHOR: "lead", KATA_TEAMMATE: undefined, KATA_INBOX_USER: "lead-inbox"});
      writeIdentity(shim, "child", {KATA_AUTHOR: "actor", KATA_TEAMMATE: "scout", KATA_INBOX_USER: "actor/scout"});
      const run = (id, command, fallback = false) => { const env = {...process.env, PI_SESSION_ID: id, KATA_AUTHOR: "spoof", ...(fallback ? {KATA_OMP_SHIM_REAL: ""} : {})}; const out = Bun.spawnSync(["/bin/sh", "-c", command], {env}); return [out.exitCode, out.stdout.toString()]; };
      console.log(JSON.stringify([run("lead", "kata-dev"), run("child", "export KATA_AUTHOR=spoof; bash -c kata-dev"), run("child", "kata"), run("child", "kata-dev", true)]));
    } finally { rmSync(root, {recursive: true, force: true}); }`;
  const result = Bun.spawnSync([process.execPath, "-e", script], { env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME!, KATA_HOME: process.env.KATA_HOME! } });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual([
    [0, "lead||lead-inbox"], [0, "actor|scout|actor/scout"], [0, "actor|scout|actor/scout"], [0, "actor|scout|actor/scout"],
  ]);
});

test("an unresolved executable uses PATH instead of recursing when cwd contains kata", () => {
  const modulePath = new URL("../plugins/oh-my-pi/shim.ts", import.meta.url).pathname;
  const script = `import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path"; import { spawnSync } from "node:child_process"; import { installShim } from ${JSON.stringify(modulePath)};
    const root = mkdtempSync(join(tmpdir(), "shim-unresolved-")), cwd = join(root, "work"), real = join(root, "real"); mkdirSync(cwd); mkdirSync(real);
    try {
      process.env.PATH = "/usr/bin:/bin";
      const shim = installShim("kata", message => { throw new Error(message); }, { roots: [root] });
      writeFileSync(join(cwd, "kata"), "#!/bin/sh\\nprintf cwd\\n", { mode: 0o700 });
      writeFileSync(join(real, "kata"), "#!/bin/sh\\nprintf real\\n", { mode: 0o700 });
      const run = path => { const out = spawnSync(join(shim.dir, "bin/kata"), [], { cwd, env: { ...process.env, PATH: path }, encoding: "utf8", timeout: 1000 }); return [out.status, out.signal, out.stdout]; };
      console.log(JSON.stringify([run(join(shim.dir, "bin") + ":" + real + ":/usr/bin:/bin"), run(join(shim.dir, "bin") + ":/usr/bin:/bin")]));
    } finally { rmSync(root, { recursive: true, force: true }); }`;
  const result = Bun.spawnSync([process.execPath, "-e", script], { env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME!, KATA_HOME: process.env.KATA_HOME! } });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual([[0, null, "real"], [127, null, ""]]);
});

test("an unavailable configured path does not run a different kata from PATH", () => {
  const modulePath = new URL("../plugins/oh-my-pi/shim.ts", import.meta.url).pathname;
  const script = `import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path"; import { installShim } from ${JSON.stringify(modulePath)};
    const root = mkdtempSync(join(tmpdir(), "shim-configured-")), configured = join(root, "configured", "kata"), fallback = join(root, "fallback"); mkdirSync(join(root, "configured")); mkdirSync(fallback);
    try {
      writeFileSync(join(fallback, "kata"), "#!/bin/sh\\nprintf wrong\\n", { mode: 0o700 });
      if (process.argv[1] === "nonexec") writeFileSync(configured, "#!/bin/sh\\nprintf configured\\n", { mode: 0o600 });
      if (process.argv[1] === "directory") mkdirSync(configured);
      if (process.argv[1] === "valid") writeFileSync(configured, "#!/bin/sh\\nprintf configured\\n", { mode: 0o700 });
      process.env.PATH = fallback + ":/usr/bin:/bin";
      const shim = installShim(configured, message => { throw new Error(message); }, { roots: [root] });
      const out = Bun.spawnSync([join(shim.dir, "bin/kata")], { env: process.env });
      console.log(JSON.stringify([out.exitCode, out.stdout.toString(), out.stderr.toString().includes(configured)]));
    } finally { rmSync(root, { recursive: true, force: true }); }`;
  const run = (kind: string) => {
    const out = Bun.spawnSync([process.execPath, "-e", script, kind], { env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME!, KATA_HOME: process.env.KATA_HOME! } });
    expect(out.exitCode).toBe(0);
    return JSON.parse(out.stdout.toString());
  };
  const missing = run("missing");
  expect([126, 127]).toContain(missing[0]); expect(missing.slice(1)).toEqual(["", true]);
  expect([run("nonexec"), run("directory"), run("valid")]).toEqual([
    [126, "", true], [126, "", true], [0, "configured", false],
  ]);
});

test("sweep removes only the known private layout for dead processes", async () => {
  const { existsSync } = await import("node:fs");
  const { sweep } = await import("../plugins/oh-my-pi/shim");
  const root = mkdtempSync(join(tmpdir(), "kata-shim-sweep-"));
  try {
    const stale = join(root, "omp-kata-99999999-Abc123"), unexpected = join(root, "omp-kata-99999998-Abc123"), live = join(root, `omp-kata-${process.pid}-Abc123`);
    for (const dir of [stale, unexpected, live]) mkdirSync(dir, { mode: 0o700 });
    mkdirSync(join(stale, "bin")); writeFileSync(join(stale, "bin", "kata"), "");
    const { symlinkSync } = await import("node:fs"); symlinkSync("kata", join(stale, "bin", "kata-dev")); writeFileSync(join(stale, "id.env"), "");
    writeFileSync(join(unexpected, "other"), "");
    sweep(root);
    expect(existsSync(stale)).toBe(false); expect(existsSync(unexpected)).toBe(true); expect(existsSync(live)).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("install retries a failed execution probe and cleans the failed directory", () => {
  const modulePath = new URL("../plugins/oh-my-pi/shim.ts", import.meta.url).pathname;
  const script = `import { mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path"; import { installShim } from ${JSON.stringify(modulePath)};
    const root = mkdtempSync(join(tmpdir(), "kata-shim-roots-")), first = join(root, "first"), second = join(root, "second"); mkdirSync(first); mkdirSync(second);
    try { let probes = 0; const warnings = []; const result = installShim("/bin/true", w => warnings.push(w), { roots: [first, second], probe: () => ++probes > 1 }); console.log(JSON.stringify({ probes, chosen: result?.dir.startsWith(second), first: readdirSync(first), warnings })); } finally { rmSync(root, {recursive: true, force: true}); }`;
  const result = Bun.spawnSync([process.execPath, "-e", script], { env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME!, KATA_HOME: process.env.KATA_HOME! } });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual({ probes: 2, chosen: true, first: [], warnings: [] });
});

test("unavailable shim warns once without altering PATH", () => {
  const modulePath = new URL("../plugins/oh-my-pi/shim.ts", import.meta.url).pathname;
  const script = `import { installShim } from ${JSON.stringify(modulePath)}; const before = process.env.PATH; const warnings = []; installShim('/bin/true', w => warnings.push(w), {platform:'win32'}); installShim('/bin/true', w => warnings.push(w), {platform:'win32'}); console.log(JSON.stringify({warnings, unchanged: before === process.env.PATH}));`;
  const result = Bun.spawnSync([process.execPath, "-e", script], { env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME!, KATA_HOME: process.env.KATA_HOME! } });
  expect(result.exitCode).toBe(0);
  const output = JSON.parse(result.stdout.toString()); expect(output.warnings).toHaveLength(1); expect(output.unchanged).toBe(true);
});
