import { afterEach, expect, test } from "bun:test";
import { realKata, unique, until } from "./kata-fixture";
import { ompHost } from "./omp-host";
import { TRANSCRIPT_ENV } from "../core/kata-cli";
import type { SessionView } from "../core/kata-core";
import { footerText, inboxText, kataCommand, REFRESHED, statusText, USAGE } from "../core/session-status";

// `/kata status|inbox|refresh` and the `kata` footer: the text from plain views, then omp wiring against a real Kata.
// pi's wiring is in pi-kata-command.test.ts, Claude Code's in claude-ui.test.ts.

const view = (over: Partial<SessionView> = {}): SessionView => ({
	workspace: "/home/a/repo", scope: "bound", outage: "", project: "kp", actor: "alice", teammate: "lead",
	inbox: { address: "alice/lead", delivery: "per prompt" }, refs: ["kp#12", "kp#14"], contract: 1834,
	counts: { trusted: 2, foreign: 1 }, settings: { executable: "kata", refGuard: true, liveInbox: false, debug: false }, ...over,
});

test("/kata status prints one label-value line each", () => {
	expect(statusText(view())).toBe([
		"workspace  /home/a/repo (project kp)",
		"actor      alice",
		"teammate   lead",
		"inbox      alice/lead · per prompt",
		"refs       kp#12, kp#14",
		"contract   1834 bytes",
		"requests   2 trusted · 1 request from another actor not shown",
		"settings   executable=kata · ref guard on · live inbox off · debug off",
	].join("\n"));
});

test("/kata status names each missing piece", () => {
	const lines = (v: SessionView) => Object.fromEntries(statusText(v).split("\n").map(l => [l.slice(0, 11).trim(), l.slice(11)]));
	const down = lines(view({ scope: "down", outage: "daemon unreachable\nmore", actor: undefined, actorError: "no actor\ntrace", teammate: "", refs: [], contract: "not-fetched", counts: undefined }));
	expect(down).toMatchObject({ workspace: "/home/a/repo (Kata unavailable: daemon unreachable)", actor: "unknown (no actor)", teammate: "none", refs: "none", contract: "not fetched yet", requests: "not read yet" });
	expect(lines(view({ scope: "unbound", project: "repo" })).workspace).toBe("/home/a/repo (not a Kata workspace — plans go to repo)");
	expect(lines(view({ inbox: { none: "unset" }, counts: undefined }))).toMatchObject({ inbox: "none — KATA_INBOX_USER is unset", requests: "none" });
	expect(lines(view({ inbox: { none: "personal" }, counts: undefined })).inbox).toBe("none — KATA_INBOX_USER names a personal inbox; set it to <user>/<name>");
	expect(lines(view({ inbox: { address: "alice/lead", delivery: "live" }, counts: { trusted: 0, foreign: 0 } }))).toMatchObject({ inbox: "alice/lead · live", requests: "none" });
	expect(lines(view({ inbox: { address: "alice/lead", delivery: "failed" } }))).toMatchObject({ inbox: "alice/lead · last read failed", requests: "read failed" });
	expect(lines(view({ contract: "off" })).contract).toBe("off — kata agent-hook supplies it");
	expect(lines(view({ inbox: { address: "alice/lead", delivery: "kata" }, counts: undefined }))).toMatchObject({ inbox: "alice/lead · kata supplies it", requests: "Kata supplies the inbox, without this plugin's actor filter" });
	expect(lines(view({ settings: { executable: "/opt/kata", refGuard: false, liveInbox: true, debug: true } })).settings).toBe("executable=/opt/kata · ref guard off · live inbox on · debug on");
});

test("the footer shows the address or actor, at most three refs and a nonzero inbox", () => {
	expect(footerText(view())).toBe("kata alice/lead · kp#12, kp#14 · inbox 2");
	expect(footerText(view({ inbox: { none: "unset" }, refs: [], counts: undefined }))).toBe("kata alice");
	expect(footerText(view({ refs: ["kp#1", "kp#2", "kp#3", "kp#4", "kp#5"], counts: undefined }))).toBe("kata alice/lead · kp#1, kp#2, kp#3 +2");
	expect(footerText(view({ scope: "down" }))).toBeUndefined();
	expect(footerText(view({ scope: "unbound" }))).toBeUndefined();
	expect(footerText(view({ inbox: { address: "alice/lead", delivery: "kata" }, counts: undefined }))).toBe("kata alice/lead · kp#12, kp#14");
});

test("/kata inbox labels the trusted lines for the person and counts the rest", () => {
	expect(inboxText({ address: "alice/lead", text: "\n- issue=\"kp#1\" message=\"hi\"", counts: { trusted: 1, foreign: 2 } }))
		.toBe('Kata inbox for "alice/lead" (shown here only; the next prompt is unchanged)\n- issue="kp#1" message="hi"\n2 requests from another actor not shown');
	expect(inboxText({ address: "alice/lead", text: "", counts: { trusted: 0, foreign: 0 } })).toBe('Kata inbox for "alice/lead" is empty');
	expect(inboxText({ address: "alice/lead", native: true, text: "\n- issue=\"kp#1\" message=\"hi\"", counts: { trusted: 1, foreign: 2 } }))
		.toBe('Kata inbox for "alice/lead" (this plugin\'s trusted view; Kata supplies the inbox without that filter)\n- issue="kp#1" message="hi"');
	expect(inboxText({ address: "alice/lead", native: true, text: "", counts: { trusted: 0, foreign: 3 } }))
		.toBe('Kata inbox for "alice/lead": this plugin\'s trusted view is empty; Kata supplies the inbox without that filter');
	expect(inboxText({ none: "unset" })).toBe("No session inbox: KATA_INBOX_USER is unset");
	expect(inboxText({ address: "alice/lead", failed: "daemon gone\nstack" })).toBe("Kata inbox read failed: daemon gone");
});

