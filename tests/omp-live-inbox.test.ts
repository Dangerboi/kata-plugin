import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { assertIsolated } from "./isolation";
import { adoptIsolatedKata, isolatedKata } from "./kata-fixture";
import { ompHost } from "./omp-host";
assertIsolated();

// What the omp adapter wires around the session inbox module: when it follows live, the aside it delivers
// with, its stream child, and the sessions that never follow. The module itself is tested in live-inbox.test.ts.
const binary = process.env.KATA_TEST_EXECUTABLE!;
if (!binary || !path.isAbsolute(binary)) throw new Error("Set KATA_TEST_EXECUTABLE to the absolute Kata binary.");
const scratch = mkdtempSync(path.join(process.env.KATA_TEST_ROOT!, "live-"));
const cwd = path.join(scratch, "workspace");
mkdirSync(cwd);
const env = { ...process.env, KATA_HOME: path.join(scratch, "home"), KATA_AUTHOR: "v2-builder" };
for (const key of ["KATA_SERVER", "KATA_DAEMON", "KATA_AUTH_TOKEN", "KATA_REF", "KATA_TEAMMATE", "KATA_INBOX_USER", "KATA_OMP_LIVE_INBOX"]) delete env[key];
const run = isolatedKata(binary, env, cwd, 5000);
async function kata(args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<any> {
	const out = await run(args, cwd, 5000, extraEnv);
	if (out.code) throw new Error(out.stderr);
	return JSON.parse(out.stdout);
}
let sequence = 0;
const issue = async () => (await kata(["create", `Live inbox ${++sequence}`, "--force-new", "--json"])).issue.short_id;
const until = async (condition: () => boolean, ms = 8000) => { const end = Date.now() + ms; while (!condition() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 25)); return condition(); };
// Integration tests against a real stream: "nothing was delivered" can only be observed by waiting out the stream's latency.
const settle = (ms = 700) => new Promise(resolve => setTimeout(resolve, ms));

function host(options: { agent?: object } = {}) {
	const sid = `live-${++sequence}`, sent: any[][] = [];
	const app = ompHost({ run: (args, opts) => run(args, opts.cwd, opts.timeout), cwd, sid, sessionFile: `${scratch}/${sid}.jsonl`, agent: options.agent,
		sendUserMessage: (...args) => { sent.push(args); },
		afterEvent: () => { delete process.env.KATA_TRANSCRIPT_AGENT; delete process.env.KATA_TRANSCRIPT_SESSION_ID; } });
	const section = async () => ((await app.event("before_agent_start", { systemPrompt: ["base"] }))?.systemPrompt ?? []).join("\n");
	return { sent, calls: app.calls, event: app.event, section };
}

let restore: (() => void) | undefined;
const apps: ReturnType<typeof host>[] = [];
const open = async (address: string, options: Parameters<typeof host>[0] = {}) => {
	process.env.KATA_INBOX_USER = address;
	const app = host(options); apps.push(app);
	await app.event("session_start");
	return app;
};
beforeAll(async () => { const out = await run(["init", "--project", "omp-v2-live"]); if (out.code) throw new Error(out.stderr); });
beforeEach(() => { restore = adoptIsolatedKata(binary, env.KATA_HOME); process.env.KATA_AUTHOR = "v2-builder"; for (const key of ["KATA_REF", "KATA_TEAMMATE", "KATA_INBOX_USER", "KATA_OMP_LIVE_INBOX"]) delete process.env[key]; });
afterEach(async () => { for (const app of apps.splice(0)) await app.event("session_shutdown"); restore?.(); });
afterAll(async () => { await run(["daemon", "stop"]); });

test("a notify reaches the main session as an aside, the section is current without an inbox read, and a clear delivers nothing", async () => {
	const address = "v2-builder/live-main";
	const app = await open(address);
	const ref = await issue();
	await until(() => app.calls.some(a => a[0] === "inbox"));
	const reads = app.calls.filter(a => a[0] === "inbox").length;
	await kata(["notify", ref, "--to", address, "--message", "live-ping-8841", "--json"]);
	expect(await until(() => app.sent.length === 1)).toBe(true);
	expect(app.sent[0][1]).toEqual({ deliverAs: "aside", attribution: "agent" });
	expect(app.sent[0][0]).toContain("live-ping-8841");
	expect(app.sent[0][0]).toContain(`kata notify omp-v2-live#${ref} --to ${address} --clear`);
	const shown = await app.section();
	expect(shown).toContain("<kata_inbox>");
	expect(shown).toContain("live-ping-8841");
	await app.section();
	expect(app.calls.filter(a => a[0] === "inbox").length).toBe(reads);
	await kata(["notify", ref, "--to", address, "--clear", "--json"]);
	await settle();
	expect(app.sent).toHaveLength(1);
	let gone = false;
	for (let i = 0; i < 40 && !gone; i++) { gone = !(await app.section()).includes("live-ping-8841"); if (!gone) await settle(50); }
	expect(gone).toBe(true);
});

test("nothing is delivered after session shutdown", async () => {
	const address = "v2-builder/live-shutdown";
	const app = await open(address);
	const ref = await issue();
	await until(() => app.calls.some(a => a[0] === "inbox"));
	await app.event("session_shutdown");
	await kata(["notify", ref, "--to", address, "--message", "after-shutdown-2207", "--json"]);
	await settle(1000);
	expect(app.sent).toEqual([]);
	await kata(["notify", ref, "--to", address, "--clear", "--json"]);
});

test("a session switch kills the old stream child and leaves exactly one", async () => {
	const address = "v2-builder/live-switch";
	const app = await open(address);
	const children = () => Bun.spawnSync(["pgrep", "-f", `events --tail --json --workspace ${cwd}`]).stdout.toString().split("\n").filter(Boolean);
	expect(await until(() => children().length === 1)).toBe(true);
	const [first] = children();
	await app.event("session_switch");
	expect(await until(() => children().length === 1 && children()[0] !== first)).toBe(true);
	await settle();
	expect(children()).toHaveLength(1);
});

test("a delegate starts no follower and keeps the per-turn section", async () => {
	const address = "v2-builder/live-delegate";
	const app = await open(address, { agent: { kind: "sub", id: "Worker" } });
	const ref = await issue();
	await kata(["notify", ref, "--to", address, "--message", "delegate-note-6602", "--json"]);
	await settle();
	expect(app.sent).toEqual([]);
	await kata(["notify", ref, "--to", address, "--clear", "--json"]);
});

test("KATA_OMP_LIVE_INBOX=0 delivers nothing live and keeps the per-turn section", async () => {
	process.env.KATA_OMP_LIVE_INBOX = "0";
	const address = "v2-builder/live-off";
	const app = await open(address);
	const ref = await issue();
	await kata(["notify", ref, "--to", address, "--message", "per-turn-only-9912", "--json"]);
	await settle();
	expect(app.sent).toEqual([]);
	await app.section();
	expect(await app.section()).toContain("per-turn-only-9912");
	expect(app.calls.some(a => a[0] === "events")).toBe(false);
	await kata(["notify", ref, "--to", address, "--clear", "--json"]);
});

test("a bare actor address starts no follower", async () => {
	const app = await open("v2-builder");
	const ref = await issue();
	await kata(["notify", ref, "--to", "v2-builder", "--message", "person-only-live-1", "--json"]);
	await settle();
	expect(app.sent).toEqual([]);
	await kata(["notify", ref, "--to", "v2-builder", "--clear", "--json"]);
});
