// Smoke test: load the portable omp plugin into a real, headless omp against a
// real Kata daemon, and check what lands in a throwaway Kata store.
//
//   bun run smoke:omp [--scenario <name>] [--live] [--verbose]
//
// Default runs use a scripted model provider (scripts/smoke-omp-provider.ts), so
// no credentials or network are needed. --live uses the model you have
// configured instead. Both run omp with PI_CODING_AGENT_DIR and KATA_HOME on the
// child process only; your ~/.omp and live Kata store are never written.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SCENARIOS, type Check, type Issue, type Scenario, type Store } from "./smoke-omp-scenarios";

const root = path.resolve(import.meta.dir, "..");
const argv = process.argv.slice(2);
const live = argv.includes("--live");
const verbose = argv.includes("--verbose");
const picked = argv.includes("--scenario") ? argv[argv.indexOf("--scenario") + 1] : undefined;
const scenarios = picked ? SCENARIOS.filter(s => s.name === picked) : SCENARIOS;
if (!scenarios.length) { console.error(`Unknown scenario ${picked}. Known: ${SCENARIOS.map(s => s.name).join(", ")}`); process.exit(2); }

const PROJECT = "omp-smoke";
const TIMEOUT_MS = live ? 600_000 : 120_000;
const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "omp-kata-smoke-")));
// Inherited routing would point the child at someone else's Kata.
const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^KATA_(SERVER|DAEMON|AUTH_TOKEN|REF|HOME|DEFAULT_PROJECT)$/.test(k)));
let failures = 0;
const report = (name: string, ok: boolean, detail?: string) => {
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
};

function kata(env: NodeJS.ProcessEnv, cwd: string, args: string[]) {
	const out = spawnSync("kata", args, { env, cwd, encoding: "utf8", timeout: 15_000 });
	if (out.status !== 0) throw new Error(`kata ${args.join(" ")}: ${out.stderr || out.error}`);
	return out.stdout;
}

function store(env: NodeJS.ProcessEnv, cwd: string): Store {
	return {
		async issues() {
			const listed = JSON.parse(kata(env, cwd, ["list", "--status", "all", "--limit", "0", "--json"])).issues;
			const events = JSON.parse(kata(env, cwd, ["events", "--project", PROJECT, "--after", "0", "--limit", "10000", "--json"])).events;
			return listed.map((i: any): Issue => ({
				ref: i.short_id, title: i.title, status: i.status, owner: i.owner, metadata: i.metadata ?? {},
				events: events.filter((e: any) => e.issue_uid === i.uid).map((e: any) => ({ type: e.type, payload: e.payload })),
			}));
		},
	};
}

// --live reads the user's omp credentials and model config by copying files; the
// originals are opened read-only and never written.
function copyUserConfig(agentDir: string) {
	const home = path.join(process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".omp", "agent"));
	for (const name of ["config.yml", "agent.db", "agent.db-wal"]) {
		if (existsSync(path.join(home, name))) copyFileSync(path.join(home, name), path.join(agentDir, name));
	}
}

async function run(scenario: Scenario) {
	console.log(`\n# scenario ${scenario.name}${live ? " (live)" : " (scripted)"}`);
	const dir = path.join(tmp, scenario.name);
	const work = path.join(dir, "repo"), agentDir = path.join(dir, "agent"), kataHome = path.join(dir, "kata");
	mkdirSync(work, { recursive: true }); mkdirSync(agentDir); mkdirSync(kataHome);
	const env: NodeJS.ProcessEnv = { ...base, KATA_HOME: kataHome, PI_CODING_AGENT_DIR: agentDir, PI_NO_TITLE: "1", KATA_SMOKE_SCENARIO: scenario.name };
	try {
		spawnSync("git", ["init", "-q", "."], { cwd: work });
		kata(env, work, ["init", "--project", PROJECT]);
		if (live) copyUserConfig(agentDir);
		const args = ["-p", "--wait-async", ...(verbose ? ["--mode", "json"] : []), "--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-title", "--no-session",
			"-e", path.join(root, "plugins/oh-my-pi/kata.ts")];
		if (!live) args.push("-e", path.join(root, "scripts/smoke-omp-provider.ts"), "--model", "kata-smoke/scripted");
		args.push(live ? scenario.livePrompt : scenario.prompt);
		const child = spawn("omp", args, { env, cwd: work, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout.on("data", d => output += d);
		child.stderr.on("data", d => output += d);
		const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
		const code = await new Promise<number | null>(resolve => child.on("close", resolve));
		clearTimeout(timer);
		if (verbose) console.log(output);
		report("omp exited cleanly", code === 0, `exit ${code}\n${output.trim().split("\n").slice(-20).join("\n")}`);
		let checks: Check[];
		try { checks = await scenario.check(store(env, work)); }
		catch (error) { checks = [{ name: "store readable", ok: false, detail: String(error) }]; }
		for (const check of checks) report(check.name, check.ok, check.detail);
	} catch (error) {
		report("scenario setup", false, String(error));
	} finally {
		spawnSync("kata", ["daemon", "stop"], { env, cwd: work, stdio: "ignore", timeout: 15_000 });
	}
}

try { for (const scenario of scenarios) await run(scenario); }
finally { rmSync(tmp, { recursive: true, force: true }); }
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
