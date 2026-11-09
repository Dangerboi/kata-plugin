import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertIsolated, assertUnchanged, snapshot } from "./isolation";

// The adapter suites load the vendored copies in plugins/*, not core/: refuse to test a stale copy.
if (Bun.spawnSync([process.execPath, "scripts/vendor-core.ts", "--check"], { stdout: "ignore", stderr: "inherit" }).exitCode !== 0) process.exit(1);

const MARKER = ".omp-kata-test", ROOT_PREFIX = "omp-kata-tests-";
const root = mkdtempSync(path.join(os.tmpdir(), ROOT_PREFIX));
// The runner's pid tells a later run whether this root's runner is still alive.
writeFileSync(path.join(root, MARKER), `throwaway\npid=${process.pid}\n`);
const env = { ...process.env, KATA_TEST_ROOT: root, KATA_HOME: path.join(root, "home") };
mkdirSync(env.KATA_HOME);
for (const key of ["KATA_SERVER", "KATA_DAEMON", "KATA_AUTH_TOKEN", "KATA_REF", "KATA_TEAMMATE", "KATA_INBOX_USER", "KATA_SESSION_ID"]) delete env[key];
assertIsolated(env);
console.log(`Isolated test root: ${root}`);

const binary = env.KATA_TEST_EXECUTABLE;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error: any) { return error.code === "EPERM"; } };

// Fixture daemons are detached, so they outlive the tests. Stops the daemon of every store under `dir`
// whose runtime record names a running process. Returns how many it stopped.
async function stopDaemons(dir: string): Promise<number> {
  if (!binary || !path.isAbsolute(binary)) return 0;
  const stores = new Set<string>();
  let entries: string[];
  try { entries = readdirSync(dir, { recursive: true }) as string[]; } catch { return 0; }
  for (const relative of entries) {
    const record = /[/\\]runtime[/\\][^/\\]+[/\\]daemon\.(\d+)\.json$/.exec(relative);
    if (record && alive(Number(record[1]))) stores.add(path.dirname(path.dirname(path.dirname(path.join(dir, relative)))));
  }
  for (const home of stores) {
    const cleanupEnv = { ...env, KATA_TEST_ROOT: dir, KATA_HOME: home };
    assertIsolated(cleanupEnv);
    await Bun.spawn([binary, "daemon", "stop"], { env: cleanupEnv, stdout: "ignore", stderr: "ignore" }).exited;
  }
  return stores.size;
}

// A root whose runner is gone: killed before it could stop its daemons. A marker written before
// markers carried a pid counts once the root is an hour old, so a run of an older checkout is left alone.
function abandoned(dir: string): boolean {
  try {
    const pid = /^pid=(\d+)$/m.exec(readFileSync(path.join(dir, MARKER), "utf8"))?.[1];
    return pid ? !alive(Number(pid)) : Date.now() - statSync(dir).mtimeMs > 3_600_000;
  } catch { return false; }
}

let stale = 0;
for (const entry of readdirSync(os.tmpdir(), { withFileTypes: true })) {
  const dir = path.join(os.tmpdir(), entry.name);
  if (entry.isDirectory() && entry.name.startsWith(ROOT_PREFIX) && abandoned(dir)) stale += await stopDaemons(dir);
}
if (stale) console.log(`Stopped ${stale} Kata daemon(s) left by earlier test runs that never finished.`);

// Bun skips `finally` on a signal it doesn't handle: stop the tests, then fall through to the cleanup below.
// A second signal kills the tests outright.
let child: Bun.Subprocess | undefined, signalled: number | undefined;
for (const [signal, status] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.on(signal, () => {
    if (signalled) child?.kill("SIGKILL");
    else { signalled = status; child?.kill(signal); }
  });
}

const before = snapshot();
try {
  const args = process.argv.slice(2);
  const todoTests = readdirSync("tests").filter(file => file.endsWith(".test.ts")).map(file => "./tests/" + file);
  const bunTest = [process.execPath, "test", "--timeout", "15000"];
  // `changed [ref]` keeps only the test files whose imports reach a file git sees as changed
  // (staged, unstaged, untracked, or since ref). It misses files read from disk and a changed Kata binary.
  const changed = args[0] === "changed" ? [args[1] ? `--changed=${args[1]}` : "--changed"] : [];
  const commands = args[0] === "all" ? [
    [...bunTest, ...todoTests],
    [process.execPath, "tests/revision-conformance.ts"],
  ]
    : args[0] === "revisions" ? [[process.execPath, "tests/revision-conformance.ts"]]
    : [[...bunTest, ...changed, ...(changed.length || !args.length ? todoTests : args)]];
  for (const command of commands) {
    if (signalled) break;
    child = Bun.spawn(command, { env, stdout: "inherit", stderr: "inherit" });
    const code = await child.exited;
    if (code !== 0) { process.exitCode = code; break; }
  }
} finally {
  // A timed-out hook can outlive a fixture's afterAll and restart its daemon.
  // Once the test process exits, stop any remaining daemon in this runner's root.
  await stopDaemons(root);
  if (signalled) process.exitCode = signalled;
  assertUnchanged(before);
  console.log(`Default Kata home canary unchanged. Isolated test root: ${root}`);
}
