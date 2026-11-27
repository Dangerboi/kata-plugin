import { expect, test } from "bun:test";
import { savedSnapshot } from "../core/kata-core";
import { claudeKata, entering, pausedClock, type ClaudeHost } from "./claude-fixture";
import { assignmentOf, EVIDENCE, eventually, holdKata, holdNext, MESSAGE, quote } from "./kata-fixture";

// Subagents and Workflow agents on the Claude mod, against a real Kata: a hand-made `$` stands in for the engine.
const { host, kata, show, commentsOf, closesOf, sh, sessionParents } = claudeKata("claude-delegates");

const itemsOf = async (h: ClaudeHost) => {
	const [parent] = await sessionParents("claude", h.state.session, true);
	return (await show(parent.short_id)).children as any[];
};
const issueOf = async (h: ClaudeHost, title: string) => {
	const found = (await itemsOf(h)).find(child => child.title === title);
	expect(found, title).toBeDefined();
	return (await show(found.short_id)).issue;
};
const labelsOf = async (ref: string) => ((await show(ref)).labels ?? []).map((label: any) => label.label);
async function started(extra: Parameters<typeof host>[0] = {}) {
	const h = host(extra);
	await h.start();
	await h.todo({ op: "init", items: ["Implement parser module", "Document the parser output"] });
	return h;
}
const tagged = (prompt: string) => /<kata_binding>\n([\s\S]*?)\n<\/kata_binding>/.exec(prompt)?.[1] ?? "";
const meta = async (h: ClaudeHost, title: string) => (await issueOf(h, title)).metadata;
const missions = async () => (await kata(["list", "--status", "all", "--json"])).issues.filter((issue: any) => issue.metadata?.["claude.mission_subagent_id"]);
// The missions with a comment containing `text`, as `kata show` gives them.
async function missionsWith(text: string) {
	const found = [];
	for (const mission of await missions()) if ((await commentsOf(mission.short_id)).join("\n").includes(text)) found.push((await show(mission.short_id)).issue);
	return found;
}
const lastCommentOf = async (ref: string) => ((await show(ref)).comments as any[]).at(-1);

test("a spawn that names a plan item gets that item's issue in its prompt, and its answer is posted when it left no comment", async () => {
	const h = await started();
	const spawned = await h.spawn({ prompt: "Please implement parser module, then verify it.", description: "Parser work" }, "agent-parser");
	const binding = tagged(spawned.prompt);
	const { ref, teammate } = assignmentOf(binding);
	expect(binding).toContain("You are subagent Parser work.");
	expect(spawned.prompt.startsWith("Please implement parser module, then verify it.")).toBe(true);
	const issue = (await show(ref)).issue;
	expect(issue.title).toBe("Implement parser module");
	expect(issue.metadata["claude.session_id"]).toBe(h.state.session);
	expect(issue.metadata.teammate).toBe(teammate);
	expect(issue.metadata["todo.status"]).toBe("in_progress");
	expect((await meta(h, "Document the parser output"))["claude.subagent_id"]).toBeUndefined();

	await h.agentCall("agent-parser", "Read", { file_path: "src/parser.ts" });
	await h.agentTurn("agent-parser", "The parser module is implemented and verified.");
	const after = await show(ref);
	expect(after.issue.status).toBe("open");
	expect(after.issue.metadata["claude.subagent_id"]).toBeUndefined();
	expect(await labelsOf(ref)).toContain("needs-review");
	expect((await commentsOf(ref)).join("\n")).toContain("The parser module is implemented and verified.");
});

test("a spawn that closes its own issue keeps its close, and its answer adds no second comment", async () => {
	const h = await started();
	const spawned = await h.spawn({ prompt: "Implement parser module", description: "Parser" }, "agent-closer");
	const { ref, close } = assignmentOf(tagged(spawned.prompt));
	await h.agentCall("agent-closer", "Bash", { command: "ls" });
	const comment = await sh(`${close!.replace(/ close .*$/, "")} comment ${quote(ref)} --body ${quote("Own comment: implemented and tested.")}`);
	expect(comment.code, comment.stderr).toBe(0);
	const closed = await sh(`${close} --message ${quote(MESSAGE)} --evidence ${quote(EVIDENCE[0])}`);
	expect(closed.code, closed.stderr).toBe(0);
	await h.agentTurn("agent-closer", "All done.");
	expect((await show(ref)).issue.status).toBe("closed");
	expect((await commentsOf(ref)).join("\n")).not.toContain("Report from subagent");
});

