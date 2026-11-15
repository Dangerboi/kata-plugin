import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertIsolated, assertUnchanged, snapshot } from "./isolation";
import { TRANSCRIPT_ENV } from "../core/kata-cli";

// The adapter suites load the vendored copies in plugins/*, not core/: refuse to test a stale copy.
if (Bun.spawnSync([process.execPath, "scripts/vendor-core.ts", "--check"], { stdout: "ignore", stderr: "inherit" }).exitCode !== 0) process.exit(1);
const binary = process.env.KATA_TEST_EXECUTABLE;
if (!binary || !path.isAbsolute(binary)) {
  console.error('Set KATA_TEST_EXECUTABLE to the absolute Kata binary, e.g. KATA_TEST_EXECUTABLE="$(readlink -f "$(command -v kata)")" bun run test.');
  process.exit(1);
}

const MARKER = ".omp-kata-test", ROOT_PREFIX = "omp-kata-tests-";
const root = mkdtempSync(path.join(os.tmpdir(), ROOT_PREFIX));
// The runner's pid tells a later run whether this root's runner is still alive.
writeFileSync(path.join(root, MARKER), `throwaway\npid=${process.pid}\n`);
const env = { ...process.env, KATA_TEST_ROOT: root, KATA_HOME: path.join(root, "home") };
mkdirSync(env.KATA_HOME);
// Parallel workers each get their own home beside this one, so no two processes share a store.
// The default never runs more workers than the machine has CPUs (CI runners have 2 to 4). Past 8, workers slow each
// other down: on 12 CPUs the suite took 67 s with 8 workers and 70 s with 12.
const DEFAULT_JOBS = Math.min(8, os.availableParallelism());
const JOBS = Math.max(1, Math.floor(Number(process.env.KATA_TEST_JOBS ?? DEFAULT_JOBS)) || DEFAULT_JOBS);
// Every inherited variable the plugins read: a developer's own settings must not change what the tests see.
for (const key of ["KATA_SERVER", "KATA_DAEMON", "KATA_AUTH_TOKEN", "KATA_REF", "KATA_TEAMMATE", "KATA_INBOX_USER", "KATA_SESSION_ID", "KATA_DEFAULT_PROJECT", "KATA_AUTHOR",
  "KATA_PI_PARENT", "KATA_OMP_LIVE_INBOX", "KATA_ATTENTION_HOST", "KATA_OMP_EXECUTABLE", "KATA_PI_EXECUTABLE", "KATA_OPENCODE_EXECUTABLE", "KATA_OMP_DEBUG", "KATA_PI_DEBUG",
  "KATA_OPENCODE_DEBUG", ...TRANSCRIPT_ENV]) delete env[key];
assertIsolated(env);
console.log(`Isolated test root: ${root}`);

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error: any) { return error.code === "EPERM"; } };

