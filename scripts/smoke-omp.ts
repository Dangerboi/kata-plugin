// Smoke test: load the portable omp plugin into a real, headless omp against a
// real Kata daemon, and check what lands in a throwaway Kata store.
//
//   bun run smoke:omp [--scenario <name>] [--verbose]
//   bun run smoke:omp --live --model <provider/model> [--scenario <name>]
//
// Default runs use a scripted model provider (scripts/smoke-omp-provider.ts), so
// no credentials or network are needed: omp runs with a throwaway PI_CODING_AGENT_DIR.
// --live uses a real model instead, through your own omp agent directory and its
// logins (prefer a subscription), so omp may update it as in any run. KATA_HOME is
// a throwaway store either way; your live Kata store is never written.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SCENARIOS, type Check, type Issue, type Prompt, type Request, type ToolUse, type Scenario, type Session, type Store } from "./smoke-omp-scenarios";
import { linesIn } from "./smoke-jsonl";

const root = path.resolve(import.meta.dir, "..");
const argv = process.argv.slice(2);
const live = argv.includes("--live");
const verbose = argv.includes("--verbose");
const picked = argv.includes("--scenario") ? argv[argv.indexOf("--scenario") + 1] : undefined;
const liveModel = argv.includes("--model") ? argv[argv.indexOf("--model") + 1] : undefined;
if (live && !liveModel) { console.error("--live needs --model <provider/model> for a provider you are logged into (prefer a subscription)."); process.exit(2); }
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

function kata(env: NodeJS.ProcessEnv, cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
	const out = spawnSync("kata", args, { env: { ...env, ...extra }, cwd, encoding: "utf8", timeout: 15_000 });
	if (out.status !== 0) throw new Error(`kata ${args.join(" ")}: ${out.stderr || out.error}`);
	return out.stdout;
}

function store(env: NodeJS.ProcessEnv, cwd: string, records: string, prompts: string, tools: string): Store {
	return {
		requests: () => linesIn<Request>(records),
		prompts: () => linesIn<Prompt>(prompts),
		tools: () => linesIn<ToolUse>(tools),
		live,
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
		kata: (args, extra) => kata(env, work, args, extra),
		requests: () => linesIn<Request>(records),
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
	const work = path.join(dir, "repo"), agentDir = path.join(dir, "agent"), kataHome = path.join(dir, "kata"), ompConfig = path.join(dir, "omp-config.yml");
	const records = path.join(dir, "requests.jsonl"), prompts = path.join(dir, "prompts.jsonl"), tools = path.join(dir, "tools.jsonl");
	mkdirSync(work, { recursive: true }); mkdirSync(agentDir); mkdirSync(kataHome);
	const env: NodeJS.ProcessEnv = { ...base, ...scenario.env, KATA_HOME: kataHome, PI_NO_TITLE: "1", KATA_SMOKE_SCENARIO: scenario.name, KATA_SMOKE_RECORD: records, KATA_SMOKE_PROMPTS: prompts, KATA_SMOKE_TOOLS: tools };
	try {
		if (scenario.config) writeFileSync(path.join(kataHome, "config.toml"), scenario.config);
		spawnSync("git", ["init", "-q", "."], { cwd: work });
		kata(env, work, ["init", "--project", PROJECT]);
		const vars = scenario.setup?.(title => JSON.parse(kata(env, work, ["create", title, "--force-new", "--json"])).issue.short_id) ?? {};
		env.KATA_SMOKE_VARS = JSON.stringify(vars);
		// Scripted runs need no login, so omp gets a throwaway agent directory; live runs use yours (inherited PI_CODING_AGENT_DIR, else omp's default).
		if (!live) env.PI_CODING_AGENT_DIR = agentDir;
		if (scenario.ompConfig) writeFileSync(ompConfig, scenario.ompConfig);
		// The smoke extension also records each agent's system prompt, so it loads after the plugin in live runs too.
		const args = ["--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-title", ...(scenario.persist ? [] : ["--no-session"]),
			"-e", path.join(root, "plugins/oh-my-pi/kata.ts"), "-e", path.join(root, "scripts/smoke-omp-provider.ts"), ...(scenario.ompConfig ? ["--config", ompConfig] : [])];
		args.push("--model", live ? liveModel! : "kata-smoke/scripted");
		let code: number | null, output: string, checks: Check[] = [];
		if (scenario.drive) ({ code, output, checks } = await drive(scenario, args, env, work, records));
		else {
			const child = spawn("omp", ["-p", "--wait-async", ...(verbose ? ["--mode", "json"] : []), ...args, live ? scenario.livePrompt!(vars) : scenario.prompt!], { env, cwd: work, stdio: ["ignore", "pipe", "pipe"] });
			output = "";
			child.stdout.on("data", d => output += d);
			child.stderr.on("data", d => output += d);
			const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
			code = await new Promise<number | null>(resolve => child.on("close", resolve));
			clearTimeout(timer);
			if (verbose) console.log(output);
		}
		report("omp exited cleanly", code === 0, `exit ${code}\n${output.trim().split("\n").slice(-20).join("\n")}`);
		if (scenario.check) {
			try { checks.push(...await scenario.check(store(env, work, records, prompts, tools), vars)); }
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