test("an unknown /kata subcommand prints the usage and reads nothing", async () => {
	const touched: string[] = [];
	const source = { view: async () => { touched.push("view"); return view(); }, inbox: async () => { touched.push("inbox"); return {}; }, refresh: () => { touched.push("refresh"); } };
	for (const args of ["explode", "toString", "status extra", "__proto__"]) expect(await kataCommand(source, {}, args)).toBe(USAGE);
	expect(touched).toEqual([]);
	expect(await kataCommand(source, {}, "  ")).toContain("workspace  /home/a/repo");
	expect(touched).toEqual(["view"]);
	expect(await kataCommand(source, {}, "refresh")).toBe(REFRESHED);
	expect(touched).toEqual(["view", "refresh"]);
});

// ------------------------------------------------------------------ omp

const store = realKata({ prefix: "kcmd", author: "kcmd-builder", project: "kcmd", adopt: true });
const { scratch, cwd, run, kata } = store;
const apps: { event: (name: string, data?: any, ctx?: any) => Promise<any> }[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.event("session_shutdown"); });

function omp(options: { agent?: object } = {}) {
	const sid = `kcmd-${unique()}`, statuses: [string, string | undefined][] = [];
	const app = ompHost({ run: (args, opts) => run(args, opts.cwd, opts.timeout), cwd, sid, sessionFile: `${scratch}/${sid}.jsonl`, agent: options.agent,
		afterEvent: () => { for (const key of TRANSCRIPT_ENV) delete process.env[key]; } });
	Object.assign(app.ctx, { hasUI: true });
	app.ctx.ui.setStatus = (key: string, value: string | undefined) => statuses.push([key, value]);
	apps.push(app);
	const command = (args: string, ctx: any = app.ctx) => app.commands.get("kata").handler(args, ctx);
	const notes = () => app.notices.filter((n: any[]) => n[1] === "info").map((n: any[]) => String(n[0]));
	return { ...app, statuses, command, notes, footer: () => statuses.filter(([key]) => key === "kata").at(-1)?.[1] };
}

/** Resolves once `calls` has not grown for `ms`: the background draws and reads a test started have finished. */
async function quiet(calls: unknown[], ms = 400) {
	for (let seen = -1; seen !== calls.length;) { seen = calls.length; await Bun.sleep(ms); }
}

test("omp registers /kata, answers status for the person and draws the footer", async () => {
	process.env.KATA_INBOX_USER = "kcmd-builder/omp-lead";
	const app = omp();
	expect(app.commands.has("kata")).toBe(true);
	await app.event("session_start");
	const parent = await app.init(["Status task"]);
	await app.event("before_agent_start", { systemPrompt: ["base"] });
	expect(await until(() => !!app.footer()?.startsWith("kata kcmd-builder/omp-lead"))).toBe(true);
	await quiet(app.calls);
	const atStatus = app.calls.length;
	await app.command("");
	// Each ref is checked once: status reconciles, and the footer redraw after it does not force a second pass.
	expect(app.calls.slice(atStatus).filter(args => args[0] === "show").map(args => args[1])).toEqual([parent]);
	const status = app.notes().at(-1)!;
	expect(status).toContain("actor      kcmd-builder");
	expect(status).toContain("inbox      kcmd-builder/omp-lead · per prompt");
	expect(status).toContain(`refs       ${parent}`);
	await app.command("refresh");
	expect(app.notes().at(-1)).toBe("Kata contract and actor cleared; the next prompt reads both again.");
	await quiet(app.calls);
	const before = app.calls.length, paints = app.statuses.length;
	await app.command("explode");
	expect(app.notes().at(-1)).toBe(USAGE);
	expect(app.calls.length).toBe(before);
	expect(app.statuses.length).toBe(paints);
	await app.event("session_shutdown"); apps.length = 0;
	expect(app.statuses.at(-1)).toEqual(["kata", undefined]);
});

test("omp /kata inbox shows the trusted inbox without changing the next prompt", async () => {
	const address = "kcmd-builder/omp-inbox";
	process.env.KATA_INBOX_USER = address;
	const app = omp();
	await app.event("session_start");
	const ref = await store.issue(`Inbox ${unique()}`);
	await kata(["notify", ref, "--to", address, "--message", "kcmd-ping-4410", "--json"]);
	const section = async () => ((await app.event("before_agent_start", { systemPrompt: ["base"] }))?.systemPrompt ?? []).join("\n");
	let prompt = "";
	for (let i = 0; i < 80 && !prompt.includes("kcmd-ping-4410"); i++) { prompt = await section(); if (!prompt.includes("kcmd-ping-4410")) await Bun.sleep(100); }
	expect(prompt).toContain("kcmd-ping-4410");
	await app.command("inbox"); await app.command("inbox");
	expect(app.notes().at(-1)).toStartWith(`Kata inbox for "${address}" (shown here only; the next prompt is unchanged)`);
	expect(app.notes().at(-1)).toContain("kcmd-ping-4410");
	expect(await section()).toBe(prompt);
	await kata(["notify", ref, "--to", address, "--clear", "--json"]);
});

test("a sub-agent omp context gets no footer and no /kata answer", async () => {
	const app = omp({ agent: { kind: "sub", id: "sub-1" } });
	await app.event("session_start");
	await app.event("before_agent_start", { systemPrompt: ["base"] });
	await app.command("status");
	expect(app.statuses).toEqual([]);
	expect(app.notes()).toEqual(["/kata answers in the main session only."]);
});
