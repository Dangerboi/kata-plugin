import type { Register } from 'claude-code'
import { onEnd, onSessionSwitch, onStart } from './lifecycle'
import { onCompact, onPrompt, onStop, onTurnComplete } from './prompt'
import { onTodoCall, onToolCall, onToolList } from './todo'
import { onTurnStart } from './inbox'
import { configure } from './lead'
import { onBand, onTickets, onTodoCard, onTodoCommand, onTodoRan, onTodoUse } from './ui'

// The hooks module: one line per event. Each feature is a module that exports its handlers; a later one
// (delegates.ts, ui.tsx, inbox.ts) adds its own lines here and nothing else changes.
export const register: Register = (on, options) => {
  configure(options as Record<string, unknown>)
  // Session
  on('session.start', onStart)
  on('classic.SessionStart', { source: ['resume', 'fork', 'clear'] }, onSessionSwitch)
  on('session.end', onEnd)
  // The todo tool: task tools out, `todo` in; the lead's call is answered here. Order matters: the todo hook answers
  // without `next`, so the observer below never sees it.
  on('tool.list', onToolList)
  on('tool.call', { tool: /^(todo)$/ }, onTodoRan)
  on('tool.call', { tool: /^todo$/ }, onTodoCall)
  on('tool.call', onToolCall)
  // Prompt context and the end of a turn
  on('prompt.submit', onPrompt)
  on('session.compact', onCompact)
  // Live inbox: whether the lead's loop is working decides how a request is delivered (the end is noted in onTurnComplete).
  on('turn.start', onTurnStart)
  on('turn.complete', onTurnComplete)
  on('classic.Stop', onStop)
  // The Claude UI: the plan band, the todo card, `#` tickets and /todo.
  on('ui.render', { component: 'AbovePrompt' }, onBand)
  on('ui.render', { component: 'ToolUse' }, onTodoUse)
  on('ui.render', { component: 'ToolResult' }, onTodoCard)
  on('prompt.autocomplete', { token: /^#/ }, onTickets)
  on('command.run', { command: 'todo' }, onTodoCommand)
}
