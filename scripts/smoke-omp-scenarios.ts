// Scenarios for the real-omp smoke test (scripts/smoke-omp.ts). A scenario is
// data: scripted turns per agent plus assertions over the throwaway Kata store.
// omp runs its own native `todo` tool; the plugin mirrors that list into Kata through
// the `kata` todo backend (the driver selects it for every run) and refuses `todo`
// calls Kata's rules forbid, through the backend's `apply` (omp asks it at execute time). Scripts send native params only, and they close
// a plan task with a `kata close` bash call before `todo done`. Assertions read the
// store, or the tool results a request carried, never a todo result's details.
// Add a scenario by appending an entry to SCENARIOS. The driver and the scripted
// provider need changes only for a scenario that restarts omp (`restart`: kill and
// `--resume`), needs a new RPC command, or needs a model call that hangs (`{ hang: true }`).

import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ownComment } from "../core/delegates";
import { closeCount, closeEvent, closeEvidence, closeTranscript, closingTeammate, eventsOf, labelled, type Check, type Issue } from "./smoke-lib";
import type { SmokeContext, SmokeTurn } from "./smoke-provider";

export type TurnContext = SmokeContext & {
	/** Every agent prompt recorded so far, oldest first. */
	prompts(): Prompt[];
};
export type Turn = SmokeTurn<TurnContext>;

/** One model request as the scripted provider saw it. */
export type Request = { agent: string; system: string; /** Text of every user-role message in the request. */ users: string[]; /** Role of every message in the request, in order. */ roles: string[]; /** Text of every tool-result message in the request: what the agent was told about its tool calls, refusals included. */ results: string[] };
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
	/** Every issue in the project. */
	issues(): Promise<Issue[]>;
};

