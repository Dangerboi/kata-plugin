import { expect, mock, test } from "claude-code/testing";

// Wiring only: the engine's own host loads the module and fires the delegate events at it. Binding against Kata itself runs
// in the repository's tests/claude-delegates.test.ts (a real Kata needs a process, which this sandbox lacks); here Kata is
// unreachable, which is the case a spawn and a shell call must survive.

function engine(
	on: any,
	kata: (argv: string[]) => { exitCode: number; stdout: string; stderr: string } = () => ({ exitCode: 1, stdout: "", stderr: "kata unavailable" })
) {
	const saved = new Map<string, unknown>();
	on("store.get", ($: unknown, e: { key: string }) => ({ value: saved.get(e.key) }));
	on("store.set", ($: unknown, e: { key: string; value: unknown }) => {
		saved.set(e.key, e.value);
		return { value: undefined };
	});
	on("store.delete", ($: unknown, e: { key: string }) => {
		saved.delete(e.key);
		return { value: undefined };
	});
	on("store.keys", () => ({ value: [...saved.keys()] }));
	on("session.id", () => ({ value: "22222222-2222-4222-8222-222222222222" }));
	on("session.cwd", () => ({ value: "/work" }));
	on("fs.stat", () => ({ value: { kind: "dir", size: 0, mtimeMs: 0, isLink: false, realPath: "/work" } }));
	on("process.run", (_: unknown, e: { argv: string[] }) => ({ value: { ...kata(e.argv), isStdoutTruncated: false, isStderrTruncated: false } }));
	on("env.get", () => ({ value: undefined }));
	on("session.start", () => ({ cwd: "/work" }));
	on("turn.complete", () => ({ text: "" }));
}

// The engine's own answer to a Bash call: what would have run.
const ran = (on: any) => on("tool.call", ($: unknown, e: { command?: string }) => ({ result: e.command }));

test("a spawn that names nothing is untracked and told so even when Kata is unreachable, and its answer is taken without error", async ($, on) => {
	engine(on);
	mock.clock(on);
	let seen = "";
	on("agent.spawn", ($: unknown, e: { prompt: string }) => {
		seen = e.prompt;
		return { model: "haiku", agentId: "a1" };
	});
	await $.session.start({ surface: "terminal", isInteractive: false, cwd: "/work" });
	const started = await $.agent.spawn({ prompt: "Look at the build", description: "Look" } as any);
	expect(started).toMatchObject({ model: "haiku", agentId: "a1" });
	// Naming nothing, it is untracked and told so.
	expect(seen.startsWith("Look at the build")).toBe(true);
	expect(seen).toContain("<kata_binding>");
	expect(seen).toContain("no Kata issue");
	const finished = await $.turn.complete({ turnId: "t1", answer: "done", durationMs: 1, isAborted: false, usage: null, agentId: "a1" } as any);
	expect(finished).toBeDefined();
});

test("a subagent kata command carries its teammate, --as is refused and the lead is left alone", async ($, on) => {
	engine(on);
	mock.clock(on);
	ran(on);
	await $.session.start({ surface: "terminal", isInteractive: false, cwd: "/work" });
	const sub = await $.tool.call({ tool: "Bash", command: "kata list --status open", agentId: "engine-fork-9" } as any);
	expect(String(sub.result)).toMatch(/^kata --teammate 'engine-fork-9-[0-9a-f]{6}' list --status open$/);
	const asked = await $.tool.call({ tool: "Bash", command: "kata close x --as me", agentId: "engine-fork-9" } as any);
	expect(String(asked.deny)).toContain("--as is not permitted");
	const lead = await $.tool.call({ tool: "Bash", command: "kata list" } as any);
	expect(lead.result).toBe("kata list");
});

test("a subagent that has no issue is told so when it calls todo", async ($, on) => {
	engine(on);
	mock.clock(on);
	await $.session.start({ surface: "terminal", isInteractive: false, cwd: "/work" });
	const sub = await $.tool.call({ tool: "todo", op: "view", agentId: "a1" } as any);
	expect(sub.isError).toBe(true);
	expect(String(sub.result)).toContain("no Kata assignment");
});

// A one-issue Kata: just enough of its CLI for a plan that names a ticket and a delegate bound to it.
function stubKata() {
	const issue: any = {
		uid: "u1",
		short_id: "ab12",
		qualified_id: "proj#ab12",
		project_id: 1,
		title: "Implement parser module",
		status: "open",
		created_at: "2026-01-01T00:00:00Z",
		revision: 1,
		owner: "lead",
		metadata: {}
	};
	const log: string[] = [];
	const run = (argv: string[]) => {
		log.push(argv.join(" "));
		const [, verb] = argv;
		let out = "{}";
		if (verb === "version") out = '{"kata_api_version":1,"name":"kata","version":"v0.23.0","agent_format":1}';
		else if (argv[0] === "git") out = "lead\n";
		else if (verb === "status") out = '{"actor":"lead"}';
		else if (verb === "projects") out = '{"projects":[{"id":1,"name":"proj"}]}';
		else if (verb === "list") out = '{"issues":[]}';
		else if (verb === "meta" && argv[2] === "set") {
			issue.metadata[argv[4]!] = argv.includes("--json-value") ? JSON.parse(argv[5]!) : argv[5];
			issue.revision++;
			out = JSON.stringify({ issue });
		} else if (verb === "show" || verb === "claim") out = JSON.stringify({ issue, comments: [] });
		return { exitCode: 0, stdout: out, stderr: "" };
	};
	return { run, log, issue };
}

// The plan names a ticket, which the one-issue Kata above serves.
async function planned($: any, on: any) {
	const kata = stubKata();
	engine(on, kata.run);
	mock.clock(on);
	const seen: string[] = [];
	on("agent.spawn", ($: unknown, e: { prompt: string }) => {
		seen.push(e.prompt);
		return { model: "haiku", agentId: `a${seen.length}` };
	});
	await $.session.start({ surface: "terminal", isInteractive: false, cwd: "/work" });
	const made = await $.tool.call({ tool: "todo", op: "init", items: ["proj#ab12: Implement parser module"] } as any);
	expect(made.isError).toBeUndefined();
	return { kata, seen };
}

test("a spawn that names a plan item takes it as its assignment: its prompt gains the issue and its own teammate", async ($, on) => {
	const { kata, seen } = await planned($, on);
	await $.agent.spawn({ prompt: "Please work proj#ab12.", description: "Parser" } as any);
	expect(seen[0]!.startsWith("Please work proj#ab12.")).toBe(true);
	expect(seen[0]).toContain("<kata_binding>");
	expect(seen[0]).toContain("Your Kata issue is proj#ab12;");
	expect(seen[0]).toMatch(/your teammate is spawn-0-[0-9a-f]{6}\./);
	expect(kata.issue.metadata["claude.subagent_id"]).toBe("spawn-0");
});

test("Workflow agents (runId, agentIndex) are each their own delegate: one gets the issue, the next is untracked", async ($, on) => {
	const { kata, seen } = await planned($, on);
	const workflow = (agentIndex: number) => ({ tool_use_id: "toolu_flow", workflow: { runId: "run-1", agentIndex } });
	await $.agent.spawn({ prompt: "Look at the build scripts.", description: "Survey", ...workflow(0) } as any);
	await $.agent.spawn({ prompt: "Please work proj#ab12.", description: "Parser", ...workflow(1) } as any);
	expect(seen[0]).toContain("you have no Kata issue");
	expect(seen[1]).toContain("Your Kata issue is proj#ab12;");
	expect(kata.issue.metadata["claude.subagent_id"]).toMatch(/^toolu_flow\.1-/);
});
