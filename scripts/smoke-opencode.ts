// Smoke test: run a real, headless OpenCode against a real Kata daemon and check what lands in a throwaway Kata store.
//
//   bun run smoke:opencode [--scenario <name>] [--verbose] [--no-plugin]
//
// Each run gets a fresh Git folder, a throwaway KATA_HOME, HOME and XDG_* directories, and an opencode.json that registers
// the repo's plugins/opencode/kata.ts through a re-export shim directory and a scripted OpenAI-compatible provider (scripts/smoke-opencode-provider.ts,
// started in this process). No credentials or network are needed. The plugin entry is left out with --no-plugin;
// scenarios that set `needsPlugin` fail in that case.
//
// Add a scenario by appending an entry to SCENARIOS: scripted turns per agent (keyed by a marker in the agent's first user
// message) plus assertions over the throwaway Kata store. The driver changes only for a scenario that restarts OpenCode.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TRANSCRIPT_ENV } from "../core/kata-cli";
import { MODEL, PROVIDER, startProvider, type Request, type Turn } from "./smoke-opencode-provider";

export type Issue = {
	ref: string; title: string; status: string; owner?: string; metadata: Record<string, string>;
	events: { type: string; payload: any }[];
};
export type Check = { name: string; ok: boolean; detail?: string };
export type Store = {
	/** Requests recorded by the scripted provider, oldest first. */
	requests(): Request[];
	/** Every `--format json` event OpenCode printed, oldest first. */
	events(): any[];
	/** Exit code of `opencode run`. */
	code: number | null;
	/** Every issue in the project. */
	issues(): Promise<Issue[]>;
	/** Short ids of the children of an issue. */
	children(ref: string): string[];
	/** Runs kata against the throwaway store, from outside OpenCode. */
	kata(args: string[], extra?: NodeJS.ProcessEnv): string;
};
export type Scenario = {
	name: string;
	/** User prompt for the lead; it must contain the lead script's marker. */
	prompt: string;
	/** Scripted turns keyed by a marker that appears in the agent's first user message (the lead's prompt; a subagent's prompt). */
	scripts: Record<string, Turn[]>;
	/** The scenario exercises the plugin: it fails when plugins/opencode/kata.ts is missing or --no-plugin is set. */
	needsPlugin?: boolean;
	/** Options for the plugin entry in opencode.json. */
	pluginOptions?: Record<string, unknown>;
	/** Extra opencode.json settings, merged over the harness's. */
	config?: Record<string, unknown>;
	/** Contents of the throwaway KATA_HOME/config.toml, written before the store is initialised. */
	kataConfig?: string;
	/** Environment for the opencode child. */
	env?: Record<string, string>;
	/** Creates tickets before OpenCode starts; the returned short ids reach the scripts (`ctx.vars`) and `check`. */
	setup?(create: (title: string) => string): Record<string, string>;
	/** Assertions run after OpenCode has exited. */
	check?(store: Store, vars: Record<string, string>): Promise<Check[]>;
};

// ---- Assertion helpers over the Kata store ----
/** The first `issue.closed` event of an issue. */
export const closeEvent = (i?: Issue) => i?.events.find(e => e.type === "issue.closed")?.payload;
/** Evidence recorded by the first close. */
export const closeEvidence = (i?: Issue): any[] => closeEvent(i)?.evidence ?? [];
/** Transcript (agent, session_id) recorded by the first close. */
export const closeTranscript = (i?: Issue): { agent?: string; session_id?: string } | undefined => closeEvent(i)?.transcript;
/** Issues whose metadata has `key` (any value when `value` is omitted). */
export const withMetadata = (issues: Issue[], key: string, value?: unknown) => issues.filter(i => key in i.metadata && (value === undefined || (i.metadata as Record<string, unknown>)[key] === value));

export const SCENARIOS: Scenario[] = [{
	name: "noop",
	prompt: "[smoke:main] Say hello.",
	scripts: { "[smoke:main]": [["hello from the scripted model"]] },
	async check(store) {
		const texts = store.events().filter(e => e.type === "text").map(e => e.part?.text);
		return [
			{ name: "the provider saw a lead request", ok: store.requests().some(r => r.agent === "[smoke:main]"), detail: JSON.stringify(store.requests().map(r => r.agent)) },
			{ name: "the lead's answer reached the event stream", ok: texts.includes("hello from the scripted model"), detail: JSON.stringify(texts) },
		];
	},
}];

