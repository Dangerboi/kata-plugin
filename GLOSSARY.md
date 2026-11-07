# kata-plugin

Plugins that keep an agent session's todo list in the Kata issue tracker, so planned work, delegated work and completion evidence live in Kata rather than in the transcript.

## Sessions and delegates

**Lead**:
The main agent session: it holds the plan and starts delegates.
_Avoid_: main agent, coordinator, parent session

**Delegate**:
An agent the lead starts to do part of the work: an omp `task` subagent or a pi child process.
_Avoid_: subagent, child, worker

**Assignment**:
The issue a delegate works and the teammate it works it as.
_Avoid_: binding, worker binding

**Untracked delegate**:
A delegate with no assignment, because its task matched no plan task and named no ticket; the lead tracks its work.

**Hand back**:
Returning an exited delegate's still-open issue to the lead, marked for review.
_Avoid_: release, settle-back

## Plans

**Plan**:
A session's todo list, made of plan tasks and ticket items grouped in phases.
_Avoid_: todo plan, task list

**Plan parent**:
The issue a plan's plan tasks are children of.
_Avoid_: session parent, binding

**Automatic parent**:
A plan parent the plugin created for one session; it closes itself once its children are closed with evidence.
_Avoid_: auto parent, session issue

**Explicit parent**:
A plan parent the user or agent chose (`KATA_REF`, an init `ref`, or an adopted issue); it never closes itself.
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
The closes the plugin still owes for a session: its pending closes and its automatic parent's close.
_Avoid_: reconcile, close queue

## Inbox

**Session inbox**:
An inbox addressed to `<actor>/<name>`; its requests steer the session that reads it.

**Personal inbox**:
An inbox addressed to a bare `<actor>`, holding requests for a person; no session reads it.
_Avoid_: person's inbox, user inbox

**Trusted request**:
An inbox request whose sender is the session's own actor; only these reach the agent.
