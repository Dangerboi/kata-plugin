// What the smoke runners share: the command line, a clean environment, a throwaway root, a Kata project per scenario,
// child processes that never outlive the run, and the check report. The scenario files import it too, and omp loads
// those inside its own process (through the provider extension), so importing this module does nothing by itself.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TRANSCRIPT_ENV } from "../core/kata-cli";

export type Issue = {
	ref: string; title: string; status: string; owner?: string;
	/** Kata stores JSON values: most are strings, `omp.auto_parent` is a boolean. */
	metadata: Record<string, unknown>;
	events: { type: string; payload: any }[];
};
export type Check = { name: string; ok: boolean; detail?: string };

// ---- Assertion helpers over an issue ----
/** The first `issue.closed` event of an issue. */
export const closeEvent = (i?: Issue) => i?.events.find(e => e.type === "issue.closed")?.payload;
/** Evidence recorded by the first close. */
export const closeEvidence = (i?: Issue): { type?: string; command?: string }[] => closeEvent(i)?.evidence ?? [];
/** Transcript (agent, session_id) recorded by the first close. */
export const closeTranscript = (i?: Issue): { agent?: string; session_id?: string } | undefined => closeEvent(i)?.transcript;

/** The records of a JSONL file the smoke run writes; none while it does not exist yet. */
export function linesIn<T>(file: string | undefined): T[] {
	return file && existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
}

// ---- Command line ----
const argv = process.argv.slice(2);
export const flag = (name: string) => argv.includes(name);
/** The value that follows `name`. */
export const option = (name: string) => flag(name) ? argv[argv.indexOf(name) + 1] : undefined;
export const verbose = flag("--verbose");
/** The scenarios `--scenario <name>` picks, all of them without it. An unknown name ends the process; `own` names the scenarios the caller runs outside `all`. */
export function pickScenarios<S extends { name: string }>(all: S[], own: string[] = []): S[] {
	const picked = option("--scenario");
	if (!picked) return all;
	const scenarios = all.filter(s => s.name === picked);
	if (!scenarios.length && !own.includes(picked)) { console.error(`Unknown scenario ${picked}. Known: ${[...all.map(s => s.name), ...own].join(", ")}`); process.exit(2); }
	return scenarios;
}

// ---- Environment and teardown ----
// Inherited routing would point the child at someone else's Kata, and an inherited transcript session would hide whether the plugin exports its own.
const ROUTING = /^KATA_(SERVER|DAEMON|AUTH_TOKEN|REF|HOME|DEFAULT_PROJECT)$/;
/** This process's environment without Kata's routing and transcript variables, and without the ones `also` matches. */
export const cleanEnv = (also?: RegExp): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env)
	.filter(([key]) => !ROUTING.test(key) && !(TRANSCRIPT_ENV as readonly string[]).includes(key) && !also?.test(key)));

const cleanups: (() => void)[] = [];
/** Undoes everything still registered, newest first. */
export function teardown() {
	for (let undo = cleanups.pop(); undo; undo = cleanups.pop()) { try { undo(); } catch {} }
}
/** Registers `undo` for the teardown. The returned function runs it now instead, once. */
export function defer(undo: () => void): () => void {
	cleanups.push(undo);
	return () => {
		const at = cleanups.indexOf(undo);
		if (at < 0) return;
		cleanups.splice(at, 1);
		undo();
	};
}
/** Makes the run's throwaway root. The teardown removes it last, and from here on an interrupt tears the run down before it exits. */
export function scratchRoot(prefix: string): string {
	const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
	defer(() => rmSync(root, { recursive: true, force: true }));
	for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { teardown(); process.exit(130); });
	return root;
}