// Fixture daemons are detached, so they outlive the tests. Stops the daemon of every store under `dir`
// whose runtime record names a running process. Returns how many it stopped.
async function stopDaemons(dir: string): Promise<number> {
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

// A finished run's root is removed: a passing one at its end, a killed or failed one by the next run, once its daemons are stopped.
let stale = 0;
for (const entry of readdirSync(os.tmpdir(), { withFileTypes: true })) {
  const dir = path.join(os.tmpdir(), entry.name);
  if (!entry.isDirectory() || !entry.name.startsWith(ROOT_PREFIX) || !abandoned(dir)) continue;
  stale += await stopDaemons(dir);
  rmSync(dir, { recursive: true, force: true });
}
if (stale) console.log(`Stopped ${stale} Kata daemon(s) left by earlier test runs that never finished.`);

// Bun skips `finally` on a signal it doesn't handle: stop the tests, then fall through to the cleanup below.
// A second signal kills the tests outright.
const children = new Set<Bun.Subprocess>();
let signalled: number | undefined;
for (const [signal, status] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.on(signal, () => {
    const again = signalled !== undefined;
    signalled = status;
    for (const child of children) child.kill(again ? "SIGKILL" : signal);
  });
}

async function runOne(command: string[]): Promise<number> {
  if (signalled) return signalled;
  const child = Bun.spawn(command, { env, stdout: "inherit", stderr: "inherit" });
  children.add(child);
  const code = await child.exited;
  children.delete(child);
  return code;
}

// Every file that takes over about 15 s, slowest first (measured with 8 workers), so the pool's last jobs are short;
// the rest follow alphabetically. A slow file left out lands at the end and stretches the run by its own length.
const SLOW_FIRST = ["reliability", "delegates", "opencode", "v2-delegate-binding", "pi-children", "v2-sessions", "v2-turn-end", "v2-tickets",
  "v2-forks-projects", "opencode-delegates", "pi-host", "pi-sessions", "v2-hosted"].map(name => `./tests/${name}.test.ts`);
const slowFirst = (files: string[]) => [...SLOW_FIRST.filter(file => files.includes(file)), ...files.filter(file => !SLOW_FIRST.includes(file))];

// KATA_TEST_SHARD=<i>/<n> keeps slice i of n of every test file. Files are dealt in pool order, reversing direction each
// round (1, 2, 2, 1, ... for two slices), so the slowest file and the third-slowest don't land in the same slice.
// CI runs one slice per job; revision conformance runs with the last slice, which gets the lighter deal.
const shardSpec = process.env.KATA_TEST_SHARD || undefined;
const shardMatch = shardSpec?.match(/^(\d+)\/(\d+)$/);
const [SHARD, SHARDS] = shardMatch ? [Number(shardMatch[1]), Number(shardMatch[2])] : [1, 1];
if (shardSpec && !(shardMatch && SHARD >= 1 && SHARD <= SHARDS)) throw new Error(`KATA_TEST_SHARD must be <i>/<n> with 1 <= i <= n, got ${shardSpec}.`);

// One `bun test` per file in a pool of JOBS workers, each with its own KATA_HOME under the root.
// A file's output is printed whole when it ends, so parallel files never interleave.
async function runPool(files: string[], bunTest: string[]): Promise<number> {
  const queue = slowFirst(files);
  const started = Date.now();
  let passed = 0, failed = 0;
  const failures: string[] = [];
  const worker = async (n: number) => {
    const home = path.join(root, `home-${n}`);
    mkdirSync(home);
    const workerEnv = { ...env, KATA_HOME: home };
    assertIsolated(workerEnv);
    for (let file = queue.shift(); file && !signalled; file = queue.shift()) {
      const t0 = Date.now();
      const child = Bun.spawn([...bunTest, file], { env: workerEnv, stdout: "pipe", stderr: "pipe" });
      children.add(child);
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      children.delete(child);
      process.stdout.write(`\n=== ${file} (${code === 0 ? "pass" : `FAIL, exit ${code}`}, ${((Date.now() - t0) / 1000).toFixed(1)} s) ===\n${out}${err}`);
      if (code === 0) passed++; else { failed++; failures.push(file); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(JOBS, queue.length) }, (_, n) => worker(n)));
  console.log(`\n${files.length} test files: ${passed} passed, ${failed} failed${signalled ? ", interrupted" : ""}, ${((Date.now() - started) / 1000).toFixed(1)} s with ${JOBS} workers.`);
  for (const file of failures) console.log(`  FAILED ${file}`);
  return failed ? 1 : 0;
}

const before = snapshot();
try {
  const args = process.argv.slice(2);
  // Sorted: readdir order follows the filesystem, so two CI machines could list the files differently and their shards
  // would then miss or repeat files.
  const allTests = readdirSync("tests").filter(file => file.endsWith(".test.ts")).sort().map(file => "./tests/" + file);
  // A shard applies to runs of every file; named files, `changed` and `revisions` ignore it.
  const slice = (k: number) => Math.floor(k / SHARDS) % 2 === 0 ? k % SHARDS : SHARDS - 1 - (k % SHARDS);
  const todoTests = slowFirst(allTests).filter((_, k) => slice(k) === SHARD - 1);
  if (SHARDS > 1) console.log(`Shard ${SHARD}/${SHARDS}: ${todoTests.length} of ${allTests.length} test files.`);
  const bunTest = [process.execPath, "test", "--timeout", "15000"];
  // `changed [ref]` keeps only the test files whose imports reach a file git sees as changed
  // (staged, unstaged, untracked, or since ref). It misses files read from disk and a changed Kata binary.
  const changed = args[0] === "changed" ? [args[1] ? `--changed=${args[1]}` : "--changed"] : [];
  const revisions = [process.execPath, "tests/revision-conformance.ts"];
  // Every test file, as the pool or (KATA_TEST_JOBS=1) as one streaming process; anything narrower is one process.
  const everything = args[0] === "all" || (!args.length && !changed.length);
  const suites: (() => Promise<number>)[] = args[0] === "revisions" ? [() => runOne(revisions)]
    : everything && JOBS > 1 ? [() => runPool(todoTests, bunTest)]
    : [() => runOne([...bunTest, ...changed, ...(changed.length ? allTests : !args.length || args[0] === "all" ? todoTests : args)])];
  if (args[0] === "all" && SHARD === SHARDS) suites.push(() => runOne(revisions));
  for (const suite of suites) {
    const code = await suite();
    if (code !== 0) { process.exitCode = code; break; }
  }
} finally {
  // A timed-out hook can outlive a fixture's afterAll and restart its daemon.
  // Once the test process exits, stop any remaining daemon in this runner's root.
  await stopDaemons(root);
  if (signalled) process.exitCode = signalled;
  assertUnchanged(before);
  if (!process.exitCode) rmSync(root, { recursive: true, force: true });
  console.log(`Default Kata home canary unchanged. ${process.exitCode ? `Isolated test root kept for inspection: ${root}` : "Isolated test root removed."}`);
}
