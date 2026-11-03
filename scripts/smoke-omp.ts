// Smoke test: load the portable omp plugin into a real, headless omp against a
// real Kata daemon, and check what lands in a throwaway Kata store.
//
//   bun run smoke:omp [--scenario <name>] [--verbose]
//   bun run smoke:omp --live --model <provider/model> [--scenario <name>]
//
// Default runs use a scripted model provider (scripts/smoke-omp-provider.ts), so
// no credentials or network are needed. --live uses a real model instead, through
// one of your API-key logins. Both run omp with PI_CODING_AGENT_DIR and KATA_HOME
// on the child process only; your ~/.omp and live Kata store are never written.
import { Database } from "bun:sqlite";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SCENARIOS, type Check, type Issue, type Request, type Scenario, type Session, type Store } from "./smoke-omp-scenarios";

const root = path.resolve(import.meta.dir, "..");
const argv = process.argv.slice(2);
const live = argv.includes("--live");
const verbose = argv.includes("--verbose");
const picked = argv.includes("--scenario") ? argv[argv.indexOf("--scenario") + 1] : undefined;
const liveModel = argv.includes("--model") ? argv[argv.indexOf("--model") + 1] : undefined;
if (live && !liveModel) { console.error("--live needs --model <provider/model> for a provider you log into with an API key (OAuth logins are never copied)."); process.exit(2); }
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

function requestsIn(file: string): Request[] {
	return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
}

function store(env: NodeJS.ProcessEnv, cwd: string, records: string): Store {
	return {
		requests: () => requestsIn(records),
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

// --live borrows the user's API-key logins and nothing else (the model comes from
// --model). OAuth logins are left out: refreshing a copy rotates the refresh token
// and can log the user's own omp out. The original database is opened read-only.
function copyUserConfig(agentDir: string) {
	const home = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".omp", "agent");
	if (!existsSync(path.join(home, "agent.db"))) { console.error(`--live needs an omp login: no agent.db in ${home}`); process.exit(2); }
	const target = path.join(agentDir, "agent.db");
	const source = new Database(path.join(home, "agent.db"), { readonly: true });
	try { source.run("VACUUM INTO ?", [target]); } finally { source.close(); }
	const copy = new Database(target);
	try {
		copy.run("DELETE FROM auth_credentials WHERE credential_type != 'api_key'");
		for (const table of ["auth_credential_blocks", "auth_credential_refresh_leases", "auth_credential_block_mirror_guard"]) copy.run(`DELETE FROM ${table} WHERE credential_id NOT IN (SELECT id FROM auth_credentials)`);
	} finally { copy.close(); }
}

// Runs omp as a long-lived RPC process and hands the scenario a Session.
async function drive(scenario: Scenario, args: string[], env: NodeJS.ProcessEnv, work: string, records: string) {
	const child = spawn("omp", ["--mode", "rpc", ...args], { env, cwd: work, stdio: ["pipe", "pipe", "pipe"] });
	let output = "", buffer = "", sequence = 0;
	const waiting = new Map<string, (frame: any) => void>();
	const ready = Promise.withResolvers<void>();
	child.stderr.on("data", d => output += d);
	child.stdout.on("data", d => {
		output += d; buffer += d;
		for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
			const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
			let frame: any;
			try { frame = JSON.parse(line); } catch { continue; }
			if (frame.type === "ready") ready.resolve();
			if (frame.type === "response" && frame.command === "fork") waiting.get(frame.id)?.(frame);
			if (frame.type === "prompt_result" && waiting.has(frame.id)) waiting.get(frame.id)!(frame);
			// A prompt that finishes locally never gets a prompt_result.
			if (frame.type === "response" && frame.command === "prompt" && frame.data?.agentInvoked === false) waiting.get(frame.id)?.(frame);
		}
	});
	const closed = new Promise<number | null>(resolve => child.on("close", resolve));
	const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
	const session: Session = {
		kata: args => kata(env, work, args),
		requests: () => requestsIn(records),
		async fork() {
			const id = `f${++sequence}`;
			const done = new Promise<any>(resolve => waiting.set(id, resolve));
			child.stdin.write(JSON.stringify({ id, type: "fork" }) + "\n");
			const frame = await done;
			if (!frame.success || frame.data?.cancelled) throw new Error(`fork failed: ${JSON.stringify(frame)}`);
		},
		async prompt(text) {
			const id = `p${++sequence}`;
			const done = new Promise<any>(resolve => waiting.set(id, resolve));
			child.stdin.write(JSON.stringify({ id, type: "prompt", message: text }) + "\n");
			const frame = await done;
			if (frame.status === "error") throw new Error(`prompt failed: ${JSON.stringify(frame.error)}`);
		},
	};
	let checks: Check[] = [];
	try {
		await ready.promise;
		checks = await scenario.drive!(session);
	} catch (error) {
		checks = [{ name: "drive the session", ok: false, detail: `${error}\n${output.trim().split("\n").slice(-20).join("\n")}` }];
	}
	child.stdin.end();
	const code = await closed;
	clearTimeout(timer);
	if (verbose) console.log(output);
	return { code, output, checks };
}

