// Smoke test: load the portable omp plugin into a real, headless omp against a
// real Kata daemon, and check what lands in a throwaway Kata store. omp's native
// todo runs with the plugin's `kata` todo backend selected (a --config overlay).
//
//   bun run smoke:omp [--scenario <name>] [--verbose]
//   bun run smoke:omp --live --model <provider/model> [--scenario <name>]
//
// Default runs use a scripted model provider (scripts/smoke-omp-provider.ts), so
// no credentials or network are needed: omp runs with a throwaway PI_CODING_AGENT_DIR.
// --live uses a real model instead, through your own omp agent directory and its
// logins (prefer a subscription), so omp may update it as in any run. KATA_HOME is
// a throwaway store either way; your live Kata store is never written.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, type Dirent } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { PROJECT, SCENARIOS, type Prompt, type Request, type ToolUse, type Scenario, type Session, type Store } from "./smoke-omp-scenarios";
import { cleanEnv, defer, flag, kataProject, lastLines, linesIn, option, pickScenarios, report, reportChecks, runToEnd, scratchRoot, teardown, verbose, verdict, type Check } from "./smoke-lib";
import { MODEL, PROVIDER } from "./smoke-provider";

const root = path.resolve(import.meta.dirname, "..");
const live = flag("--live");
const liveModel = option("--model");
if (live && !liveModel) { console.error("--live needs --model <provider/model> for a provider you are logged into (prefer a subscription)."); process.exit(2); }
const scenarios = pickScenarios(SCENARIOS);

const TIMEOUT_MS = live ? 600_000 : 120_000;
const tmp = scratchRoot("omp-kata-smoke-");
const base = cleanEnv();

// Runs omp as a long-lived RPC process and hands the scenario a Session. `restart` is the generic kill point: it waits until
// the persisted session file (under the throwaway PI_CODING_AGENT_DIR) contains `saved`, SIGKILLs omp (no shutdown hook runs),
// and starts a new process on that same session file with `--resume <file>`.
async function drive(scenario: Scenario, args: string[], env: NodeJS.ProcessEnv, work: string, kata: Session["kata"]) {
	let output = "", sequence = 0;
	const waiting = new Map<string, (frame: any) => void>();
	let child!: ChildProcessWithoutNullStreams, ready!: Promise<void>, closed!: Promise<number | null>;
	const start = (extra: string[]) => {
		const proc = spawn("omp", ["--mode", "rpc", ...args, ...extra], { env, cwd: work, stdio: ["pipe", "pipe", "pipe"] });
		let buffer = "";
		proc.stderr.on("data", d => output += d);
		ready = new Promise<void>(resolve => proc.stdout.on("data", d => {
			output += d; buffer += d;
			for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
				const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
				let frame: any;
				try { frame = JSON.parse(line); } catch { continue; }
				if (frame.type === "ready") resolve();
				if (frame.type === "response" && frame.command === "fork") waiting.get(frame.id)?.(frame);
				if (frame.type === "prompt_result" && waiting.has(frame.id)) waiting.get(frame.id)!(frame);
				// A prompt that finishes locally never gets a prompt_result.
				if (frame.type === "response" && frame.command === "prompt" && frame.data?.agentInvoked === false) waiting.get(frame.id)?.(frame);
			}
		}));
		child = proc;
		closed = new Promise<number | null>(resolve => proc.on("close", resolve));
	};
	start([]);
	const kill = () => void child.kill("SIGKILL");
	const settled = defer(kill);
	const timer = setTimeout(kill, TIMEOUT_MS);
	const session: Session = {
		kata,
		requests: () => linesIn<Request>(env.KATA_SMOKE_RECORD),
		tools: () => linesIn<ToolUse>(env.KATA_SMOKE_TOOLS),
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
		async restart(saved) {
			const sessions = path.join(env.PI_CODING_AGENT_DIR!, "sessions");
			const find = () => (readdirSync(sessions, { recursive: true, withFileTypes: true }) as Dirent[])
				.filter(e => e.isFile() && e.name.endsWith(".jsonl")).map(e => path.join(e.parentPath, e.name))
				.find(file => readFileSync(file, "utf8").includes(saved));
			let file: string | undefined;
			for (const end = Date.now() + 30_000; !(file = existsSync(sessions) ? find() : undefined) && Date.now() < end;) await sleep(100);
			if (!file) throw new Error(`no session file contains ${saved}`);
			child.kill("SIGKILL");
			await closed;
			start(["--resume", file]);
			await ready;
		},
	};
	let checks: Check[] = [];
	try {
		await ready;
		checks = await scenario.drive!(session);
	} catch (error) {
		checks = [{ name: "drive the session", ok: false, detail: `${error}\n${lastLines(output)}` }];
	}
	child.stdin.end();
	const code = await closed;
	clearTimeout(timer);
	settled();
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
	const project = kataProject(env, work, PROJECT);
	const store: Store = { requests: () => linesIn<Request>(records), prompts: () => linesIn<Prompt>(prompts), tools: () => linesIn<ToolUse>(tools), live, issues: project.issues };
	try {
		project.init();
		const vars = scenario.setup?.(project.create) ?? {};
		env.KATA_SMOKE_VARS = JSON.stringify(vars);
		// Scripted runs need no login, so omp gets a throwaway agent directory; live runs use yours (inherited PI_CODING_AGENT_DIR, else omp's default).
		if (!live) env.PI_CODING_AGENT_DIR = agentDir;
		// The plugin mirrors and guards omp's native todo only while the `kata` backend is selected, so every run selects it; the scenario's own settings follow.
		writeFileSync(ompConfig, `todo:\n  backend: kata\n${scenario.ompConfig ?? ""}`);
		// The smoke extension also records each agent's system prompt, so it loads after the plugin in live runs too.
		const args = ["--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-title", ...(scenario.persist ? [] : ["--no-session"]),
			"-e", path.join(root, "plugins/oh-my-pi/kata.ts"), "-e", path.join(root, "scripts/smoke-omp-provider.ts"), "--config", ompConfig];
		args.push("--model", live ? liveModel! : `${PROVIDER}/${MODEL}`);
		const { code, output, checks } = scenario.drive ? await drive(scenario, args, env, work, project.kata)
			: { ...await runToEnd("omp", ["-p", "--wait-async", ...(verbose ? ["--mode", "json"] : []), ...args, live ? scenario.livePrompt!(vars) : scenario.prompt!], { env, cwd: work, timeout: TIMEOUT_MS }), checks: [] };
		report("omp exited cleanly", code === 0, `exit ${code}\n${lastLines(output)}`);
		await reportChecks(() => checks);
		await reportChecks(() => scenario.check?.(store, vars) ?? []);
	} catch (error) {
		report("scenario setup", false, String(error));
	} finally {
		project.stopDaemon();
	}
}

try { for (const scenario of scenarios) await run(scenario); }
finally { teardown(); }
process.exit(verdict());
