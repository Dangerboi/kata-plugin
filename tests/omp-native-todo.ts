/**
 * A faithful port of omp 19.1.1's native `todo` tool, for the fake omp host. Source: oh-my-pi at 31ffee513f,
 * `packages/coding-agent/src/tools/todo.ts` ("todo.ts") and `packages/tui/src/tools/todo.ts` ("tui todo.ts").
 * Only the tool's own semantics live here (params, ops, normalization, errors, result); the host ordering around it
 * (tool_call, replace, tool_result) is in `omp-host.ts`. Where omp validates with arktype, the messages here are
 * close but not identical; no test should depend on the schema summary beyond the `Invalid todo arguments:` prefix.
 */

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned";
export type TodoItem = { content: string; status: TodoStatus };
export type TodoPhase = { name: string; tasks: TodoItem[] };
export type TodoOperation = "init" | "start" | "done" | "rm" | "drop" | "append" | "view";
export interface TodoParams {
  op: TodoOperation;
  list?: { phase: string; items: string[] }[];
  task?: string | string[];
  phase?: string;
  items?: string[];
  [key: string]: unknown;
}
export interface TodoCompletionTransition { phase: string; content: string }
export interface TodoResult {
  content: { type: "text"; text: string }[];
  details: { op?: TodoOperation; phases?: TodoPhase[]; storage?: "session" | "memory"; completedTasks?: TodoCompletionTransition[] };
  isError?: true;
}
/** The outcome of one native call: the tool result, and the list the call committed (undefined for errors and `view`). */
export interface TodoOutcome { result: TodoResult; committed?: TodoPhase[] }

const OPS: readonly string[] = ["init", "start", "done", "rm", "drop", "append", "view"];
const DEFAULT_INIT_PHASE = "Tasks"; // todo.ts, initPhases

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");

