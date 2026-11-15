// Smoke test: run a real, headless OpenCode against a real Kata daemon and check what lands in a throwaway Kata store.
//
//   bun run smoke:opencode [--scenario <name>] [--verbose]
//
// Each run gets a fresh Git folder, a throwaway KATA_HOME, HOME and XDG_* directories, and an opencode.json that registers
// the repo's plugins/opencode folder directly and a scripted OpenAI-compatible provider (scripts/smoke-opencode-provider.ts,
// started in this process). No credentials or network are needed.
//
// Add a scenario by appending an entry to SCENARIOS: scripted turns per agent (keyed by a marker in the agent's first user
// message) plus assertions over the throwaway Kata store. The driver changes only for a scenario that restarts OpenCode.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { cleanEnv, closeCount, closeEvent, closeEvidence, closeTranscript, commentsOn, defer, eventsOf, kataProject, labelled, lastLines, option, pickScenarios, report, reportChecks, runToEnd, scratchRoot, teardown, verdict, type Check, type Issue } from "./smoke-lib";
import { MODEL, PROVIDER, startProvider, type Request, type Turn } from "./smoke-opencode-provider";
import { SUBAGENT_PREFIX } from "../plugins/opencode/subagents";

type Store = {
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
type Scenario = {
	name: string;
	/** User prompt for the lead; it must contain the lead script's marker. */
	prompt: string;
	/** Scripted turns keyed by a marker that appears in the agent's first user message (the lead's prompt; a subagent's prompt). */
	scripts: Record<string, Turn[]>;
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

const SCENARIOS: Scenario[] = [];

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
			{ name: "the refused call changed nothing", ok: closeCount(one) === 1 && closeCount(two) === 1 && closeCount(three) === 1 && String(closeEvent(one)?.message).includes("Parser written") && hasTest(one, "bun test parser"), detail: JSON.stringify([one, two, three].map(i => i?.events.map(e => e.type))) },
			{ name: "the plan section is in the system prompt after the first accepted list", ok: !requests[0].system.includes("Current plan:") && requests.slice(1).every(r => r.system.includes("The todowrite tool is backed by Kata. Current plan:")), detail: JSON.stringify(requests.map(r => r.system.includes("Current plan:"))) },
		];
	},
});

