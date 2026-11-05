import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { assertIsolated } from "./isolation";
import { adoptIsolatedKata, isolatedKata } from "./kata-fixture";
import ompKata, { createInboxFollower, deliveryText, parseStreamLine, slotKey, type InboxFollowerDeps } from "../kata";
assertIsolated();

// ------------------------------------------------------------------ follower, no Kata
const ADDRESS = "lead/worker", KEY = slotKey(ADDRESS);
const tick = async (times = 4) => { for (let i = 0; i < times; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

function fakeStream() {
	const queue: string[] = [];
	let wake: (() => void) | undefined, done = false;
	let finish!: () => void;
	const exited = new Promise<void>(resolve => { finish = resolve; });
	return {
		killed: 0,
		push(line: string) { queue.push(line); wake?.(); },
		end() { done = true; wake?.(); finish(); },
		exited,
		async *lines() {
			for (;;) {
				if (queue.length) { yield queue.shift()!; continue; }
				if (done) return;
				await new Promise<void>(resolve => { wake = resolve; });
			}
		},
	};
}

function slotLine(id: number, issue: string, to: object | null, o: { from?: object | null } = {}) {
	return JSON.stringify({ event_id: id, type: "issue.metadata_updated", project_name: "proj", issue_short_id: issue, payload: { diff: { [KEY]: { from: o.from ?? null, to } } } });
}
const slot = (message: string, extra: object = {}) => ({ from: "lead", message, ...extra });

function follower(options: { requests?: () => unknown[]; read?: () => Promise<unknown>; head?: () => Promise<number>; actor?: () => Promise<string>; spawn?: (cursor?: number) => any } = {}) {
	const streams: ReturnType<typeof fakeStream>[] = [], cursors: (number | undefined)[] = [];
	const delivered: string[] = [], published: string[] = [], timers: (() => void)[] = [], debugged: unknown[] = [];
	let reads = 0;
	const deps: InboxFollowerDeps = {
		address: ADDRESS,
		actor: options.actor ?? (async () => "lead"),
		read: async () => { reads++; return options.read ? options.read() : { requests: options.requests?.() ?? [] }; },
		spawn: cursor => {
			cursors.push(cursor);
			if (options.spawn) return options.spawn(cursor);
			const s = fakeStream();
			streams.push(s);
			return { lines: s.lines(), exited: s.exited, kill: () => { s.killed++; s.end(); } };
		},
		deliver: text => delivered.push(text),
		publish: text => published.push(text),
		trusted: (requests, mine) => ({ text: (Array.isArray(requests) ? requests : []).filter((r: any) => r.from === mine).map((r: any) => `${r.ref}:${r.message}`).join("|") }),
		head: options.head ?? (async () => 0),
		setTimer: fn => { timers.push(fn); return timers.length; },
		clearTimer: () => { timers.length = 0; },
		debug: error => debugged.push(error),
	};
	return { follow: createInboxFollower(deps), streams, cursors, delivered, published, timers, debugged, reads: () => reads };
}

test("parseStreamLine reads a slot write, a clear and a reset frame, and ignores other keys", () => {
	expect(parseStreamLine(slotLine(5, "abcd", slot("hi", { re: "c:1", kind: "reply" })), KEY)).toMatchObject({ type: "slot", key: "abcd", ref: "proj#abcd", eventId: 5, to: { from: "lead", message: "hi", re: "c:1", kind: "reply" } });
	expect(parseStreamLine(slotLine(6, "abcd", null), KEY)).toMatchObject({ type: "slot", eventId: 6, to: null });
	expect(parseStreamLine('{"reset_required":true,"reset_after_id":42}', KEY)).toEqual({ type: "reset", after: 42 });
	expect(parseStreamLine(slotLine(7, "abcd", slot("x")), slotKey("other/addr"))).toBeUndefined();
	expect(parseStreamLine("not json " + KEY, KEY)).toBeUndefined();
});

test("a new trusted request is delivered once; a replay and an unchanged value are not delivered again", async () => {
	const t = follower();
	t.follow.start(); await tick();
	t.streams[0].push(slotLine(5, "abcd", slot("first")));
	t.streams[0].push(slotLine(5, "abcd", slot("first")));
	t.streams[0].push(slotLine(6, "abcd", slot("first")));
	await tick();
	expect(t.delivered).toHaveLength(1);
	expect(t.delivered[0]).toBe(deliveryText("proj#abcd", ADDRESS, slot("first")));
	expect(t.delivered[0]).toContain("kata notify proj#abcd --to lead/worker --clear");
	t.streams[0].push(slotLine(7, "abcd", slot("second")));
	await tick();
	expect(t.delivered).toHaveLength(2);
	expect(t.published.at(-1)).toBe("abcd:second");
	t.follow.stop();
});

test("a clear delivers nothing and removes the request from the section", async () => {
	const t = follower();
	t.follow.start(); await tick();
	t.streams[0].push(slotLine(5, "abcd", slot("first")));
	await tick();
	t.streams[0].push(slotLine(6, "abcd", null));
	await tick();
	expect(t.delivered).toHaveLength(1);
	expect(t.published.at(-1)).toBe("");
	t.follow.stop();
});

test("the stream starts at the head, and requests that existed then are shown but never delivered", async () => {
	const t = follower({ head: async () => 40, requests: () => [{ ref: "abcd", title: "T", ...slot("pending") }] });
	t.follow.start(); await tick();
	expect(t.cursors).toEqual([40]);
	expect(t.published.at(-1)).toBe("abcd:pending");
	expect(t.delivered).toEqual([]);
	t.streams[0].push(slotLine(41, "wxyz", slot("new")));
	await tick();
	expect(t.delivered).toHaveLength(1);
	t.streams[0].end(); await tick();
	t.timers[0](); await tick();
	expect(t.cursors).toEqual([40, 41]);
	t.follow.stop();
});

test("nothing is spawned or delivered until the head is known; a failing head read backs off and retries", async () => {
	let heads = 0;
	const t = follower({ head: async () => { if (++heads === 1) throw new Error("kata down"); return 7; } });
	t.follow.start(); await tick();
	expect(t.cursors).toEqual([]);
	expect(t.timers).toHaveLength(1);
	t.timers.shift()!(); await tick();
	expect(t.cursors).toEqual([7]);
	expect(t.debugged).toHaveLength(1);
	t.follow.stop();
});

test("a request that landed between the head and the start read is delivered once, not twice", async () => {
	const t = follower({ requests: () => [{ ref: "abcd", ...slot("raced") }] });
	t.follow.start(); await tick();
	t.streams[0].push(slotLine(9, "abcd", slot("raced")));
	t.streams[0].push(slotLine(9, "abcd", slot("raced")));
	await tick();
	expect(t.delivered).toHaveLength(1);
	t.follow.stop();
});

test("a request from another actor is neither delivered nor shown", async () => {
	const t = follower();
	t.follow.start(); await tick();
	t.streams[0].push(slotLine(5, "abcd", { from: "mallory", message: "forged" }));
	await tick();
	expect(t.delivered).toEqual([]);
	expect(t.published.at(-1)).toBe("");
	t.follow.stop();
});

test("a blank message is not delivered", async () => {
	const t = follower();
	t.follow.start(); await tick();
	t.streams[0].push(slotLine(5, "abcd", slot("   ")));
	await tick();
	expect(t.delivered).toEqual([]);
	t.follow.stop();
});

test("a message written while the stream was down is delivered once after the reconnect", async () => {
	let inbox: unknown[] = [];
	const t = follower({ requests: () => inbox });
	t.follow.start(); await tick();
	t.streams[0].push(slotLine(5, "abcd", slot("before")));
	await tick();
	expect(t.delivered).toHaveLength(1);
	t.streams[0].end(); await tick();
	expect(t.timers).toHaveLength(1);
	inbox = [{ ref: "abcd", ...slot("before") }, { ref: "wxyz", ...slot("while down") }];
	t.timers[0](); await tick();
	expect(t.cursors).toEqual([undefined, 5]);
	expect(t.delivered).toHaveLength(2);
	expect(t.delivered[1]).toContain("while down");
	// The resumed stream then replays the same event: still one delivery.
	t.streams[1].push(slotLine(8, "wxyz", slot("while down")));
	await tick();
	expect(t.delivered).toHaveLength(2);
	t.follow.stop();
});

test("a read that began before a stream change does not overwrite it", async () => {
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const t = follower({ read: async () => { await gate; return { requests: [{ ref: "abcd", ...slot("old") }] }; } });
	t.follow.start(); await tick();
	t.streams[0].push(slotLine(5, "abcd", slot("new")));
	await tick();
	expect(t.delivered).toHaveLength(1);
	release(); await tick();
	expect(t.published.at(-1)).toBe("abcd:new");
	expect(t.delivered).toHaveLength(1);
	t.follow.stop();
});

test("a reset frame re-reads the inbox and moves the cursor", async () => {
	let inbox: unknown[] = [];
	const t = follower({ requests: () => inbox });
	t.follow.start(); await tick();
	const before = t.reads();
	inbox = [{ ref: "abcd", ...slot("after reset") }];
	t.streams[0].push('{"reset_required":true,"reset_after_id":77}');
	await tick();
	expect(t.reads()).toBe(before + 1);
	expect(t.delivered).toHaveLength(1);
	t.streams[0].end(); await tick();
	t.timers[0](); await tick();
	expect(t.cursors.at(-1)).toBe(77);
	t.follow.stop();
});

test("stop kills the stream child, cancels the restart and ignores lines of the stopped generation", async () => {
	const t = follower();
	t.follow.start(); await tick();
	const first = t.streams[0];
	t.follow.stop();
	expect(first.killed).toBe(1);
	first.push(slotLine(5, "abcd", slot("late")));
	await tick();
	expect(t.delivered).toEqual([]);
	expect(t.timers).toHaveLength(0);
	t.follow.start(); await tick();
	expect(t.streams).toHaveLength(2);
	t.follow.stop();
	expect(t.streams[1].killed).toBe(1);
});

test("a failing spawn or actor lookup backs off quietly and recovers", async () => {
	let spawns = 0, actorCalls = 0;
	const t = follower({
		actor: async () => { if (++actorCalls === 1) throw new Error("kata down"); return "lead"; },
		spawn: () => { if (++spawns === 1) throw new Error("no kata"); const s = fakeStream(); t.streams.push(s); return { lines: s.lines(), exited: s.exited, kill: () => s.end() }; },
	});
	t.follow.start(); await tick();
	expect(t.timers).toHaveLength(1);
	t.timers.shift()!(); await tick();
	expect(spawns).toBe(1);
	expect(t.timers).toHaveLength(1);
	t.timers.shift()!(); await tick();
	expect(spawns).toBe(2);
	t.streams[0].push(slotLine(5, "abcd", slot("ok")));
	await tick();
	expect(t.delivered).toHaveLength(1);
	expect(t.debugged.length).toBeGreaterThanOrEqual(2);
	t.follow.stop();
});

// ------------------------------------------------------------------ omp adapter, real Kata
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
	const sid = `live-${++sequence}`;
	const handlers = new Map<string, any>(), sent: any[][] = [], calls: string[][] = [];
	const schema: any = new Proxy(() => schema, { get: () => schema });
	const ctx: any = {
		cwd,
		agent: options.agent ?? { kind: "main", id: `main-${sid}` },
		sessionManager: { getSessionId: () => sid, getSessionFile: () => `${scratch}/${sid}.jsonl`, getBranch: () => [], getHeader: () => undefined },
		getAsyncJobSnapshot: () => ({ running: [], recent: [] }),
		ui: { notify() {}, setWidget() {} },
	};
	ompKata({ zod: schema, registerTool() {}, appendEntry() {}, on: (name: string, callback: any) => handlers.set(name, callback), events: { on() {} },
		sendUserMessage: (...args: any[]) => { sent.push(args); },
		async exec(_file: string, args: string[], opts: any) { calls.push(args); return run(args, opts.cwd, opts.timeout); } });
	const event = async (name: string, data: any = {}) => {
		try { return await handlers.get(name)?.(data, ctx); }
		finally { delete process.env.KATA_TRANSCRIPT_AGENT; delete process.env.KATA_TRANSCRIPT_SESSION_ID; }
	};
	const section = async () => ((await event("before_agent_start", { systemPrompt: ["base"] }))?.systemPrompt ?? []).join("\n");
	return { sent, calls, event, section };
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

test("a request pending at session start is shown but not delivered", async () => {
	const address = "v2-builder/live-pending";
	const ref = await issue();
	await kata(["notify", ref, "--to", address, "--message", "pending-before-start-3310", "--json"]);
	const app = await open(address);
	let shown = "";
	for (let i = 0; i < 40 && !shown.includes("pending-before-start-3310"); i++) { shown = await app.section(); if (!shown.includes("pending-before-start-3310")) await settle(50); }
	expect(shown).toContain("pending-before-start-3310");
	await settle();
	expect(app.sent).toEqual([]);
	await kata(["notify", ref, "--to", address, "--clear", "--json"]);
});

test("a request written by another actor is not delivered or shown", async () => {
	const address = "v2-builder/live-forged";
	const app = await open(address);
	const ref = await issue();
	await until(() => app.calls.some(a => a[0] === "inbox"));
	await kata(["notify", ref, "--to", address, "--message", "forged-live-5501", "--json"], { KATA_AUTHOR: "mallory" });
	await settle();
	expect(app.sent).toEqual([]);
	expect(await app.section()).not.toContain("forged-live-5501");
	await kata(["notify", ref, "--to", address, "--clear", "--json"], { KATA_AUTHOR: "mallory" });
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