const PLAN = ["Write the parser", "Wire the parser into the CLI", "Document the parser"];
const PLAN_MSG = (what: string) => `${what}: implemented and verified by running the parser tests, all green.`;
// The JSON list a refusal ends with. OpenCode hands a thrown tool error back as {"error":{"message":...},"content":[]}.
const refusedList = (texts: string[]): any[] => {
	const text = [...texts].reverse().find(t => t.includes("Refused: this list disagrees"))!;
	let message = text;
	try { message = JSON.parse(text).error.message; } catch {}
	return JSON.parse(message.trim().split("\n").pop()!).todos;
};
SCENARIOS.push({
	name: "plan",
	needsPlugin: true,
	prompt: "[smoke:plan] Plan and do the parser work.",
	scripts: {
		"[smoke:plan]": [
			[{ tool: "todowrite", args: { todos: [{ content: PLAN[0], status: "in_progress" }, { content: PLAN[1], status: "pending" }, { content: PLAN[2], status: "pending" }] } }],
			// Completing without message/evidence: refused.
			[{ tool: "todowrite", args: { todos: [{ content: PLAN[0], status: "completed" }, { content: PLAN[1], status: "pending" }, { content: PLAN[2], status: "pending" }] } }],
			// Resend on top of the list the refusal carried.
			ctx => {
				const list = refusedList(ctx.texts);
				return [{ tool: "todowrite", args: { todos: list.map((t: any) => t.content === PLAN[0]
					? { ...t, status: "completed", message: PLAN_MSG("Parser written"), evidence: ["test:bun test parser"] }
					: t.content === PLAN[1] ? { ...t, status: "in_progress" } : t) } }];
			},
			[{ tool: "todowrite", args: { todos: [
				{ content: PLAN[0], status: "completed" },
				{ content: PLAN[1], status: "completed", message: PLAN_MSG("Parser wired into the CLI"), evidence: ["test:bun test cli"] },
				{ content: PLAN[2], status: "cancelled", reason: "The docs are generated elsewhere, nothing to write here." },
			] } }],
			["plan done"],
		],
	},
	async check(store) {
		const issues = await store.issues();
		const requests = store.requests().filter(r => r.agent === "[smoke:plan]");
		const sessionID = store.events().find(e => e.sessionID)?.sessionID;
		const byTitle = (title: string) => issues.find(i => i.title.includes(title));
		const [one, two, three] = PLAN.map(byTitle);
		const children = issues.filter(i => i.ref !== one?.ref && i.ref !== two?.ref && i.ref !== three?.ref);
		// The automatic parent is the one issue the three items hang under.
		const parent = children.find(i => store.children(i.ref).length === 3);
		const kids = parent ? store.children(parent.ref) : [];
		const refusal = requests[2]?.toolResults[1] ?? "";
		let carried: any[] = [];
		try { carried = refusedList(requests[2]?.toolResults ?? []); } catch {}
		const hasTest = (i: Issue | undefined, command: string) => closeEvidence(i).some(e => e.type === "test" && e.command === command);
		const closes = (i?: Issue) => i?.events.filter(e => e.type === "issue.closed").length;
		const tool = requests[0]?.tools.includes("todowrite");
		return [
			{ name: "the lead's todowrite tool was offered with the plugin's schema", ok: !!tool && requests.every(r => r.tools.includes("todowrite")), detail: JSON.stringify(requests.map(r => r.tools)) },
			{ name: "the lead made all four calls and ended with text", ok: requests.length === 5, detail: `${requests.length} requests` },
			{ name: "the refusal reached the model carrying the current list", ok: refusal.includes("Refused") && carried.length === 3 && carried.every((t: any, n: number) => t.content === PLAN[n]) && carried[0].status === "in_progress", detail: refusal },
			{ name: "an automatic parent has the three items as children", ok: !!parent && !!one && !!two && !!three && [one, two, three].every(i => kids.includes(i!.ref)), detail: JSON.stringify(issues.map(i => [i.ref, i.title, i.status])) },
			{ name: "the parent is still open", ok: parent?.status === "open", detail: parent?.status },
			{ name: "item 1 closed done with its evidence", ok: one?.status === "closed" && closeEvent(one)?.reason === "done" && hasTest(one, "bun test parser"), detail: JSON.stringify(closeEvent(one)) },
			{ name: "item 2 closed done with its evidence", ok: two?.status === "closed" && closeEvent(two)?.reason === "done" && hasTest(two, "bun test cli"), detail: JSON.stringify(closeEvent(two)) },
			{ name: "item 3 closed wontfix", ok: three?.status === "closed" && closeEvent(three)?.reason === "wontfix", detail: JSON.stringify(closeEvent(three)) },
			{ name: "closes carry a transcript of agent opencode and the lead's session", ok: !!sessionID && [one, two].every(i => closeTranscript(i)?.agent === "opencode" && closeTranscript(i)?.session_id === sessionID), detail: JSON.stringify([sessionID, closeTranscript(one), closeTranscript(two)]) },
			// The refusal came before the resend: a close it had let through would be item 1's first close, without the resend's message and evidence.
			{ name: "the refused call changed nothing", ok: closes(one) === 1 && closes(two) === 1 && closes(three) === 1 && String(closeEvent(one)?.message).includes("Parser written") && hasTest(one, "bun test parser"), detail: JSON.stringify([one, two, three].map(i => i?.events.map(e => e.type))) },
			{ name: "the plan section is in the system prompt after the first accepted list", ok: !requests[0].system.includes("Current plan:") && requests.slice(1).every(r => r.system.includes("The todowrite tool is backed by Kata. Current plan:")), detail: JSON.stringify(requests.map(r => r.system.includes("Current plan:"))) },
		];
	},
});

