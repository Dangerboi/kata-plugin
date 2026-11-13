import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { diffTodoList, listOf, type ListItem, type ListOp, type ListStatus, type PlanItem } from "../core/todo-list";

const LONG = "Changed the parser and verified it with the unit tests";
const none = new Set<string>();
const ops = (plan: PlanItem[], incoming: ListItem[], accepted = none) => {
	const result = diffTodoList(plan, accepted, incoming);
	if (!("ops" in result)) throw new Error(result.refusal);
	return result.ops;
};
const refusal = (plan: PlanItem[], incoming: ListItem[], accepted = none) => {
	const result = diffTodoList(plan, accepted, incoming);
	if ("ops" in result) throw new Error(`expected refusal, got ${JSON.stringify(result.ops)}`);
	return result;
};

describe("listOf", () => {
	test("maps Kata statuses to list statuses", () => {
		expect(listOf([
			{ content: "a", status: "pending" }, { content: "b", status: "in_progress" },
			{ content: "c", status: "blocked", blocker: "waiting" }, { content: "d", status: "completed" }, { content: "e", status: "abandoned" },
		])).toEqual([
			{ content: "a", status: "pending" }, { content: "b", status: "in_progress" },
			{ content: "c", status: "in_progress", blocker: "waiting" }, { content: "d", status: "completed" }, { content: "e", status: "cancelled" },
		]);
	});
});