/** What an interactive scenario can do to a running omp session. */
export type Session = {
	/** Sends a prompt and resolves once the agent has yielded. */
	prompt(text: string): Promise<void>;
	/** Forks the conversation (RPC `fork`): the process moves onto a new session with the same transcript. */
	fork(): Promise<void>;
	/** Waits until the persisted session file contains `saved`, SIGKILLs omp (no shutdown hook runs) and resumes that same session in a new process (`--resume <file>`). Needs `persist`. */
	restart(saved: string): Promise<void>;
	/** Runs kata against the throwaway store, from outside omp. */
	kata(args: string[], env?: NodeJS.ProcessEnv): string;
	/** Requests recorded so far. */
	requests(): Request[];
	/** Finished tool calls recorded so far. */
	tools(): ToolUse[];
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
	/** omp settings for this run, in config.yml form, appended to the driver's own `todo.backend: kata` in the `--config` overlay. */
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

const SAME = "[smoke:same]";
const MAIN = "[smoke:main]";
const SUB = "[smoke:sub]";
const SCOUT = "[smoke:scout]";
const WORKER = "[smoke:worker]";
const CUT = "[smoke:cut]";
const IDLE = "[smoke:idle]";
const RESUMED = "[smoke:resumed] Welcome back; look at the plan.";
const RESUME_HAND_BACK = "Resume hand back item";
const RESUME_ROLL_BACK = "Resume roll back item";
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
// kata notify stores a request as notify.<recipient> metadata.
const notified = (i?: Issue) => Object.keys(i?.metadata ?? {}).some(key => key.startsWith("notify."));
// A delegate that closed its issue and exited: bound by the lead's session, outcome completed, no subagent key.
const returnedToLead = (i?: Issue) => !!i?.metadata["omp.session_id"] && i.metadata["omp.status"] === "completed" && !i.metadata["omp.subagent_id"];

const evidence = "test:bun smoke scenario ran";
const recorded = { type: "test", command: "bun smoke scenario ran" }; // how Kata stores it
const message = "Verified the smoke scenario by running it end to end against a real omp and a real Kata daemon.";

export const PROJECT = "omp-smoke";
// A plan task is mirrored into Kata after omp's own todo call returns, and that mirror needs the omp process's event loop,
// so a scripted turn never waits for it itself. It hands omp's bash tool a bun script instead: the script polls `kata list`
// until the plan task's child issue exists, then runs `run` with `ref` (qualified) and `kata(...)` in scope.
const onChild = (title: string, run: string) => `bun -e '${[
	'const { execFileSync: x } = require("node:child_process");',
	'const kata = (...a) => x("kata", a, { encoding: "utf8" });',
	"for (let n = 0; n < 150; n++) {",
	`	const hit = JSON.parse(kata("list", "--status", "all", "--limit", "0", "--json")).issues.find(i => i.title === ${JSON.stringify(title)} && i.metadata?.["todo.phase"]);`,
	`	if (hit) { const ref = "${PROJECT}#" + hit.short_id; ${run} process.exit(0); }`,
	"	Bun.sleepSync(200);",
	"}",
	"process.exit(1);",
].join("\n")}'`;
const closeChild = (title: string, test: string) => onChild(title, `kata("close", ref, "--done", "--message", ${JSON.stringify(message)}, "--test", ${JSON.stringify(test)}); console.log("closed " + ref);`);
const showChild = (title: string) => onChild(title, `console.log("child-state " + ref + " " + JSON.parse(kata("show", ref, "--json")).issue.status);`);
const closeIssue = (ref: string, test: string) => `kata close ${ref} --done --message '${message}' --test '${test}'`;
// Waits in omp's bash tool (not in the provider) until the resumed lead has settled both cut delegates.
const waitSettled = (handBack: string, rollBack: string) => `bun -e '${[
	'const { execFileSync: x } = require("node:child_process");',
	"for (let n = 0; n < 160; n++) {",
	'	const issues = JSON.parse(x("kata", ["list", "--status", "all", "--limit", "0", "--json"], { encoding: "utf8" })).issues;',
	`	const hand = issues.find(i => i.title === ${JSON.stringify(handBack)}), roll = issues.find(i => i.title === ${JSON.stringify(rollBack)});`,
	'	if (hand?.metadata?.["omp.status"] === "aborted" && roll && !roll.metadata?.["omp.subagent_id"]) break;',
	"	Bun.sleepSync(250);",
	"}",
	'console.log("settled");',
].join("\n")}'`;

export const SCENARIOS: Scenario[] = [{
	name: "default",
	setup: create => ({ bashClosed: create("Close from the main agent's bash") }),
	prompt: `${MAIN} Plan the parser work, delegate the first item, close the second, then stop.`,
	livePrompt: () => `Use the todo tool to plan two items, 'Implement parser module' and 'Write parser tests'. Delegate 'Implement parser module' to a task subagent (name it ImplementParser) and tell it to close its Kata issue with evidence ${evidence} and a 40+ character message. Then finish 'Write parser tests': the todo tool refuses 'done' while its Kata issue is open, so close that issue first with kata close <ref> --done --message '<40+ characters>' --test 'bun smoke scenario ran' (its ref is in the Kata todo section of your prompt, or in kata list), then mark it done through the todo tool. Change no files. Stop when both are closed.`,
	scripts: {
		[MAIN]: [
			[{ tool: "todo", args: { op: "init", list: [{ phase: "Parser", items: ["Implement parser module", "Write parser tests"] }] } }],
			[{ tool: "task", args: { name: "ImplementParser", agent: "task", task: `${SUB} Implement parser module`, solutionSpace: "one fix: nothing to change, just close the issue" } }],
			// The task's Kata child is still open, so the plugin refuses the call and the model is told which issue to close.
			[{ tool: "todo", args: { op: "done", task: "Write parser tests" } }],
			[{ tool: "bash", args: { command: showChild("Write parser tests") } }],
			[{ tool: "bash", args: { command: closeChild("Write parser tests", "bun smoke scenario ran") } }],
			[{ tool: "todo", args: { op: "done", task: "Write parser tests" } }],
			[{ tool: "bash", args: { command: `kata close ${vars().bashClosed} --done --message '${message}' --evidence '${evidence}'` } }],
			["All parser work is finished."],
			// omp wakes the lead when the background delegate reports back.
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
		const parent = issues.find(i => i.metadata["omp.auto_parent"] === true);
		const parser = children.find(i => i.title === "Implement parser module");
		const tests = children.find(i => i.title === "Write parser tests");
		const hasRecorded = (e: { type?: string; command?: string }) => e.type === recorded.type && e.command === recorded.command;
		const commentPayloads = (i?: Issue) => eventsOf(i, "issue.commented").map(e => e.payload);
		const comments = (i?: Issue) => commentPayloads(i).map(p => JSON.stringify(p));
		// Only a real model follows the assignment's instruction; the scripted delegate just closes. Once the delegate exits,
		// its closed issue goes back to the lead's teammate, so its own comments are those under the teammate the issue
		// carried when it closed; the plugin's report and the lead's notes do not count.
		const delegateNote = store.live ? [{ name: "the delegate commented what it did on its own task", ok: commentPayloads(parser).some(p => ownComment(p, closingTeammate(parser))), detail: comments(parser).join(" | ") }] : [];
		const results = store.requests().filter(r => r.agent === MAIN).flatMap(r => r.results);
		// Scripted turns echo the child's state right after the refusal; a live model has no such step.
		const scripted = store.live ? [] : [
			{ name: "after the refusal the plan task's Kata child was still open", ok: !!tests && results.some(t => t.includes(`child-state ${PROJECT}#${tests.ref} open`)), detail: results.filter(t => t.includes("child-state")).join(" | ") },
		];
		return [
			...delegateNote,
			...scripted,
			{ name: "todo done on a task whose Kata child is open is refused, with a reason naming the child's ref", ok: !!tests && results.some(t => t.includes("is open in Kata as") && t.includes(tests.ref)), detail: results.filter(t => t.includes("open in Kata")).join(" | ") || `${results.length} tool results, none refusing` },
			{ name: "todo done went through once the child was closed", ok: store.tools().some(t => t.tool === "todo" && t.op === "done" && !t.isError), detail: JSON.stringify(store.tools().filter(t => t.tool === "todo").map(t => [t.op, t.isError])) },
			{ name: "the first todo init mirrors into an automatic parent", ok: !!parent, detail: parent?.title },
			{ name: "the mirror creates both plan tasks", ok: children.length === 2 && !!parser && !!tests, detail: children.map(c => c.title).join(", ") },
			{ name: "task delegation binds to its plan task and, closed, returns it to the lead (omp.session_id, omp.status completed, no omp.subagent_id)", ok: returnedToLead(parser), detail: JSON.stringify(parser?.metadata) },
			{ name: "no stray issue was created for the delegation", ok: issues.length === 4, detail: `${issues.length} issues` },
			{ name: "the main agent's kata close of the plan task records the evidence", ok: tests?.status === "closed" && closeEvidence(tests).some(hasRecorded), detail: `${tests?.status} ${JSON.stringify(closeEvidence(tests))}` },
			{ name: "delegate closed its own task with evidence", ok: parser?.status === "closed" && closeEvidence(parser).some(hasRecorded), detail: `${parser?.status} ${JSON.stringify(closeEvidence(parser))}` },
			{ name: "the main agent's kata close of the plan task records the omp session", ok: closeTranscript(tests)?.agent === "omp" && !!closeTranscript(tests)?.session_id, detail: JSON.stringify(closeTranscript(tests)) },
			{ name: "the automatic parent's close records the same omp session as the plan task's kata close", ok: closeTranscript(parent)?.agent === "omp" && closeTranscript(parent)?.session_id === closeTranscript(tests)?.session_id, detail: JSON.stringify(closeTranscript(parent)) },
			{ name: "the main agent's bash close inherits the omp session", ok: bashClosed?.status === "closed" && closeTranscript(bashClosed)?.agent === "omp" && closeTranscript(bashClosed)?.session_id === closeTranscript(tests)?.session_id, detail: `${bashClosed?.status} ${JSON.stringify(closeTranscript(bashClosed))}` },
			{ name: "the delegate's bash close records the omp session of the delegate, not the lead's", ok: closeTranscript(parser)?.agent === "omp" && !!closeTranscript(parser)?.session_id && closeTranscript(parser)?.session_id !== closeTranscript(tests)?.session_id, detail: JSON.stringify(closeTranscript(parser)) },
			{ name: "session shutdown closed the automatic parent", ok: parent?.status === "closed", detail: parent?.status },
		];
	},
}, {
	name: "same-message",
	// The todo backend's apply runs at execute time, after the close earlier in the same assistant message has finished, so no guard refuses the done.
	prompt: `${SAME} Plan one task, then close it and mark it done in a single message.`,
	livePrompt: () => "Use the todo tool to plan one item, 'Write parser tests'. Find its Kata ref (the Kata todo section of your prompt, or kata list). Then, in ONE message with two tool calls, send kata close <ref> --done --message '<40+ characters>' --test 'bun smoke scenario ran' and the todo tool's done for 'Write parser tests'. Do not send them in separate messages. Change no files. Stop when it is done.",
	scripts: {
		[SAME]: [
			[{ tool: "todo", args: { op: "init", list: [{ phase: "Parser", items: ["Write parser tests"] }] } }],
			[{ tool: "bash", args: { command: showChild("Write parser tests") } }],
			// One assistant message, two tool calls: the close runs first, then the done is applied.
			[{ tool: "bash", args: { command: closeChild("Write parser tests", "bun smoke scenario ran") } }, { tool: "todo", args: { op: "done", task: "Write parser tests" } }],
			["The parser tests task is finished."],
		],
	},
	async check(store) {
		const tests = (await store.issues()).find(i => i.title === "Write parser tests");
		const dones = store.tools().filter(t => t.tool === "todo" && t.op === "done");
		const results = store.requests().flatMap(r => r.results);
		return [
			{ name: "the todo done sent in the same message as the close was not an error", ok: dones.length > 0 && !dones[0].isError, detail: JSON.stringify(dones.map(t => t.isError)) },
			{ name: "no tool result in any request said the child is open in Kata", ok: !results.some(t => t.includes("is open in Kata as")), detail: results.filter(t => t.includes("open in Kata")).join(" | ") },
			{ name: "the plan task's Kata child is closed with the recorded evidence", ok: tests?.status === "closed" && closeEvidence(tests).some(e => e.type === recorded.type && e.command === recorded.command), detail: `${tests?.status} ${JSON.stringify(closeEvidence(tests))}` },
			{ name: "exactly one todo done call was made, so there was no retry", ok: dones.length === 1, detail: `${dones.length} done calls` },
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
		const until = async (condition: () => boolean, ms = 20_000) => { for (const end = Date.now() + ms; !condition() && Date.now() < end;) await sleep(100); return condition(); };
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
		await sleep(1500);
		await session.prompt("after the idle delivery");
		checks.push({ name: "the inbox section shows the request on the next prompt", ok: shows("smoke-idle-marker") });
		// Later requests keep the delivered message in their history, so a second delivery shows as a second copy there.
		const copies = (mark: string) => main().at(-1)?.users.filter(u => u.includes(mark)).length ?? 0;
		checks.push({ name: "the idle request was delivered once", ok: copies("smoke-idle-marker") === 1, detail: `${copies("smoke-idle-marker")} copies` });

		clear();
		await sleep(1500);
		const afterClear = main().length;
		await session.prompt("after the clear");
		checks.push({ name: "clearing delivers nothing", ok: main().length === afterClear + 1, detail: `${main().length - afterClear} requests after the clear` });
		checks.push({ name: "the cleared request leaves the section", ok: !shows("smoke-idle-marker") });

		// A request another actor wrote for this session never starts a turn nor reaches a prompt.
		const before = main().length;
		session.kata(["notify", target, "--to", "smoke-user/lead", "--message", "smoke-forged-marker"], { KATA_AUTHOR: "mallory" });
		await sleep(2500);
		checks.push({ name: "a request from another actor starts no turn", ok: main().length === before, detail: `${main().length - before} new requests` });
		await session.prompt("after the forged request");
		const everywhere = session.requests().filter(r => r.system.includes("smoke-forged-marker") || r.users.some(u => u.includes("smoke-forged-marker")));
		checks.push({ name: "its marker is in no system prompt or user message", ok: everywhere.length === 0, detail: `${everywhere.length} requests` });
		session.kata(["notify", target, "--to", "smoke-user/lead", "--clear"], { KATA_AUTHOR: "mallory" });

		// A working agent: the request waits for the step boundary, behind the tool result.
		const running = session.prompt("slow-work please");
		await sleep(1500);
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
		await sleep(2000);
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
	// Which turn runs is chosen by what the agent was last told rather than by its position, so a wake-up cannot shift the script.
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
		`Kata tickets omp-smoke#${a}, omp-smoke#${b} and omp-smoke#${c} already exist. Change no files; use the todo tool and one task subagent, in this order. The todo tool refuses 'done' on the last open plan item of a ticket until the ticket itself is closed (kata close <ref> --done --message '<40+ characters>' --test '<command>'); close it, then call done again.`,
		`1. init a plan with phase Alpha items 'omp-smoke#${a}: write the parser' and 'omp-smoke#${a}: bump the docs', and phase Beta item 'omp-smoke#${b}: fetch the inbox data'.`,
		`2. Mark 'omp-smoke#${a}: write the parser' done. Then close omp-smoke#${a} with --test 'bun smoke scenario second' and mark 'omp-smoke#${a}: bump the docs' done.`,
		`3. Append 'omp-smoke#zzzz: ghost work' to phase Beta. It names no ticket, so nothing is created for it; do not retry it.`,
		`4. Drop 'omp-smoke#${b}: fetch the inbox data'.`,
		`5. Append 'omp-smoke#${c}: write the widget parser' to phase Gamma and delegate exactly that item to a task subagent named WidgetParser, telling it to close its Kata issue with evidence ${evidence} and a 40+ character message.`,
		`6. Append 'update CHANGELOG' to phase Gamma, close its Kata issue (kata close <ref> --done --message '<40+ characters>' --test '${evidence}'; find the ref with kata list) and mark it done.`,
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
			// Not the ticket's last open plan item, so it goes through; the mirror comments on the open ticket.
			() => [{ tool: "todo", args: { op: "done", task: `omp-smoke#${vars().a}: write the parser` } }],
			// The last open plan item of an open ticket: refused until the ticket is closed.
			() => [{ tool: "todo", args: { op: "done", task: `omp-smoke#${vars().a}: bump the docs` } }],
			() => [{ tool: "bash", args: { command: closeIssue(`omp-smoke#${vars().a}`, "bun smoke scenario second") } }],
			() => [{ tool: "todo", args: { op: "done", task: `omp-smoke#${vars().a}: bump the docs` } }],
			// omp's native list accepts the ghost; the mirror finds no ticket for it and creates nothing.
			() => [{ tool: "todo", args: { op: "append", items: ["omp-smoke#zzzz: ghost work"], phase: "Beta" } }],
			() => [{ tool: "todo", args: { op: "drop", task: `omp-smoke#${vars().b}: fetch the inbox data` } }],
			() => [{ tool: "todo", args: { op: "append", items: [`omp-smoke#${vars().c}: write the widget parser`], phase: "Gamma" } }],
			() => [{ tool: "task", args: { name: "WidgetParser", agent: "task", task: `${SUB} Write the widget parser (omp-smoke#${vars().c}) and close its ticket.`, solutionSpace: "one fix: nothing to change, just close the ticket" } }],
			[{ tool: "todo", args: { op: "append", items: ["update CHANGELOG"], phase: "Gamma" } }],
			[{ tool: "bash", args: { command: closeChild("update CHANGELOG", "bun smoke scenario ran") } }],
			[{ tool: "todo", args: { op: "done", task: "update CHANGELOG" } }],
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
		const comments = (i?: Issue) => eventsOf(i, "issue.commented");
		const closed = eventsOf(alpha, "issue.closed");
		const parents = issues.filter(i => i.metadata["omp.auto_parent"] === true);
		const changelog = issues.find(i => i.title === "update CHANGELOG");
		const results = store.requests().filter(r => r.agent === MAIN).flatMap(r => r.results);
		return [
			{ name: "items naming tickets create no issue; only the plain item and its parent are new", ok: issues.length === 5 && parents.length === 1 && !!changelog, detail: issues.map(i => i.title).join(", ") },
			{ name: "the plain item is a child of the automatic parent", ok: !!changelog?.metadata["todo.phase"] && parents.length === 1, detail: JSON.stringify(changelog?.metadata) },
			{ name: "named tickets never join a plan (no todo.phase)", ok: [alpha, beta, gamma].every(i => !i?.metadata["todo.phase"]), detail: JSON.stringify([alpha, beta, gamma].map(i => i?.metadata)) },
			{ name: "todo done on the ticket's last open plan item was refused until the ticket was closed", ok: results.some(t => t.includes(a) && t.includes("kata close")), detail: results.filter(t => t.includes(a)).join(" | ") || `${results.length} tool results, none naming the ticket` },
			{ name: "the ticket's own kata close is its only close, with that evidence", ok: alpha?.status === "closed" && closed.length === 1 && JSON.stringify(closed[0].payload.evidence) === JSON.stringify([{ type: "test", command: "bun smoke scenario second" }]), detail: JSON.stringify(closed) },
			{ name: "completing the first item left a comment on the ticket", ok: comments(alpha).length >= 1, detail: `${comments(alpha).length} comments` },
			// Dropping a ticket item is not specified by the mirror's rules beyond "not closed", so its comment count is not asserted.
			{ name: "dropping a ticket item leaves the ticket open", ok: beta?.status === "open" && closeCount(beta) === 0, detail: `${beta?.status} ${comments(beta).length} comments` },
			{ name: "an unresolvable ref created nothing", ok: !issues.some(i => /ghost/.test(i.title)) },
			{ name: "a delegate bound the ticket its item names, closed it and returned it to the lead", ok: returnedToLead(gamma) && gamma?.status === "closed" && !issues.some(i => i.title.startsWith("Subagent")), detail: `${gamma?.status} ${JSON.stringify(gamma?.metadata)}` },
			{ name: "the plain item closed through kata close", ok: changelog?.status === "closed" && closeEvidence(changelog).some(e => e.type === "test"), detail: `${changelog?.status} ${JSON.stringify(closeEvidence(changelog))}` },
		];
	},
}, {
	name: "claimed",
	prompt: `${MAIN} Claim the ticket, plan it through the todo tool, then stop.`,
	livePrompt: ({ t }) => [
		`Kata ticket omp-smoke#${t} already exists. Change no files. As Kata's contract says, claim it first with bash (kata claim omp-smoke#${t}); that makes it the plan's parent. The todo tool refuses 'done' on a task whose Kata issue is open, so close issues first with kata close <ref> --done --message '<40+ characters>' --test '<command>' (refs: kata list). Use the todo tool in this order:`,
		`1. init a plan with the items 'omp-smoke#${t}: write the greeting' and 'Add the ignore file'.`,
		`2. Close 'Add the ignore file' (kata close with --test '${evidence}'), then close omp-smoke#${t} itself with --test 'bun smoke scenario ticket item'.`,
		`3. Mark both items done through the todo tool.`,
	].join("\n"),
	setup: create => ({ t: create("Ticket claimed first") }),
	scripts: {
		[MAIN]: [
			() => [{ tool: "bash", args: { command: `kata claim omp-smoke#${vars().t}` } }],
			() => [{ tool: "todo", args: { op: "init", items: [`omp-smoke#${vars().t}: write the greeting`, "Add the ignore file"] } }],
			// The ticket cannot close while its plan child is open, so the child closes first.
			[{ tool: "bash", args: { command: closeChild("Add the ignore file", "bun smoke scenario ran") } }],
			() => [{ tool: "bash", args: { command: closeIssue(`omp-smoke#${vars().t}`, "bun smoke scenario ticket item") } }],
			() => [{ tool: "todo", args: { op: "done", task: `omp-smoke#${vars().t}: write the greeting` } }],
			[{ tool: "todo", args: { op: "done", task: "Add the ignore file" } }],
			["The ticket is worked."],
			["Nothing else to do."],
			["Nothing else to do."],
		],
	},
	async check(store, { t }) {
		const issues = await store.issues();
		const ticket = issues.find(i => i.ref === t);
		const closed = eventsOf(ticket, "issue.closed");
		return [
			{ name: "the claimed ticket is the plan parent: the plain item is its child", ok: issues.some(i => i.title === "Add the ignore file" && i.status === "closed"), detail: issues.map(i => `${i.title}:${i.status}`).join(", ") },
			{ name: "the ticket closed once, through the agent's kata close with the ticket item's evidence", ok: ticket?.status === "closed" && closed.length === 1 && JSON.stringify(closed[0].payload.evidence) === JSON.stringify([{ type: "test", command: "bun smoke scenario ticket item" }]), detail: `${ticket?.status} ${JSON.stringify(closed)}` },
		];
	},
}, {
	name: "untracked",
	prompt: `${MAIN} Plan the docs work, send a scout to survey the repo, close both items, then stop.`,
	livePrompt: () => `Use the todo tool to plan two items, 'Write migration guide' and 'Refresh release notes'. Then use the task tool to send one subagent with agent "scout" to list the top-level directories of this repository and report them. After it reports, close each item's Kata issue (kata close <ref> --done --message '<40+ characters>' --test '${evidence}'; refs: kata list) and mark it done through the todo tool; the todo tool refuses 'done' while the issue is open. Change no files. Stop when both are closed.`,
	scripts: {
		[MAIN]: [
			[{ tool: "todo", args: { op: "init", list: [{ phase: "Docs", items: ["Write migration guide", "Refresh release notes"] }] } }],
			// No bash for this agent, and nothing in the prompt matches a plan item or names a ticket.
			[{ tool: "task", args: { name: "Survey", agent: "scout", task: `${SCOUT} Survey the repository layout and report the top-level directories.`, solutionSpace: "one answer: a plain text report" } }],
			// Close and done are separate turns: omp runs every tool_call handler of a message before any of its calls executes, so
			// the plugin would refuse a done that shares a message with its close.
			[{ tool: "bash", args: { command: closeChild("Write migration guide", "bun smoke scenario first") } }],
			[{ tool: "todo", args: { op: "done", task: "Write migration guide" } }],
			[{ tool: "bash", args: { command: closeChild("Refresh release notes", "bun smoke scenario second") } }],
			[{ tool: "todo", args: { op: "done", task: "Refresh release notes" } }],
			["All docs work is finished."],
			["The scout has reported back."],
			["Nothing else to do."],
		],
		[SCOUT]: [["The repository has no interesting layout."]],
	},
	async check(store) {
		const issues = await store.issues();
		const children = issues.filter(i => i.metadata["todo.phase"]);
		const missions = issues.filter(i => i.metadata["omp.mission"] === "true");
		const parent = issues.find(i => i.metadata["omp.session_id"] && !i.metadata["todo.phase"]);
		const requests = issues.filter(notified).map(i => i.ref);
		const review = issues.filter(labelled);
		const mission = missions[0];
		const reports = eventsOf(mission, "issue.commented").filter(e => String(e.payload?.body).startsWith("Report from subagent"));
		return [
			{ name: "only the parent, the two plan items and the scout's mission exist", ok: issues.length === 4 && children.length === 2 && missions.length === 1 && !!parent, detail: issues.map(i => i.title).join(", ") },
			{ name: "the scout's run is a mission closed as audit-no-change, naming its agent", ok: mission?.status === "closed" && closeEvent(mission)?.reason === "audit-no-change" && mission.metadata["omp.mission_agent"] === "scout", detail: `${mission?.status} ${closeEvent(mission)?.reason} ${JSON.stringify(mission?.metadata)}` },
			{ name: "the mission holds the scout's report under its teammate", ok: reports.length === 1 && String(reports[0].payload.body).includes("no interesting layout") && !!reports[0].payload.teammate, detail: JSON.stringify(reports.map(e => e.payload)) },
			{ name: "no issue carries needs-review", ok: review.length === 0, detail: review.map(i => i.ref).join(", ") },
			{ name: "the lead got no inbox request", ok: requests.length === 0, detail: requests.join(", ") },
			{ name: "session shutdown closed the automatic parent as done, from the plan items' evidence", ok: parent?.status === "closed" && closeEvent(parent)?.reason === "done", detail: `${parent?.status} ${JSON.stringify(closeEvidence(parent))}` },
		];
	},
}, {
	name: "workers",
	// omp strips its todo tool from subagents unless prewalk is armed for their agent; a prewalk target lets delegates
	// call todo. It hands off at a delegate's first edit; the target is a subscription model, and must differ from the
	// --model of a live run in model or thinking level, or omp skips prewalk. Scripted runs skip it: no login. The driver adds `todo.backend: kata` ahead of this.
	ompConfig: "task:\n  agentPrewalk:\n    task: anthropic/claude-haiku-5-5:low\n",
	prompt: `${MAIN} Plan the ports, delegate all of them at once, then stop.`,
	// Live: odd delegates plan one step under their own issue with the todo tool, finish it, then close their issue; even
	// ones run a tool and leave their task open, so the lead hands it back.
	livePrompt: () => [
		`Use the todo tool to plan these items in one phase: ${PORTS.map(p => `'${p}'`).join(", ")}.`,
		`Then delegate all of them in ONE task call with exactly ${PORTS.length} tasks, named Port1 to Port${PORTS.length} in that order, task N working item N. Copy each task's instructions exactly, with <item> replaced by its item:`,
		`- Port1, Port3, Port5 and every other odd-numbered task: "Work '<item>'. Change no files. First call the todo tool with op init and items ['Verify <item>']. Then close that step's Kata issue: kata close <ref> --done --message '<40+ characters>' --test '${evidence}' (its ref is in the Kata todo section of your prompt, or in kata list); the todo tool refuses done while it is open. Then call the todo tool with op done and task 'Verify <item>'. Then close your own Kata issue with the kata close command your Kata binding gives, with evidence '${evidence}'. Do nothing else: no exploring, no tests, no other todo items or files. If a step fails twice, report the error and stop."`,
		`- Port2, Port4, Port6 and every other even-numbered task: "Work '<item>'. Change no files. Run the bash command ls exactly once, then stop. Do nothing else: do not close or change your Kata issue, do not call the todo tool, do not run tests."`,
		`After the task call, do not close, change or re-plan any task yourself; just stop.`,
	].join("\n"),
	scripts: {
		[MAIN]: [
			[{ tool: "todo", args: { op: "init", list: [{ phase: "Ports", items: PORTS }] } }],
			[{ tool: "task", args: { context: "Smoke port work: nothing to change, just close your Kata issue.", tasks: PORTS.map((port, i) => ({ name: `Port${i + 1}`, agent: "task", task: `${WORKER} ${port}`, solutionSpace: "one fix: nothing to change, just close the issue" })) } }],
			["The ports are delegated."],
			// omp wakes the lead as background delegates report back. Each turn only acknowledges; the end of the turn
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
		const onWorker = [...first.values()].filter(p => !p.mainThread).map(p => p.agent);
		const checks: Check[] = [
			{ name: "omp ran at least one delegate on a worker thread", ok: onWorker.length > 0, detail: `${onWorker.length} of ${first.size} delegates off the main thread` },
			{ name: "every delegate, on a worker or not, saw its own plan task in its system prompt", ok: first.size === PORTS.length && wrong.length === 0, detail: wrong.join(", ") || `${first.size} delegates prompted` },
		];
		const numbers = PORTS.map((_, i) => i + 1);
		const tools = store.tools();
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
		const doneClose = (i: Issue) => eventsOf(i, "issue.closed").some(e => e.payload?.reason === "done");
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
		const sessionOf = (i?: Issue) => closeTranscript(i)?.session_id;
		// The todo close and the bash close of one delegate both carry that delegate's own session; a delegate whose session is unknown records none.
		const ownSession = (n: number) => !!sessionOf(stepOf(n)) && sessionOf(stepOf(n)) === sessionOf(taskOf(n)) && sessionOf(taskOf(n)) !== parent?.metadata["omp.session_id"];
		return [...checks,
			{ name: "a delegate on a worker thread planned, finished and closed through its own todo and kata close", ok: onWorkerOf(closers).length > 0 && onWorkerOf(closers).every(workedThroughTodo), detail: `worker delegates ${onWorker.join(", ")}; ${describe(onWorkerOf(closers), workedThroughTodo)}` },
			{ name: "a worker delegate's todo close and kata close record its own omp session, not the lead's", ok: onWorkerOf(closers).length > 0 && onWorkerOf(closers).every(ownSession), detail: onWorkerOf(closers).filter(n => !ownSession(n)).map(n => `Port${n}: step ${sessionOf(stepOf(n)) ?? "none"}, issue ${sessionOf(taskOf(n)) ?? "none"}, lead ${parent?.metadata["omp.session_id"]}`).join("; ") },
			{ name: "a delegate on a worker thread that ran a tool and left its task open was handed back", ok: onWorkerOf(leavers).length > 0 && onWorkerOf(leavers).every(handedBack), detail: `worker delegates ${onWorker.join(", ")}; ${describe(onWorkerOf(leavers), handedBack)}` },
		];
	},
}, {
	// Run 1 is cut with SIGKILL while two delegates are still running, so no cleanup runs: one has run a tool and holds a
	// second, long bash call; the other is waiting on its first model call. Run 2 resumes the same session file; the lead's
	// snapshot carries both records, and the resumed lead settles them in the background.
	name: "resume",
	persist: true,
	scripts: {
		[MAIN]: [
			[{ tool: "todo", args: { op: "init", list: [{ phase: "Resume", items: [RESUME_HAND_BACK, RESUME_ROLL_BACK] }] } }],
			[{ tool: "task", args: { context: "Smoke resume work: nothing to change.", tasks: [
				{ name: "ResumeOne", agent: "task", task: `${CUT} ${RESUME_HAND_BACK}`, solutionSpace: "one fix: nothing to change" },
				{ name: "ResumeTwo", agent: "task", task: `${IDLE} ${RESUME_ROLL_BACK}`, solutionSpace: "one fix: nothing to change" },
			] } }],
			// Delegate wake-ups re-prompt the lead, and the resumed run continues this script after the first run's assistant
			// messages, so a turn chooses by what it was last told rather than by its position. The resumed lead's turn waits in
			// omp's bash tool until the background settle has written the hand back and the rollback: a native `todo view` does
			// not pass through the plugin, so it cannot be used to wait for the settle.
			...Array.from({ length: 24 }, () => (ctx: TurnContext) => ctx.texts.at(-1)?.includes(RESUMED) ? [{ tool: "bash", args: { command: waitSettled(RESUME_HAND_BACK, RESUME_ROLL_BACK) } }] : ["Noted."]),
		],
		// ResumeOne: one finished tool, then a bash call that outlives the process. ResumeTwo: its model call never answers,
		// because the plugin counts a delegate's tool call (not its result) as a tool run, which would hand it back.
		[CUT]: [[{ tool: "bash", args: { command: "ls" } }], [{ tool: "bash", args: { command: "sleep 45" } }]],
		[IDLE]: [[{ hang: true }]],
	},
	async drive(session) {
		const tasks = () => (JSON.parse(session.kata(["list", "--status", "all", "--limit", "0", "--json"])).issues as { title: string; metadata?: Record<string, string> }[])
			.filter(i => [RESUME_HAND_BACK, RESUME_ROLL_BACK].includes(i.title));
		await session.prompt(`${MAIN} plan the work and delegate it`);
		const bothHeld = (h: { metadata?: Record<string, string> }[]) => h.length === 2 && h.every(i => i.metadata?.["omp.subagent_id"] && i.metadata["omp.status"] === "running");
		let held = tasks();
		for (let end = Date.now() + 30_000; Date.now() < end && !bothHeld(held); held = tasks()) await sleep(250);
		const holding = bothHeld(held);
		// The tool use reaches the snapshot at the call, the tool record at its result: wait for both before the cut.
		for (let end = Date.now() + 30_000; Date.now() < end && !session.tools().some(t => t.agent === "ResumeOne" && t.tool === "bash");) await sleep(100);
		await session.restart('"ranTool":true');
		await session.prompt(RESUMED);
		return [{ name: "before the resume, both delegates' issues are still held by a delegate that never finished (omp.subagent_id set, omp.status running)", ok: holding, detail: JSON.stringify(held.map(i => [i.title, i.metadata?.["omp.subagent_id"], i.metadata?.["omp.status"]])) }];
	},
	async check(store) {
		const issues = await store.issues();
		const handBack = issues.find(i => i.title === RESUME_HAND_BACK), rollBack = issues.find(i => i.title === RESUME_ROLL_BACK);
		const tools = store.tools();
		return [
			{ name: "the cut delegates ran as scripted: ResumeOne finished a bash call, ResumeTwo none", ok: tools.some(t => t.agent === "ResumeOne" && t.tool === "bash") && !tools.some(t => t.agent === "ResumeTwo"), detail: JSON.stringify(tools.filter(t => /^Resume(One|Two)$/.test(t.agent)).map(t => [t.agent, t.tool])) },
			{ name: "the delegate that ran a tool was handed back after the resume: needs-review, needs-human, an inbox request, omp.status aborted", ok: labelled(handBack) && handBack?.metadata["work.attention"] === "needs-human" && notified(handBack) && handBack?.metadata["omp.status"] === "aborted", detail: JSON.stringify({ labelled: labelled(handBack), attention: handBack?.metadata["work.attention"], notified: notified(handBack), status: handBack?.metadata["omp.status"] }) },
			{ name: "the delegate that ran no tool was rolled back after the resume: open, no needs-review, no omp.subagent_id", ok: rollBack?.status === "open" && !labelled(rollBack) && !rollBack.metadata["omp.subagent_id"] && !notified(rollBack), detail: JSON.stringify({ status: rollBack?.status, labelled: labelled(rollBack), subagent: rollBack?.metadata["omp.subagent_id"], notified: notified(rollBack) }) },
			{ name: "no stray issue", ok: issues.length === 3, detail: `${issues.length} issues: ${issues.map(i => i.title).join(", ")}` },
		];
	},
}];

// The same delegation with every Kata call the lead's plugin makes starting late, as on a loaded machine. Delegates are
// assigned one after another, so the last one's first prompt waits for all fourteen assignments. Scripted only.
const workers = SCENARIOS.find(s => s.name === "workers")!;
SCENARIOS.push({ ...workers, name: "workers-slow-kata", livePrompt: undefined,
	env: { KATA_OMP_EXECUTABLE: fileURLToPath(new URL("./smoke-slow-kata.sh", import.meta.url)) } });