// ---- Delegates: a lead's `subagent` calls bound to its plan items ----
const DELEGATE_PLAN = ["Build the parser", "Document the parser"];
const planOf = (items: string[]) => [{ tool: "todowrite", args: { todos: items.map((content, n) => ({ content, status: n ? "pending" : "in_progress" })) } }];
const SUBAGENT_PREFIX = "You are a subagent spawned by another session.\n";
// The child's session id as the lead's subagent result names it.
const childOf = (texts: string[]) => texts.map(t => /ses_[A-Za-z0-9]+/.exec(t.slice(t.indexOf("sessionID")))?.[0] ?? /sessionID[^A-Za-z0-9]+(ses_[A-Za-z0-9]+)/.exec(t)?.[1]).find(Boolean);
/** The checks every delegate scenario shares: the assignment reached the child, the item came back to the lead open and labelled, the report is a comment. */
function delegateChecks(store: Store, issues: Issue[], marker: string, report: string): Check[] {
	const one = issues.find(i => i.title.includes(DELEGATE_PLAN[0]));
	const two = issues.find(i => i.title.includes(DELEGATE_PLAN[1]));
	const child = store.requests().filter(r => r.agent === marker);
	const assignment = child[0]?.system.match(/You are subagent [^\n]*Your Kata issue is ([^;]+); your teammate is ([^.\s]+)\./);
	const events = (i?: Issue) => i?.events.map(e => e.type) ?? [];
	const comments = (i?: Issue) => (i?.events ?? []).filter(e => e.type === "issue.commented").map(e => String(e.payload?.body ?? ""));
	return [
		{ name: "the delegate's system prompt carries the assignment naming item 1 and its teammate", ok: !!assignment && !!one && assignment[1].endsWith(`#${one.ref}`), detail: JSON.stringify([assignment, one?.ref, child[0]?.system.slice(-600)]) },
		{ name: "the delegate ran a tool and ended with text", ok: child.length === 2 && child[0].tools.includes("read"), detail: `${child.length} child requests` },
		{ name: "item 1 was assigned to the delegate's teammate while it ran", ok: !!assignment && JSON.stringify(one?.events ?? []).includes(assignment[2]), detail: JSON.stringify(one?.events) },
		{ name: "item 1 is open again and not owned by the delegate", ok: one?.status === "open" && !!assignment && one.metadata.teammate !== assignment[2], detail: JSON.stringify([one?.status, one?.metadata]) },
		{ name: "item 1 carries needs-review", ok: JSON.stringify(one?.events ?? []).includes("needs-review"), detail: JSON.stringify(events(one)) },
		{ name: "the delegate's report is a comment on item 1", ok: comments(one).some(c => c.includes(report)), detail: JSON.stringify(comments(one)) },
		{ name: "item 2 was left alone", ok: two?.status === "open" && !events(two).some(t => t === "issue.commented"), detail: JSON.stringify([two?.status, events(two)]) },
	];
}
const delegateChild = (report: string): Turn[] => [
	[{ tool: "read", args: { path: "." } }],
	[report],
];
SCENARIOS.push({
	name: "delegate-foreground",
	needsPlugin: true,
	prompt: "[smoke:fg-lead] Plan the parser work and hand the first item to a subagent.",
	scripts: {
		"[smoke:fg-lead]": [
			planOf(DELEGATE_PLAN),
			[{ tool: "subagent", args: { agent: "general", description: "Build parser", prompt: `[smoke:fg-child] Work on "${DELEGATE_PLAN[0]}" and report back.` } }],
			["lead done"],
		],
		"[smoke:fg-child]": delegateChild("FG-REPORT parser built, not closed."),
	},
	async check(store) {
		const issues = await store.issues();
		const lead = store.requests().filter(r => r.agent === "[smoke:fg-lead]");
		return [
			{ name: "the lead planned, called subagent and ended with text", ok: lead.length === 3, detail: `${lead.length} lead requests` },
			{ name: "the child's first message is the subagent preamble and the prompt", ok: store.requests().find(r => r.agent === "[smoke:fg-child]")?.users[0]?.startsWith(SUBAGENT_PREFIX) === true, detail: JSON.stringify(store.requests().find(r => r.agent === "[smoke:fg-child]")?.users) },
			...delegateChecks(store, issues, "[smoke:fg-child]", "FG-REPORT"),
		];
	},
});
SCENARIOS.push({
	name: "delegate-background",
	needsPlugin: true,
	prompt: "[smoke:bg-lead] Plan the parser work and start the first item in the background.",
	scripts: {
		"[smoke:bg-lead]": [
			planOf(DELEGATE_PLAN),
			[{ tool: "subagent", args: { agent: "general", description: "Build parser", background: true, prompt: `[smoke:bg-child] Work on "${DELEGATE_PLAN[0]}" and report back.` } }],
			["started it in the background"],
		],
		"[smoke:bg-child]": delegateChild("BG-REPORT parser built, not closed."),
	},
	async check(store) {
		const issues = await store.issues();
		const lead = store.requests().filter(r => r.agent === "[smoke:bg-lead]");
		return [
			{ name: "the lead planned, called subagent and ended with text", ok: lead.length >= 3, detail: `${lead.length} lead requests` },
			{ name: "the call returned at once, the child still running", ok: (lead[2]?.toolResults.at(-1) ?? "").includes("in the background"), detail: lead[2]?.toolResults.at(-1) },
			...delegateChecks(store, issues, "[smoke:bg-child]", "BG-REPORT"),
		];
	},
});
SCENARIOS.push({
	name: "delegate-followup",
	needsPlugin: true,
	prompt: "[smoke:fu-lead] Plan the parser work, hand the first item to a subagent, then send it a follow-up.",
	scripts: {
		"[smoke:fu-lead]": [
			planOf(DELEGATE_PLAN),
			[{ tool: "subagent", args: { agent: "general", description: "Build parser", prompt: `[smoke:fu-child] Work on "${DELEGATE_PLAN[0]}" and report back.` } }],
			ctx => [{ tool: "subagent", args: { agent: "general", description: "Build parser", sessionID: childOf(ctx.texts), prompt: "[smoke:fu-more] Also add a changelog line." } }],
			["lead done"],
		],
		"[smoke:fu-child]": [
			[{ tool: "read", args: { path: "." } }],
			["FU-FIRST parser built, not closed."],
			// The follow-up also runs a tool: a woken delegate that ran none is rolled back and posts no report.
			[{ tool: "read", args: { path: "." } }],
			["FU-SECOND changelog line added."],
		],
	},
	async check(store) {
		const issues = await store.issues();
		const lead = store.requests().filter(r => r.agent === "[smoke:fu-lead]");
		const one = issues.find(i => i.title.includes(DELEGATE_PLAN[0]));
		const comments = (one?.events ?? []).filter(e => e.type === "issue.commented").map(e => String(e.payload?.body ?? ""));
		const parents = issues.filter(i => store.children(i.ref).length > 0);
		return [
			{ name: "the lead made all calls and ended with text", ok: lead.length === 4, detail: `${lead.length} lead requests` },
			{ name: "the lead named the child's session in the follow-up", ok: !!childOf(lead[2]?.toolResults ?? []), detail: JSON.stringify(lead[2]?.toolResults) },
			{ name: "the plan's two items and their parent are the only issues", ok: issues.length === 3 && parents.length === 1, detail: JSON.stringify(issues.map(i => [i.ref, i.title, i.status])) },
			{ name: "the first report landed on item 1", ok: comments.some(c => c.includes("FU-FIRST")), detail: JSON.stringify(comments) },
			{ name: "the follow-up's report landed on the same issue", ok: comments.some(c => c.includes("FU-SECOND")), detail: JSON.stringify(comments) },
			{ name: "item 1 is open with needs-review and back with the lead", ok: one?.status === "open" && JSON.stringify(one.events).includes("needs-review"), detail: JSON.stringify([one?.status, one?.metadata]) },
		];
	},
});
// The child runs the commands its assignment hands it, through the `shell` tool: plain `kata` stands for the quoted executable.
const ASSIGNED = /YOU must comment on your issue[^:]*: ('kata' --workspace .*? --teammate '[^']*') comment ('[^']*') --body /;
const assigned = (ctx: { system: string }) => {
	const m = ASSIGNED.exec(ctx.system);
	return { prefix: m ? m[1].replace(/^'kata'/, "kata") : "kata", ref: m?.[2] ?? "''" };
};
const DC_MESSAGE = "Parser built and verified by running the parser tests, all green.";
SCENARIOS.push({
	name: "delegate-close",
	needsPlugin: true,
	prompt: "[smoke:dc-lead] Plan the parser work, hand the first item to a subagent, then settle the plan.",
	scripts: {
		"[smoke:dc-lead]": [
			planOf(DELEGATE_PLAN),
			[{ tool: "subagent", args: { agent: "general", description: "Build parser", prompt: `[smoke:dc-child] Work on "${DELEGATE_PLAN[0]}", close it and report back.` } }],
			// Kata closed item 1 already: completed without message or evidence must be accepted.
			[{ tool: "todowrite", args: { todos: [{ content: DELEGATE_PLAN[0], status: "completed" }, { content: DELEGATE_PLAN[1], status: "in_progress" }] } }],
			["lead done"],
		],
		"[smoke:dc-child]": [
			ctx => [{ tool: "shell", args: { command: `${assigned(ctx).prefix} --as someone comment ${assigned(ctx).ref} --body 'DC-AS impersonated'`, description: "Comment as someone else" } }],
			ctx => [{ tool: "shell", args: { command: `${assigned(ctx).prefix} comment ${assigned(ctx).ref} --body 'DC-REPORT parser built and tested.'`, description: "Comment on the issue" } }],
			ctx => [{ tool: "shell", args: { command: `${assigned(ctx).prefix} close ${assigned(ctx).ref} --done --message '${DC_MESSAGE}' --evidence 'test:bun test parser'`, description: "Close the issue" } }],
			["DC-DONE parser built and closed."],
		],
	},
	async check(store) {
		const issues = await store.issues();
		const requests = store.requests();
		const lead = requests.filter(r => r.agent === "[smoke:dc-lead]");
		const child = requests.filter(r => r.agent === "[smoke:dc-child]");
		const one = issues.find(i => i.title.includes(DELEGATE_PLAN[0]));
		const two = issues.find(i => i.title.includes(DELEGATE_PLAN[1]));
		const assignment = child[0]?.system.match(/Your Kata issue is ([^;]+); your teammate is ([^.\s]+)\./);
		const leadSession = store.events().find(e => e.sessionID)?.sessionID;
		const childSession = childOf(lead[2]?.toolResults ?? []);
		const closed = closeEvent(one);
		const all = JSON.stringify(issues.map(i => i.events));
		const resend = lead[3]?.toolResults.at(-1) ?? "";
		const asResult = child[1]?.toolResults[0] ?? "";
		return [
			{ name: "the lead made all calls and the delegate ran three shell calls and ended with text", ok: lead.length === 4 && child.length === 4 && child[0].tools.includes("shell"), detail: `${lead.length} lead, ${child.length} child requests, ${JSON.stringify(child[0]?.tools)}` },
			{ name: "the --as call ended as an error and ran nothing", ok: /--as is not permitted/.test(asResult) && !all.includes("DC-AS"), detail: asResult },
			{ name: "item 1 closed done with the delegate's message and evidence", ok: one?.status === "closed" && closed?.reason === "done" && String(closed?.message).includes(DC_MESSAGE) && closeEvidence(one).some(e => e.type === "test" && e.command === "bun test parser"), detail: JSON.stringify(closed) },
			{ name: "the close carries agent opencode and the child's session, not the lead's", ok: !!childSession && childSession !== leadSession && closeTranscript(one)?.agent === "opencode" && closeTranscript(one)?.session_id === childSession, detail: JSON.stringify([leadSession, childSession, closeTranscript(one)]) },
			{ name: "the close and the comment are the delegate's teammate's", ok: !!assignment && JSON.stringify(one?.events.filter(e => e.type === "issue.closed" || e.type === "issue.commented")).includes(assignment[2]) && !!one?.events.some(e => e.type === "issue.commented" && String(e.payload?.body).includes("DC-REPORT")), detail: JSON.stringify([assignment, one?.events]) },
			{ name: "the lead's resend with item 1 completed and no fields was accepted", ok: resend !== "" && !resend.includes("Refused"), detail: resend },
			{ name: "item 2 is in progress", ok: two?.status === "open" && two.metadata["todo.status"] === "in_progress", detail: JSON.stringify([two?.status, two?.owner, two?.metadata]) },
			{ name: "item 1 has no needs-review", ok: !JSON.stringify(one?.events ?? []).includes("needs-review"), detail: JSON.stringify(one?.events.map(e => e.type)) },
		];
	},
});