describe("diffTodoList", () => {
	test("an unchanged list yields no ops", () => {
		const plan: PlanItem[] = [{ content: "a", status: "pending" }, { content: "b", status: "blocked", blocker: "x" }, { content: "c", status: "completed" }];
		expect(ops(plan, listOf(plan))).toEqual([]);
	});

	test("blank and duplicate content are refused", () => {
		const r = refusal([], [{ content: "  ", status: "pending" }, { content: "a", status: "pending" }, { content: "a", status: "pending" }]);
		expect(r.problems).toEqual(["an item has blank content", "\"a\" appears more than once"]);
	});

	test("new items become one append, then start, done or block", () => {
		const plan: PlanItem[] = [];
		expect(ops(plan, [{ content: "a", status: "pending" }, { content: "b", status: "in_progress" }])).toEqual([
			{ op: "append", items: ["a", "b"] }, { op: "start", task: "b" },
		]);
		expect(ops(plan, [{ content: "a", status: "completed", message: LONG, evidence: ["test:bun test"] }])).toEqual([
			{ op: "append", items: ["a"] }, { op: "done", task: "a", message: LONG, evidence: ["test:bun test"] },
		]);
		expect(ops(plan, [{ content: "a", status: "in_progress", blocker: "needs review" }])).toEqual([
			{ op: "append", items: ["a"] }, { op: "block", task: "a", reason: "needs review" },
		]);
	});

	test("a new item sent as cancelled is refused", () => {
		expect(refusal([], [{ content: "a", status: "cancelled", reason: "no" }]).problems[0]).toContain("leave it out instead");
	});

	test("a new completed item still needs its proof", () => {
		expect(refusal([], [{ content: "a", status: "completed" }]).problems[0]).toContain("without a message");
	});

	test("closed items accept only their closed status and ignore extra fields", () => {
		const plan: PlanItem[] = [{ content: "a", status: "completed" }, { content: "b", status: "abandoned" }];
		expect(ops(plan, [{ content: "a", status: "completed", message: "x", evidence: [] , blocker: "b" }, { content: "b", status: "cancelled", reason: "r" }])).toEqual([]);
		expect(refusal(plan, [{ content: "a", status: "pending" }, { content: "b", status: "completed", message: LONG, evidence: ["e"] }]).problems).toEqual([
			"\"a\" is already completed in Kata and cannot be sent as pending",
			"\"b\" is already cancelled in Kata and cannot be sent as completed",
		]);
	});

	test("completing an open item needs a 40+ character message and evidence", () => {
		const plan: PlanItem[] = [{ content: "a", status: "in_progress" }];
		expect(ops(plan, [{ content: "a", status: "completed", message: LONG, evidence: ["commit:abc"] }])).toEqual([
			{ op: "done", task: "a", message: LONG, evidence: ["commit:abc"] },
		]);
		expect(refusal(plan, [{ content: "a", status: "completed", evidence: ["e"] }]).problems).toEqual(["\"a\" cannot be completed without a message of 40+ characters saying what changed and how it was verified"]);
		expect(refusal(plan, [{ content: "a", status: "completed", message: `short   ${" ".repeat(60)}x`, evidence: ["e"] }]).problems[0]).toContain("without a message of 40+");
		expect(refusal(plan, [{ content: "a", status: "completed", message: LONG, evidence: [] }]).problems).toEqual(["\"a\" cannot be completed without evidence"]);
	});

	test("cancelling an open item needs a reason and becomes drop", () => {
		const plan: PlanItem[] = [{ content: "a", status: "pending" }];
		expect(ops(plan, [{ content: "a", status: "cancelled", reason: "not needed" }])).toEqual([{ op: "drop", task: "a", message: "not needed" }]);
		expect(refusal(plan, [{ content: "a", status: "cancelled", reason: " " }]).problems).toEqual(["\"a\" cannot be cancelled without a reason"]);
	});

	test("open item transitions", () => {
		const pending: PlanItem[] = [{ content: "a", status: "pending" }];
		expect(ops(pending, [{ content: "a", status: "in_progress" }])).toEqual([{ op: "start", task: "a" }]);
		expect(ops(pending, [{ content: "a", status: "pending", blocker: "w" }])).toEqual([{ op: "block", task: "a", reason: "w" }]);
		expect(ops(pending, [{ content: "a", status: "in_progress", blocker: "w" }])).toEqual([{ op: "block", task: "a", reason: "w" }]);
		const started: PlanItem[] = [{ content: "a", status: "in_progress" }];
		expect(ops(started, [{ content: "a", status: "in_progress", blocker: "w" }])).toEqual([{ op: "block", task: "a", reason: "w" }]);
		expect(refusal(started, [{ content: "a", status: "pending" }]).problems[0]).toContain("to pause it, keep it in_progress and set blocker");
	});

	test("blocked item transitions", () => {
		const plan: PlanItem[] = [{ content: "a", status: "blocked", blocker: "old" }];
		expect(ops(plan, [{ content: "a", status: "in_progress", blocker: "new text" }])).toEqual([]);
		expect(ops(plan, [{ content: "a", status: "in_progress" }])).toEqual([{ op: "unblock", task: "a" }, { op: "start", task: "a" }]);
		expect(ops(plan, [{ content: "a", status: "pending" }])).toEqual([{ op: "unblock", task: "a" }]);
		expect(ops(plan, [{ content: "a", status: "pending", blocker: "w" }])).toEqual([]);
	});

	test("a missing open item is refused by who added it", () => {
		const plan: PlanItem[] = [{ content: "mine", status: "pending" }, { content: "theirs", status: "pending" }, { content: "old", status: "completed" }];
		const r = refusal(plan, [], new Set(["mine"]));
		expect(r.problems).toEqual([
			"\"mine\" is missing from the list: keep it, or mark it cancelled with a reason",
			"\"theirs\" was added to the Kata plan outside this session and is requested work: send it back unchanged",
		]);
		expect(r.problems.join()).not.toContain("old");
	});

	test("refusal text lists every problem and the current plan", () => {
		const plan: PlanItem[] = [{ content: "a", status: "blocked", blocker: "w" }, { content: "b", status: "pending" }];
		const r = refusal(plan, [{ content: "a", status: "completed" }, { content: "c", status: "cancelled" }]);
		expect(r.refusal.split("\n")).toEqual([
			"Refused: this list disagrees with the Kata plan. Nothing was changed.",
			...r.problems.map(p => `- ${p}`),
			"The current Kata plan is below. Send it again with your changes applied on top:",
			'{"todos":[{"content":"a","status":"in_progress","blocker":"w"},{"content":"b","status":"pending"}]}',
		]);
		expect(r.problems).toHaveLength(3);
	});

	test("ops run append, close, unblock, block, start", () => {
		const plan: PlanItem[] = [
			{ content: "s", status: "pending" }, { content: "bl", status: "pending" }, { content: "u", status: "blocked", blocker: "x" }, { content: "d", status: "in_progress" },
		];
		const result = ops(plan, [
			{ content: "s", status: "in_progress" }, { content: "bl", status: "pending", blocker: "w" }, { content: "u", status: "pending" },
			{ content: "d", status: "completed", message: LONG, evidence: ["e"] }, { content: "n", status: "pending" },
		]);
		expect(result.map(o => o.op)).toEqual(["append", "done", "unblock", "block", "start"]);
	});
});

