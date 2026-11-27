import type { InboxView, SessionView } from "./kata-core";

// What `/kata` and the `kata` footer show the person: plain text from the core's plain data. Nothing here runs Kata.

export const KATA_SUBCOMMANDS = ["status", "inbox", "refresh"] as const;
export type KataSubcommand = (typeof KATA_SUBCOMMANDS)[number];
export const USAGE = `Usage: /kata [${KATA_SUBCOMMANDS.join("|")}]`;
export const KATA_DESCRIPTION = "Show this session's Kata actor, inbox, refs and contract";
export const REFRESHED = "Kata contract and actor cleared; the next prompt reads both again.";
export const MAIN_ONLY = "/kata answers in the main session only.";
export const SUPERSEDED = "The Kata session changed while /kata status ran (a refresh, a session switch or shutdown); run /kata status again.";

/** The subcommand `args` names; empty args are `status`; anything else is undefined (the usage, with no Kata call). */
export function parseKataCommand(args: string): KataSubcommand | undefined {
	const word = (args ?? "").trim();
	if (!word) return "status";
	return (KATA_SUBCOMMANDS as readonly string[]).includes(word) ? word as KataSubcommand : undefined;
}

const firstLine = (text: string) => text.split("\n")[0]!.trim();
const noInbox = (none: "unset" | "personal" | undefined) =>
	none === "personal" ? "KATA_INBOX_USER names a personal inbox; set it to <user>/<name>" : "KATA_INBOX_USER is unset";
const others = (n: number) => `${n} request${n === 1 ? "" : "s"} from another actor not shown`;
const DELIVERY = { live: "live", "per prompt": "per prompt", failed: "last read failed", kata: "kata supplies it" } as const;

export function statusText(view: SessionView): string {
	const where = view.scope === "down" ? `${view.workspace} (Kata unavailable${view.outage ? `: ${firstLine(view.outage)}` : ""})`
		: view.scope === "unbound" ? `${view.workspace} (not a Kata workspace — plans go to ${view.project ?? "the default project"})`
		: `${view.workspace}${view.project ? ` (project ${view.project})` : ""}`;
	const inbox = view.inbox.address ? `${view.inbox.address} · ${DELIVERY[view.inbox.delivery ?? "per prompt"]}` : `none — ${noInbox(view.inbox.none)}`;
	const counts = view.counts;
	const requests = !view.inbox.address ? "none"
		: view.inbox.delivery === "kata" ? "Kata supplies the inbox, without this plugin's actor filter"
		: view.inbox.delivery === "failed" ? "read failed"
		: !counts ? "not read yet"
		: !counts.trusted && !counts.foreign ? "none"
		: [`${counts.trusted} trusted`, ...counts.foreign ? [others(counts.foreign)] : []].join(" · ");
	const contract = view.contract === "off" ? "off — kata agent-hook supplies it" : view.contract === "not-fetched" ? "not fetched yet" : `${view.contract} bytes`;
	const on = (flag: boolean) => flag ? "on" : "off";
	const s = view.settings;
	const rows: [string, string][] = [
		["workspace", where],
		["actor", view.actor ?? `unknown${view.actorError ? ` (${firstLine(view.actorError)})` : ""}`],
		["teammate", view.teammate || "none"],
		["inbox", inbox],
		["refs", view.refs.length ? view.refs.join(", ") : "none"],
		["contract", contract],
		["requests", requests],
		["settings", `executable=${s.executable} · ref guard ${on(s.refGuard)} · live inbox ${on(s.liveInbox)} · debug ${on(s.debug)}`],
	];
	return rows.map(([label, value]) => `${label.padEnd(11)}${value}`).join("\n");
}

/** The footer: `kata <address or actor> · <refs> · inbox N`; undefined clears it (Kata down, or the folder is no Kata workspace). */
export function footerText(view: SessionView): string | undefined {
	if (view.scope === "down" || view.scope === "unbound") return undefined;
	const parts = [`kata${view.inbox.address ?? view.actor ? ` ${view.inbox.address ?? view.actor}` : ""}`];
	if (view.refs.length) parts.push(view.refs.slice(0, 3).join(", ") + (view.refs.length > 3 ? ` +${view.refs.length - 3}` : ""));
	if (view.counts?.trusted) parts.push(`inbox ${view.counts.trusted}`);
	return parts.join(" · ");
}

export function inboxText(result: InboxView): string {
	if (!result.address) return `No session inbox: ${noInbox(result.none)}`;
	const name = JSON.stringify(result.address);
	if (result.failed !== undefined) return `Kata inbox read failed: ${firstLine(result.failed)}`;
	// When Kata supplies the inbox, the prompt carries every request: the foreign ones are not "not shown".
	const foreign = !result.native && result.counts?.foreign ? `\n${others(result.counts.foreign)}` : "";
	const lines = (result.text ?? "").replace(/^\n/, "");
	const native = "Kata supplies the inbox without that filter";
	if (!lines) return result.native ? `Kata inbox for ${name}: this plugin's trusted view is empty; ${native}` : `Kata inbox for ${name} is empty${foreign}`;
	return `Kata inbox for ${name} (${result.native ? `this plugin's trusted view; ${native}` : "shown here only; the next prompt is unchanged"})\n${lines}${foreign}`;
}

/** The part of a core's session `/kata` reads. */
export type KataStatusSource = {
	view(ctx: any, opts?: { reconcile?: boolean; context?: boolean; nativeInbox?: boolean }): Promise<SessionView | undefined>;
	inbox(ctx: any, opts?: { nativeInbox?: boolean }): Promise<InboxView>;
	refresh(): void;
};

/**
 * `/kata <args>` for the main session's `ctx`. The subcommand is checked before anything reads Kata. `context: false`: Kata
 * supplies the contract; `nativeInbox`: Kata supplies the inbox, unfiltered. Each host passes what it knows.
 */
export async function kataCommand(session: KataStatusSource, ctx: any, args: string, opts: { context?: boolean; nativeInbox?: boolean } = {}): Promise<string> {
	const sub = parseKataCommand(args);
	if (!sub) return USAGE;
	if (sub === "refresh") { session.refresh(); return REFRESHED; }
	if (sub === "inbox") return inboxText(await session.inbox(ctx, { nativeInbox: opts.nativeInbox }));
	// Hosts pass only the main session here, so no view means a refresh, switch or shutdown overtook the read: read once more.
	const read = () => session.view(ctx, { reconcile: true, context: opts.context, nativeInbox: opts.nativeInbox });
	const view = await read() ?? await read();
	return view ? statusText(view) : SUPERSEDED;
}