const root = path.resolve(import.meta.dir, "..");
const argv = process.argv.slice(2);
const verbose = argv.includes("--verbose");
const picked = argv.includes("--scenario") ? argv[argv.indexOf("--scenario") + 1] : undefined;
const pluginFile = path.join(root, "plugins/opencode/kata.ts");
const withPlugin = !argv.includes("--no-plugin") && existsSync(pluginFile);
const scenarios = picked ? SCENARIOS.filter(s => s.name === picked) : SCENARIOS;
if (import.meta.main && !scenarios.length) { console.error(`Unknown scenario ${picked}. Known: ${SCENARIOS.map(s => s.name).join(", ")}`); process.exit(2); }

const PROJECT = "opencode-smoke";
const TIMEOUT_MS = 120_000;
// Inherited routing would point the child at someone else's Kata, and an inherited transcript session would hide whether the plugin exports its own.
const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(KATA_(SERVER|DAEMON|AUTH_TOKEN|REF|HOME|DEFAULT_PROJECT)|OPENCODE_.*|XDG_.*)$/.test(k) && !(TRANSCRIPT_ENV as readonly string[]).includes(k)));
let failures = 0;
const report = (name: string, ok: boolean, detail?: string) => {
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
};

function kata(env: NodeJS.ProcessEnv, cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
	const out = spawnSync("kata", args, { env: { ...env, ...extra }, cwd, encoding: "utf8", timeout: 15_000 });
	if (out.status !== 0) throw new Error(`kata ${args.join(" ")}: ${out.stderr || out.error}`);
	return out.stdout;
}