test("a spawn that names nothing is untracked: it is told so, and its run and answer become a closed mission", async () => {
	const h = await started();
	const spawned = await h.spawn({ prompt: "Survey the build scripts and list the slow ones.", description: "Survey" }, "agent-survey");
	expect(tagged(spawned.prompt)).toContain("you have no Kata issue");
	await h.agentTurn("agent-survey", "Slow ones: build-all.sh and lint.sh (found by the survey).");
	const found = await missionsWith("found by the survey");
	expect(found).toHaveLength(1);
	expect(found[0].status).toBe("closed");
	expect((await meta(h, "Implement parser module"))["claude.subagent_id"]).toBeUndefined();
});

test("Workflow agents of one run each bind to their own item and report on it", async () => {
	const h = await started();
	const call = "toolu_workflow_1";
	const first = await h.spawn(
		{ tool_use_id: call, workflow: { runId: "wf_1", agentIndex: 1 }, prompt: "Implement parser module", description: "" },
		"wf-agent-1"
	);
	const second = await h.spawn(
		{ tool_use_id: call, workflow: { runId: "wf_1", agentIndex: 2 }, prompt: "Document the parser output", description: "" },
		"wf-agent-2"
	);
	const one = assignmentOf(tagged(first.prompt)),
		two = assignmentOf(tagged(second.prompt));
	expect(one.ref).not.toBe(two.ref);
	expect((await show(one.ref)).issue.title).toBe("Implement parser module");
	expect((await show(two.ref)).issue.title).toBe("Document the parser output");
	expect(one.teammate).not.toBe(two.teammate);
	await h.agentCall("wf-agent-1", "Read");
	await h.agentCall("wf-agent-2", "Read");
	await h.agentTurn("wf-agent-2", "Docs written for the output.");
	await h.agentTurn("wf-agent-1", "Parser written and verified.");
	expect((await commentsOf(one.ref)).join("\n")).toContain("Parser written and verified.");
	expect((await commentsOf(one.ref)).join("\n")).not.toContain("Docs written");
	expect((await commentsOf(two.ref)).join("\n")).toContain("Docs written for the output.");
});

test("a spawn that names an item another agent holds is refused, and the item frees when that agent is over", async () => {
	const h = await started();
	await h.spawn({ prompt: "Implement parser module" }, "agent-first");
	const refused = await h.spawn({ prompt: "Implement parser module again" }, "agent-second");
	expect(refused.deny).toContain("already delegated");
	await h.agentTurn("agent-first", "Done.");
	const retry = await h.spawn({ prompt: "Implement parser module again" }, "agent-third");
	expect(retry.deny).toBeUndefined();
});

test("a resumed run goes on with its record: its answer is posted on the issue it already had", async () => {
	const h = await started();
	const spawned = await h.spawn({ prompt: "Implement parser module", description: "Parser" }, "agent-resumed");
	const { ref } = assignmentOf(tagged(spawned.prompt));
	await h.agentCall("agent-resumed", "Read");
	await h.agentTurn("agent-resumed", "First run finished.");
	const resumed = await h.spawn({ prompt: "Also handle empty input.", resume: { agentId: "agent-resumed" } }, "agent-resumed");
	// The engine takes no rewrite of a resumed run: nothing is added to its prompt.
	expect(resumed.prompt).toBe("Also handle empty input.");
	await h.agentTurn("agent-resumed", "Empty input handled in the second run.");
	const comments = (await commentsOf(ref)).join("\n");
	expect(comments).toContain("First run finished.");
	expect(comments).toContain("Empty input handled in the second run.");
});

test("a fork no tool call starts runs as it is: no assignment, no mission, no comment on the plan", async () => {
	const h = await started();
	const before = (await missions()).map((mission: any) => mission.short_id);
	const fork = await h.spawn({ prompt: "side question", tool_use_id: "", fork: true }, "agent-fork");
	expect(fork.prompt).toBe("side question");
	await h.agentTurn("agent-fork", "answer of the fork");
	expect((await missions()).map((mission: any) => mission.short_id)).toEqual(before);
	for (const item of await itemsOf(h)) expect((await commentsOf(item.short_id)).join("\n")).not.toContain("answer of the fork");
});

