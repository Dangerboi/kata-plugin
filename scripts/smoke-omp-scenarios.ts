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
export type Store = {
	/** Every issue in the project except the ones filtered out by `parent`. */
	issues(): Promise<Issue[]>;
};
export type Check = { name: string; ok: boolean; detail?: string };

export type Scenario = {
	name: string;
	/** User prompt for the main agent; it must contain the main script's marker. */
	prompt: string;
	/** Prompt for --live, where the user's real model has to do the same work unscripted. */
	livePrompt: string;
	/** Scripted turns keyed by a marker that appears in the agent's first user message. */
	scripts: Record<string, Turn[]>;
	/** Assertions run through `kata show --json` after omp has exited. */
	check(store: Store): Promise<Check[]>;
};

const MAIN = "[smoke:main]";
const SUB = "[smoke:sub]";
const lastRef = (ctx: TurnContext, pattern: RegExp) => ctx.texts.join("\n").match(pattern)?.[0];

const evidence = "test:bun smoke scenario ran";
const recorded = { type: "test", command: "bun smoke scenario ran" }; // how Kata stores it
const message = "Verified the smoke scenario by running it end to end against a real omp and a real Kata daemon.";

export const SCENARIOS: Scenario[] = [{
	name: "default",
	prompt: `${MAIN} Plan the parser work, delegate the first item, close the second, then stop.`,
	livePrompt: "Use the todo tool to plan two items, 'Implement parser module' and 'Write parser tests'. Delegate 'Implement parser module' to a task subagent (name it ImplementParser) and tell it to close its Kata issue with evidence test:echo ok. Then mark 'Write parser tests' done through the todo tool with evidence test:echo ok and a 40+ character message. Change no files. Stop when both are closed.",
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
}];