// ---- Delegates: a lead's `subagent` calls bound to its plan items ----
const DELEGATE_PLAN = ["Build the parser", "Document the parser"];
const planOf = (items: string[]) => [{ tool: "todowrite", args: { todos: items.map((content, n) => ({ content, status: n ? "pending" : "in_progress" })) } }];
// The child's session id as the lead's subagent result names it.
const childOf = (texts: string[]) => texts.map(t => /ses_[A-Za-z0-9]+/.exec(t.slice(t.indexOf("sessionID")))?.[0] ?? /sessionID[^A-Za-z0-9]+(ses_[A-Za-z0-9]+)/.exec(t)?.[1]).find(Boolean);
/** The checks every delegate scenario shares: the assignment reached the child, the item came back to the lead open and labelled, the report is a comment. */
function delegateChecks(store: Store, issues: Issue[], marker: string, report: string): Check[] {
	const one = issues.find(i => i.title.includes(DELEGATE_PLAN[0]));
	const two = issues.find(i => i.title.includes(DELEGATE_PLAN[1]));
	const child = store.requests().filter(r => r.agent === marker);
	const assignment = child[0]?.system.match(/You are subagent [^\n]*Your Kata issue is ([^;]+); your teammate is ([^.\s]+)\./);
	const events = (i?: Issue) => i?.events.map(e => e.type) ?? [];
	return [
		{ name: "the delegate's system prompt carries the assignment naming item 1 and its teammate", ok: !!assignment && !!one && assignment[1].endsWith(`#${one.ref}`), detail: JSON.stringify([assignment, one?.ref, child[0]?.system.slice(-600)]) },
		{ name: "the delegate ran a tool and ended with text", ok: child.length === 2 && child[0].tools.includes("read"), detail: `${child.length} child requests` },
		{ name: "item 1 was assigned to the delegate's teammate while it ran", ok: !!assignment && JSON.stringify(one?.events ?? []).includes(assignment[2]), detail: JSON.stringify(one?.events) },
		{ name: "item 1 is open again and not owned by the delegate", ok: one?.status === "open" && !!assignment && one.metadata.teammate !== assignment[2], detail: JSON.stringify([one?.status, one?.metadata]) },
		{ name: "item 1 carries needs-review", ok: labelled(one), detail: JSON.stringify(events(one)) },
		{ name: "the delegate's report is a comment on item 1", ok: commentsOn(one).some(c => c.includes(report)), detail: JSON.stringify(commentsOn(one)) },
		{ name: "item 2 was left alone", ok: two?.status === "open" && !commentsOn(two).length, detail: JSON.stringify([two?.status, events(two)]) },
	];
}
const delegateChild = (report: string): Turn[] => [
	[{ tool: "read", args: { path: "." } }],
	[report],
];
SCENARIOS.push({
	name: "delegate-foreground",
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
		const comments = commentsOn(one);
		const parents = issues.filter(i => store.children(i.ref).length > 0);
		return [
			{ name: "the lead made all calls and ended with text", ok: lead.length === 4, detail: `${lead.length} lead requests` },
			{ name: "the lead named the child's session in the follow-up", ok: !!childOf(lead[2]?.toolResults ?? []), detail: JSON.stringify(lead[2]?.toolResults) },
			{ name: "the plan's two items and their parent are the only issues", ok: issues.length === 3 && parents.length === 1, detail: JSON.stringify(issues.map(i => [i.ref, i.title, i.status])) },
			{ name: "the first report landed on item 1", ok: comments.some(c => c.includes("FU-FIRST")), detail: JSON.stringify(comments) },
			{ name: "the follow-up's report landed on the same issue", ok: comments.some(c => c.includes("FU-SECOND")), detail: JSON.stringify(comments) },
			{ name: "item 1 is open with needs-review and back with the lead", ok: one?.status === "open" && labelled(one), detail: JSON.stringify([one?.status, one?.metadata]) },
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
			{ name: "the close and the comment are the delegate's teammate's", ok: !!assignment && JSON.stringify([...eventsOf(one, "issue.closed"), ...eventsOf(one, "issue.commented")]).includes(assignment[2]) && !!one?.events.some(e => e.type === "issue.commented" && String(e.payload?.body).includes("DC-REPORT")), detail: JSON.stringify([assignment, one?.events]) },
			{ name: "the lead's resend with item 1 completed and no fields was accepted", ok: resend !== "" && !resend.includes("Refused"), detail: resend },
			{ name: "item 2 is in progress", ok: two?.status === "open" && two.metadata["todo.status"] === "in_progress", detail: JSON.stringify([two?.status, two?.owner, two?.metadata]) },
			{ name: "item 1 has no needs-review", ok: !labelled(one), detail: JSON.stringify(one?.events.map(e => e.type)) },
		];
	},
});

const SHARED = "shared-server";
const root = path.resolve(import.meta.dirname, "..");
const pluginFile = path.join(root, "plugins/opencode/kata.ts");
const scenarios = pickScenarios(SCENARIOS, [SHARED]);

const PROJECT = "opencode-smoke";
const TIMEOUT_MS = 120_000;
const base = cleanEnv(/^(OPENCODE|XDG)_/);
const tmp = scratchRoot("opencode-kata-smoke-");

/** The folders of one scenario under the run's root, and the environment that points OpenCode and Kata at them. */
function sandbox(name: string, extra: NodeJS.ProcessEnv = {}) {
	const dir = path.join(tmp, name), work = path.join(dir, "repo"), kataHome = path.join(dir, "kata"), home = path.join(dir, "home");
	for (const d of [work, kataHome, home]) mkdirSync(d, { recursive: true });
	const xdg = Object.fromEntries(["config", "data", "cache", "state"].map(k => [`XDG_${k.toUpperCase()}_HOME`, path.join(home, `.${k}`)]));
	const env: NodeJS.ProcessEnv = { ...base, ...extra, ...xdg, HOME: home, KATA_HOME: kataHome, PWD: work };
	return { dir, work, env };
}

