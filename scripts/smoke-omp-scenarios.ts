// Scenarios for the real-omp smoke test (scripts/smoke-omp.ts). A scenario is
// data: scripted turns per agent plus assertions over the throwaway Kata store.
// Add a scenario by appending an entry to SCENARIOS; the driver and the scripted
// provider need no changes.

import { fileURLToPath } from "node:url";

export type Block = string | { tool: string; args: Record<string, unknown> };
export type TurnContext = {
	/** Text of every message so far (tool results included), oldest first. */
	texts: string[];
	/** System prompt text. */
	system: string;
	/** Every agent prompt recorded so far, oldest first. */
	prompts(): Prompt[];
};
export type Turn = Block[] | ((ctx: TurnContext) => Block[]);

export type Issue = {
	ref: string; title: string; status: string; owner?: string; metadata: Record<string, string>;
	events: { type: string; payload: any }[];
};
/** One model request as the scripted provider saw it. */
export type Request = { agent: string; system: string; /** Text of every user-role message in the request. */ users: string[]; /** Role of every message in the request, in order. */ roles: string[] };
/** One agent prompt: the system prompt the plugin left, and whether the agent ran on omp's main thread. */
export type Prompt = { agent: string; system: string; mainThread: boolean };
/** One finished tool call of an agent; `op` is a todo call's operation. */
export type ToolUse = { agent: string; tool: string; op?: string; isError: boolean; mainThread: boolean };
export type Store = {
	/** Requests recorded by the scripted provider, oldest first. */
	requests(): Request[];
	/** Every agent prompt, oldest first (live runs too). */
	prompts(): Prompt[];
	/** Every finished tool call, oldest first (live runs too). */
	tools(): ToolUse[];
	/** A real model did the work (--live). */
	live: boolean;
	/** Every issue in the project except the ones filtered out by `parent`. */
	issues(): Promise<Issue[]>;
};
export type Check = { name: string; ok: boolean; detail?: string };

/** What an interactive scenario can do to a running omp session. */
export type Session = {
	/** Sends a prompt and resolves once the agent has yielded. */
	prompt(text: string): Promise<void>;
	/** Forks the conversation (RPC `fork`): the process moves onto a new session with the same transcript. */
	fork(): Promise<void>;
	/** Runs kata against the throwaway store, from outside omp. */
	kata(args: string[], env?: NodeJS.ProcessEnv): string;
	/** Requests recorded so far. */
	requests(): Request[];
};

export type Scenario = {
	name: string;
	/** One-shot scenarios: user prompt for the main agent; it must contain the main script's marker. */
	prompt?: string;
	/** Prompt for --live, where a real model has to do the same work unscripted (given the setup's ticket ids). Scenarios without one are scripted-only. */
	livePrompt?: (vars: Record<string, string>) => string;
	/** Interactive scenarios: drive one long-lived omp session (RPC) prompt by prompt. Runs before `check`. */
	drive?(session: Session): Promise<Check[]>;
	/** Keeps the session file on disk (omp's `--no-session` is dropped); RPC `fork` needs one. */
	persist?: boolean;
	/** Contents of the throwaway KATA_HOME/config.toml, written before the store is initialised. */
	config?: string;
	/** omp settings for this run, in config.yml form, passed as a `--config` overlay. */
	ompConfig?: string;
	/** Environment for the omp child. */
	env?: Record<string, string>;
	/** Scripted turns keyed by a marker that appears in the agent's first user message. */
	scripts: Record<string, Turn[]>;
	/** Creates tickets before omp starts; the returned short ids reach the scripts as KATA_SMOKE_VARS (JSON) and `check`. */
	setup?(create: (title: string) => string): Record<string, string>;
	/** Assertions run through `kata show --json` after omp has exited. */
	check?(store: Store, vars: Record<string, string>): Promise<Check[]>;
};

const MAIN = "[smoke:main]";
const SUB = "[smoke:sub]";
const SCOUT = "[smoke:scout]";
const WORKER = "[smoke:worker]";
// omp runs a subagent on a worker thread once nine or more run at once (its docs say four); fourteen puts several on a
// worker.
const PORTS = ["lexer", "parser", "printer", "checker", "linker", "loader", "emitter", "resolver", "formatter", "bundler", "planner", "scheduler", "tracer", "profiler"].map(part => `Port ${part} module`);
const ROLES = ["close", "handBack", "rollback"] as const;
// A scripted delegate closes its issue, runs a tool and leaves it open (hand back), or answers without a tool (rollback).
// Delegates on a worker thread take the roles in turn, in the order they started, so any three of them cover every role
// wherever omp places them; main-thread delegates go by number.
const workerRole = (n: number, prompts: Prompt[]) => {
	const onWorker = [...new Set(prompts.filter(p => /^Port\d+$/.test(p.agent) && !p.mainThread).map(p => p.agent))];
	const turn = onWorker.indexOf(`Port${n}`);
	return ROLES[(turn >= 0 ? turn : n) % ROLES.length];
};
const vars = (): Record<string, string> => JSON.parse(process.env.KATA_SMOKE_VARS ?? "{}");
const lastRef = (ctx: TurnContext, pattern: RegExp) => ctx.texts.join("\n").match(pattern)?.[0];

