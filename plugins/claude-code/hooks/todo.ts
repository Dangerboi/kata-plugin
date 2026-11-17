import type { EngineInterface, Hook } from "claude-code";
import { DESCRIPTION, TODO_OPS, TODO_PARAMS, todoText } from "../core/kata-core";
import { NO_JOB } from "../core/kata-cli";
import { delegateTodo } from "./delegates";
import { contextOf, enter, runtime } from "./lead";
import { rememberCard } from "./plan";

// The task tools Claude Code offers are replaced by one Kata-backed `todo`. TaskStop stays: it stops background tasks.
const REPLACED = new Set(["TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "TodoWrite"]);

const TODO_TOOL = {
	name: "todo",
	description: DESCRIPTION,
	mcp: false,
	inputSchema: {
		type: "object",
		properties: {
			op: { type: "string", enum: [...TODO_OPS] },
			list: {
				type: "array",
				description: TODO_PARAMS.list,
				items: {
					type: "object",
					properties: { phase: { type: "string" }, items: { type: "array", items: { type: "string" }, minItems: 1 } },
					required: ["phase", "items"]
				}
			},
			task: { type: "string", description: TODO_PARAMS.task },
			phase: { type: "string" },
			items: { type: "array", items: { type: "string" }, description: TODO_PARAMS.items },
			reason: { type: "string", description: TODO_PARAMS.reason },
			ref: { type: "string", description: TODO_PARAMS.ref },
			replace: { type: "boolean", description: TODO_PARAMS.replace },
			takeover: { type: "boolean", description: TODO_PARAMS.takeover },
			message: { type: "string", description: TODO_PARAMS.message },
			evidence: { type: "array", items: { type: "string" }, description: TODO_PARAMS.evidence }
		},
		required: ["op"]
	}
};

export const onToolList: Hook<"tool.list"> = async ($, e, next) => {
	const listed = await next(e);
	if (listed.value === undefined) return listed;
	return { value: [...listed.value.filter(tool => !REPLACED.has(tool.name) && tool.name !== TODO_TOOL.name), TODO_TOOL] };
};

const failure = (text: string) => ({ isError: true as const, result: text });

// `todo` is answered here, with no permission prompt: the call runs the core and its text is the result. A result that is not an
// error also leaves its checklist card, which the transcript's result row draws.
export async function onTodoCall($: EngineInterface, e: Record<string, unknown> & { agentId?: string }) {
	const {
		tool: _tool,
		tool_use_id: callId,
		agentId,
		requestMeta: _meta,
		...params
	} = e as Record<string, unknown> & { agentId?: string; tool_use_id?: string };
	const op = String(params.op);
	// A subagent shares the tool pool but not the lead's plan: its call reaches the core of its own issue.
	if (agentId !== undefined) {
		const out = await delegateTodo($, agentId, op, params);
		return out.isError ? failure(out.text) : { result: out.text };
	}
	try {
		const { rt, ctx } = await enter($);
		const out = await rt.core.todo.apply(ctx, op, params, NO_JOB);
		await rt.core.tools.result(ctx, { toolName: "todo", isError: out.isError === true });
		const text = todoText(out);
		if (out.isError === true) return failure(text);
		await rememberCard($, String(callId), text, out.details.kata).catch(rt.debug);
		return { result: text };
	} catch (error) {
		return failure(`Kata todo could not run: ${error instanceof Error ? error.message : String(error)}`);
	}
}

// Every other tool call: once it has run, the core learns of it (progress for the stop reminder, a `kata claim` that adopts its issue).
export const onToolCall: Hook<"tool.call"> = async ($, e, next) => {
	const done = await next(e);
	const rt = runtime();
	const latest = rt?.latest;
	// A subagent's calls are its own: they never adopt an issue as the lead's plan parent or count as the lead's progress.
	if (!rt?.bound || !latest || e.agentId !== undefined) return done;
	try {
		await rt.core.tools.result(contextOf($, rt, latest.held), {
			toolName: String(e.tool).toLowerCase(),
			isError: done?.isError === true || done?.deny !== undefined,
			input: e
		});
	} catch (error) {
		rt.debug(error);
	}
	return done;
};
