import { diffTodoList, LIST_STATUSES, listOf, planTail, type ListItem, type ListOp, type PlanItem } from "./todo-list";
import { RULES } from "./kata-core";
import { PROOF_MIN } from "./model";
import type { Planner, TodoResult } from "./lead";
import type { Seam } from "./seam";
import { DESCRIPTION } from "./wording";

const SCHEMA = {
	type: "object",
	properties: {
		todos: {
			type: "array",
			description: "The whole todo list.",
			items: {
				type: "object",
				properties: {
					content: { type: "string", description: "Exact task text; also the item's identity." },
					status: { type: "string", enum: [...LIST_STATUSES] },
					message: { type: "string", description: `completed: what changed and how it was verified (${PROOF_MIN}+ characters).` },
					evidence: { type: "array", items: { type: "string" }, description: `completed: ${RULES.evidence}.` },
					reason: { type: "string", description: "cancelled: why." },
					blocker: { type: "string", description: "in_progress: what the item is waiting on." },
				},
				required: ["content", "status"],
			},
		},
		ref: { type: "string", description: "First call: the existing Kata issue this plan serves." },
		takeover: { type: "boolean", description: "Take over the items this call changes from another session that started them and crashed or was killed; recorded on each issue." },
	},
	required: ["todos"],
};

function parseInput(input: any): { todos: ListItem[]; ref?: string; takeover: boolean } {
	if (!input || !Array.isArray(input.todos)) throw new Error("todowrite needs todos: [{content, status}], the whole list.");
	const text = (value: unknown, where: string) => {
		if (value !== undefined && typeof value !== "string") throw new Error(`${where} must be a string.`);
		return value as string | undefined;
	};
	const todos = input.todos.map((item: any, index: number): ListItem => {
		const where = `todos[${index}]`;
		if (!item || typeof item.content !== "string") throw new Error(`${where}.content must be a string.`);
		if (!LIST_STATUSES.includes(item.status)) throw new Error(`${where}.status must be one of ${LIST_STATUSES.join(", ")}.`);
		if (item.evidence !== undefined && (!Array.isArray(item.evidence) || item.evidence.some((e: unknown) => typeof e !== "string"))) throw new Error(`${where}.evidence must be an array of strings.`);
		return { content: item.content, status: item.status, message: text(item.message, `${where}.message`), evidence: item.evidence, reason: text(item.reason, `${where}.reason`), blocker: text(item.blocker, `${where}.blocker`) };
	});
	if (input.takeover !== undefined && typeof input.takeover !== "boolean") throw new Error("takeover must be a boolean.");
	return { todos, ref: text(input.ref, "ref")?.trim() || undefined, takeover: input.takeover === true };
}

const planOf = (result: TodoResult): PlanItem[] => (result.kata.phases ?? []).flatMap(phase => phase.tasks.map(({ content, status, blocker, ref }) => ({ content, status, blocker, ref })));

function coreOp(op: ListOp, init: { ref?: string } | undefined, takeover: boolean): [string, Record<string, unknown>] {
	const taken = takeover ? { takeover: true } : {};
	switch (op.op) {
		// The first items of a session with no plan start it, in the core's one default phase.
		case "append": return init ? ["init", { items: op.items, ...(init.ref ? { ref: init.ref } : {}) }] : ["append", { items: op.items }];
		case "start": return ["start", { task: op.task, ...taken }];
		case "done": return ["done", { task: op.task, message: op.message, evidence: op.evidence, ...taken }];
		case "drop": return ["drop", { task: op.task, message: op.message, ...taken }];
		case "block": return ["block", { task: op.task, reason: op.reason, ...taken }];
		case "unblock": return ["unblock", { task: op.task, ...taken }];
	}
}

// One todowrite call, as one job of the session's core: reload the Kata plan, diff the list against it, apply the ops in order. A refusal changes nothing.
async function write(seam: Seam, planner: Planner, input: unknown) {
	const { todos, ref, takeover } = parseInput(input);
	return planner.batch(async job => {
		let result = await planner.todo("view", {}, job);
		if (result.isError) throw new Error(result.text);
		const hasPlan = !!result.kata.parent || !!result.kata.local || planOf(result).length > 0;
		const accepted = new Set(await seam.storage.accepted(planner.id));
		const diff = diffTodoList(planOf(result), accepted, todos);
		if ("refusal" in diff) throw new Error(diff.refusal);

		let init = hasPlan ? undefined : { ref };
		for (const op of diff.ops) {
			const [name, params] = coreOp(op, init, takeover);
			init = undefined;
			result = await planner.todo(name, params, job);
			if (op.op === "append" && !result.isError) for (const item of op.items) accepted.add(item);
			// An earlier op may have been applied: say what the plan is now, and remember the items this call already added.
			if (result.isError) {
				await seam.storage.accept(planner.id, [...accepted]);
				throw new Error(`${result.kata.notice || result.text}\nEarlier changes of this call may have been applied. ${planTail(planOf(result))}`);
			}
		}
		await seam.storage.accept(planner.id, todos.map(item => item.content));
		return { content: result.text, metadata: { todos: listOf(planOf(result)), ...(result.kata.parent ? { parent: result.kata.parent } : {}) } };
	});
}

export function install(seam: Seam): Promise<unknown> {
	return seam.ctx.tool.transform((editor: any) => editor.add({
		name: "todowrite",
		description: DESCRIPTION,
		input: SCHEMA,
		options: { codemode: false },
		async execute(input: unknown, context: { sessionID: string }) {
			const role = await seam.roleOf(context.sessionID);
			if (role.kind === "lead") return write(seam, role.lead, input);
			if (role.kind === "other") throw new Error("todowrite could not read this session from OpenCode, so it changed nothing. Send the list again.");
			// A delegate bound to an issue plans under it, through its own core; one that is not bound has no plan, and the lead tracks its work.
			if (!role.record) throw new Error("todowrite is for the lead session: a delegate reports its work in its reply, and the lead tracks it.");
			await role.lead.delegateEvent({ type: "nextUse", id: role.record.id });
			return write(seam, role.lead.delegatePlan(context.sessionID), input);
		},
	}));
}