/** Writes the folder's opencode.json: the scripted provider and, unless the plugin is left out, the repo's plugin folder with `options`. */
function writeConfig(work: string, providerUrl: string, options: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
	const config = {
		// The folder itself is the plugin (package.json `exports`); a file path is refused with "configured plugin path must be a directory".
		plugins: [{ package: path.dirname(pluginFile), options }],
		providers: { [PROVIDER]: { package: "@opencode/ai/providers/openai-compatible", name: "Kata smoke", settings: { baseURL: providerUrl, apiKey: "unused" }, models: { [MODEL]: { name: "Scripted" } } } },
		...extra,
	};
	writeFileSync(path.join(work, "opencode.json"), JSON.stringify(config, null, 2));
}

/** Runs `opencode run` for one prompt to its end; `events` are the `--format json` events it printed. */
async function opencodeRun(env: NodeJS.ProcessEnv, cwd: string, mode: string[], prompt: string) {
	const { code, output } = await runToEnd("opencode", ["run", ...mode, "--auto", "--archived", "--format", "json", "-m", `${PROVIDER}/${MODEL}`, prompt], { env, cwd, timeout: TIMEOUT_MS });
	const events = output.split("\n").filter(l => l.startsWith("{")).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
	return { code, output, events };
}

async function run(scenario: Scenario) {
	console.log(`\n# scenario ${scenario.name}`);
	const { work, env } = sandbox(scenario.name, scenario.env);
	let vars: Record<string, string> = {};
	const provider = await startProvider(scenario.scripts, () => vars);
	const stopProvider = defer(provider.stop);
	const project = kataProject(env, work, PROJECT);
	try {
		project.init(scenario.kataConfig);
		vars = scenario.setup?.(project.create) ?? {};
		writeConfig(work, provider.url, scenario.pluginOptions, scenario.config);
		const { code, output, events } = await opencodeRun(env, work, ["--standalone"], scenario.prompt);
		report("opencode exited cleanly", code === 0, `exit ${code}\n${lastLines(output)}`);
		report("the provider saw a request", provider.requests.length > 0, "no model request reached the scripted provider");
		const store: Store = { requests: () => provider.requests, events: () => events, code, kata: project.kata, children: project.children, issues: project.issues };
		await reportChecks(() => scenario.check?.(store, vars) ?? []);
	} catch (error) {
		report("scenario setup", false, String(error));
	} finally {
		project.stopDaemon();
		stopProvider();
	}
}

// ---- Shared server: the default OpenCode mode, one `opencode serve` for several leads ----
const SHARED_PROJECT = "opencode-smoke-default";
const sharedPlan = (tag: string) => [`${tag} one`, `${tag} two`];
const sharedLead = (tag: string): Turn[] => {
	const [one, two] = sharedPlan(tag);
	return [
		[{ tool: "todowrite", args: { todos: [{ content: one, status: "in_progress" }, { content: two, status: "pending" }] } }],
		[{ tool: "todowrite", args: { todos: [{ content: one, status: "completed", message: `${one}: implemented and verified by running its tests, all green.`, evidence: [`test:bun test ${tag}`] }, { content: two, status: "in_progress" }] } }],
		[{ tool: "todowrite", args: { todos: [{ content: one, status: "completed" }, { content: two, status: "completed", message: `${two}: implemented and verified by running its tests, all green.`, evidence: [`test:bun test ${tag} two`] }] } }],
		[`${tag} done`],
	];
};
const freePort = () => new Promise<number>(resolve => {
	const probe = createServer().listen(0, "127.0.0.1", () => {
		const { port } = probe.address() as AddressInfo;
		probe.close(() => resolve(port));
	});
});