const CONTENTS = ["a", "b", "c", "d", "e", "f", "g"];
// Contents may repeat: a plan made elsewhere can carry one title in two phases. Each task has its own ref.
const planArb = fc.array(fc.constantFrom(...CONTENTS), { maxLength: 6 }).chain(names =>
	fc.tuple(...names.map((content, index) => fc.constantFrom<PlanItem["status"]>("pending", "in_progress", "blocked", "completed", "abandoned").map(status => ({ content, ref: `p#${index}`, status, ...(status === "blocked" ? { blocker: "w" } : {}) } as PlanItem)))),
);
const itemArb = (content: string) => fc.record({
	content: fc.constant(content),
	status: fc.constantFrom<ListStatus>("pending", "in_progress", "completed", "cancelled"),
	message: fc.option(fc.constantFrom("short", LONG), { nil: undefined }),
	evidence: fc.option(fc.constantFrom([], ["test:x"]), { nil: undefined }),
	reason: fc.option(fc.constantFrom("", "why"), { nil: undefined }),
	blocker: fc.option(fc.constantFrom("", "w"), { nil: undefined }),
}) as fc.Arbitrary<ListItem>;
const incomingArb = fc.uniqueArray(fc.constantFrom(...CONTENTS), { maxLength: 6 }).chain(names => fc.tuple(...names.map(itemArb)));
const acceptedArb = fc.subarray(CONTENTS).map(list => new Set(list));

const STATUS_OF: Record<ListOp["op"], PlanItem["status"]> = { append: "pending", start: "in_progress", done: "completed", drop: "abandoned", block: "blocked", unblock: "pending" };
const applyOps = (plan: PlanItem[], list: readonly ListOp[]): PlanItem[] => {
	const next = plan.map(t => ({ ...t }));
	for (const o of list) {
		if (o.op === "append") { for (const content of o.items) next.push({ content, ref: `n#${next.length}`, status: "pending" }); continue; }
		// Resolves a name like core: an exact ref, else a content that matches one task, else an error.
		const byRef = next.filter(t => t.ref === o.task);
		const byContent = next.filter(t => t.content === o.task);
		if (!byRef.length && byContent.length !== 1) throw new Error(`Ambiguous or unknown task: ${o.task}`);
		const task = byRef[0] ?? byContent[0];
		task.status = STATUS_OF[o.op];
		task.blocker = o.op === "block" ? o.reason : undefined;
	}
	return next;
};

describe("a content that appears in several plan tasks", () => {
	const twice = (a: PlanItem["status"], b: PlanItem["status"]): PlanItem[] => [{ content: "t", ref: "p#1", status: a }, { content: "t", ref: "p#2", status: b }];

	test("is one list item and its own list is a no-op", () => {
		const plan = twice("pending", "in_progress");
		expect(listOf(plan)).toEqual([{ content: "t", status: "in_progress" }]);
		expect(ops(plan, listOf(plan))).toEqual([]);
	});

	test("an op names each open copy by ref and skips closed ones", () => {
		const plan = [...twice("pending", "pending"), { content: "t", ref: "p#3", status: "completed" } as PlanItem];
		expect(ops(plan, [{ content: "t", status: "in_progress" }])).toEqual([{ op: "start", task: "p#1" }, { op: "start", task: "p#2" }]);
		expect(ops(twice("in_progress", "pending"), [{ content: "t", status: "completed", message: LONG, evidence: ["e"] }]).map(o => (o as { task: string }).task)).toEqual(["p#1", "p#2"]);
		expect(ops(twice("pending", "pending"), [{ content: "t", status: "cancelled", reason: "r" }])).toEqual([{ op: "drop", task: "p#1", message: "r" }, { op: "drop", task: "p#2", message: "r" }]);
	});

	test("a copy that is missing from the list is reported once", () => {
		expect(refusal(twice("pending", "pending"), []).problems).toEqual([`"t" was added to the Kata plan outside this session and is requested work: send it back unchanged`]);
	});

	test("an op names the open copy by ref when another copy is closed", () => {
		const done = [{ content: "t", ref: "p#1", status: "completed" } as PlanItem, { content: "t", ref: "p#2", status: "pending" } as PlanItem];
		expect(ops(done, [{ content: "t", status: "completed", message: LONG, evidence: ["e"] }])).toEqual([{ op: "done", task: "p#2", message: LONG, evidence: ["e"] }]);
		expect(ops(done, [{ content: "t", status: "cancelled", reason: "r" }])).toEqual([{ op: "drop", task: "p#2", message: "r" }]);
		const abandoned = [{ content: "t", ref: "p#1", status: "abandoned" } as PlanItem, { content: "t", ref: "p#2", status: "in_progress" } as PlanItem];
		expect(ops(abandoned, [{ content: "t", status: "completed", message: LONG, evidence: ["e"] }]).map(o => (o as { task: string }).task)).toEqual(["p#2"]);
	});

	test("copies that share one ref are refused when an op is needed, and a no-op resend passes", () => {
		const shared = [{ content: "t", ref: "k#1", status: "pending" } as PlanItem, { content: "t", ref: "k#1", status: "pending" } as PlanItem];
		const sent: ListItem[][] = [
			[{ content: "t", status: "in_progress" }],
			[{ content: "t", status: "in_progress", blocker: "w" }],
			[{ content: "t", status: "cancelled", reason: "r" }],
			[{ content: "t", status: "completed", message: LONG, evidence: ["e"] }],
		];
		for (const list of sent) {
			const problems = refusal(shared, list).problems;
			expect(problems).toHaveLength(1);
			expect(problems[0]).toContain(`"t" appears in more than one phase naming the same ticket, so todowrite cannot change it: ask the user to remove the duplicate item`);
		}
		const blocked = shared.map(t => ({ ...t, status: "blocked", blocker: "w" }) as PlanItem);
		expect(refusal(blocked, [{ content: "t", status: "in_progress" }]).problems).toHaveLength(1);
		// Nothing to apply: every op the model could send for them is refused, so applyOps never meets an ambiguous name.
		expect(ops(shared, listOf(shared))).toEqual([]);
		expect(applyOps(shared, ops(shared, listOf(shared)))).toEqual(shared);
	});
});

