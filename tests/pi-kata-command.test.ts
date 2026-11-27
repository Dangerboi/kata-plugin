import { expect, test } from "bun:test";
import { until } from "./kata-fixture";
import { piFixture } from "./pi-fixture";
import { USAGE } from "../core/session-status";

// pi's `/kata` and `kata` footer: replies go to the person through notify, never to the model through sendMessage.
const { host, kata, issue, nativeKey, globalRegistry } = piFixture();

async function pi(options: any = {}) {
	const app = await host(options);
	const statuses: [string, string | undefined][] = [];
	app.ctx.ui.setStatus = (key: string, value: string | undefined) => statuses.push([key, value]);
	const kata = (args: string) => app.commands.get("kata").handler(args, app.ctx);
	const notes = () => app.notices.map((n: any[]) => String(n[0]));
	return { ...app, statuses, kata, notes, footer: () => statuses.filter(([key]) => key === "kata").at(-1)?.[1] };
}

test("pi /kata answers through notify, the footer follows the session and clears at shutdown", async () => {
	const app = await pi();
	expect(app.commands.has("kata")).toBe(true);
	await app.event("session_start", { reason: "startup" });
	await app.init(["Pi status task"]);
	await app.event("before_agent_start", { prompt: "go", systemPromptOptions: { sections: {} } });
	expect(await until(() => !!app.footer()?.match(/^kata pi-builder · pitest#\w+$/))).toBe(true);
	await app.kata("status");
	expect(app.notes().at(-1)).toContain("actor      pi-builder");
	expect(app.notes().at(-1)).toMatch(/refs       pitest#\w+/);
	await app.kata("inbox");
	expect(app.notes().at(-1)).toBe("No session inbox: KATA_INBOX_USER is unset");
	const calls = app.calls.length;
	await app.kata("nope");
	expect(app.notes().at(-1)).toBe(USAGE);
	expect(app.calls.length).toBe(calls);
	expect(app.messages.filter(m => m[0]?.customType !== "kata.todo.command")).toEqual([]);
	await app.event("session_shutdown", { reason: "quit" });
	expect(app.statuses.at(-1)).toEqual(["kata", undefined]);
});

test("pi /kata inbox redraws the footer with the trusted count it read", async () => {
	const address = "pi-builder/kata-inbox";
	process.env.KATA_INBOX_USER = address;
	const app = await pi();
	await app.event("session_start", { reason: "startup" });
	const ref = await issue("Pi inbox footer");
	await kata(["notify", ref, "--to", address, "--message", "pi-footer-ping-2207", "--json"]);
	await app.kata("inbox");
	expect(app.notes().at(-1)).toStartWith(`Kata inbox for "${address}" (shown here only; the next prompt is unchanged)`);
	expect(app.notes().at(-1)).toContain("pi-footer-ping-2207");
	expect(await until(() => !!app.footer()?.endsWith(" · inbox 1"))).toBe(true);
	expect(app.messages.filter(m => m[0]?.customType !== "kata.todo.command")).toEqual([]);
	await kata(["notify", ref, "--to", address, "--clear", "--json"]);
	await app.event("session_shutdown", { reason: "quit" });
});

test("pi under Kata's native adapter says Kata supplies the contract and the inbox, and counts nothing in the footer", async () => {
	const address = "pi-builder/kata-native";
	process.env.KATA_INBOX_USER = address;
	globalRegistry[nativeKey].adapters.set("native", { options: { scope: "user", contract: true } });
	const app = await pi();
	await app.event("session_start", { reason: "startup" });
	const ref = await issue("Pi native inbox");
	await kata(["notify", ref, "--to", address, "--message", "pi-native-ping-3318", "--json"]);
	await app.kata("status");
	const rows = Object.fromEntries(app.notes().at(-1)!.split("\n").map(line => [line.slice(0, 11).trim(), line.slice(11)]));
	expect(rows).toMatchObject({ inbox: `${address} · kata supplies it`, contract: "off — kata agent-hook supplies it", requests: "Kata supplies the inbox, without this plugin's actor filter" });
	await app.kata("inbox");
	expect(app.notes().at(-1)).toStartWith(`Kata inbox for "${address}" (this plugin's trusted view; Kata supplies the inbox without that filter)`);
	expect(app.notes().at(-1)).toContain("pi-native-ping-3318");
	expect(app.footer()).toBe("kata pi-builder/kata-native");
	await kata(["notify", ref, "--to", address, "--clear", "--json"]);
	await app.event("session_shutdown", { reason: "quit" });
});

test("pi without a UI draws no footer and runs no Kata for it", async () => {
	const app = await pi({ hasUI: false });
	await app.event("session_start", { reason: "startup" });
	await app.event("before_agent_start", { prompt: "go", systemPromptOptions: { sections: {} } });
	expect(app.statuses).toEqual([]);
	await app.event("session_shutdown", { reason: "quit" });
});