// tui todo.ts, `splitTaskList`: delimiters tried in order on a `task` string that names no task verbatim.
const TASK_LIST_DELIMITERS: readonly { pattern: RegExp; partial: boolean }[] = [
  { pattern: /\r?\n/, partial: true },
  { pattern: /;/, partial: true },
  { pattern: /,/, partial: true },
  { pattern: /\s+/, partial: false },
  { pattern: /[\s,;]+/, partial: false },
];
const QUOTED_TASK_RE = /^(["'`])(.*)\1$/s;
function normalizeTaskPart(part: string): string {
  const trimmed = part.trim();
  return QUOTED_TASK_RE.exec(trimmed)?.[2].trim() ?? trimmed;
}
function splitTaskList(content: string, known: ReadonlySet<string>): string[] {
  if (known.has(content)) return [content];
  let partial: string[] | undefined;
  for (const delimiter of TASK_LIST_DELIMITERS) {
    const parts = content.split(delimiter.pattern).map(normalizeTaskPart).filter(part => part.length > 0);
    const named = parts.filter(part => known.has(part)).length;
    if (named > 0 && named === parts.length) return parts;
    if (!partial && delimiter.partial && named > 0 && parts.length > 1) partial = parts;
  }
  return partial ?? [content];
}
/** The task contents a `task` arg targets (tui todo.ts, `todoTaskTargets`): a verbatim name is one target, a flattened list splits; absent, `""` and `[]` target none. */
export function todoTaskTargets(phases: readonly TodoPhase[], task: string | readonly string[] | undefined): string[] {
  if (task === undefined || task === "") return [];
  const known = new Set(phases.flatMap(phase => phase.tasks.map(item => item.content)));
  return (typeof task === "string" ? [task] : task).flatMap(content => splitTaskList(content, known));
}

// todo.ts, `findTaskByContent`, `findPhaseByName`, `getCompletionTransitions`
const findTaskByContent = (phases: TodoPhase[], content: string) => {
  for (const phase of phases) {
    const task = phase.tasks.find(t => t.content === content);
    if (task) return { task, phase };
  }
  return undefined;
};
const findPhaseByName = (phases: TodoPhase[], name: string) => phases.find(phase => phase.name === name);
export const clonePhases = (phases: readonly TodoPhase[]): TodoPhase[] => phases.map(phase => ({ name: phase.name, tasks: phase.tasks.map(task => ({ content: task.content, status: task.status })) }));
const transitionKey = (phase: string, content: string) => `${phase}\u0000${content}`;
function getCompletionTransitions(previous: TodoPhase[], updated: TodoPhase[]): TodoCompletionTransition[] {
  const previousStatuses = new Map<string, TodoStatus>();
  for (const phase of previous) for (const task of phase.tasks) previousStatuses.set(transitionKey(phase.name, task.content), task.status);
  const transitions: TodoCompletionTransition[] = [];
  for (const phase of updated) for (const task of phase.tasks) {
    if (task.status !== "completed") continue;
    const before = previousStatuses.get(transitionKey(phase.name, task.content));
    if (before && before !== "completed") transitions.push({ phase: phase.name, content: task.content });
  }
  return transitions;
}

/** todo.ts, `normalizeInProgressTask`: the first in_progress task stays and later ones go back to pending; with none, the first pending task starts. */
export function normalizeInProgressTask(phases: TodoPhase[]): void {
  const ordered = phases.flatMap(phase => phase.tasks);
  if (ordered.length === 0) return;
  const inProgress = ordered.filter(task => task.status === "in_progress");
  for (const task of inProgress.slice(1)) task.status = "pending";
  if (inProgress.length > 0) return;
  const firstPending = ordered.find(task => task.status === "pending");
  if (firstPending) firstPending.status = "in_progress";
}
/** todo.ts, `nextActionableTask` */
function nextActionableTask(phases: readonly TodoPhase[]): TodoItem | undefined {
  let firstPending: TodoItem | undefined;
  for (const phase of phases) for (const task of phase.tasks) {
    if (task.status === "in_progress") return task;
    if (!firstPending && task.status === "pending") firstPending = task;
  }
  return firstPending;
}

// todo.ts, `resolveTaskOrError`, `resolveTasksOrError`, `resolvePhaseOrError`
function resolveTaskOrError(phases: TodoPhase[], content: string | undefined, errors: string[]) {
  if (!content) { errors.push("Missing task content"); return undefined; }
  const hit = findTaskByContent(phases, content);
  if (!hit) {
    if (/^task-\d+$/.test(content)) {
      errors.push(`Task "${content}" not found. Tasks are referenced by content, not by IDs — pass the task's full text from the previous result.`);
    } else {
      const total = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
      errors.push(`Task "${content}" not found${total === 0 ? " (todo list is empty — was it replaced or not yet created?)" : ""}`);
    }
  }
  return hit;
}
function resolveTasksOrError(phases: TodoPhase[], contents: string[], errors: string[]) {
  const hits: { task: TodoItem; phase: TodoPhase }[] = [];
  for (const content of contents) { const hit = resolveTaskOrError(phases, content, errors); if (hit) hits.push(hit); }
  return hits;
}
function resolvePhaseOrError(phases: TodoPhase[], name: string | undefined, errors: string[]): TodoPhase | undefined {
  if (!name) { errors.push("Missing phase name"); return undefined; }
  const phase = findPhaseByName(phases, name);
  if (!phase) errors.push(`Phase "${name}" not found`);
  return phase;
}
/** done/drop/rm targets: `task`, else `items` (todo.ts, `getTaskTargets`). */
const namedTaskContents = (phases: TodoPhase[], entry: TodoParams): string[] => {
  const contents = todoTaskTargets(phases, entry.task);
  return contents.length > 0 ? contents : (entry.items ?? []);
};
function getTaskTargets(phases: TodoPhase[], entry: TodoParams, errors: string[]): TodoItem[] {
  const contents = namedTaskContents(phases, entry);
  if (contents.length > 0) return resolveTasksOrError(phases, contents, errors).map(hit => hit.task);
  if (entry.phase) {
    const phase = resolvePhaseOrError(phases, entry.phase, errors);
    return phase ? [...phase.tasks] : [];
  }
  errors.push(`${entry.op} needs a task, items or a phase`);
  return [];
}

// todo.ts, `initPhases`: a non-empty `list` wins over flat `items` (+ `phase`); an empty phase name becomes "Tasks".
function initPhases(entry: TodoParams, errors: string[]): TodoPhase[] {
  const flat = entry.items && entry.items.length > 0 ? [{ phase: entry.phase as string, items: entry.items }] : undefined;
  const list = entry.list?.length ? entry.list : (flat ?? entry.list);
  if (!list) { errors.push("Missing list for init operation"); return []; }
  const phases: TodoPhase[] = [], seenPhases = new Set<string>(), seenTasks = new Set<string>();
  for (const listEntry of list) {
    const name = listEntry.phase || DEFAULT_INIT_PHASE;
    if (seenPhases.has(name)) errors.push(`Duplicate phase "${name}" in init list`);
    seenPhases.add(name);
    const tasks: TodoItem[] = [];
    for (const content of listEntry.items) {
      if (seenTasks.has(content)) errors.push(`Duplicate task "${content}" in init list`);
      seenTasks.add(content);
      tasks.push({ content, status: "pending" });
    }
    phases.push({ name, tasks });
  }
  return phases;
}

// todo.ts, `appendItems`: an existing item anywhere is an error; without `phase`, items go to the phase of the in-progress task, else the first pending task, else the last phase, else "Tasks".
function appendItems(phases: TodoPhase[], entry: TodoParams, errors: string[]): TodoPhase[] {
  if (entry.phase === "") { errors.push("Missing phase name for append operation"); return phases; }
  if (!entry.items || entry.items.length === 0) { errors.push("Missing items for append operation"); return phases; }
  const seen = new Set<string>();
  let hasDuplicate = false;
  for (const content of entry.items) {
    if (seen.has(content) || findTaskByContent(phases, content)) { errors.push(`Task "${content}" already exists`); hasDuplicate = true; }
    seen.add(content);
  }
  if (hasDuplicate) return phases;
  const active = entry.phase === undefined ? nextActionableTask(phases) : undefined;
  const name = entry.phase ?? (active ? phases.find(phase => phase.tasks.includes(active))?.name : phases.at(-1)?.name) ?? DEFAULT_INIT_PHASE;
  let phase = findPhaseByName(phases, name);
  if (!phase) { phase = { name, tasks: [] }; phases.push(phase); }
  for (const content of entry.items) phase.tasks.push({ content, status: "pending" });
  return phases;
}

// todo.ts, `removeTasks`: rm removes the targets; with only `phase` it empties that phase.
function removeTasks(phases: TodoPhase[], entry: TodoParams, errors: string[]): TodoPhase[] {
  const contents = namedTaskContents(phases, entry);
  if (contents.length > 0) {
    for (const hit of resolveTasksOrError(phases, contents, errors)) hit.phase.tasks = hit.phase.tasks.filter(candidate => candidate !== hit.task);
    return phases;
  }
  if (entry.phase) {
    const phase = resolvePhaseOrError(phases, entry.phase, errors);
    if (phase) phase.tasks = [];
    return phases;
  }
  errors.push("rm needs a task, items or a phase");
  return phases;
}

// todo.ts, `applyEntry`
function applyEntry(phases: TodoPhase[], entry: TodoParams, errors: string[]): TodoPhase[] {
  switch (entry.op) {
    case "init": return initPhases(entry, errors);
    case "start": {
      const contents = todoTaskTargets(phases, entry.task);
      if (contents.length > 1) { errors.push("start takes a single task: only one task can be in progress"); return phases; }
      const hit = resolveTaskOrError(phases, contents[0], errors);
      if (!hit) return phases;
      for (const phase of phases) for (const candidate of phase.tasks) if (candidate.status === "in_progress" && candidate !== hit.task) candidate.status = "pending";
      hit.task.status = "in_progress";
      return phases;
    }
    case "done": for (const task of getTaskTargets(phases, entry, errors)) task.status = "completed"; return phases;
    case "drop": for (const task of getTaskTargets(phases, entry, errors)) task.status = "abandoned"; return phases;
    case "rm": return removeTasks(phases, entry, errors);
    case "append": return appendItems(phases, entry, errors);
    case "view": return phases;
  }
}

/** todo.ts, `inferTodoOp`: only unambiguous shapes infer a missing `op`. */
function inferTodoOp(args: Record<string, unknown>, hasExistingPhases: boolean): TodoOperation | undefined {
  if (Array.isArray(args.list) && args.list.length > 0) return "init";
  if (Array.isArray(args.items) && args.items.length > 0) {
    if (typeof args.phase === "string" && args.phase) return "append";
    if (!hasExistingPhases) return "init";
  }
  return undefined;
}

/** What the arktype schema (todo.ts, `todoSchema`) rejects: a summary per problem, none when `raw` is valid. */
function schemaProblems(raw: unknown): string[] {
  if (!isRecord(raw)) return [`must be an object (was ${raw === null ? "null" : typeof raw})`];
  const problems: string[] = [];
  if (typeof raw.op !== "string" || !OPS.includes(raw.op)) problems.push(raw.op === undefined ? "op must be present" : `op must be "init" | "start" | "done" | "rm" | "drop" | "append" | "view" (was ${JSON.stringify(raw.op)})`);
  if (raw.list !== undefined) {
    if (!Array.isArray(raw.list)) problems.push("list must be an array");
    else raw.list.forEach((entry, i) => {
      if (!isRecord(entry)) return problems.push(`list[${i}] must be an object`);
      if (typeof entry.phase !== "string") problems.push(`list[${i}].phase must be a string`);
      if (!isStrings(entry.items)) problems.push(`list[${i}].items must be an array of strings`);
      else if (entry.items.length < 1) problems.push(`list[${i}].items must be non-empty`);
    });
  }
  if (raw.task !== undefined && typeof raw.task !== "string" && !isStrings(raw.task)) problems.push("task must be a string or an array of strings");
  if (raw.phase !== undefined && typeof raw.phase !== "string") problems.push("phase must be a string");
  // No minimum length for `items`: init and append enforce it with their own errors (todo.ts schema).
  if (raw.items !== undefined && !isStrings(raw.items)) problems.push("items must be an array of strings");
  return problems;
}

/** todo.ts, `resolveTodoParams`: validate, repairing an omitted `op` next to an unambiguous payload; else the schema error text. Unknown keys stay. */
export function resolveTodoParams(raw: unknown, hasExistingPhases: boolean): TodoParams | string {
  const problems = schemaProblems(raw);
  if (problems.length === 0) return raw as TodoParams;
  if (isRecord(raw) && raw.op === undefined) {
    const inferred = inferTodoOp(raw, hasExistingPhases);
    if (inferred && schemaProblems({ ...raw, op: inferred }).length === 0) return { ...raw, op: inferred } as TodoParams;
  }
  return `Invalid todo arguments: ${problems.join("\n")}`;
}

/** todo.ts, `applyParams`: the op, then normalization (also on a failing call, whose result is discarded). */
export function applyParams(phases: TodoPhase[], params: TodoParams): { phases: TodoPhase[]; errors: string[] } {
  const errors: string[] = [];
  const next = applyEntry(phases, params, errors);
  normalizeInProgressTask(next);
  return { phases: next, errors };
}

/** todo.ts, `formatSummary` */
function formatSummary(phases: TodoPhase[], errors: string[], readOnly = false): string {
  const tasks = phases.flatMap(phase => phase.tasks);
  if (tasks.length === 0) {
    if (errors.length > 0) return `Errors: ${errors.join("; ")}`;
    return readOnly ? "Todo list is empty." : "Todo list cleared.";
  }
  const remaining = phases
    .map(phase => ({ name: phase.name, tasks: phase.tasks.filter(task => task.status === "pending" || task.status === "in_progress") }))
    .filter(phase => phase.tasks.length > 0)
    .flatMap(phase => phase.tasks.map(task => ({ ...task, phase: phase.name })));
  let currentIdx = phases.findIndex(phase => phase.tasks.some(task => task.status === "in_progress"));
  if (currentIdx === -1) currentIdx = phases.findIndex(phase => phase.tasks.some(task => task.status === "pending"));
  if (currentIdx === -1) currentIdx = phases.length - 1;
  const current = phases[currentIdx];
  const closed = (task: TodoItem) => task.status === "completed" || task.status === "abandoned";
  const done = current.tasks.filter(closed).length;
  const lines: string[] = [];
  if (errors.length > 0) lines.push(`Errors: ${errors.join("; ")}`);
  if (remaining.length === 0) lines.push("Remaining items: none.");
  else {
    lines.push(`Remaining items (${remaining.length}):`);
    for (const task of remaining) lines.push(`  - ${task.content} [${task.status}] (${task.phase})`);
  }
  const closedAll = tasks.filter(closed).length;
  const workedAhead = phases.some((phase, idx) => idx > currentIdx && phase.tasks.some(closed));
  lines.push(`Overall: ${closedAll}/${tasks.length} done, ${remaining.length} open.`);
  lines.push(`Active phase ${currentIdx + 1}/${phases.length} "${current.name}" (${done}/${current.tasks.length})${workedAhead
    ? " — the in-progress pointer auto-advances to the earliest open task on each completion, so it can sit behind out-of-order work (nothing was un-completed)."
    : "."}`);
  for (const phase of phases) {
    lines.push(`  ${phase.name}:`);
    for (const task of phase.tasks) {
      const tag = task.status === "in_progress" ? " (in progress)" : task.status === "abandoned" ? " (dropped)" : "";
      lines.push(`    - ${task.status === "completed" ? "[X]" : "[ ]"} ${task.content}${tag}`);
    }
  }
  return lines.join("\n");
}

/**
 * One native `todo` call against `previous` (todo.ts, `TodoTool.execute`). A schema failure, any op error, or a
 * `view` leaves the list as it was; an error discards the whole call. `details` is `{ op, phases, storage, completedTasks? }`
 * (a schema failure has no `op`); the error result carries `isError: true`.
 */
export function executeTodo(previous: readonly TodoPhase[], raw: unknown, storage: "session" | "memory"): TodoOutcome {
  const before = clonePhases(previous);
  const resolved = resolveTodoParams(raw, before.length > 0);
  if (typeof resolved === "string") return { result: { content: [{ type: "text", text: resolved }], details: { phases: before, storage }, isError: true } };
  const readOnly = resolved.op === "view";
  const { phases: updated, errors } = readOnly ? { phases: before, errors: [] as string[] } : applyParams(clonePhases(before), resolved);
  const failed = errors.length > 0;
  const effective = failed ? before : updated;
  const completedTasks = readOnly || failed ? [] : getCompletionTransitions(before, updated);
  const details: TodoResult["details"] = { op: resolved.op, phases: effective, storage };
  if (completedTasks.length > 0) details.completedTasks = completedTasks;
  return {
    result: { content: [{ type: "text", text: formatSummary(effective, errors, readOnly) }], details, ...errors.length > 0 && { isError: true as const } },
    committed: readOnly || failed ? undefined : updated,
  };
}
