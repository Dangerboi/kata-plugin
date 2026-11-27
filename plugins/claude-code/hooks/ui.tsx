import type { EngineInterface, Hook, MatchedHook } from "claude-code";
import { TODO_COMMANDS, type PlanView } from "../core/kata-core";
import { enter, runtime, type Runtime } from "./lead";
import { cardOf, planOf } from "./plan";
import { KATA_DESCRIPTION, KATA_SUBCOMMANDS, kataCommand, parseKataCommand, USAGE } from "../core/session-status";

// What the lead sees of its Kata plan, as omp shows it: the progress band above the prompt, the checklist card under each
// `todo` call, `#` ticket completion and the /todo command. Render hooks draw from `$.state` (plan.ts) and never run Kata.

type Render<C extends string> = MatchedHook<"ui.render", { readonly component: C }>;

type Task = PlanView["phases"][number]["tasks"][number];
const GLYPHS: Record<Task["status"], string> = { pending: "☐", in_progress: "▶", blocked: "⏸", completed: "✔", abandoned: "✗" };
const closed = (task: Task) => task.status === "completed" || task.status === "abandoned";
const clip = (text: string, width: number) => (text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text);

// A survey holds the band: yield to it.
export const onBand: Render<"AbovePrompt"> = async ($, e, next) => {
	if (e.props.hasSurvey) return next(e);
	const { value: shown } = await planOf($);
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
			<Text bold color={e.props.isErrored ? "error" : undefined}>
				{"Todo "}
			</Text>
			<Text dimColor>{callTitle(e.props.input)}</Text>
		</Box>
	);
};

// An error keeps the engine's row, which reads what the model read.
export const onTodoCard: Render<"ToolResult"> = async ($, e, next) => {
	if (e.props.tool !== "todo" || e.props.isErrored) return next(e);
	const { value: card } = await cardOf($, e.props.tool_use_id);
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

// Typing is never held by Kata: the core's ticket lists answer from its cache, and the wait for a session's first fill runs
// beside the plugins beneath, not after them. An unreachable or failing Kata adds no rows.
async function ticketRows(
	rt: Runtime,
	e: { text: string; cursor: number },
	signal: AbortSignal
): Promise<{ text: string; label: string; description?: string }[]> {
	if (!rt.bound) return [];
	try {
		const line = e.text.slice(0, e.cursor).split("\n").pop() ?? "";
		const found = await rt.core.suggestTickets(line, signal);
		return (found?.items ?? []).map(item => ({ text: `${item.value} `, label: item.value, ...(item.description ? { description: item.description } : {}) }));
	} catch (error) {
		rt.debug(error);
		return [];
	}
}

export const onTickets: Hook<"prompt.autocomplete"> = async ($, e, next) => {
	const rt = runtime();
	const [beneath, ours] = await Promise.all([next(e), rt ? ticketRows(rt, e, next.signal) : []]);
	return ours.length ? { suggestions: [...beneath.suggestions, ...ours] } : beneath;
};

export async function registerTodoCommand($: EngineInterface) {
	try {
		await $.command.register({
			name: "todo",
			description: "Show or change the Kata plan",
			argumentHint: `[${TODO_COMMANDS.join("|")}] [task]`
		});
		await $.command.register({ name: "kata", description: KATA_DESCRIPTION, argumentHint: `[${KATA_SUBCOMMANDS.join("|")}]` });
	} catch (error) {
		runtime()?.debug(error);
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

// /kata status|inbox|refresh, for the person only: the text never reaches the model, and Claude Code has no footer.
export const onKataCommand: Hook<"command.run"> = async ($, e) => {
	// The usage reply does no work at all: no session start or switch, no Kata.
	if (!parseKataCommand(e.args)) return { text: USAGE, isTextDisplayOnly: true };
	try {
		const { rt, ctx } = await enter($);
		// With the mod's contract and live inbox both off, Kata's agent hook reads the inbox into each prompt, unfiltered.
		const nativeInbox = !rt.settings.contract && !rt.settings.liveInbox;
		return { text: await kataCommand(rt.core.session, ctx, e.args, { context: rt.settings.contract, nativeInbox }), isTextDisplayOnly: true };
	} catch (error) {
		return { text: `Kata could not answer /kata: ${error instanceof Error ? error.message : String(error)}`, isTextDisplayOnly: true };
	}
};
