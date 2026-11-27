# kata-plugin

Plugins that keep an agent session's todo list in the Kata issue tracker, so planned work, delegated work and completion evidence live in Kata rather than in the transcript.

## Sessions and delegates

**Lead**:
The main agent session: it holds the plan and starts delegates.
_Avoid_: main agent, coordinator, parent session

**Delegate**:
An agent the lead starts to do part of the work: an omp `task` subagent, a pi child process, an OpenCode subagent session or a Claude Code `Agent`, Workflow agent or teammate.
_Avoid_: subagent, child, worker

**Assignment**:
The issue a delegate works and the teammate it works it as.
_Avoid_: binding, worker binding (`Binding` is the stored plan parent and workspace pair, not the assignment)

**Untracked delegate**:
A delegate with no assignment, because its task named no plan task it could take and no ticket, or (a pi child) the plugin refused its assignment; the lead tracks its work. When it exits with a report, the plugin records its run as a mission; a refused pi child gets no mission, and its report goes on the tickets or plan items it named only when it named several.

**Mission**:
The issue the plugin makes under the plan parent to record an untracked delegate's run: its task as the body, its report as a comment, closed as audit-no-change because a report proves no change.
_Avoid_: subagent issue, run record

**Hand back**:
Returning an exited delegate's still-open issue to the lead, marked for review.
_Avoid_: settle-back; release (a lead session giving up its own tasks)

**Return**:
Giving a closed issue a delegate still marks back to the lead, with no review: the lead's teammate, the final plan status, the delegate's keys removed.
_Avoid_: retire; release (a lead session giving up its own tasks)

**Holder**:
The lead session that started or blocked an open plan task (`todo.session`); other lead sessions are refused on the task until it releases it, a fork that replaces it inherits it, or one takes it over.
_Avoid_: owner (Kata's owner is an actor)

**Release**:
A lead session giving up the plan tasks it holds when it ends: it shuts down, or switches to another session. A reload does not end it, and a fork that replaces it in the same process inherits its tasks instead. A task whose close is still pending is not released.

**Take over**:
A lead session making itself the holder of a plan task another session holds, on explicit request, with a comment naming both sessions.
_Avoid_: steal, reclaim

**Report**:
A delegate's final word on its work: the text of its last assistant message that has any, or what it yielded. The plugin posts it on the delegate's issue when the delegate left no comment of its own, on its mission when it was untracked, or on the targets a refused pi child named.
_Avoid_: summary, result

## Plans

**Plan**:
A session's todo list, made of plan tasks and ticket items grouped in phases.
_Avoid_: todo plan, task list

**Plan parent**:
The issue a plan's plan tasks are children of.
_Avoid_: session parent, binding

**Automatic parent**:
A plan parent the plugin created for one session; it closes itself once its children are closed with evidence, or as audit-no-change when every child that is not wontfix is a mission (at least one).
_Avoid_: auto parent, session issue

**Explicit parent**:
A plan parent the user or agent chose (`KATA_REF`, an init `ref`, omp's `/todo ref`, a claimed ticket, or an adopted issue); it never closes itself.
_Avoid_: bound parent, claimed parent

**Plan task**:
A plan item that is a child issue of the plan parent.
_Avoid_: todo issue, child task

**Ticket item**:
A plan item that works an existing issue named at its start (`<project>#<short_id>: <action>`).
_Avoid_: named ticket, named item

**Local plan**:
A plan kept only in the session while Kata is unreachable, replayed into Kata when it returns.
_Avoid_: offline plan, session-local plan

## Closing

**Pending close**:
A close Kata refused for now (throttled, or waiting on open children) that the plugin retries.
_Avoid_: deferred close, retry

**Settlement**:
The closes the plugin still owes for a session: its pending closes and its automatic parent's close, with any mission a delegate's settle could not close.
_Avoid_: reconcile, close queue

**Ended session**:
A lead session deleted or archived while it still owes closes or delegate cleanups; it is finished once that work is done, by the instance that holds it or else by the next plugin setup, and its saved state is then forgotten.
_Avoid_: pending end, ended mark

## Repository content

**Ref guard**:
The check that refuses a write, or a `git commit`, `merge`, `tag` or `notes` message, adding a Kata ref the session works, so the model describes the behaviour instead; refs already in the file never count.
_Avoid_: ref filter, ref blocker, ticket-id check

## Inbox

**Session inbox**:
An inbox addressed to `<actor>/<name>`; its requests steer the session that reads it. A delegate has its own, `<actor>/<teammate>`.

**Personal inbox**:
An inbox addressed to a bare `<actor>`, holding requests for a person; no session reads it.
_Avoid_: person's inbox, user inbox

**Trusted request**:
An inbox request whose sender is the session's own actor; only these reach the agent.
