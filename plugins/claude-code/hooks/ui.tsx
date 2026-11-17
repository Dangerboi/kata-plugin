import type { Hook } from "claude-code";
import type { PlanView } from "../core/kata-core";
import type { Engine, Render } from "./engine";
import { enter, runtime, type Runtime } from "./lead";
import { rememberCard } from "./plan";

// What the lead sees of its Kata plan, as omp shows it: the progress band above the prompt, the checklist card under each
// `todo` call, `#` ticket completion and the /todo command. Render hooks draw from `$.state` (plan.ts) and never run Kata.

const plan = { plugin: "kata-cc", key: "plan" } as const;
const cards = { plugin: "kata-cc", key: "cards" } as const;

type Task = PlanView["phases"][number]["tasks"][number];
const GLYPHS: Record<Task["status"], string> = { pending: "☐", in_progress: "▶", blocked: "⏸", completed: "✔", abandoned: "✗" };
const closed = (task: Task) => task.status === "completed" || task.status === "abandoned";
const clip = (text: string, width: number) => (text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text);

// ------------------------------------------------------------------------------------------------------------- the band

// `Kata plan 2/5 · 1 blocked · ▶ active task`, the bar filled by the tasks completed. A survey holds the band: yield to it.
export const onBand: Render<"AbovePrompt"> = async ($, e, next) => {
	if (e.props.hasSurvey) return next(e);
	const { value: shown } = await $.state.get(plan);
	if (!shown) return next(e);
	const { Progress, Text } = $.ui.resolve(e);
	if (shown.error) return <Text dimColor>{clip(`Kata: ${shown.error.split("\n")[0]}`, e.props.bodyColumns)}</Text>;
	const tasks = shown.phases.flatMap(phase => phase.tasks);
	if (tasks.length === 0) return next(e);
	const done = tasks.filter(task => task.status === "completed").length;
	const blocked = tasks.filter(task => task.status === "blocked").length;
	const active = tasks.find(task => task.status === "in_progress");
	const head = `Kata plan ${done}/${tasks.length}${blocked ? ` · ${blocked} blocked` : ""}`;
	const label = active ? `${head} · ▶ ${clip(active.content, Math.max(12, e.props.bodyColumns - head.length - 24))}` : head;
	return <Progress label={label} value={done} max={tasks.length} valueText={`${done} of ${tasks.length}`} />;
};

// ------------------------------------------------------------------------------------------------------------ the card

// `Todo <op> <task|phase> <n items>`, as omp's own todo call reads.
function callTitle(input: unknown): string {
	const args = (input ?? {}) as { op?: unknown; task?: unknown; phase?: unknown; items?: unknown; list?: unknown };
	const parts = [typeof args.op === "string" ? args.op : "update"];
	for (const name of [args.task, args.phase]) if (typeof name === "string" && name) parts.push(name);
	const items = Array.isArray(args.list)
		? args.list.reduce((n: number, phase: { items?: unknown[] }) => n + (Array.isArray(phase?.items) ? phase.items.length : 0), 0)
		: Array.isArray(args.items)
			? args.items.length
			: 0;
	if (items) parts.push(`${items} item${items === 1 ? "" : "s"}`);
	return parts.join(" ");
}

export const onTodoUse: Render<"ToolUse"> = async ($, e, next) => {
	if (e.props.tool !== "todo") return next(e);
	const { Box, Text } = $.ui.resolve(e);
	return (
		<Box>
			<Text bold color={e.props.isErrored ? "error" : undefined}>{"Todo "}</Text>
			<Text dimColor>{callTitle(e.props.input)}</Text>
		</Box>
	);
};

// The checklist: `Todo closed/total` and the plan's parent, then each task with its Kata ref and, for a paused one, its
// blocker. An error keeps the engine's row, which reads what the model read.
export const onTodoCard: Render<"ToolResult"> = async ($, e, next) => {
	if (e.props.tool !== "todo" || e.props.isErrored) return next(e);
	const { value: card } = await $.state.get({ ...cards, id: e.props.tool_use_id });
	const view = card?.view;
	if (!view) return next(e);
	const { Box, Text } = $.ui.resolve(e);
	const phases = view.phases.filter(phase => phase.tasks.length > 0);
	const tasks = phases.flatMap(phase => phase.tasks);
	return (
		<Box flexDirection="column">
			<Box>
				<Text bold>
					Todo {tasks.filter(closed).length}/{tasks.length}{" "}
				</Text>
				<Text dimColor>{view.local ? "session-local" : (view.parent ?? "tickets")}</Text>
			</Box>
			{card?.notice && <Text color="warning">{card.notice}</Text>}
			{phases.map((phase, p) => (
				<Box key={`p${p}`} flexDirection="column">
					{phases.length > 1 && <Text dimColor>{phase.name}</Text>}
					{phase.tasks.map((task, t) => (
						<Box key={`p${p}.${t}`} flexDirection="column">
							<Box>
								<Text
									color={task.status === "completed" ? "success" : task.status === "blocked" ? "warning" : task.status === "in_progress" ? "claude" : undefined}
									dimColor={task.status === "pending" || task.status === "abandoned"}
								>
									{GLYPHS[task.status]}{" "}
								</Text>
								<Text dimColor={closed(task)} strikethrough={task.status === "abandoned"}>
									{task.content}
								</Text>
								<Text dimColor> {task.ref}</Text>
							</Box>
							{task.blocker && <Text color="warning"> ↳ {task.blocker}</Text>}
						</Box>
					))}
				</Box>
			))}
		</Box>
	);
};

