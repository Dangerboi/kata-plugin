import { diffTodoList, listOf, type ListItem, type ListOp, type PlanItem } from "./todo-list";
import type { Lead, TodoResult } from "./lead";
import type { Seam } from "./seam";

const STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;

// DESCRIPTION in kata-core.ts, for the list interface: the model sends the whole list, not ops.
const DESCRIPTION = `Track multi-step work as a todo list stored in Kata. Send the WHOLE list on every call: todos [{content, status}] with status pending, in_progress, completed or cancelled. Items are identified by exact content: keep the wording of an item stable between calls. Create the list before work for 3+ steps or several user requests, one item per request; mark an item in_progress when you start it and completed right after it is verified. Nothing starts on its own, and several items may be in progress.
Every call is compared with the Kata plan. A call that disagrees with it is refused and changes nothing; the error carries the current list: send it again with your changes on top.
- completed needs \`message\` (40+ characters: what changed and how it was verified) and \`evidence\` (an array: commit:<sha>, test:<cmd>, pr:<url>, reviewed-paths:<path>). Unverified work: do not complete it; pause it instead.
- cancelled needs \`reason\`. A new item cannot be cancelled: leave it out.
- To pause an item (waiting on the user, an agent or a service), keep it in_progress and set \`blocker\` to the reason; remove the blocker to resume. A started item cannot go back to pending.
- An open item missing from your list is refused: keep it, or cancel it with a reason. Items added to the plan outside this session (by the user or a teammate) are requested work: send them back unchanged.
- An item Kata has closed (a delegate closed its own issue, or the user did) stays completed or cancelled: resend it with that status and no message, evidence or reason.
- An item that works an existing ticket starts with its qualified ref: \`<project>#<short_id>: <action>\`. It creates no issue: starting it claims the ticket, completing it comments on it, and the last completed item of a ticket closes it with that item's evidence. A ref that does not resolve, or a closed ticket, is an error.
- Every other item becomes a child issue of one parent issue. On the first call pass \`ref\` with the Kata issue this plan serves (search first: kata search "<terms>" --agent); without it the session gets its own parent issue.
- The tool does the Kata bookkeeping for its items (claims, attention, closes). Do not run \`kata claim\`, \`kata meta set ... work.attention\` or \`kata close\` for them yourself, and never add such bookkeeping as an item.
- A delegate bound to an item or ticket closes that issue itself, with its own evidence, once its work is verified; the item then shows completed.`;

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
					status: { type: "string", enum: [...STATUSES] },
					message: { type: "string", description: "completed: what changed and how it was verified (40+ characters)." },
					evidence: { type: "array", items: { type: "string" }, description: "completed: commit:<sha>, test:<cmd>, pr:<url>, reviewed-paths:<path>." },
					reason: { type: "string", description: "cancelled: why." },
					blocker: { type: "string", description: "in_progress: what the item is waiting on." },
				},
				required: ["content", "status"],
			},
		},
		ref: { type: "string", description: "First call: the existing Kata issue this plan serves." },
	},
	required: ["todos"],
};

function parseInput(input: any): { todos: ListItem[]; ref?: string } {
	if (!input || !Array.isArray(input.todos)) throw new Error("todowrite needs todos: [{content, status}], the whole list.");
	const text = (value: unknown, where: string) => {
		if (value !== undefined && typeof value !== "string") throw new Error(`${where} must be a string.`);
		return value as string | undefined;
	};
	const todos = input.todos.map((item: any, index: number): ListItem => {
		const where = `todos[${index}]`;
		if (!item || typeof item.content !== "string") throw new Error(`${where}.content must be a string.`);
		if (!STATUSES.includes(item.status)) throw new Error(`${where}.status must be one of ${STATUSES.join(", ")}.`);
		if (item.evidence !== undefined && (!Array.isArray(item.evidence) || item.evidence.some((e: unknown) => typeof e !== "string"))) throw new Error(`${where}.evidence must be an array of strings.`);
		return { content: item.content, status: item.status, message: text(item.message, `${where}.message`), evidence: item.evidence, reason: text(item.reason, `${where}.reason`), blocker: text(item.blocker, `${where}.blocker`) };
	});
	return { todos, ref: text(input.ref, "ref")?.trim() || undefined };
}

const planOf = (result: TodoResult): PlanItem[] => (result.kata.phases ?? []).flatMap(phase => phase.tasks.map(({ content, status, blocker }) => ({ content, status, blocker })));

// The list tail every refusal and failure ends with, so the model can resend it.
const listTail = (result: TodoResult) => JSON.stringify({ todos: listOf(planOf(result)) });

function coreOp(op: ListOp, init: { ref?: string } | undefined): [string, Record<string, unknown>] {
	switch (op.op) {
		// The first items of a session with no plan start it: one phase.
		case "append": return init ? ["init", { list: [{ phase: "Tasks", items: op.items }], ...(init.ref ? { ref: init.ref } : {}) }] : ["append", { items: op.items }];
		case "start": return ["start", { task: op.task }];
		case "done": return ["done", { task: op.task, message: op.message, evidence: op.evidence }];
		case "drop": return ["drop", { task: op.task, message: op.message }];
		case "block": return ["block", { task: op.task, reason: op.reason }];
		case "unblock": return ["unblock", { task: op.task }];
	}
}

// One todowrite call: reload the Kata plan, diff the list against it, apply the ops in order. A refusal changes nothing.
async function write(seam: Seam, lead: Pick<Lead, "id" | "exclusive" | "todo">, input: unknown) {
	const { todos, ref } = parseInput(input);
	return lead.exclusive(async () => {
		let result = await lead.todo("view");
		if (result.isError) throw new Error(result.text);
		const hasPlan = !!result.kata.parent || !!result.kata.local || planOf(result).length > 0;
		const accepted = new Set(await seam.storage.get<string[]>(lead.id, "accepted") ?? []);
		const diff = diffTodoList(planOf(result), accepted, todos);
		if ("refusal" in diff) throw new Error(diff.refusal);

		let init = hasPlan ? undefined : { ref };
		for (const op of diff.ops) {
			const [name, params] = coreOp(op, init);
			init = undefined;
			result = await lead.todo(name, params);
			if (op.op === "append" && !result.isError) for (const item of op.items) accepted.add(item);
			// An earlier op may have been applied: say what the plan is now, and remember the items this call already added.
			if (result.isError) {
				await seam.storage.set(lead.id, "accepted", [...accepted]);
				throw new Error(`${result.kata.notice || result.text}\nEarlier changes of this call may have been applied. The current Kata plan is below. Send the list again with your changes applied on top:\n${listTail(result)}`);
			}
		}
		await seam.storage.set(lead.id, "accepted", todos.map(item => item.content));
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
			const session = await seam.sessionOf(context.sessionID);
			if (session?.parentID === undefined) {
				const lead = session && await seam.leadOf(context.sessionID);
				if (!lead) throw new Error("todowrite is for the lead session: a delegate reports its work in its reply, and the lead tracks it.");
				return write(seam, lead, input);
			}
			// A delegate bound to an issue plans under it, through its own core; one that is not bound has no plan, and the lead tracks its work.
			const delegate = await seam.delegateOf(context.sessionID);
			if (!delegate) throw new Error("todowrite is for the lead session: a delegate reports its work in its reply, and the lead tracks it.");
			await delegate.lead.core.delegates.apply({ type: "nextUse", id: delegate.record.id });
			return write(seam, delegate.lead.delegateCore(context.sessionID), input);
		},
	}));
}