test("a subagent's kata commands run under its teammate; --as is refused; a command that carries it is left as written", async () => {
	const h = await started();
	const spawned = await h.spawn({ prompt: "Implement parser module", description: "Parser" }, "agent-shell");
	const { ref, teammate } = assignmentOf(tagged(spawned.prompt));
	const rewritten = await h.agentCall("agent-shell", "Bash", { command: `kata comment ${ref} --body 'progress' && ls` });
	expect(rewritten.command.endsWith("&& ls")).toBe(true);
	const again = await h.agentCall("agent-shell", "Bash", { command: rewritten.command });
	expect(again.command).toBe(rewritten.command);
	const ran = await sh(rewritten.command.replace("&& ls", ""));
	expect(ran.code, ran.stderr).toBe(0);
	expect((await lastCommentOf(ref)).body).toBe("progress");
	expect((await lastCommentOf(ref)).teammate).toBe(teammate);

	const other = await h.agentCall("agent-shell", "Bash", { command: `kata --teammate somebody-else comment ${ref} --body 'second'` });
	expect(other.command).not.toContain("somebody-else");
	const reran = await sh(other.command);
	expect(reran.code, reran.stderr).toBe(0);
	expect((await lastCommentOf(ref)).teammate).toBe(teammate);

	const asked = await h.agentCall("agent-shell", "Bash", { command: `kata close ${ref} --as someone --done` });
	expect(asked.deny).toContain("--as is not permitted");
	expect((await h.agentCall("agent-shell", "Bash", { command: "ls -la" })).command).toBe("ls -la");
	expect((await h.fire("tool.call", { tool: "Bash", tool_use_id: "t", command: `kata show ${ref}` })).command).toBe(`kata show ${ref}`);
});

test("under auto mode the engine refuses a changed call: the subagent is told the exact command to run, and the repeat passes", async () => {
	const h = await started();
	const spawned = await h.spawn({ prompt: "Implement parser module", description: "Parser", permissionMode: "auto" }, "agent-auto");
	const { ref, teammate } = assignmentOf(tagged(spawned.prompt));
	const refused = await h.agentCall("agent-auto", "Bash", { command: `kata comment ${ref} --body 'auto'` }, () => {
		throw new Error("the engine ran a changed call");
	});
	const exact = refused.deny.split("exactly like this: ")[1];
	expect(exact).toBeTruthy();
	expect((await h.agentCall("agent-auto", "Bash", { command: exact })).command).toBe(exact);
	const ran = await sh(exact);
	expect(ran.code, ran.stderr).toBe(0);
	expect((await lastCommentOf(ref)).teammate).toBe(teammate);

	// A session whose mode the module could not see: the engine's own denial of the rewrite becomes the same instruction.
	const open = await h.spawn({ prompt: "Document the parser output", description: "Docs" }, "agent-unknown");
	const docs = assignmentOf(tagged(open.prompt));
	const denied = await h.agentCall("agent-unknown", "Bash", { command: `kata comment ${docs.ref} --body 'docs'` }, () => ({
		deny: "a hook changed this call's input after auto mode reviewed it"
	}));
	const docsExact = denied.deny.split("exactly like this: ")[1];
	expect(docsExact).toBeTruthy();
	const docsRan = await sh(docsExact);
	expect(docsRan.code, docsRan.stderr).toBe(0);
	expect((await lastCommentOf(docs.ref)).teammate).toBe(docs.teammate);
	expect(teammate).not.toBe(docs.teammate);
});

test("a subagent's Bash kata close records the lead's session, also through the auto-mode refusal; the switch still turns it off", async () => {
	const closeCommand = (ref: string) => `kata close ${ref} --done --message ${quote(MESSAGE)} --evidence ${quote(EVIDENCE[0])}`;
	const h = await started();
	const spawned = await h.spawn({ prompt: "Implement parser module", description: "Parser", permissionMode: "auto" }, "agent-closes");
	const { ref } = assignmentOf(tagged(spawned.prompt));
	const refused = await h.agentCall("agent-closes", "Bash", { command: closeCommand(ref) }, () => {
		throw new Error("the engine ran a changed call");
	});
	const exact = refused.deny.split("exactly like this: ")[1];
	expect((await h.agentCall("agent-closes", "Bash", { command: exact })).command).toBe(exact);
	const ran = await sh(exact);
	expect(ran.code, ran.stderr).toBe(0);
	expect((await closesOf(ref))[0].payload.transcript).toMatchObject({ agent: "claude", session_id: h.state.session });

	const off = await started({ env: { KATA_CLOSE_TRANSCRIPT_ENABLED: "false" } });
	const quiet = assignmentOf(tagged((await off.spawn({ prompt: "Implement parser module", description: "Parser" }, "agent-quiet")).prompt));
	const routed = await off.agentCall("agent-quiet", "Bash", { command: closeCommand(quiet.ref) });
	const ranQuiet = await sh(routed.command);
	expect(ranQuiet.code, ranQuiet.stderr).toBe(0);
	expect((await closesOf(quiet.ref))[0].payload.transcript).toBeUndefined();
});