// A `todo` call that ran: its card is kept for the transcript's result row. Registered before the hook that answers the call.
// A subagent's call answers from the core of its own issue: its card would show the lead's plan, so it has none.
export const onTodoRan: Hook<"tool.call"> = async ($, e, next) => {
	if (e.agentId !== undefined) return next(e);
	const ran = await next(e);
	try {
		await rememberCard($, String(e.tool_use_id), ran);
	} catch {
		/* The row falls back to the model's text. */
	}
	return ran;
};

// ------------------------------------------------------------------------------------------------------------ `#` tickets

// The core's ticket completion offers itself to an editor's provider chain; here the chain is empty, so what it returns is the
// tickets alone, and the typeahead's rows are those. Its cache, its 400 ms wait and its rules for tokens (a digits-only `#1234`
// is GitHub's, `#<project>#<token>` names a project) are the core's, shared with omp.
type Provider = {
	getSuggestions(lines: string[], line: number, col: number, signal?: AbortSignal): Promise<{ items: { value: string; description?: string }[] } | null>;
};
const providers = new WeakMap<Runtime, Provider>();

function providerOf(rt: Runtime): Provider {
	let provider = providers.get(rt);
	if (!provider) {
		let wrap: ((current: unknown) => Provider) | undefined;
		rt.core.offerTickets({
			addAutocompleteProvider: factory => {
				wrap = factory as typeof wrap;
			}
		});
		provider = wrap!({
			getSuggestions: async () => null,
			applyCompletion: (lines: string[], cursorLine: number, cursorCol: number) => ({ lines, cursorLine, cursorCol })
		});
		providers.set(rt, provider);
	}
	return provider;
}

// Typing is never held by Kata: a loaded list answers from the core's cache whatever Kata is doing (it refreshes in the
// background), and only the first fill of a session's list waits, for the core's 400 ms at most. The wait runs beside the
// plugins beneath, not after them, and an unreachable or failing Kata adds no rows.
async function ticketRows(
	rt: Runtime,
	e: { text: string; cursor: number },
	signal: AbortSignal
): Promise<{ text: string; label: string; description?: string }[]> {
	if (!rt.writer || rt.id === undefined) return [];
	try {
		const line = e.text.slice(0, e.cursor).split("\n").pop() ?? "";
		const found = await providerOf(rt).getSuggestions([line], 0, line.length, signal);
		return (found?.items ?? []).map(item => ({ text: `${item.value} `, label: item.value, ...(item.description ? { description: item.description } : {}) }));
	} catch {
		return [];
	}
}

export const onTickets: Hook<"prompt.autocomplete"> = async ($, e, next) => {
	const rt = runtime();
	const [beneath, ours] = await Promise.all([next(e), rt ? ticketRows(rt, e, next.signal) : []]);
	return ours.length ? { suggestions: [...beneath.suggestions, ...ours] } : beneath;
};

// ------------------------------------------------------------------------------------------------------------- /todo

export async function registerTodoCommand($: Engine) {
	try {
		await $.command.register({
			name: "todo",
			description: "Show or change the Kata plan",
			argumentHint: "[start|done|drop|rm|append|block|unblock|takeover] [task]"
		});
	} catch {
		/* The model's todo tool still works. */
	}
}

// The omp subcommands, answered by the core: the plan with no subcommand, takeover included. The text is for the person; the
// plan the model reads is sent with the next prompt once it changed.
export const onTodoCommand: Hook<"command.run"> = async ($, e) => {
	try {
		const { rt, ctx } = await enter($);
		return { text: await rt.core.todo.command(ctx, e.args), isTextDisplayOnly: true };
	} catch (error) {
		return { text: `Kata todo could not run: ${error instanceof Error ? error.message : String(error)}`, isTextDisplayOnly: true };
	}
};
