// Smoke test: load the Claude Code mod into a real, headless `claude -p` against a real Kata daemon, and check what lands
// in a throwaway Kata store.
//
//   bun run smoke:claude [--model haiku] [--verbose]
//
// THIS RUN IS PAID. Claude Code has no scripted model provider, so a real model does the work: it needs a Claude Code
// login (`claude auth login`; a subscription is billed as usage, an API key by the token) and spends a few cents on haiku.
// Run it before a release and after each Claude Code release; never from CI. The Kata store is a throwaway one (a fresh
// KATA_HOME, in a fresh Git folder), but Claude Code itself runs with your own config directory and its login, so it may
// update that directory as in any run. The mod loads from this checkout with `--plugin-dir`; it is not installed.
// Model behaviour can fail a run that the plugin did right, so a failure prints the store to tell the two apart.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { cleanEnv, closeCount, closeEvent, closeEvidence, closeTranscript, commentsOn, kataProject, lastLines, option, report, reportChecks, runToEnd, scratchRoot, teardown, verdict, type Check, type Issue } from "./smoke-lib";

const root = path.resolve(import.meta.dirname, "..");
const model = option("--model") ?? "haiku";
const PROJECT = "claude-smoke";
const TIMEOUT_MS = 600_000;
const WRITE = "Write notes", VERIFY = "Verify notes";

const login = spawnSync("claude", ["auth", "status"], { encoding: "utf8", timeout: 30_000 });
if (login.status !== 0 || !/"loggedIn":\s*true/.test(login.stdout)) { console.error("smoke:claude needs a Claude Code login (`claude auth login`). The run is paid."); process.exit(2); }
console.log(`smoke:claude is a paid run: one headless claude -p on ${model}.`);

const tmp = scratchRoot("claude-kata-smoke-");
const work = path.join(tmp, "repo"), kataHome = path.join(tmp, "kata");
mkdirSync(work); mkdirSync(kataHome);
// A smoke started from inside a Claude Code session must not inherit that session's identity.
const env: NodeJS.ProcessEnv = { ...cleanEnv(/^(KATA_CLAUDE_|CLAUDE_CODE_SESSION_ID$)/), KATA_HOME: kataHome };
const sessionId = randomUUID();
const project = kataProject(env, work, PROJECT);

const prompt = [
	"Plan with your todo tool only, never the Task tools or TodoWrite.",
	`1. Make a plan of exactly two tasks, titled "${WRITE}" and "${VERIFY}".`,
	`2. Start "${WRITE}", create notes.txt in this folder containing the line smoke-ok, then mark the task done with a message of at least 40 characters and the command \`cat notes.txt\` as its evidence.`,
	`3. Hand "${VERIFY}" to a subagent: call the Agent tool (general-purpose) with a prompt that starts with the exact words "${VERIFY}" and asks it to check with \`grep smoke-ok notes.txt\` that notes.txt holds smoke-ok. It must follow the Kata assignment it is given: comment on its issue what it did and close that issue with the grep as evidence.`,
	"4. When it reports back, answer DONE. Do nothing else.",
].join("\n");

function checks(issues: Issue[], exit: { code: number | null; output: string }): Check[] {
	const parents = issues.filter(i => i.metadata["claude.auto_parent"] === true);
	const parent = parents[0];
	const tasks = issues.filter(i => i !== parent && !i.metadata["claude.mission"]);
	const write = tasks.find(i => i.title.includes(WRITE)), verify = tasks.find(i => i.title.includes(VERIFY));
	return [
		{ name: "claude exited cleanly", ok: exit.code === 0, detail: `exit ${exit.code}\n${lastLines(exit.output)}` },
		{ name: "one automatic parent was made for the session", ok: parents.length === 1 && parent.metadata["claude.session_id"] === sessionId, detail: JSON.stringify(parents.map(p => [p.ref, p.metadata])) },
		{ name: "the plan has its two tasks under the parent", ok: !!write && !!verify, detail: JSON.stringify(issues.map(i => [i.ref, i.title, i.status])) },
		{ name: `"${WRITE}" is closed with evidence and the session's transcript`, ok: write?.status === "closed" && closeEvidence(write).length > 0 && closeTranscript(write)?.agent === "claude" && closeTranscript(write)?.session_id === sessionId, detail: JSON.stringify(closeEvent(write)) },
		{ name: `"${VERIFY}" was bound to the subagent: its issue carries the lead's session`, ok: verify?.metadata["claude.session_id"] === sessionId, detail: JSON.stringify(verify?.metadata) },
		{ name: `the subagent closed "${VERIFY}" itself, once, with evidence and a comment of its own`, ok: verify?.status === "closed" && closeCount(verify) === 1 && closeEvidence(verify).length > 0 && commentsOn(verify).some(c => !c.startsWith("Done:")), detail: JSON.stringify(verify?.events) },
		{ name: `"${VERIFY}" was returned to the lead: no subagent id left on it`, ok: !!verify && verify.metadata["claude.subagent_id"] === undefined, detail: JSON.stringify(verify?.metadata) },
		{ name: "no task was handed back for review", ok: tasks.every(i => !i.events.some(e => JSON.stringify(e.payload).includes("needs-review"))), detail: JSON.stringify(tasks.map(i => [i.ref, i.events.map(e => e.type)])) },
		{ name: "the parent was closed at session end, after its children", ok: parent?.status === "closed" && closeCount(parent) === 1 && closeTranscript(parent)?.agent === "claude", detail: JSON.stringify([parent?.status, closeEvent(parent)]) },
	];
}

try {
	project.init();
	const args = ["-p", prompt, "--model", model, "--plugin-dir", path.join(root, "plugins/claude-code"), "--session-id", sessionId,
		"--permission-mode", "bypassPermissions", "--max-budget-usd", "1"];
	console.log(`\n# claude -p (live, ${model}) in ${work}`);
	const exit = await runToEnd("claude", args, { env, cwd: work, timeout: TIMEOUT_MS });
	let issues = await project.issues().catch(() => [] as Issue[]);
	// The parent closes while the session ends; give a slow Kata a moment before judging.
	for (let waited = 0; waited < 10_000 && !issues.some(i => i.metadata["claude.auto_parent"] === true && i.status === "closed"); waited += 500) {
		await sleep(500);
		issues = await project.issues().catch(() => issues);
	}
	await reportChecks(() => checks(issues, exit));
	if (verdict() !== 0) {
		console.log("\nStore at the end of the run:");
		for (const i of issues) console.log(JSON.stringify({ ref: i.ref, title: i.title, status: i.status, metadata: i.metadata, events: i.events.map(e => e.type) }));
		console.log(`\nclaude output:\n${lastLines(exit.output, 40)}`);
		process.exitCode = 1;
	}
} catch (error) {
	report("run", false, String(error));
	process.exitCode = 1;
} finally {
	project.stopDaemon();
	teardown();
}
process.exit(process.exitCode ?? 0);