// ---- Kata ----
type Listed = { uid: string; short_id: string; title: string; status: string; owner?: string; metadata?: Record<string, unknown> };
type Logged = { issue_uid: string; type: string; payload: unknown };
/** Kata in one folder of the run, under `env`; `name` is the project `init` creates there. The teardown stops its daemon. */
export function kataProject(env: NodeJS.ProcessEnv, cwd: string, name: string) {
	const kata = (args: string[], extra: NodeJS.ProcessEnv = {}): string => {
		const out = spawnSync("kata", args, { env: { ...env, ...extra }, cwd, encoding: "utf8", timeout: 15_000 });
		if (out.status !== 0) throw new Error(`kata ${args.join(" ")}: ${out.stderr || out.error}`);
		return out.stdout;
	};
	return {
		/** Runs kata from outside the host and returns its stdout; a failed call throws. */
		kata,
		/** Makes the folder a Git folder holding the project. `config` becomes KATA_HOME/config.toml first. */
		init(config?: string) {
			if (config) writeFileSync(path.join(env.KATA_HOME!, "config.toml"), config);
			spawnSync("git", ["init", "-q", "."], { cwd });
			kata(["init", "--project", name]);
		},
		/** Creates an issue and returns its short id. */
		create: (title: string): string => JSON.parse(kata(["create", title, "--force-new", "--json"])).issue.short_id,
		/** Short ids of the children of an issue. */
		children(ref: string): string[] {
			const children: Listed[] = JSON.parse(kata(["show", ref, "--json"])).children ?? [];
			return children.map(c => c.short_id);
		},
		/** Every issue in the project, each with its events. */
		async issues(): Promise<Issue[]> {
			const listed: Listed[] = JSON.parse(kata(["list", "--status", "all", "--limit", "0", "--json"])).issues;
			const events: Logged[] = JSON.parse(kata(["events", "--project", name, "--after", "0", "--limit", "10000", "--json"])).events;
			return listed.map(i => ({
				ref: i.short_id, title: i.title, status: i.status, owner: i.owner, metadata: i.metadata ?? {},
				events: events.filter(e => e.issue_uid === i.uid).map(e => ({ type: e.type, payload: e.payload })),
			}));
		},
		/** Stops the daemon now rather than at the teardown. */
		stopDaemon: defer(() => void spawnSync("kata", ["daemon", "stop"], { env, cwd, stdio: "ignore", timeout: 15_000 })),
	};
}

// ---- Child processes ----
/** The last lines of a child's output, for the detail of a failed check. */
export const lastLines = (output: string, count = 20) => output.trim().split("\n").slice(-count).join("\n");
/**
 * Runs a command to its end and returns its exit code with its stdout and stderr as one text, printed under --verbose.
 * The command is killed after `timeout` ms, and by a teardown that comes first.
 */
export async function runToEnd(file: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd: string; timeout: number }): Promise<{ code: number | null; output: string }> {
	const child = spawn(file, args, { env: options.env, cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	child.stdout.on("data", d => output += d);
	child.stderr.on("data", d => output += d);
	// A command that cannot start reports an error and then closes. Unheard, the error would end the run before its teardown.
	child.on("error", error => output += `${error}\n`);
	const kill = () => void child.kill("SIGKILL");
	const settled = defer(kill);
	const timer = setTimeout(kill, options.timeout);
	const code = await new Promise<number | null>(resolve => child.on("close", resolve));
	clearTimeout(timer);
	settled();
	if (verbose) console.log(output);
	return { code, output };
}

// ---- Report ----
let failures = 0;
export function report(name: string, ok: boolean, detail?: string) {
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
}
/** Reports the checks `run` returns; a `run` that throws is one failed check. */
export async function reportChecks(run: () => Check[] | Promise<Check[]>) {
	let checks: Check[];
	try { checks = await run(); }
	catch (error) { checks = [{ name: "store readable", ok: false, detail: String(error) }]; }
	for (const check of checks) report(check.name, check.ok, check.detail);
}
/** Prints the run's verdict and returns its exit code. */
export function verdict(): number {
	console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
	return failures ? 1 : 0;
}
