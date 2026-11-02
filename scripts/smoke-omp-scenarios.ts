// Scenarios for the real-omp smoke test (scripts/smoke-omp.ts). A scenario is
// data: scripted turns per agent plus assertions over the throwaway Kata store.
// Add a scenario by appending an entry to SCENARIOS; the driver and the scripted
// provider need no changes.

export type Block = string | { tool: string; args: Record<string, unknown> };
export type TurnContext = {
	/** Text of every message so far (tool results included), oldest first. */
	texts: string[];
	/** System prompt text. */
	system: string;
};
export type Turn = Block[] | ((ctx: TurnContext) => Block[]);

export type Issue = {
	ref: string; title: string; status: string; owner?: string; metadata: Record<string, string>;
	events: { type: string; payload: any }[];
};
/** One model request as the scripted provider saw it. */
export type Request = { agent: string; system: string };
export type Store = {
	/** Requests recorded by the scripted provider, oldest first. */
	requests(): Request[];
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
	kata(args: string[]): string;
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
const vars = (): Record<string, string> => JSON.parse(process.env.KATA_SMOKE_VARS ?? "{}");
const lastRef = (ctx: TurnContext, pattern: RegExp) => ctx.texts.join("\n").match(pattern)?.[0];

const evidence = "test:bun smoke scenario ran";
const recorded = { type: "test", command: "bun smoke scenario ran" }; // how Kata stores it
const message = "Verified the smoke scenario by running it end to end against a real omp and a real Kata daemon.";

export const SCENARIOS: Scenario[] = [{
	name: "default",
	prompt: `${MAIN} Plan the parser work, delegate the first item, close the second, then stop.`,
	livePrompt: () => `Use the todo tool to plan two items, 'Implement parser module' and 'Write parser tests'. Delegate 'Implement parser module' to a task subagent (name it ImplementParser) and tell it to close its Kata issue with evidence ${evidence} and a 40+ character message. Then mark 'Write parser tests' done through the todo tool with evidence ${evidence} and a 40+ character message. Change no files. Stop when both are closed.`,
	scripts: {
		[MAIN]: [
			[{ tool: "todo", args: { op: "init", list: [{ phase: "Parser", items: ["Implement parser module", "Write parser tests"] }], message: "Smoke parser session" } }],
			[{ tool: "task", args: { name: "ImplementParser", agent: "task", task: `${SUB} Implement parser module`, solutionSpace: "one fix: nothing to change, just close the issue" } }],
			[{ tool: "todo", args: { op: "done", task: "Write parser tests", message, evidence: [evidence] } }],
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
	async check(store) {
		const issues = await store.issues();
		const children = issues.filter(i => i.metadata["todo.phase"]);
		const parent = issues.find(i => i.metadata["omp.session_id"] && !i.metadata["omp.subagent_id"] && !i.metadata["todo.phase"]);
		const parser = children.find(i => i.title === "Implement parser module");
		const tests = children.find(i => i.title === "Write parser tests");
		const hasRecorded = (e: any) => e?.type === recorded.type && e?.command === recorded.command;
		const closeEvidence = (i?: Issue) => i?.events.find(e => e.type === "issue.closed")?.payload?.evidence ?? [];
		return [
			{ name: "todo init creates the automatic parent", ok: !!parent, detail: parent?.title },
			{ name: "todo init creates both plan tasks", ok: children.length === 2 && !!parser && !!tests, detail: children.map(c => c.title).join(", ") },
			{ name: "task delegation binds to its plan task (omp.subagent_id)", ok: !!parser?.metadata["omp.subagent_id"], detail: JSON.stringify(parser?.metadata) },
			{ name: "no stray issue was created for the delegation", ok: issues.length === 3, detail: `${issues.length} issues` },
			{ name: "todo done closes with the evidence", ok: tests?.status === "closed" && closeEvidence(tests).some(hasRecorded), detail: `${tests?.status} ${JSON.stringify(closeEvidence(tests))}` },
			{ name: "delegate closed its own task with evidence", ok: parser?.status === "closed" && closeEvidence(parser).some(hasRecorded), detail: `${parser?.status} ${JSON.stringify(closeEvidence(parser))}` },
			{ name: "session shutdown closed the automatic parent", ok: parent?.status === "closed", detail: parent?.status },
		];
	},
}, {
	name: "inbox",
	env: { KATA_INBOX_USER: "smoke-user" },
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
		session.kata(["notify", target, "--to", "smoke-user", "--message", MARK]);
		const shown = await within(2, true);
		checks.push({ name: "notify sent mid-session reaches the system prompt within two turns", ok: shown > 0, detail: "never appeared" });
		session.kata(["notify", target, "--to", "smoke-user", "--clear"]);
		const cleared = await within(2, false);
		checks.push({ name: "clearing the request removes the section within two turns", ok: cleared > 0, detail: "still present" });
		await session.prompt("one more turn");
		checks.push({ name: "the cleared request stays gone", ok: !seen() });
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
}];
