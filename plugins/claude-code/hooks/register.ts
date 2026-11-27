import type { Register } from "claude-code";
import { onEnd, onSessionSwitch, onStart } from "./lifecycle";
import { onCompact, onPrompt, onStop, onTurnComplete } from "./prompt";
import { onTodoCall, onToolCall, onToolList } from "./todo";
import { onDelegateCall, onSpawn } from "./delegates";
import { onLeadShell, onShellCheck } from "./shell";
import { onWriteGuard } from "./write-guard";
import { onTurnStart } from "./inbox";
import { configure } from "./lead";
import { onBand, onKataCommand, onTickets, onTodoCard, onTodoCommand, onTodoUse } from "./ui";

// The hooks module: one line per event. `claude plugin validate` follows `$` through a helper only when the helper is declared at
// the top of its file, so every helper that takes the `$` a hook gets lives there.
export const register: Register = (on, options) => {
	configure(options as Record<string, unknown>);
	on("session.start", onStart);
	on("classic.SessionStart", { source: ["resume", "fork", "clear"] }, onSessionSwitch);
	on("session.end", onEnd);
	// The task tools go out and `todo` comes in; the todo hook answers the lead's call without `next`, so `onToolCall` never sees it.
	on("tool.list", onToolList);
	on("tool.call", { tool: /^todo$/ }, onTodoCall);
	on("tool.call", { agentId: /./ }, onDelegateCall);
	on("tool.call", onToolCall);
	// After `onToolCall`, which calls `next` first and so still sees a refusal. The matcher keeps `claude plugin validate` from
	// refusing a second unmatched `tool.call` hook; these are the tools the guard checks.
	on("tool.call", { tool: /^(Write|Edit|NotebookEdit|Bash)$/ }, onWriteGuard);
	on("tool.call", { tool: "Bash" }, onLeadShell);
	on("tool.check", { tool: "Bash" }, onShellCheck);
	on("agent.spawn", onSpawn);
	on("prompt.submit", onPrompt);
	on("session.compact", onCompact);
	// The lead's loop working or idle decides how a live inbox request is delivered (the end is noted in onTurnComplete).
	on("turn.start", onTurnStart);
	on("turn.complete", onTurnComplete);
	on("classic.Stop", onStop);
	on("ui.render", { component: "AbovePrompt" }, onBand);
	on("ui.render", { component: "ToolUse" }, onTodoUse);
	on("ui.render", { component: "ToolResult" }, onTodoCard);
	on("prompt.autocomplete", { token: /^#/ }, onTickets);
	on("command.run", { command: "todo" }, onTodoCommand);
	on("command.run", { command: "kata" }, onKataCommand);
};