function store(env: NodeJS.ProcessEnv, cwd: string, provider: { requests: Request[] }, events: any[], code: number | null): Store {
	return {
		requests: () => provider.requests,
		events: () => events,
		code,
		kata: (args, extra) => kata(env, cwd, args, extra),
		children: ref => (JSON.parse(kata(env, cwd, ["show", ref, "--json"])).children ?? []).map((c: any) => c.short_id),
		async issues() {
			const listed = JSON.parse(kata(env, cwd, ["list", "--status", "all", "--limit", "0", "--json"])).issues;
			const all = JSON.parse(kata(env, cwd, ["events", "--project", PROJECT, "--after", "0", "--limit", "10000", "--json"])).events;
			return listed.map((i: any): Issue => ({
				ref: i.short_id, title: i.title, status: i.status, owner: i.owner, metadata: i.metadata ?? {},
				events: all.filter((e: any) => e.issue_uid === i.uid).map((e: any) => ({ type: e.type, payload: e.payload })),
			}));
		},
	};
}

const tmp = import.meta.main ? realpathSync(mkdtempSync(path.join(os.tmpdir(), "opencode-kata-smoke-"))) : "";
// Everything that must be torn down, also when a run fails or the driver is interrupted.
const cleanups = new Set<() => void>();
const teardown = () => { for (const fn of [...cleanups]) { try { fn(); } catch {} cleanups.delete(fn); } if (tmp) rmSync(tmp, { recursive: true, force: true }); };
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { teardown(); process.exit(130); });