/** Two concurrent leads on one `opencode serve`; the project comes from the plugin option alone (no KATA_DEFAULT_PROJECT anywhere). */
async function runShared() {
	console.log(`\n# scenario ${SHARED}`);
	// `opencode serve` insists on a password, and its clients must present the same one.
	const { dir, work, env } = sandbox(SHARED, { OPENCODE_PASSWORD: "smoke-password" });
	const projectDir = path.join(dir, "project");
	mkdirSync(projectDir);
	const tags = ["alpha", "bravo"];
	const provider = await startProvider(Object.fromEntries(tags.map(t => [`[smoke:${t}]`, sharedLead(t)])));
	const stopProvider = defer(provider.stop);
	const project = kataProject(env, projectDir, SHARED_PROJECT);
	let stopServer = () => {};
	try {
		project.init();
		// The lead's folder has no Kata project, so only the plugin option can route its plans.
		spawnSync("git", ["init", "-q", "."], { cwd: work });
		writeConfig(work, provider.url, { defaultProject: SHARED_PROJECT });

		const port = await freePort(), url = `http://127.0.0.1:${port}`;
		let serverLog = "";
		const server = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { env, cwd: work, stdio: ["ignore", "pipe", "pipe"] });
		// Registered before any lead starts, so a teardown kills the leads first.
		stopServer = defer(() => void server.kill("SIGKILL"));
		server.stdout.on("data", d => serverLog += d);
		server.stderr.on("data", d => serverLog += d);
		const up = async () => { for (let n = 0; n < 150; n++) { try { await fetch(url); return true; } catch { await sleep(200); } } return false; };
		report("opencode serve is reachable", await up(), lastLines(serverLog, 10));

		const runs = await Promise.all(tags.map(tag => opencodeRun(env, work, ["--server", url], `[smoke:${tag}] Plan and do the ${tag} work.`)));
		runs.forEach((r, n) => report(`lead ${tags[n]} exited cleanly`, r.code === 0, `exit ${r.code}\n${lastLines(r.output)}`));
		const sessions = runs.map(r => r.events.find(x => x.sessionID)?.sessionID as string | undefined);

		const issues = await project.issues();
		const byTitle = (t: string) => issues.find(i => i.title.includes(t));
		const parents = issues.filter(i => project.children(i.ref).length);
		const checks: Check[] = [
			{ name: "the two leads have distinct sessions", ok: !!sessions[0] && !!sessions[1] && sessions[0] !== sessions[1], detail: JSON.stringify(sessions) },
			{ name: "every plan item landed in the defaultProject project", ok: tags.every(t => sharedPlan(t).every(c => byTitle(c))), detail: JSON.stringify(issues.map(i => [i.ref, i.title])) },
			{ name: "exactly two automatic parents exist", ok: parents.length === 2, detail: JSON.stringify(parents.map(p => [p.ref, p.title])) },
		];
		// Each `children` call runs `kata show`, so find every lead's parent once.
		const parentOf = tags.map(t => parents.find(p => project.children(p.ref).includes(byTitle(sharedPlan(t)[0])?.ref ?? "")));
		tags.forEach((tag, n) => {
			const items = sharedPlan(tag).map(byTitle);
			const parent = parentOf[n];
			const kids = parent ? project.children(parent.ref) : [];
			checks.push(
				{ name: `${tag}: its parent has exactly its own two items`, ok: !!parent && kids.length === 2 && items.every(i => !!i && kids.includes(i.ref)), detail: JSON.stringify([parent?.ref, kids, items.map(i => i?.ref)]) },
				{ name: `${tag}: both items closed done under its own session id`, ok: items.every(i => i?.status === "closed" && closeEvent(i)?.reason === "done" && closeTranscript(i)?.agent === "opencode" && closeTranscript(i)?.session_id === sessions[n]), detail: JSON.stringify(items.map(i => [i?.status, closeTranscript(i)])) },
			);
		});
		const [a, b] = parentOf;
		checks.push({ name: "the two leads have different parents", ok: !!a && !!b && a.ref !== b.ref, detail: JSON.stringify([a?.ref, b?.ref]) });
		await reportChecks(() => checks);
	} catch (error) {
		report("scenario setup", false, String(error));
	} finally {
		stopServer();
		project.stopDaemon();
		stopProvider();
	}
}

try {
	for (const scenario of scenarios) await run(scenario);
	if ([undefined, SHARED].includes(option("--scenario"))) await runShared();
} finally {
	teardown();
}
process.exit(verdict());
