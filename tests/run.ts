import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertIsolated, assertUnchanged, snapshot } from "./isolation";

// The adapter suites load the vendored copies in plugins/*, not core/: refuse to test a stale copy.
if (Bun.spawnSync([process.execPath, "scripts/vendor-core.ts", "--check"], { stdout: "ignore", stderr: "inherit" }).exitCode !== 0) process.exit(1);

const root = mkdtempSync(path.join(os.tmpdir(), "omp-kata-tests-"));
writeFileSync(path.join(root, ".omp-kata-test"), "throwaway\n");
const env = { ...process.env, KATA_TEST_ROOT: root, KATA_HOME: path.join(root, "home") };
mkdirSync(env.KATA_HOME);
for (const key of ["KATA_SERVER", "KATA_DAEMON", "KATA_AUTH_TOKEN", "KATA_REF", "KATA_TEAMMATE", "KATA_INBOX_USER", "KATA_SESSION_ID"]) delete env[key];
assertIsolated(env);
console.log(`Isolated test root: ${root}`);
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
    const code = await Bun.spawn(command, { env, stdout: "inherit", stderr: "inherit" }).exited;
    if (code !== 0) { process.exitCode = code; break; }
  }
} finally {
	// A timed-out hook can outlive a fixture's afterAll and restart its daemon.
	// Once the test process exits, stop any remaining daemon in this runner's root.
	const binary = env.KATA_TEST_EXECUTABLE;
	if (binary && path.isAbsolute(binary)) {
		const stores = new Set<string>();
		for (const relative of readdirSync(root, { recursive: true }) as string[]) {
			if (/[/\\]runtime[/\\][^/\\]+[/\\]daemon\.\d+\.json$/.test(relative)) stores.add(path.dirname(path.dirname(path.dirname(path.join(root, relative)))));
		}
		for (const home of stores) {
			const cleanupEnv = { ...env, KATA_HOME: home };
			assertIsolated(cleanupEnv);
			await Bun.spawn([binary, "daemon", "stop"], { env: cleanupEnv, stdout: "ignore", stderr: "ignore" }).exited;
		}
	}
  assertUnchanged(before);
  console.log(`Default Kata home canary unchanged. Isolated test root: ${root}`);
}