async function run(scenario: Scenario) {
	console.log(`\n# scenario ${scenario.name}`);
	const dir = path.join(tmp, scenario.name);
	const work = path.join(dir, "repo"), kataHome = path.join(dir, "kata"), home = path.join(dir, "home");
	for (const d of [work, kataHome, home]) mkdirSync(d, { recursive: true });
	const xdg = Object.fromEntries(["config", "data", "cache", "state"].map(k => [`XDG_${k.toUpperCase()}_HOME`, path.join(home, `.${k}`)]));
	const env: NodeJS.ProcessEnv = { ...base, ...scenario.env, ...xdg, HOME: home, KATA_HOME: kataHome, PWD: work };
	let vars: Record<string, string> = {};
	const provider = startProvider(scenario.scripts, () => vars);
	const stopDaemon = () => void spawnSync("kata", ["daemon", "stop"], { env, cwd: work, stdio: "ignore", timeout: 15_000 });
	cleanups.add(provider.stop); cleanups.add(stopDaemon);
	try {
		if (scenario.needsPlugin && !withPlugin) throw new Error("scenario needs plugins/opencode/kata.ts and --no-plugin is not set");
		if (scenario.kataConfig) writeFileSync(path.join(kataHome, "config.toml"), scenario.kataConfig);
		spawnSync("git", ["init", "-q", "."], { cwd: work });
		kata(env, work, ["init", "--project", PROJECT]);
		vars = scenario.setup?.(title => JSON.parse(kata(env, work, ["create", title, "--force-new", "--json"])).issue.short_id) ?? {};
		// A configured local plugin must be a directory (a file path is refused with "configured plugin path must be a directory")
		// whose `server.ts` or `index.ts` default-exports the plugin, so a one-line re-export of the repo file stands in for it;
		// this is the only way to give a local plugin options.
		const shim = path.join(work, "kata-plugin");
		mkdirSync(shim);
		writeFileSync(path.join(shim, "index.ts"), `export { default } from ${JSON.stringify(pluginFile)};\n`);
		const config = {
			...(withPlugin ? { plugins: [{ package: shim, options: scenario.pluginOptions ?? {} }] } : {}),
			providers: { [PROVIDER]: { package: "@opencode/ai/providers/openai-compatible", name: "Kata smoke", settings: { baseURL: provider.url, apiKey: "unused" }, models: { [MODEL]: { name: "Scripted" } } } },
			...scenario.config,
		};
		writeFileSync(path.join(work, "opencode.json"), JSON.stringify(config, null, 2));

		const child = spawn("opencode", ["run", "--standalone", "--auto", "--archived", "--format", "json", "-m", `${PROVIDER}/${MODEL}`, scenario.prompt], { env, cwd: work, stdio: ["ignore", "pipe", "pipe"] });
		const killChild = () => void child.kill("SIGKILL");
		cleanups.add(killChild);
		let output = "";
		child.stdout.on("data", d => output += d);
		child.stderr.on("data", d => output += d);
		const timer = setTimeout(killChild, TIMEOUT_MS);
		const code = await new Promise<number | null>(resolve => child.on("close", resolve));
		clearTimeout(timer); cleanups.delete(killChild); killChild();
		if (verbose) console.log(output);
		report("opencode exited cleanly", code === 0, `exit ${code}\n${output.trim().split("\n").slice(-20).join("\n")}`);
		report("the provider saw a request", provider.requests.length > 0, "no model request reached the scripted provider");
		const events = output.split("\n").filter(l => l.startsWith("{")).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
		if (scenario.check) {
			let checks: Check[];
			try { checks = await scenario.check(store(env, work, provider, events, code), vars); }
			catch (error) { checks = [{ name: "store readable", ok: false, detail: String(error) }]; }
			for (const check of checks) report(check.name, check.ok, check.detail);
		}
	} catch (error) {
		report("scenario setup", false, String(error));
	} finally {
		stopDaemon(); cleanups.delete(stopDaemon);
		provider.stop(); cleanups.delete(provider.stop);
	}
}

if (import.meta.main) {
	try { for (const scenario of scenarios) await run(scenario); }
	finally { teardown(); }
	console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
	process.exit(failures ? 1 : 0);
}