const evidence = "test:bun smoke scenario ran";
const recorded = { type: "test", command: "bun smoke scenario ran" }; // how Kata stores it
const message = "Verified the smoke scenario by running it end to end against a real omp and a real Kata daemon.";

export const SCENARIOS: Scenario[] = [{
	name: "default",
	config: "[close.transcript]\nenabled = true\n",
	setup: create => ({ bashClosed: create("Close from the main agent's bash") }),
	prompt: `${MAIN} Plan the parser work, delegate the first item, close the second, then stop.`,
	livePrompt: () => `Use the todo tool to plan two items, 'Implement parser module' and 'Write parser tests'. Delegate 'Implement parser module' to a task subagent (name it ImplementParser) and tell it to close its Kata issue with evidence ${evidence} and a 40+ character message. Then mark 'Write parser tests' done through the todo tool with evidence ${evidence} and a 40+ character message. Change no files. Stop when both are closed.`,
	scripts: {
		[MAIN]: [
			[{ tool: "todo", args: { op: "init", list: [{ phase: "Parser", items: ["Implement parser module", "Write parser tests"] }], message: "Smoke parser session" } }],
			[{ tool: "task", args: { name: "ImplementParser", agent: "task", task: `${SUB} Implement parser module`, solutionSpace: "one fix: nothing to change, just close the issue" } }],
			[{ tool: "todo", args: { op: "done", task: "Write parser tests", message, evidence: [evidence] } }],
			[{ tool: "bash", args: { command: `kata close ${vars().bashClosed} --done --message '${message}' --evidence '${evidence}'` } }],
			["All parser work is finished."],
			// omp wakes the main agent when the background delegate reports back.
			["The delegate has reported back."],
		],
		[SUB]: [
			// The binding block in the system prompt names the delegate's own issue.
			ctx => {
				const ref = lastRef({ ...ctx, texts: [ctx.system] }, /Your Kata issue is ([\w#-]+)/)?.replace("Your Kata issue is ", "");
				if (!ref) return ["No Kata binding in system prompt."];
				return [{ tool: "bash", args: { command: `kata close ${ref} --done --message '${message}' --evidence '${evidence}'` } }];
			},
			["Parser module done."],
		],
	},
	async check(store, ids) {
		const issues = await store.issues();
		const bashClosed = issues.find(i => i.ref.endsWith(ids.bashClosed));
		const children = issues.filter(i => i.metadata["todo.phase"]);
		const parent = issues.find(i => i.metadata["omp.session_id"] && !i.metadata["omp.subagent_id"] && !i.metadata["todo.phase"]);
		const parser = children.find(i => i.title === "Implement parser module");
		const tests = children.find(i => i.title === "Write parser tests");
		const hasRecorded = (e: any) => e?.type === recorded.type && e?.command === recorded.command;
		const transcript = (i?: Issue) => i?.events.find(e => e.type === "issue.closed")?.payload?.transcript;
		const closeEvidence = (i?: Issue) => i?.events.find(e => e.type === "issue.closed")?.payload?.evidence ?? [];
		return [
			{ name: "todo init creates the automatic parent", ok: !!parent, detail: parent?.title },
			{ name: "todo init creates both plan tasks", ok: children.length === 2 && !!parser && !!tests, detail: children.map(c => c.title).join(", ") },
			{ name: "task delegation binds to its plan task (omp.subagent_id)", ok: !!parser?.metadata["omp.subagent_id"], detail: JSON.stringify(parser?.metadata) },
			{ name: "no stray issue was created for the delegation", ok: issues.length === 4, detail: `${issues.length} issues` },
			{ name: "todo done closes with the evidence", ok: tests?.status === "closed" && closeEvidence(tests).some(hasRecorded), detail: `${tests?.status} ${JSON.stringify(closeEvidence(tests))}` },
			{ name: "delegate closed its own task with evidence", ok: parser?.status === "closed" && closeEvidence(parser).some(hasRecorded), detail: `${parser?.status} ${JSON.stringify(closeEvidence(parser))}` },
			{ name: "the plugin's todo done close records the omp session", ok: transcript(tests)?.agent === "omp" && !!transcript(tests)?.session_id, detail: JSON.stringify(transcript(tests)) },
			{ name: "the automatic parent's close records the same omp session as todo done", ok: transcript(parent)?.agent === "omp" && transcript(parent)?.session_id === transcript(tests)?.session_id, detail: JSON.stringify(transcript(parent)) },
			{ name: "the main agent's bash close inherits the omp session", ok: bashClosed?.status === "closed" && transcript(bashClosed)?.agent === "omp" && transcript(bashClosed)?.session_id === transcript(tests)?.session_id, detail: `${bashClosed?.status} ${JSON.stringify(transcript(bashClosed))}` },
			{ name: "the delegate's bash close records the omp session", ok: transcript(parser)?.agent === "omp" && !!transcript(parser)?.session_id, detail: JSON.stringify(transcript(parser)) },
			{ name: "session shutdown closed the automatic parent", ok: parent?.status === "closed", detail: parent?.status },
		];
	},
}, {
	name: "inbox",
	// The notify sender and the session share this actor, so the trust rule accepts the requests.
	env: { KATA_INBOX_USER: "smoke-user/lead", KATA_AUTHOR: "smoke-user" },
	// A prompt containing "slow-work" runs a slow bash step; every other turn just answers.
	scripts: { [MAIN]: Array.from({ length: 60 }, () => (ctx: TurnContext) => ctx.texts.at(-1)?.includes("slow-work") ? [{ tool: "bash", args: { command: "sleep 4" } }] : ["noted"]) },
	async drive(session) {
		const checks: Check[] = [];
		const target = JSON.parse(session.kata(["create", "Inbox target", "--json"])).issue.short_id;
		const main = () => session.requests().filter(r => r.agent === MAIN);
		const carrying = (mark: string) => main().filter(r => r.users.some(u => u.includes(mark)));
		const shows = (mark: string) => (main().at(-1)?.system ?? "").includes(`<kata_inbox>`) && (main().at(-1)?.system ?? "").includes(mark);
		const until = async (condition: () => boolean, ms = 20_000) => { for (const end = Date.now() + ms; !condition() && Date.now() < end;) await new Promise(r => setTimeout(r, 100)); return condition(); };
		const notify = (message: string) => session.kata(["notify", target, "--to", "smoke-user/lead", "--message", message]);
		const clear = () => session.kata(["notify", target, "--to", "smoke-user/lead", "--clear"]);
		await session.prompt(`${MAIN} start`);
		checks.push({ name: "no inbox section before any notify", ok: !shows("smoke-") });

		// An idle agent: nobody types, yet a turn starts on the request.
		notify("smoke-idle-marker");
		const idle = await until(() => carrying("smoke-idle-marker").length > 0);
		checks.push({ name: "a notify to an idle agent starts a turn carrying it", ok: idle, detail: "no request carried the message" });
		const text = carrying("smoke-idle-marker")[0]?.users.find(u => u.includes("smoke-idle-marker")) ?? "";
		checks.push({ name: "the delivered message names the sender, the issue and how to clear it", ok: text.includes("smoke-user") && text.includes(`omp-smoke#${target}`) && text.includes(`kata notify omp-smoke#${target} --to smoke-user/lead --clear`), detail: text });
		// Let the turn the request started finish before the next prompt.
		await new Promise(r => setTimeout(r, 1500));
		await session.prompt("after the idle delivery");
		checks.push({ name: "the inbox section shows the request on the next prompt", ok: shows("smoke-idle-marker") });
		// Later requests keep the delivered message in their history, so a second delivery shows as a second copy there.
		const copies = (mark: string) => main().at(-1)?.users.filter(u => u.includes(mark)).length ?? 0;
		checks.push({ name: "the idle request was delivered once", ok: copies("smoke-idle-marker") === 1, detail: `${copies("smoke-idle-marker")} copies` });

		clear();
		await new Promise(r => setTimeout(r, 1500));
		const afterClear = main().length;
		await session.prompt("after the clear");
		checks.push({ name: "clearing delivers nothing", ok: main().length === afterClear + 1, detail: `${main().length - afterClear} requests after the clear` });
		checks.push({ name: "the cleared request leaves the section", ok: !shows("smoke-idle-marker") });

		// A request another actor wrote for this session never starts a turn nor reaches a prompt.
		const before = main().length;
		session.kata(["notify", target, "--to", "smoke-user/lead", "--message", "smoke-forged-marker"], { KATA_AUTHOR: "mallory" });
		await new Promise(r => setTimeout(r, 2500));
		checks.push({ name: "a request from another actor starts no turn", ok: main().length === before, detail: `${main().length - before} new requests` });
		await session.prompt("after the forged request");
		const everywhere = session.requests().filter(r => r.system.includes("smoke-forged-marker") || r.users.some(u => u.includes("smoke-forged-marker")));
		checks.push({ name: "its marker is in no system prompt or user message", ok: everywhere.length === 0, detail: `${everywhere.length} requests` });
		session.kata(["notify", target, "--to", "smoke-user/lead", "--clear"], { KATA_AUTHOR: "mallory" });

		// A working agent: the request waits for the step boundary, behind the tool result.
		const running = session.prompt("slow-work please");
		await new Promise(r => setTimeout(r, 1500));
		notify("smoke-working-marker");
		await running;
		const working = carrying("smoke-working-marker");
		checks.push({ name: "a notify to a working agent arrives within the same run, once", ok: working.length > 0 && copies("smoke-working-marker") === 1, detail: `${working.length} requests carried it, ${copies("smoke-working-marker")} copies` });
		const roles = working[0]?.roles ?? [];
		checks.push({ name: "it arrives after the slow tool step finished, not by interrupting it", ok: roles.slice(-3).join() === "assistant,toolResult,user", detail: roles.join() });
		clear();
		return checks;
	},
}, {
	name: "inbox-per-turn",
	// KATA_OMP_LIVE_INBOX=0 is what tern-kata sets for the agents it starts: it delivers there itself.
	env: { KATA_INBOX_USER: "smoke-user/lead", KATA_AUTHOR: "smoke-user", KATA_OMP_LIVE_INBOX: "0" },
	scripts: { [MAIN]: Array.from({ length: 12 }, () => ["noted"]) },
	async drive(session) {
		const MARK = "smoke-inbox-marker";
		const target = JSON.parse(session.kata(["create", "Inbox target", "--json"])).issue.short_id;
		const latest = () => session.requests().filter(r => r.agent === MAIN).at(-1)?.system ?? "";
		const seen = () => latest().includes("<kata_inbox>") && latest().includes(MARK);
		// A read slower than the hook's budget lands on the following turn, so allow two.
		const within = async (limit: number, want: boolean) => {
			for (let n = 1; n <= limit; n++) { await session.prompt(`turn ${n}`); if (seen() === want) return n; }
			return 0;
		};
		const checks: Check[] = [];
		await session.prompt(`${MAIN} start`);
		checks.push({ name: "no inbox section before any notify", ok: !seen() });
		session.kata(["notify", target, "--to", "smoke-user/lead", "--message", MARK]);
		await new Promise(r => setTimeout(r, 2000));
		checks.push({ name: "with live delivery off, a notify starts no turn", ok: !session.requests().some(r => r.users.some(u => u.includes(MARK))) && session.requests().length === 1, detail: `${session.requests().length} requests` });
		const shown = await within(2, true);
		checks.push({ name: "notify sent mid-session reaches the system prompt within two turns", ok: shown > 0, detail: "never appeared" });
		session.kata(["notify", target, "--to", "smoke-user/lead", "--clear"]);
		const cleared = await within(2, false);
		checks.push({ name: "clearing the request removes the section within two turns", ok: cleared > 0, detail: "still present" });
		await session.prompt("one more turn");
		checks.push({ name: "the cleared request stays gone", ok: !seen() });
		checks.push({ name: "no message was delivered live at any point", ok: !session.requests().some(r => r.users.some(u => u.includes(MARK))) });
		return checks;
	},
}, {
	name: "fork",
	persist: true,
	// Stop reminders re-prompt the agent, so a turn chooses by what it was last told rather than by its position.
	scripts: { [MAIN]: [
		[{ tool: "todo", args: { op: "init", items: ["Shared plan item one", "Shared plan item two"] } }],
		...Array.from({ length: 12 }, () => (ctx: TurnContext) => ctx.texts.at(-1)?.includes("extend the plan")
			? [{ tool: "todo", args: { op: "append", items: ["Added after the fork"] } }] : ["Noted."]),
	] },
	async drive(session) {
		await session.prompt(`${MAIN} plan the work`);
		await session.fork();
		await session.prompt("extend the plan");
		const issues: any[] = JSON.parse(session.kata(["list", "--status", "all", "--json"])).issues;
		const parents = issues.filter(i => i.metadata?.["omp.auto_parent"] === true);
		const children: any[] = parents.length === 1 ? JSON.parse(session.kata(["show", parents[0].short_id, "--json"])).children : [];
		return [
			{ name: "a forked session creates no second automatic parent", ok: parents.length === 1, detail: `${parents.length} parents` },
			{ name: "the fork's new item joins the source plan", ok: children.map(c => c.title).sort().join("|") === "Added after the fork|Shared plan item one|Shared plan item two", detail: children.map(c => c.title).join(", ") },
		];
	},
}, {
	name: "tickets",
	prompt: `${MAIN} Work the existing tickets through the todo plan, then stop.`,
	livePrompt: ({ a, b, c }) => [
		`Kata tickets omp-smoke#${a}, omp-smoke#${b} and omp-smoke#${c} already exist. Change no files; use the todo tool and one task subagent, in this order:`,
		`1. init a plan with phase Alpha items 'omp-smoke#${a}: write the parser' and 'omp-smoke#${a}: bump the docs', and phase Beta item 'omp-smoke#${b}: fetch the inbox data'.`,
		`2. Mark 'omp-smoke#${a}: write the parser' done with evidence test:bun smoke scenario first, then 'omp-smoke#${a}: bump the docs' done with evidence test:bun smoke scenario second, each with a 40+ character message.`,
		`3. Append 'omp-smoke#zzzz: ghost work' to phase Beta. It is expected to fail; do not retry it.`,
		`4. Drop 'omp-smoke#${b}: fetch the inbox data' with a reason.`,
		`5. Append 'omp-smoke#${c}: write the widget parser' to phase Gamma and delegate exactly that item to a task subagent named WidgetParser, telling it to close its Kata issue with evidence ${evidence} and a 40+ character message.`,
		`6. Append 'update CHANGELOG' to phase Gamma and mark it done with evidence ${evidence} and a 40+ character message.`,
	].join("\n"),
	setup: create => ({ a: create("Ticket alpha"), b: create("Ticket beta"), c: create("Ticket gamma") }),
	scripts: {
		[MAIN]: [
			() => {
				const { a, b } = vars();
				return [{ tool: "todo", args: { op: "init", list: [
					{ phase: "Alpha", items: [`omp-smoke#${a}: write the parser`, `omp-smoke#${a}: bump the docs`] },
					{ phase: "Beta", items: [`omp-smoke#${b}: fetch the inbox data`] },
				] } }];
			},
			() => [{ tool: "todo", args: { op: "done", task: `omp-smoke#${vars().a}: write the parser`, message, evidence: ["test:bun smoke scenario first"] } }],
			() => [{ tool: "todo", args: { op: "done", task: `omp-smoke#${vars().a}: bump the docs`, message, evidence: ["test:bun smoke scenario second"] } }],
			() => [{ tool: "todo", args: { op: "append", items: ["omp-smoke#zzzz: ghost work"], phase: "Beta" } }],
			() => [{ tool: "todo", args: { op: "drop", task: `omp-smoke#${vars().b}: fetch the inbox data`, message: "The inbox fetch moved to another plan." } }],
			() => [{ tool: "todo", args: { op: "append", items: [`omp-smoke#${vars().c}: write the widget parser`], phase: "Gamma" } }],
			[{ tool: "task", args: { name: "WidgetParser", agent: "task", task: `${SUB} Write the widget parser and close its ticket.`, solutionSpace: "one fix: nothing to change, just close the ticket" } }],
			[{ tool: "todo", args: { op: "append", items: ["update CHANGELOG"], phase: "Gamma" } }],
			[{ tool: "todo", args: { op: "done", task: "update CHANGELOG", message, evidence: [evidence] } }],
			["The tickets are worked."],
			["The delegate has reported back."],
			["Nothing else to do."],
			["Nothing else to do."],
			["Nothing else to do."],
		],
		[SUB]: [
			ctx => {
				const ref = lastRef({ ...ctx, texts: [ctx.system] }, /Your Kata issue is ([\w#.-]+)/)?.replace("Your Kata issue is ", "");
				if (!ref) return ["No Kata binding in system prompt."];
				return [{ tool: "bash", args: { command: `kata close ${ref} --done --message '${message}' --evidence '${evidence}'` } }];
			},
			["Widget parser done."],
		],
	},
	async check(store, { a, b, c }) {
		const issues = await store.issues();
		const byId = (id: string) => issues.find(i => i.ref === id);
		const [alpha, beta, gamma] = [byId(a), byId(b), byId(c)];
		const events = (i?: Issue, type?: string) => i?.events.filter(e => e.type === type) ?? [];
		const comments = (i?: Issue) => i?.events.filter(e => /comment/.test(e.type)) ?? [];
		const closed = events(alpha, "issue.closed");
		const parents = issues.filter(i => i.metadata["omp.auto_parent"] === true);
		const changelog = issues.find(i => i.title === "update CHANGELOG");
		return [
			{ name: "items naming tickets create no issue; only the plain item and its parent are new", ok: issues.length === 5 && parents.length === 1 && !!changelog, detail: issues.map(i => i.title).join(", ") },
			{ name: "the plain item is a child of the automatic parent", ok: !!changelog?.metadata["todo.phase"] && parents.length === 1, detail: JSON.stringify(changelog?.metadata) },
			{ name: "named tickets never join a plan (no todo.phase)", ok: [alpha, beta, gamma].every(i => !i?.metadata["todo.phase"]), detail: JSON.stringify([alpha, beta, gamma].map(i => i?.metadata)) },
			{ name: "finishing every item closes the ticket once with the last item's evidence", ok: alpha?.status === "closed" && closed.length === 1 && JSON.stringify(closed[0].payload.evidence) === JSON.stringify([{ type: "test", command: "bun smoke scenario second" }]), detail: JSON.stringify(closed) },
			{ name: "each finished item left a comment", ok: comments(alpha).length === 2, detail: `${comments(alpha).length} comments` },
			{ name: "drop comments and leaves the ticket open", ok: beta?.status === "open" && comments(beta).length === 1 && events(beta, "issue.closed").length === 0, detail: `${beta?.status} ${comments(beta).length} comments` },
			{ name: "an unresolvable ref created nothing", ok: !issues.some(i => /ghost/.test(i.title)) },
			{ name: "a delegate bound the ticket its item names and closed it", ok: !!gamma?.metadata["omp.subagent_id"] && gamma.status === "closed" && !issues.some(i => i.title.startsWith("Subagent")), detail: `${gamma?.status} ${JSON.stringify(gamma?.metadata)}` },
		];
	},
}, {
	name: "claimed",
	prompt: `${MAIN} Claim the ticket, plan it through the todo tool, then stop.`,
	livePrompt: ({ t }) => [
		`Kata ticket omp-smoke#${t} already exists. Change no files. As Kata's contract says, claim it first with bash (kata claim omp-smoke#${t}), then use the todo tool in this order:`,
		`1. init a plan with the items 'omp-smoke#${t}: write the greeting' and 'Add the ignore file'.`,
		`2. Mark 'omp-smoke#${t}: write the greeting' done with evidence test:bun smoke scenario ticket item and a 40+ character message.`,
		`3. Mark 'Add the ignore file' done with evidence ${evidence} and a 40+ character message. Do not close the ticket yourself.`,
	].join("\n"),
	setup: create => ({ t: create("Ticket claimed first") }),
	scripts: {
		[MAIN]: [
			() => [{ tool: "bash", args: { command: `kata claim omp-smoke#${vars().t}` } }],
			() => [{ tool: "todo", args: { op: "init", items: [`omp-smoke#${vars().t}: write the greeting`, "Add the ignore file"] } }],
			() => [{ tool: "todo", args: { op: "done", task: `omp-smoke#${vars().t}: write the greeting`, message, evidence: ["test:bun smoke scenario ticket item"] } }],
			[{ tool: "todo", args: { op: "done", task: "Add the ignore file", message, evidence: [evidence] } }],
			["The ticket is worked."],
			["Nothing else to do."],
			["Nothing else to do."],
		],
	},
	async check(store, { t }) {
		const issues = await store.issues();
		const ticket = issues.find(i => i.ref === t);
		const closed = ticket?.events.filter(e => e.type === "issue.closed") ?? [];
		const blocking = ticket?.events.filter(e => /comment/.test(e.type) && /open child/.test(JSON.stringify(e.payload))) ?? [];
		return [
			{ name: "the claimed ticket is the plan parent: the plain item is its child", ok: issues.some(i => i.title === "Add the ignore file" && i.status === "closed"), detail: issues.map(i => `${i.title}:${i.status}`).join(", ") },
			{ name: "the ticket closes once its plan children close, with the ticket item's evidence", ok: ticket?.status === "closed" && closed.length === 1 && JSON.stringify(closed[0].payload.evidence) === JSON.stringify([{ type: "test", command: "bun smoke scenario ticket item" }]), detail: `${ticket?.status} ${JSON.stringify(closed)}` },
			{ name: "the refused close left exactly one blocking comment", ok: blocking.length === 1, detail: `${blocking.length} comments` },
		];
	},
}, {
	name: "untracked",
	prompt: `${MAIN} Plan the docs work, send a scout to survey the repo, close both items, then stop.`,
	livePrompt: () => `Use the todo tool to plan two items, 'Write migration guide' and 'Refresh release notes'. Then use the task tool to send one subagent with agent "scout" to list the top-level directories of this repository and report them. After it reports, mark both items done through the todo tool with evidence ${evidence} and a 40+ character message. Change no files. Stop when both are closed.`,
	scripts: {
		[MAIN]: [
			[{ tool: "todo", args: { op: "init", list: [{ phase: "Docs", items: ["Write migration guide", "Refresh release notes"] }], message: "Smoke untracked session" } }],
			// No bash for this agent, and nothing in the prompt matches a plan item or names a ticket.
			[{ tool: "task", args: { name: "Survey", agent: "scout", task: `${SCOUT} Survey the repository layout and report the top-level directories.`, solutionSpace: "one answer: a plain text report" } }],
			[{ tool: "todo", args: { op: "done", task: "Write migration guide", message, evidence: ["test:bun smoke scenario first"] } }],
			[{ tool: "todo", args: { op: "done", task: "Refresh release notes", message, evidence: ["test:bun smoke scenario second"] } }],
			["All docs work is finished."],
			["The scout has reported back."],
			["Nothing else to do."],
		],
		[SCOUT]: [["The repository has no interesting layout."]],
	},
	async check(store) {
		const issues = await store.issues();
		const children = issues.filter(i => i.metadata["todo.phase"]);
		const parent = issues.find(i => i.metadata["omp.session_id"] && !i.metadata["todo.phase"]);
		// kata notify stores a request as notify.<recipient> metadata.
		const requests = issues.filter(i => Object.keys(i.metadata).some(key => key.startsWith("notify."))).map(i => i.ref);
		const labelled = issues.filter(i => i.events.some(e => /label/.test(e.type) && JSON.stringify(e.payload).includes("needs-review")));
		return [
			{ name: "only the parent and the two plan items exist", ok: issues.length === 3 && children.length === 2 && !!parent, detail: issues.map(i => i.title).join(", ") },
			{ name: "the scout created no Subagent issue", ok: !issues.some(i => i.title.startsWith("Subagent")), detail: issues.map(i => i.title).join(", ") },
			{ name: "no issue carries needs-review", ok: labelled.length === 0, detail: labelled.map(i => i.ref).join(", ") },
			{ name: "the lead got no inbox request", ok: requests.length === 0, detail: requests.join(", ") },
			{ name: "session shutdown closed the automatic parent", ok: parent?.status === "closed", detail: parent?.status },
		];
	},
}, {
	name: "workers",
	config: "[close.transcript]\nenabled = true\n",
	// omp strips its todo tool from subagents unless prewalk is armed for their agent; a prewalk target lets delegates
	// call todo. It hands off at a delegate's first edit; the target is a subscription model, and must differ from the
	// --model of a live run in model or thinking level, or omp skips prewalk. Scripted runs skip it: no login.
	ompConfig: "task:\n  agentPrewalk:\n    task: anthropic/claude-haiku-5-5:low\n",
	prompt: `${MAIN} Plan the ports, delegate all of them at once, then stop.`,
	// Live: odd delegates plan one step under their own issue with the todo tool, finish it, then close their issue; even
	// ones run a tool and leave their task open, so the lead hands it back.
	livePrompt: () => [
		`Use the todo tool to plan these items in one phase: ${PORTS.map(p => `'${p}'`).join(", ")}.`,
		`Then delegate all of them in ONE task call with exactly ${PORTS.length} tasks, named Port1 to Port${PORTS.length} in that order, task N working item N. Copy each task's instructions exactly, with <item> replaced by its item:`,
		`- Port1, Port3, Port5 and every other odd-numbered task: "Work '<item>'. Change no files. First call the todo tool with op init and items ['Verify <item>']. Then call the todo tool with op done, task 'Verify <item>', evidence ['${evidence}'] and a message of at least 40 characters. Then close your own Kata issue with the kata close command your Kata binding gives, with evidence '${evidence}'. Do nothing else: no exploring, no tests, no other todo items or files. If a step fails twice, report the error and stop."`,
		`- Port2, Port4, Port6 and every other even-numbered task: "Work '<item>'. Change no files. Run the bash command ls exactly once, then stop. Do nothing else: do not close or change your Kata issue, do not call the todo tool, do not run tests."`,
		`After the task call, do not close, change or re-plan any task yourself, even when reminded; just stop.`,
	].join("\n"),
	scripts: {
		[MAIN]: [
			[{ tool: "todo", args: { op: "init", list: [{ phase: "Ports", items: PORTS }], message: "Smoke worker-thread session" } }],
			[{ tool: "task", args: { context: "Smoke port work: nothing to change, just close your Kata issue.", tasks: PORTS.map((port, i) => ({ name: `Port${i + 1}`, agent: "task", task: `${WORKER} ${port}`, solutionSpace: "one fix: nothing to change, just close the issue" })) } }],
			["The ports are delegated."],
			// omp wakes the main agent as background delegates report back. Each turn only acknowledges; the end of the turn
			// waits for the hand backs and rollbacks, so the run cannot end before they are written.
			...Array.from({ length: 2 * PORTS.length }, () => ["Noted."]),
		],
		[WORKER]: [
			ctx => {
				const ref = ctx.system.match(/Your Kata issue is ([\w#-]+)/)?.[1];
				if (!ref) return ["No Kata binding in system prompt."];
				const role = workerRole(PORTS.findIndex(port => ctx.texts.some(text => text.includes(port))) + 1, ctx.prompts());
				if (role === "rollback") return ["Nothing to change for this port."];
				if (role === "handBack") return [{ tool: "bash", args: { command: "ls" } }];
				return [{ tool: "bash", args: { command: `kata close ${ref} --done --message '${message}' --evidence '${evidence}'` } }];
			},
			["Port done."],
		],
	},
	async check(store) {
		const issues = await store.issues();
		const children = issues.filter(i => i.metadata["todo.phase"]);
		const parent = issues.find(i => i.metadata["omp.session_id"] && !i.metadata["todo.phase"]);
		const first = new Map<string, Prompt>();
		for (const prompt of store.prompts()) if (/^Port\d+$/.test(prompt.agent) && !first.has(prompt.agent)) first.set(prompt.agent, prompt);
		const taskOf = (n: number) => children.find(c => c.title === PORTS[n - 1]);
		const wrong = PORTS.map((_, i) => {
			const ref = first.get(`Port${i + 1}`)?.system.match(/Your Kata issue is [\w-]+#([\w]+)/)?.[1];
			const task = taskOf(i + 1);
			return !task || ref !== task.ref ? `Port${i + 1}: ${ref ?? "none"} for ${task?.ref ?? "no task"}` : undefined;
		}).filter(Boolean);
		const labelled = (i?: Issue) => !!i?.events.some(e => /label/.test(e.type) && JSON.stringify(e.payload).includes("needs-review"));
		const onWorker = [...first.values()].filter(p => !p.mainThread).map(p => p.agent);
		const checks: Check[] = [
			{ name: "omp ran at least one delegate on a worker thread", ok: onWorker.length > 0, detail: `${onWorker.length} of ${first.size} delegates off the main thread` },
			{ name: "every delegate, on a worker or not, saw its own plan task in its system prompt", ok: first.size === PORTS.length && wrong.length === 0, detail: wrong.join(", ") || `${first.size} delegates prompted` },
		];
		const numbers = PORTS.map((_, i) => i + 1);
		const tools = store.tools();
		const notified = (i?: Issue) => Object.keys(i?.metadata ?? {}).some(key => key.startsWith("notify."));
		// Hand back: a delegate that ran a tool and left its task open; one whose tool use never reached the lead is rolled back instead, unlabelled.
		const handedBack = (n: number) => {
			const task = taskOf(n);
			return labelled(task) && task?.metadata["work.attention"] === "needs-human" && notified(task) && tools.some(t => t.agent === `Port${n}` && t.tool === "bash");
		};
		const rolledBack = (n: number) => {
			const task = taskOf(n);
			return task?.status === "open" && !task.metadata["omp.subagent_id"] && !labelled(task) && !notified(task);
		};
		// A delegate that ran init twice has two steps of that title; the one it finished is the one closed as done.
		const doneClose = (i: Issue) => i.events.some(e => e.type === "issue.closed" && e.payload?.reason === "done");
		const stepOf = (n: number) => {
			const steps = issues.filter(i => i.title === `Verify ${PORTS[n - 1]}`);
			return steps.find(doneClose) ?? steps[0];
		};
		const describe = (ns: number[], ok: (n: number) => boolean) => ns.filter(n => !ok(n)).map(n => `Port${n}${onWorker.includes(`Port${n}`) ? " (worker)" : ""}: ${taskOf(n)?.status}, step ${stepOf(n)?.status ?? "none"}, tools ${JSON.stringify(tools.filter(t => t.agent === `Port${n}`).map(t => `${t.tool}${t.op ? `:${t.op}` : ""}${t.isError ? "!" : ""}`))}`).join("; ");
		const onWorkerOf = (ns: number[]) => ns.filter(n => onWorker.includes(`Port${n}`));
		if (!store.live) {
			const outcome = { close: (n: number) => taskOf(n)?.status === "closed" && !labelled(taskOf(n)), handBack: handedBack, rollback: rolledBack };
			const prompts = store.prompts(), roleOf = (n: number) => workerRole(n, prompts);
			const asScripted = (n: number) => outcome[roleOf(n)](n);
			const uncovered = ROLES.filter(role => onWorkerOf(numbers.filter(n => roleOf(n) === role)).length === 0);
			return [...checks,
				{ name: "every role (close, hand back, rollback) has a delegate on a worker thread", ok: uncovered.length === 0, detail: `missing ${uncovered.join(", ")}; worker delegates ${onWorker.join(", ")}` },
				{ name: "every delegate's task ended as its script directs: closed, handed back or rolled back", ok: numbers.every(asScripted), detail: describe(numbers, asScripted) },
				{ name: "no stray issue", ok: issues.length === PORTS.length + 1, detail: `${issues.length} issues` },
			];
		}
		const closers = numbers.filter(n => n % 2 === 1), leavers = numbers.filter(n => n % 2 === 0);
		const used = (n: number, op: string) => tools.some(t => t.agent === `Port${n}` && t.tool === "todo" && t.op === op && !t.isError);
		const workedThroughTodo = (n: number) => used(n, "init") && used(n, "done") && stepOf(n)?.status === "closed" && taskOf(n)?.status === "closed";
		const sessionOf = (i?: Issue) => i?.events.find(e => e.type === "issue.closed")?.payload?.transcript?.session_id;
		// The todo close and the bash close of one delegate both carry that delegate's own session; without its record, the lead's.
		const ownSession = (n: number) => !!sessionOf(stepOf(n)) && sessionOf(stepOf(n)) === sessionOf(taskOf(n)) && sessionOf(taskOf(n)) !== parent?.metadata["omp.session_id"];
		return [...checks,
			{ name: "a delegate on a worker thread planned, finished and closed through its own todo and kata close", ok: onWorkerOf(closers).length > 0 && onWorkerOf(closers).every(workedThroughTodo), detail: `worker delegates ${onWorker.join(", ")}; ${describe(onWorkerOf(closers), workedThroughTodo)}` },
			{ name: "a worker delegate's todo close and kata close record its own omp session, not the lead's", ok: onWorkerOf(closers).length > 0 && onWorkerOf(closers).every(ownSession), detail: onWorkerOf(closers).filter(n => !ownSession(n)).map(n => `Port${n}: step ${sessionOf(stepOf(n)) ?? "none"}, issue ${sessionOf(taskOf(n)) ?? "none"}, lead ${parent?.metadata["omp.session_id"]}`).join("; ") },
			{ name: "a delegate on a worker thread that ran a tool and left its task open was handed back", ok: onWorkerOf(leavers).length > 0 && onWorkerOf(leavers).every(handedBack), detail: `worker delegates ${onWorker.join(", ")}; ${describe(onWorkerOf(leavers), handedBack)}` },
		];
	},
}];

// The same delegation with every Kata call the lead's plugin makes starting late, as on a loaded machine. Delegates are
// assigned one after another, so the last one's first prompt waits for all fourteen assignments. Scripted only.
const workers = SCENARIOS.find(s => s.name === "workers")!;
SCENARIOS.push({ ...workers, name: "workers-slow-kata", livePrompt: undefined,
	env: { KATA_OMP_EXECUTABLE: fileURLToPath(new URL("./smoke-slow-kata.sh", import.meta.url)) } });
