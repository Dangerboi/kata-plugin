import { afterEach, expect, test } from "bun:test";
import { eventually, realKata, settle, unique, until } from "./kata-fixture";
import { ompHost } from "./omp-host";
import { TRANSCRIPT_ENV } from "../core/kata-cli";

// What the omp adapter wires around the session inbox module: when it follows live, the aside it delivers
// with, its stream child, and the sessions that never follow. The module itself is tested in live-inbox.test.ts.
const store = realKata({ prefix: "live", author: "v2-builder", project: "omp-v2-live", adopt: true });
const { scratch, cwd, run, kata } = store;
const issue = () => store.issue(`Live inbox ${unique()}`);
const children = () => Bun.spawnSync(["pgrep", "-f", `events --tail --json --workspace ${cwd}`]).stdout.toString().split("\n").filter(Boolean);

function host(options: { agent?: object; sessionFile?: string } = {}) {
	const sid = `live-${unique()}`, sent: any[][] = [];
	const app = ompHost({ run: (args, opts) => run(args, opts.cwd, opts.timeout), cwd, sid, sessionFile: options.sessionFile ?? `${scratch}/${sid}.jsonl`, agent: options.agent,
		sendUserMessage: (...args) => { sent.push(args); },
		afterEvent: () => { for (const key of TRANSCRIPT_ENV) delete process.env[key]; } });
	const section = async () => ((await app.event("before_agent_start", { systemPrompt: ["base"] }))?.systemPrompt ?? []).join("\n");
	return { sent, calls: app.calls, event: app.event, section, emit: app.emit, ctx: app.ctx };
}

const apps: ReturnType<typeof host>[] = [];
const open = async (address: string, options: Parameters<typeof host>[0] = {}) => {
	process.env.KATA_INBOX_USER = address;
	const app = host(options); apps.push(app);
	await app.event("session_start");
	return app;
};
afterEach(async () => { for (const app of apps.splice(0)) await app.event("session_shutdown"); });

test("a notify reaches the main session as an aside, the section is current without an inbox read, and a clear delivers nothing", async () => {
	const address = "v2-builder/live-main";
	const app = await open(address);
	const ref = await issue();
	expect(await until(() => app.calls.some(a => a[0] === "inbox"))).toBe(true);
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
	process.env.KATA_INBOX_POLL_SECONDS = "0";
	expect(await app.event("tool_result", { toolName: "read", content: [], isError: false })).toBeUndefined();
	await settle();
	expect(app.calls.filter(a => a[0] === "inbox").length).toBe(reads);
	await kata(["notify", ref, "--to", address, "--clear", "--json"]);
	// The stream is ordered: a later notify is delivered after the clear, so the clear was processed before it reached us.
	const sentinel = await issue();
	await kata(["notify", sentinel, "--to", address, "--message", "after-clear-5530", "--json"]);
	expect(await until(() => app.sent.length === 2)).toBe(true);
	expect(app.sent[1][0]).toContain("after-clear-5530");
	await kata(["notify", sentinel, "--to", address, "--clear", "--json"]);
	await eventually(async () => (await app.section()).includes("live-ping-8841"), false);
});

test("nothing is delivered after session shutdown", async () => {
	const address = "v2-builder/live-shutdown";
	const app = await open(address);
	const ref = await issue();
	expect(await until(() => app.calls.some(a => a[0] === "inbox"))).toBe(true);
	await app.event("session_shutdown");
	await kata(["notify", ref, "--to", address, "--message", "after-shutdown-2207", "--json"]);
	// A stopped stream child cannot deliver.
	expect(await until(() => children().length === 0)).toBe(true);
	expect(app.sent).toEqual([]);
	await kata(["notify", ref, "--to", address, "--clear", "--json"]);
});

test("a session switch kills the old stream child and leaves exactly one", async () => {
	const address = "v2-builder/live-switch";
	const app = await open(address);
	expect(await until(() => children().length === 1)).toBe(true);
	const [first] = children();
	await app.event("session_switch");
	expect(await until(() => children().length === 1 && children()[0] !== first)).toBe(true);
	await settle();
	expect(children()).toHaveLength(1);
});

test("a delegate starts no follower and keeps the per-turn section of its own address", async () => {
	const lead = await open("v2-builder/live-delegate-lead");
	const sessionFile = `${scratch}/live-delegate.jsonl`;
	lead.emit("task:subagent:lifecycle", { id: "Worker", agent: "scout", status: "started", sessionFile, description: "Survey the tree" });
	await lead.section();
	const worker = host({ sessionFile, agent: { kind: "sub", id: "Worker", parentId: lead.ctx.agent.id } }); apps.push(worker);
	await worker.event("session_start");
	const address = /Your Kata inbox is (\S+?);/.exec(await worker.section())?.[1];
	expect(address).toMatch(/^v2-builder\/.+/);
	expect(address).not.toBe("v2-builder/live-delegate-lead");
	const ref = await issue();
	await kata(["notify", ref, "--to", address!, "--message", "delegate-note-6602", "--json"]);
	expect(await worker.section()).toContain("delegate-note-6602");
	expect(worker.calls.some(a => a[0] === "events")).toBe(false);
	expect(worker.sent).toEqual([]);
	await kata(["notify", ref, "--to", address!, "--clear", "--json"]);
});

test("KATA_OMP_LIVE_INBOX=0 delivers nothing live and keeps the per-turn section", async () => {
	process.env.KATA_OMP_LIVE_INBOX = "0";
	const address = "v2-builder/live-off";
	const app = await open(address);
	const ref = await issue();
	await kata(["notify", ref, "--to", address, "--message", "per-turn-only-9912", "--json"]);
	expect(await app.section()).toContain("per-turn-only-9912");
	expect(app.calls.some(a => a[0] === "events")).toBe(false);
	expect(app.sent).toEqual([]);
	await kata(["notify", ref, "--to", address, "--clear", "--json"]);
});

test("a bare actor address starts no follower", async () => {
	const app = await open("v2-builder");
	const ref = await issue();
	await kata(["notify", ref, "--to", "v2-builder", "--message", "person-only-live-1", "--json"]);
	await app.section();
	expect(app.calls.some(a => a[0] === "events")).toBe(false);
	expect(app.sent).toEqual([]);
	await kata(["notify", ref, "--to", "v2-builder", "--clear", "--json"]);
});
