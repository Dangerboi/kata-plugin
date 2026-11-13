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
const planArb = fc.uniqueArray(fc.constantFrom(...CONTENTS), { maxLength: 5 }).chain(names =>
	fc.tuple(...names.map(content => fc.constantFrom<PlanItem["status"]>("pending", "in_progress", "blocked", "completed", "abandoned").map(status => ({ content, status, ...(status === "blocked" ? { blocker: "w" } : {}) } as PlanItem)))),
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
		if (o.op === "append") { for (const content of o.items) next.push({ content, status: "pending" }); continue; }
		const task = next.find(t => t.content === o.task)!;
		task.status = STATUS_OF[o.op];
		task.blocker = o.op === "block" ? o.reason : undefined;
	}
	return next;
};

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

	test("the list inside a refusal is accepted when sent back", () => {
		fc.assert(fc.property(planArb, acceptedArb, incomingArb, (plan, accepted, incoming) => {
			const result = diffTodoList(plan, accepted, incoming);
			if (!("refusal" in result)) return;
			const todos = JSON.parse(result.refusal.split("\n").pop()!).todos;
			expect(diffTodoList(plan, accepted, todos)).toEqual({ ops: [] });
		}));
	});
});