test("a rewritten Bash call is allowed where the model's own command is; a hook's ask and the rules' other verdicts stand", async () => {
	// Allow rule `Bash(kata *)`, which matches nothing past a `/usr/bin/env NAME=…` prefix, and a PreToolUse guard that asks about any
	// call naming zz99 (a `$.tool.check` query runs no PreToolUse hook and carries no call id).
	const rules = (e: any) =>
		e.tool_use_id && /zz99/.test(e.input.command) ? { decision: "ask" as const, hook: "PreToolUse" } : { decision: /^kata /.test(e.input.command) ? ("allow" as const) : ("ask" as const) };
	const h = await started({ rules });
	const lead = await h.fire("tool.call", { tool: "Bash", tool_use_id: "b-lead", command: "kata close ab12 --done" });
	expect(lead.command).toStartWith("/usr/bin/env KATA_TRANSCRIPT_AGENT=");
	expect((await h.check(lead.command)).decision).toBe("allow");
	const { ref } = assignmentOf(tagged((await h.spawn({ prompt: "Implement parser module", description: "Parser" }, "agent-rules")).prompt));
	const sub = await h.agentCall("agent-rules", "Bash", { command: `kata close ${ref} --done` });
	expect((await h.check(sub.command, "agent-rules")).decision).toBe("allow");
	const guarded = await h.fire("tool.call", { tool: "Bash", tool_use_id: "b-guarded", command: "kata close zz99 --done" });
	expect(await h.check(guarded.command)).toMatchObject({ decision: "ask", hook: "PreToolUse" });

	const chained = await h.fire("tool.call", { tool: "Bash", tool_use_id: "b-chained", command: "rm -rf build && kata close ab12 --done" });
	expect((await h.check(chained.command)).decision).toBe("ask");
	expect((await h.check("env KATA_TRANSCRIPT_AGENT=claude kata close ab12 --done")).decision).toBe("ask");
});

test("an agent the lead does not track still gets a teammate of its own on its kata commands", async () => {
	const h = await started();
	const out = await h.agentCall("engine-fork-1", "Bash", { command: "kata list" });
	const other = await h.agentCall("engine-fork-2", "Bash", { command: "kata list" });
	const teammateOf = (command: string) => /--teammate '([^']+)'/.exec(command)?.[1];
	expect(teammateOf(out.command)).toBeTruthy();
	expect(teammateOf(out.command)).not.toBe(teammateOf(other.command));
});

test("a subagent works its own issue through todo, and one without an issue is told it has none", async () => {
	const h = await started();
	const spawned = await h.spawn({ prompt: "Implement parser module", description: "Parser" }, "agent-todo");
	const { ref } = assignmentOf(tagged(spawned.prompt));
	const init = await h.todo({ op: "init", items: ["Write the parser", "Test the parser"] }, "agent-todo");
	expect(init.isError, init.result).toBeUndefined();
	expect(((await show(ref)).children as any[]).map(child => child.title).sort()).toEqual(["Test the parser", "Write the parser"]);
	const done = await h.todo({ op: "done", task: "Write the parser", message: MESSAGE, evidence: EVIDENCE }, "agent-todo");
	expect(done.isError, done.result).toBeUndefined();
	expect(done.result).toContain("[x] Write the parser");
	expect((await show(ref)).issue.status).toBe("open");
	expect((await h.todo({ op: "view" })).result).toContain("Document the parser output");

	const loose = await h.spawn({ prompt: "Survey the build scripts" }, "agent-loose");
	expect(tagged(loose.prompt)).toContain("you have no Kata issue");
	const refused = await h.todo({ op: "view" }, "agent-loose");
	expect(refused.isError).toBe(true);
	expect(refused.result).toContain("no Kata issue");
	const stranger = await h.todo({ op: "view" }, "agent-never-spawned");
	expect(stranger.isError).toBe(true);
});

test("an agent still running when the session ends is picked up by the resumed session, which finds it by its agent id", async () => {
	const store = new Map<string, unknown>();
	const first = host({ store });
	await first.start();
	await first.todo({ op: "init", items: ["Implement parser module"] });
	const spawned = await first.spawn({ prompt: "Implement parser module", description: "Parser" }, "agent-survivor");
	const { ref } = assignmentOf(tagged(spawned.prompt));
	await first.agentCall("agent-survivor", "Read");
	await first.end();
	const second = host({ store, session: first.state.session });
	await second.start();
	// The unfinished delegate is settled in the background: its issue goes back to the lead for review.
	await eventually(async () => (await labelsOf(ref)).includes("needs-review"), true);
	const bash = await second.agentCall("agent-survivor", "Bash", { command: `kata show ${ref}` });
	expect(bash.command).toContain("--teammate");
});

