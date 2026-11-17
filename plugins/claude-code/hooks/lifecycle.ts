import { waitAtMost } from '../core/kata-cli'
import type { Hook } from 'claude-code'
import { contextOf, enter, runtime } from './lead'

// Session start, the switches that fire no start, and the end.

// Awaited before the first prompt: binds the session's plan (a resumed session's saved work resumes with it) and prunes.
export const onStart: Hook<'session.start'> = async ($, e, next) => {
  try { await enter($) } catch { /* A slow or unreachable Kata never holds the session. */ }
  return next(e)
}

// /resume, /branch and /clear fire no `session.start`, but this settings event does (unless a managed-settings guard skips
// it: then the next hook finds the new session id, `enter`). A fork shares its source's plan.
export const onSessionSwitch: Hook<'classic.SessionStart'> = async ($, e, next) => {
  try { await enter($, { fork: e.source === 'fork' }) } catch { /* As onStart. */ }
  return next(e)
}

// The whole chain of session.end hooks has 1.5 s. A /clear or /resume goes on in the same process: nothing ends, the next
// `enter` switches. At the end of the process the core's shutdown gets what time is left; what it did not finish stays
// in the saved record, and the session's resume finishes it.
export const onEnd: Hook<'session.end'> = async ($, e, next) => {
  const rt = runtime()
  if (rt?.id && rt.writer && e.reason !== 'clear' && e.reason !== 'resume') {
    try {
      const ctx = contextOf($, rt)
      const remaining = next.budget.remainingMs
      await waitAtMost(rt.core.session.shutdown(ctx), Math.max(200, Math.min(remaining - 300, 1200)), () => undefined, ctx.timers!)
      await rt.writer.end(rt.core.session.owes(), await $.clock.now())
    } catch { /* Whatever was saved stays. */ }
  } else if (rt?.writer) await rt.writer.settled()
  return next(e)
}