async function run(scenario: Scenario) {
	if (live && !scenario.livePrompt) { console.log(`\n# scenario ${scenario.name} skipped: scripted only`); return; }
	console.log(`\n# scenario ${scenario.name}${live ? " (live)" : " (scripted)"}`);
	const dir = path.join(tmp, scenario.name);
	const work = path.join(dir, "repo"), agentDir = path.join(dir, "agent"), kataHome = path.join(dir, "kata");
	const records = path.join(dir, "requests.jsonl");
	mkdirSync(work, { recursive: true }); mkdirSync(agentDir); mkdirSync(kataHome);
	const env: NodeJS.ProcessEnv = { ...base, ...scenario.env, KATA_HOME: kataHome, PI_CODING_AGENT_DIR: agentDir, PI_NO_TITLE: "1", KATA_SMOKE_SCENARIO: scenario.name, KATA_SMOKE_RECORD: records };
	try {
		spawnSync("git", ["init", "-q", "."], { cwd: work });
		kata(env, work, ["init", "--project", PROJECT]);
		const vars = scenario.setup?.(title => JSON.parse(kata(env, work, ["create", title, "--force-new", "--json"])).issue.short_id) ?? {};
		env.KATA_SMOKE_VARS = JSON.stringify(vars);
		if (live) copyUserConfig(agentDir);
		const args = ["--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-title", ...(scenario.persist ? [] : ["--no-session"]),
			"-e", path.join(root, "plugins/oh-my-pi/kata.ts")];
		args.push(...(live ? ["--model", liveModel!] : ["-e", path.join(root, "scripts/smoke-omp-provider.ts"), "--model", "kata-smoke/scripted"]));
		if (scenario.config) {
			const config = path.join(dir, "config.yml");
			writeFileSync(config, scenario.config);
			args.push("--config", config);
		}
		let code: number | null, output: string, checks: Check[] = [];
		if (scenario.drive) ({ code, output, checks } = await drive(scenario, args, env, work, records));
		else {
			const child = spawn("omp", ["-p", "--wait-async", ...(verbose || scenario.checkOutput ? ["--mode", "json"] : []), ...args, live ? scenario.livePrompt!(vars) : scenario.prompt!], { env, cwd: work, stdio: ["ignore", "pipe", "pipe"] });
			output = "";
			child.stdout.on("data", d => output += d);
			child.stderr.on("data", d => output += d);
			const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
			code = await new Promise<number | null>(resolve => child.on("close", resolve));
			clearTimeout(timer);
			if (verbose) console.log(output);
		}
		report("omp exited cleanly", code === 0, `exit ${code}\n${output.trim().split("\n").slice(-20).join("\n")}`);
		if (scenario.checkOutput) checks.push(...scenario.checkOutput(output));
		if (scenario.check) {
			try { checks.push(...await scenario.check(store(env, work, records), vars)); }
			catch (error) { checks.push({ name: "store readable", ok: false, detail: String(error) }); }
		}
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
