// The plan as omp's own todo looks in a Tern Surface Protocol (TSP) terminal such as Tern: the todo result as a
// checklist card, and the progress widget as the dock pill whose popover lists the plan. Terminals without TSP
// keep the plugin's text result and widget line. Nodes are TSP wire objects (`k` kind, `p` props, `key`), built
// here without omp's builders, which extensions cannot import.
import type { PlanView } from "./kata-core";

type Task = PlanView["phases"][number]["tasks"][number];
type Text = string | { t: string; s?: string }[];
type Node = { k: string; p?: Record<string, unknown>; c?: Node[]; key?: string };

const CHECKLIST: Record<Task["status"], string> = { pending: "pending", in_progress: "active", completed: "done", abandoned: "dropped", blocked: "blocked" };
const closed = (task: Task) => task.status === "completed" || task.status === "abandoned";
const ROMAN: [number, string][] = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
function roman(n: number): string {
	let out = "";
	for (const [value, digits] of ROMAN) for (; n >= value; n -= value) out += digits;
	return out;
}
const textNode = (text: string, tone?: string): Node => ({ k: "text", p: tone ? { spans: [{ t: text, s: tone }], wrap: "word" } : { text, wrap: "word" } });

// The card shows each task's Kata ref after it, muted. The HUD pill labels itself with the active task's text, so its
// items stay plain, as omp's own HUD does.
const itemText = (task: Task, mode: "full" | "hud"): Text => mode === "hud" ? task.content : [{ t: task.content }, { t: `  ${task.ref}`, s: "muted" }];

// `hud` numbers the phases of a multi-phase plan as omp's HUD does; the card names them plainly.
function checklist(view: PlanView, mode: "full" | "hud"): Node {
	const phases = view.phases.filter(phase => phase.tasks.length > 0);
	const numbered = mode === "hud" && phases.length > 1;
	return {
		k: "checklist", key: "checklist",
		p: {
			mode, ...(mode === "hud" ? { role: "omp.hud.todo" } : {}),
			phases: phases.map((phase, p) => ({
				id: `p${p}`,
				title: numbered ? `${roman(p + 1)}. ${phase.name}` : phase.name,
				...(phase.tasks.every(closed) ? { collapsed: true } : {}),
				items: phase.tasks.map((task, t) => ({ id: `p${p}.${t}`, text: itemText(task, mode), status: CHECKLIST[task.status], ...(task.blocker ? { note: task.blocker } : {}) })),
			})),
		},
	};
}

const tasksOf = (view: PlanView) => view.phases.flatMap(phase => phase.tasks);
const where = (view: PlanView) => view.local ? "session-local" : view.parent ?? "tickets";

// While the call runs: `Todo <op> <task|phase> <n items>`, as omp's own todo call reads.
export function describeTodoCall(args: { op?: unknown; task?: unknown; phase?: unknown; items?: unknown; list?: unknown } | undefined) {
	const parts = [typeof args?.op === "string" ? args.op : "update"];
	for (const name of [args?.task, args?.phase]) if (typeof name === "string" && name) parts.push(name);
	const items = Array.isArray(args?.list) ? args.list.reduce((n: number, phase: any) => n + (Array.isArray(phase?.items) ? phase.items.length : 0), 0) : Array.isArray(args?.items) ? args.items.length : 0;
	if (items) parts.push(`${items} item${items === 1 ? "" : "s"}`);
	return { tool: { title: "Todo", target: parts.join(" "), targetKind: "text" } };
}

// omp's todo card, from a todo result: `Todo closed/total` with the plan's parent, then the checklist. Text before
// the plan (an error, a pending close, a deleted parent) goes above it; a result with no tasks shows its text.
const views = new WeakMap<object, object>();
export function describeTodoResult(result: { content?: { type: string; text?: string }[]; details?: any; isError?: boolean }) {
	const key = result.details ?? result;
	const known = views.get(key);
	if (known) return known;
	const view: PlanView | undefined = result.details?.kata?.phases ? result.details.kata : undefined;
	const tasks = view ? tasksOf(view) : [];
	const text = (result.content ?? []).filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
	const tone = result.isError ? "error" : "muted";
	let described: object;
	if (!view || tasks.length === 0) {
		described = { tool: { title: "Todo" }, ...(result.isError ? { tone: "error" } : {}), body: [textNode(text || "No todos", tone)] };
	} else {
		const notice: string | undefined = result.details.kata.notice;
		described = {
			tool: { title: "Todo", target: `${tasks.filter(closed).length}/${tasks.length}`, targetKind: "text", meta: [where(view)] },
			...(result.isError ? { tone: "error" } : {}),
			body: [...(notice ? [textNode(notice, tone)] : []), checklist(view, "full")],
			preview: "none",
			open: true,
		};
	}
	views.set(key, described);
	return described;
}

// The progress widget: in a TSP terminal that draws checklists, the dock pill and popover omp's own todo HUD
// uses; elsewhere the summary line, as omp's Text component draws a string widget.
export function todoWidget(TextComponent: (new (text: string, paddingX: number, paddingY: number) => any) | undefined, line: string, view: PlanView): unknown {
	if (!TextComponent) return [line];
	const hud = checklist(view, "hud");
	return () => {
		const component = new TextComponent(line, 1, 0);
		component.describe = (cx: { supports?(kind: string): boolean } | undefined) => cx?.supports?.("checklist") ? hud : null;
		return component;
	};
}