test("a spawn whose Kata hangs still returns inside the hook's budget, with the agent started and no assignment", async () => {
	let hanging = false;
	const hang = holdKata(() => hanging);
	const h = host({ before: hang.before });
	await h.start();
	await h.todo({ op: "init", items: ["Implement parser module"] });
	const clock = pausedClock(h.$);
	hanging = true;
	let outcome: any;
	// A budget of 5 s: what is waited before the engine's spawn and after it must fit inside, not add up past it.
	const spawning = h
		.fire(
			"agent.spawn",
			{
				tool_use_id: "toolu_hang",
				prompt: "Implement parser module",
				description: "Parser",
				subagentType: "general-purpose",
				provider: { plugin: "engine", tier: "core" },
				parentModel: "sonnet",
				background: true,
				fork: false
			},
			(e: any) => ({ model: "haiku", agentId: "agent-hang", prompt: e.prompt }),
			{ budget: { remainingMs: 5000 } }
		)
		.then(result => (outcome = result));
	await eventually(async () => {
		clock.fireNext();
		return outcome !== undefined;
	}, true);
	await spawning;
	hang.release();
	expect(outcome.agentId).toBe("agent-hang");
	expect(outcome.prompt).toBe("Implement parser module");
	expect(clock.elapsed()).toBeLessThan(5000);
}, 20_000);

test("a delegate's exit still running at a session switch saves to its own session, and the resumed session keeps its snapshot", async () => {
	const store = new Map<string, unknown>();
	const entriesOf = (id: string) => ((store.get(`session/${id}`) as any)?.entries ?? []) as any[];
	const snapshotOf = (id: string) => savedSnapshot(entriesOf(id), "claude") as any;
	// A session X with a saved plan of its own, ended so that a resume can pick it up.
	const first = host({ store });
	await first.start();
	await first.todo({ op: "init", items: ["Plan of the resumed session"] });
	const x = first.state.session;
	await first.end("clear");
	expect(JSON.stringify(entriesOf(x))).toContain("Plan of the resumed session");

	// The delegate's exit unsets the first Kata metadata after `arm`: it is then a job running in the core's queue.
	const gate = holdNext(argv => argv.includes("unset"));
	const h = host({ store, before: gate.before });
	await h.start();
	const a = h.state.session;
	await h.todo({ op: "init", items: ["Implement parser module"] });
	const spawned = await h.spawn({ prompt: "Implement parser module", description: "Parser" }, "agent-switch");
	expect(assignmentOf(spawned.prompt).ref).not.toBe("");
	const before = JSON.stringify(snapshotOf(a));
	gate.arm();
	const exiting = h.agentTurn("agent-switch", "The parser module is implemented and verified.");
	await gate.entered;
	// The session switches to X while the exit still runs; the switch queues behind it.
	h.state.session = x;
	const { result: viewing } = await entering(() => h.todo({ op: "view" }));
	gate.release();
	await exiting;
	const view = await viewing;
	await h.end("clear");
	expect(view.result).toContain("Plan of the resumed session");
	expect(snapshotOf(x).sessionId).toBe(x);
	expect(JSON.stringify(entriesOf(x))).not.toContain("agent-switch");
	expect(snapshotOf(x).plan.tasks.map((t: any) => t.content)).toEqual(["Plan of the resumed session"]);
	await eventually(async () => snapshotOf(a)?.sessionId === a && JSON.stringify(snapshotOf(a)) !== before, true);
}, 30_000);

test("a delegate is recorded for the session its spawn began in when the session switches while the spawn waits on the core", async () => {
	const gate = holdNext();
	const h = host({ before: gate.before });
	await h.start();
	const a = h.state.session;
	await h.todo({ op: "init", items: ["Implement parser module"] });
	gate.arm();
	const spawning = h.spawn({ prompt: "Survey the build scripts and list the slow ones.", description: "Survey" }, "agent-switching");
	await gate.entered;
	// A new session replaces A while the spawn still waits on the core's queue.
	h.state.session = crypto.randomUUID();
	const { result: viewing } = await entering(() => h.todo({ op: "view" }));
	gate.release();
	await spawning;
	await viewing;
	await h.agentCall("agent-switching", "Read");
	await h.agentTurn("agent-switching", "Slow ones: build-all.sh (found by the switching survey).");
	await eventually(async () => (await missionsWith("found by the switching survey")).length, 1);
	const [mission] = await missionsWith("found by the switching survey");
	expect(mission.body).toContain(`session ${a}`);
}, 30_000);