describe("diffTodoList properties", () => {
	test("the plan's own list yields no ops", () => {
		fc.assert(fc.property(planArb, acceptedArb, (plan, accepted) => {
			expect(diffTodoList(plan, accepted, listOf(plan))).toEqual({ ops: [] });
		}));
	});

	test("applying the ops makes the same list a no-op", () => {
		fc.assert(fc.property(planArb, acceptedArb, incomingArb, (plan, accepted, incoming) => {
			const result = diffTodoList(plan, accepted, incoming);
			if (!("ops" in result)) return;
			expect(diffTodoList(applyOps(plan, result.ops), accepted, incoming)).toEqual({ ops: [] });
		}));
	});

	// Two contents over up to six tasks make repeated titles with mixed statuses common; the seed pins the run.
	test("applying the ops makes the same list a no-op, with repeated titles in mixed statuses", () => {
		const pool = ["a", "b"];
		const plans = fc.array(fc.tuple(fc.constantFrom(...pool), fc.constantFrom<PlanItem["status"]>("pending", "in_progress", "completed", "abandoned")), { maxLength: 6 })
			.map(rows => rows.map(([content, status], index) => ({ content, ref: `p#${index}`, status }) as PlanItem));
		const lists = fc.uniqueArray(fc.constantFrom(...pool), { maxLength: 2 }).chain(names => fc.tuple(...names.map(itemArb)));
		fc.assert(fc.property(plans, lists, (plan, incoming) => {
			const result = diffTodoList(plan, none, incoming);
			if (!("ops" in result)) return;
			expect(diffTodoList(applyOps(plan, result.ops), none, incoming)).toEqual({ ops: [] });
		}), { seed: 11, numRuns: 20000 });
	});

	test("a repeated title with one completed and one open copy: cancelling it leaves a list that stays accepted", () => {
		const plan: PlanItem[] = [{ content: "t", ref: "p#1", status: "completed" }, { content: "t", ref: "p#2", status: "pending" }];
		const cancelled: ListItem[] = [{ content: "t", status: "cancelled", reason: "why" }];
		const result = diffTodoList(plan, none, cancelled);
		if (!("ops" in result)) throw new Error(result.refusal);
		const after = applyOps(plan, result.ops);
		expect(after.map(t => t.status)).toEqual(["completed", "abandoned"]);
		expect(diffTodoList(after, none, cancelled)).toEqual({ ops: [] });
		expect(diffTodoList(after, none, [{ content: "t", status: "completed" }])).toEqual({ ops: [] });
		expect(diffTodoList(after, none, [{ content: "t", status: "pending" }])).toHaveProperty("refusal");
	});

	test("the list inside a refusal is accepted when sent back", () => {
		fc.assert(fc.property(planArb, acceptedArb, incomingArb, (plan, accepted, incoming) => {
			const result = diffTodoList(plan, accepted, incoming);
			if (!("refusal" in result)) return;
			const todos = JSON.parse(result.refusal.split("\n").pop()!).todos;
			expect(diffTodoList(plan, accepted, todos)).toEqual({ ops: [] });
		}));
	});
});
