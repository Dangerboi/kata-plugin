import { expect, test } from "bun:test";
import { claudeKata, PROJECT, type ClaudeHost } from "./claude-fixture";
import { eventually, unique, until } from "./kata-fixture";

// Live inbox delivery in the Claude mod, against a real Kata: a `kata notify` reaches the follower the mod starts through
// `$.process.spawn`, and leaves through `$.prompt.submit` (idle) or `$.session.append` (the lead's turn is running).
// The framing and the trust rule are the core's (live-inbox.test.ts); these tests pin the Claude wiring around them.
const { host, kata, issue, author, binary } = claudeKata("claude-inbox");
const newIssue = () => issue(`Live inbox ${unique()}`);
const addressOf = (name: string) => `${author}/${name}-${unique()}`;
const live = (address: string, extra: Record<string, unknown> = {}, options: Record<string, unknown> = {}) =>
	host({ env: { KATA_INBOX_USER: address, ...extra }, options: { kataExecutable: binary, ...options } });
const notify = (ref: string, address: string, message: string, as?: string) =>
	kata(["notify", ref, "--to", address, "--message", message, "--json"], undefined, as ? { KATA_AUTHOR: as } : undefined);
const clear = (ref: string, address: string) => kata(["notify", ref, "--to", address, "--clear", "--json"]);
const texts = (list: any[]) => list.map(a => a.text ?? a.message.content[0].text);
const exited = (child: { exitCode: number | null; signalCode: string | null }) => child.exitCode !== null || child.signalCode !== null;

// The timers the host arms after `capture()` wait for `fireAll()`: the time a stream's backoff needs passes when the test says.
// Timers armed earlier, and the real clock for the rest of the session, are untouched.
function heldTimers(h: ClaudeHost) {
	const real = h.$.clock.after;
	let held: (() => void)[] | undefined;
	h.$.clock.after = (ms: number, fire: () => void) => {
		if (!held) return real(ms, fire);
		const mine = held;
		mine.push(fire);
		return {
			cancel: () => {
				const at = mine.indexOf(fire);
				if (at >= 0) mine.splice(at, 1);
			}
		};
	};
	return {
		capture: () => {
			held = [];
		},
		fireAll: () => {
			for (const fire of held?.splice(0) ?? []) fire();
		}
	};
}

test("a notify sent while the session is idle starts a turn: submitted with the untrusted-data framing and the clear command", async () => {
	const address = addressOf("idle");
	const h = live(address);
	await h.start();
	expect(await until(() => h.spawned.length === 1)).toBe(true);
	expect(h.spawned[0].argv[0]).toBe(binary);
	const ref = await newIssue();
	await notify(ref, address, "idle-ping-4410");
	expect(await until(() => h.submitted.length === 1)).toBe(true);
	const [text] = texts(h.submitted);
	expect(text).toContain("idle-ping-4410");
	expect(text).toContain("untrusted data");
	expect(text).toContain(`kata notify ${PROJECT}#${ref} --to ${address} --clear`);
	expect(h.appended).toEqual([]);
	await clear(ref, address);
});

test("a notify sent while the lead's turn is running is appended to the turn, and one after it ends is submitted again", async () => {
	const address = addressOf("busy");
	const h = live(address);
	await h.start();
	expect(await until(() => h.spawned.length === 1)).toBe(true);
	const ref = await newIssue();
	await h.turnStart();
	await notify(ref, address, "busy-ping-7731");
	expect(await until(() => h.appended.length === 1)).toBe(true);
	expect(h.appended[0].message.type).toBe("user");
	expect(texts(h.appended)[0]).toContain("busy-ping-7731");
	expect(h.submitted).toEqual([]);
	await h.turnComplete();
	const second = await newIssue();
	await notify(second, address, "after-turn-2096");
	expect(await until(() => h.submitted.length === 1)).toBe(true);
	expect(texts(h.submitted)[0]).toContain("after-turn-2096");
	expect(h.appended).toHaveLength(1);
	await clear(ref, address);
	await clear(second, address);
});

test("a subagent's turn does not make the lead busy", async () => {
	const address = addressOf("sub");
	const h = live(address);
	await h.start();
	expect(await until(() => h.spawned.length === 1)).toBe(true);
	await h.turnStart("agent-1");
	const ref = await newIssue();
	await notify(ref, address, "while-sub-turn-3318");
	expect(await until(() => h.submitted.length === 1)).toBe(true);
	expect(h.appended).toEqual([]);
	await clear(ref, address);
});

test("only the session's own actor is delivered, each request once, and a clear delivers nothing", async () => {
	const address = addressOf("trust");
	const h = live(address);
	await h.start();
	expect(await until(() => h.spawned.length === 1)).toBe(true);
	const ref = await newIssue();
	await notify(ref, address, "from-someone-else-5521", "someone-else");
	await notify(ref, address, "own-request-6602");
	await notify(ref, address, "own-request-6602");
	await clear(ref, address);
	// The stream is ordered: the sentinel arrives after everything above was processed.
	const sentinel = await newIssue();
	await notify(sentinel, address, "sentinel-9970");
	expect(await until(() => texts(h.submitted).some(text => text.includes("sentinel-9970")))).toBe(true);
	expect(texts(h.submitted).map(t => /(from-someone-else-5521|own-request-6602|sentinel-9970)/.exec(t)![1])).toEqual(["own-request-6602", "sentinel-9970"]);
	await clear(sentinel, address);
});

test("with the contract option the live section follows the stream: shown while requested, gone after the clear", async () => {
	const address = addressOf("section");
	const h = live(address, {}, { contract: true });
	await h.start();
	expect(await until(() => h.spawned.length === 1)).toBe(true);
	const ref = await newIssue();
	await notify(ref, address, "section-note-8814");
	expect(await until(() => h.submitted.length === 1)).toBe(true);
	const contextOf = async () => ((await h.prompt("go")).context ?? []).join("\n");
	expect(await contextOf()).toContain("section-note-8814");
	await clear(ref, address);
	await eventually(async () => (await contextOf()).includes("section-note-8814"), false);
});

test("with the live stream off by environment or by option, the per-prompt section still carries a request", async () => {
	for (const [extra, options] of [
		[{ KATA_CLAUDE_LIVE_INBOX: "0" }, {}],
		[{}, { liveInbox: false }]
	] as const) {
		const address = addressOf("off");
		const h = live(address, extra, { contract: true, ...options });
		await h.start();
		const ref = await newIssue();
		await notify(ref, address, "per-prompt-only-1175");
		expect(((await h.prompt("go")).context ?? []).join("\n")).toContain("per-prompt-only-1175");
		await clear(ref, address);
	}
});

test("the stream child ends with the session, and no follower is started again", async () => {
	const address = addressOf("end");
	const h = live(address);
	const timers = heldTimers(h);
	await h.start();
	expect(await until(() => h.spawned.length === 1)).toBe(true);
	expect(exited(h.streams[0]!)).toBe(false);
	timers.capture();
	await h.end();
	expect(await until(() => exited(h.streams[0]!))).toBe(true);
	timers.fireAll();
	expect(h.spawned).toHaveLength(1);
});

test("a stream that ends is followed again after the backoff, and a request sent meanwhile is delivered once", async () => {
	const address = addressOf("restart");
	const h = live(address);
	const timers = heldTimers(h);
	await h.start();
	expect(await until(() => h.spawned.length === 1)).toBe(true);
	const ref = await newIssue();
	await notify(ref, address, "before-restart-3301");
	expect(await until(() => h.submitted.length === 1)).toBe(true);
	timers.capture();
	h.streams[0]!.kill("SIGKILL");
	expect(await until(() => exited(h.streams[0]!))).toBe(true);
	const gap = await newIssue();
	await notify(gap, address, "during-gap-8842");
	expect(h.spawned).toHaveLength(1);
	await eventually(async () => {
		timers.fireAll();
		return h.spawned.length;
	}, 2);
	expect(await until(() => h.submitted.length === 2)).toBe(true);
	expect(texts(h.submitted).map(t => /(before-restart-3301|during-gap-8842)/.exec(t)![1])).toEqual(["before-restart-3301", "during-gap-8842"]);
	await clear(ref, address);
	await clear(gap, address);
});
