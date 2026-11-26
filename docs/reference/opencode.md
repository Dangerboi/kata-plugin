# OpenCode reference

Package: `@dangerboi/kata-opencode` on npm; entry: `plugins/opencode/kata.ts`. Requires OpenCode 2.2.7 or later and Kata 0.23.0 or later, checked before CLI use; see [runtime compatibility](../how-to/install.md#runtime-compatibility) for errors, source builds and background hook behavior. The plugin is the default export of `kata.ts` (plugin id `kata`). OpenCode loads it from the `plugins` list of `opencode.json` (global or per project) as an npm package or as a local directory; a bare file path is refused. The `plugins/opencode` directory loads as it is, because its `package.json` `exports` points at `kata.ts`. See [install](../how-to/install.md#opencode) for both forms. Keep the plugin directory intact: every `.ts` file next to `kata.ts` is a required module.

The plugin replaces OpenCode's `todowrite` tool, adds a plan section to the lead's system prompt, binds the lead's `subagent` calls to Kata issues ([Delegates](#delegates)) and rewrites Kata commands in the `shell` tool ([Shell](#shell)). It does not inject the Kata contract, the inbox or session attention: the core runs with `context: false`, and `kata agent-hook install opencode` supplies them (see [Use with Kata agent hooks](../how-to/use-with-kata-agent-hooks.md#opencode)).

## Settings

Plugin options sit next to the package in `opencode.json`. Each option falls back to a variable in the server's environment. The option wins when both are set; a value counts only when it is a non-blank string, and it is trimmed.

| Option | Variable | Meaning |
| --- | --- | --- |
| `executable` | `KATA_OPENCODE_EXECUTABLE` | The Kata executable the plugin itself runs; defaults to `kata`. The `shell` tool is not rewritten to use it. |
| `ref` | `KATA_REF` | Explicit parent issue every session of the plugin plans under. For one session, pass `ref` in its first `todowrite` call instead. |
| `defaultProject` | `KATA_DEFAULT_PROJECT` | Existing Kata project that collects the plans of folders without a project; issues carry a label naming the repo. |
| `author` | `KATA_AUTHOR` | Existing actor; also set in the environment of every Kata process the plugin starts. |
| `teammate` | `KATA_TEAMMATE` | Optional teammate for the lead; also set in the environment of every Kata process. |
| `refGuard` | `KATA_REF_GUARD` | `off`, `0` or the JSON `false` stops the refusal of writes and commits that name a Kata ref ([below](#kata-refs-in-repository-content)). On by default. |
| `debugFile` | `KATA_OPENCODE_DEBUG` | Optional append-only diagnostic log. |

Variables come from the OpenCode server process, not from the shell that starts a client. The default background service does not see variables set in the launching shell; only `opencode run --standalone` does. Use plugin options, or the service's own environment. `KATA_CLOSE_TRANSCRIPT_ENABLED` is read from the same server environment at each close (see below).

Where the plan lives follows the [oh-my-pi rules](oh-my-pi.md#where-the-plan-lives) with `ref` and `defaultProject` in place of `KATA_REF` and `KATA_DEFAULT_PROJECT`: the setting, then the plan parent saved for the session, then the folder's Kata project, then `defaultProject`, then the inferred project. Nothing is created until the first plan change.

## The `todowrite` tool

OpenCode sends the whole list on every call, and so does this tool: `todos: [{ content, status }]` with status `pending`, `in_progress`, `completed` or `cancelled`. OpenCode's input shape is kept, so its sidebar renders the call. Items add optional fields: `message` and `evidence` (an array) for `completed`, `reason` for `cancelled`, `blocker` for a paused item. The top-level `ref` names an existing Kata issue the plan serves. It counts only on the call that creates the plan; without it (and without a `ref` setting) the session gets its own automatic parent issue. When that issue already has open items, a first list that leaves them out is refused with their titles: send the list again with them in it.

An item's identity is its exact `content`. The plugin reloads the Kata plan on each call and compares the two:

| In the list | Effect in Kata |
| --- | --- |
| New content | Appended as a child issue of the parent. A new item may arrive `pending`, `in_progress`, `completed` or blocked, but not `cancelled`. |
| `pending` to `in_progress` | The task starts (claimed by the session). |
| `completed` | Done, with `message` (at least 40 characters, after collapsing whitespace) and a non-blank `evidence` entry. Kata validates the close as in [closing rules](closing-rules.md). |
| `cancelled` | Dropped, with a `reason`. The issue stays in Kata. |
| `blocker` on an open item | The task is blocked with that reason, and the list shows it as `in_progress` with the `blocker` field. Removing `blocker` unblocks it. |

Nothing starts on its own, and several items may be `in_progress` at once; the list says what is in progress. Closes apply first, then unblocks, blocks and starts. `message`/`evidence` and `reason` are required only on the transition into `completed` or `cancelled`.

A call is refused, with nothing changed, when any item disagrees with Kata. The error starts with `Refused: this list disagrees with the Kata plan. Nothing was changed.`, lists each problem, and ends with `The current Kata plan is below. Send it again with your changes applied on top:` and the current list as JSON (`{"todos":[…]}`). Refusals:

- A new item that is `cancelled`, a duplicate or blank `content`, a `completed` item without enough message or evidence, a `cancelled` item without a reason.
- A started item sent back as `pending`. To pause it, keep it `in_progress` and set `blocker`.
- An open item missing from the list. If it was in the session's last accepted list, the model dropped it: keep it, or cancel it with a reason. If it was not, it was added outside the session (by the user or a teammate, in Kata) and counts as requested work: the refusal asks for it back unchanged and does not offer cancelling.
- An item Kata already closed, sent with a different status. Closed items stay as Kata has them (`completed` or `cancelled`); any `message`, `evidence` or `reason` resent with them is ignored and never written.

If Kata fails part-way through the ops of one accepted call, the error says earlier changes may have been applied and ends with the current list in the same shape. A refused call's list never reaches Kata. The last accepted list's contents are saved per session; they tell a dropped item from one added outside.

A started item stays with the session that started it until that session ends, and a call that changes it from another lead session is refused (the refusal says to send the list again with `takeover: true`). The optional top-level `takeover: true` is for an item whose session crashed or was killed: it is passed to every op of that call, so each item the call changes is taken over, and Kata records the takeover as a comment on the issue. It changes nothing for items the call leaves alone. The refusal and error texts speak `todowrite`, not the omp `todo` tool.

Content is not normalised: Kata stores an issue title exactly as sent, so leading and trailing spaces, inner newlines and tabs, and 600-character titles come back unchanged, and the same list resent is a no-op. When a plan made elsewhere (the omp or pi `todo` tool, or Kata directly) has one content in two phases, the list shows it once, as the copy that is furthest along (`in_progress`, then paused, then `pending`; a closed copy only when no copy is open). Changes to that item apply to every open copy, and a call that agrees with the shown status changes nothing. Copies that name the same ticket cannot be told apart, so a call that needs a change to them is refused with advice to ask the user to remove the duplicate item. When every copy is closed and they are closed both ways (completed and cancelled), the item may be sent as either status.

An item whose text starts with a qualified ref and a colon (`<project>#<short_id>: <action>`) works that existing ticket instead of creating an issue: starting it claims the ticket, completing it comments on it, and the last completed item of a ticket closes it with that item's evidence. An unresolved ref or a closed ticket is an error.

A delegate's `todowrite` works only when the delegate is bound to an issue ([Delegates](#delegates)): it plans under that issue, through its own plan, and never touches the lead's. A delegate with no assigned issue gets the core's error saying so; a child session the lead does not track gets an error telling it to report in its reply; a session OpenCode cannot read gets an error saying so, and nothing is changed. A successful call returns the core's plan text and the list as metadata. The plan section added to the lead's system prompt describes the plan; it does not stop a stale call, the refusal does.

OpenCode's TUI sidebar renders every completed `todowrite` call from the list the model sent. The desktop composer pill also needs `experimental.todo: true` in `opencode.json`.

## Delegates

A delegate is a session the lead's `subagent` tool call creates. The plugin matches it to a plan item or a named ticket with the rules of the [oh-my-pi reference](oh-my-pi.md): the same naming rules, the same refusals, the same hand back. What differs is how OpenCode lets the plugin see each step.

| Step | What the plugin does |
| --- | --- |
| `subagent` call by the lead (`execute.before`) | Matches the call's `prompt` and `description` against the plan, with the refs other pending calls of this lead already hold. A task or ticket that is already delegated, two tickets in one prompt, or a ticket that cannot be delegated refuses the call with the core's error, and nothing is written; a Kata that cannot be reached refuses nothing: the call runs and its assignment is retried on the delegate's next use. A call that matches nothing runs as an untracked delegate, whose run becomes a mission when it exits with a report. |
| The delegate's first context hook | Binds the delegate before its first model call, to the pending call its first message comes from: the call whose `prompt` is the whole message after OpenCode's preamble, else the call with the longest `prompt` the message ends with. The core then claims the issue for the delegate's teammate. |
| Every context hook of a bound delegate | Adds the assignment section to the delegate's system prompt: the issue, the teammate, the commands to comment and to close it, and to leave it open instead when its task text says not to close issues or to leave the issue open. An untracked delegate gets a short note instead. A first prompt waits for the assignment, up to a bound. |
| A tool call of the delegate (`execute.before`) | Marks the delegate as having acted, so its assignment is no longer rolled back at exit. |
| Call returns, delegate runs | On OpenCode 2.4.2 every `subagent` call runs in the background: the call returns at once and the lead is woken by a `<background-result kind="subagent">` message. The delegate's `session.execution.succeeded`, `failed` or `interrupted` event ends it (`completed`, `failed`, `aborted`); its last assistant text is the report. A delegate whose session can no longer be read exits without a report. Older OpenCode (2.2.7) also runs a foreground call to its result: `execute.after` then carries the delegate's final reply, without the `<subagent …>` wrapper, as its report and exits it `completed`, or `failed` (`aborted` when the message says it was cancelled) with `Failed: <message>` as the report. |
| The delegate's own `session.deleted` or `session.archived` | A delegate still running exits `aborted`. |

An exit ends the run it belongs to, once. On OpenCode 2.4.2 a follow-up sent to a delegate that is still running joins its run: the plugin tracks it as the same run on the same issue, and the delegate's one end event ends it. A follow-up to a delegate that has ended starts a new run, and an end event OpenCode made before that run began (the earlier run's, handled late) does not end it.

Two calls of one lead that name the same plan item or ticket, in the same turn or in parallel, are checked one after the other: the second is refused as already delegated. Two calls that match nothing are both untracked, and each run that ends with a report becomes its own mission. A call that never gets a child (another plugin's hook refused it after the check, or its child never reached its first prompt) gives up what it reserved at the end of the lead's turn, so the item can be delegated again. On OpenCode 2.4.2 every call returns before its child's first prompt, so a call whose child has not reached a context hook by the end of the lead's turn is dropped then; on older OpenCode only background calls are.

At exit the core settles each delegate as for omp: a delegate that closed its issue returns it to the lead; one that exited without running any tool is rolled back, restoring the issue as it was before the assignment; one that ran a tool and left the issue open comments, flags it for the user and hands it back to the lead with the `needs-review` label. A delegate that left no comment gets its report posted for it. An untracked delegate that exits with a report gets a mission, as for omp (see the [oh-my-pi reference](oh-my-pi.md)), with the call's `agent` as `opencode.mission_agent`. Settling runs at the end of the lead's turn; see [Sessions, settling and restart](#sessions-settling-and-restart).

A `subagent` call with `sessionID` is a follow-up: it stays on the delegate's record and issue and matches nothing again. If the issue is still open, the delegate is assigned again and tracked as before. If the issue is closed, the follow-up's report is added to it as a comment and the issue stays closed: the plugin never reopens an issue. A follow-up to an open issue whose delegate runs no tool is rolled back like a first run, but its report is still posted on the issue. A follow-up to an untracked delegate whose run became a mission adds its report to that mission as a comment.

A bound delegate's `todowrite` plans under its assigned issue: new items become children of that issue, and its closes follow [closing rules](closing-rules.md). It cannot take over the lead's plan.

After a restart, the delegates of a lead come back with the lead's saved state: the unfinished ones resume, and the ones that ended with an issue, a mission included, are kept too, so a follow-up still reaches its issue. An untracked delegate that left no mission is not saved: a follow-up to it after a restart is not tracked.

## Shell

The plugin rewrites Kata commands in the `shell` tool's `command` before it runs. Only commands in command position are touched; quoted arguments and heredoc bodies are data.

| Caller | Rewrite |
| --- | --- |
| Delegate bound to an issue | Each `kata` command gets `--teammate <teammate>` (an earlier `--teammate` is removed), `KATA_AUTHOR` from the `author` setting when one is set, and `--workspace` and `--project` of the assignment unless the command sets them. A `kata close` also gets the delegate's own transcript pair, `KATA_TRANSCRIPT_AGENT=opencode` and `KATA_TRANSCRIPT_SESSION_ID=<the delegate's session id>`. Without it the close would record the lead's session. |
| Any other child session (an untracked delegate, a delegate's own subagent, a child the lead holds no record of) | The same without `--workspace` and `--project`. A child without a record gets the teammate a record would give it, derived from its session id and its lead's, so it never acts as the lead. |
| Child session with `--as` | The call is refused: `Kata subagents keep the current actor. Use your assigned --teammate; --as is not permitted.` |
| Lead | Each `kata` command gets `KATA_AUTHOR` and `KATA_TEAMMATE` from the `author` and `teammate` settings when they are set, because the server's environment may not hold them. `--as` is left alone. A `kata close` also gets the lead's transcript pair, because the server's environment cannot hold one per session. |
| Any caller | A close gets `KATA_CLOSE_TRANSCRIPT_ENABLED=true` unless the server's environment sets that variable. |

The TUI keeps showing the command the model wrote; the rewritten one is what runs. Rewriting is lexical and no sandbox: dynamic aliases and scripts must use the supplied commands themselves (see [limits](../explanation/limits.md)). Only `--as` and the delegate rules of a `subagent` call refuse a tool call: when the plugin cannot read a session or its storage in a hook, the call runs as written.

`shell` is not available in Code Mode (the tool sets `codemode: false`), so Code Mode calls never bypass the hook: every `shell` call passes `execute.before` (OpenCode `core/src/tool/plugin/shell.ts:182`, `core/src/tool.ts:268`).

## Kata refs in repository content

Kata refs resolve only in the local tracker, so the plugin refuses a `write`, `edit` (`newString`), `patch` (`+` rows) or `shell` call that puts a ref the session works (the plan parent and items, the assigned or claimed issue, a delegate's issue) into a file under the session's folder or into a `git commit` message, and the model rewrites it to describe the behaviour. A qualified ref counts only when its project is one the session knows, so `README.md#tasks` passes. A bare short id counts only when the session knows it. Only added text is checked: refs the replaced text or the file already holds, removed and context lines, hashline headers, files outside the folder, internal URLs and the bodies of `kata comment`, `kata close` and `kata create` are not. The check waits at most 2 seconds and lets the call through on an error. `KATA_REF_GUARD=off` (or `0`) turns it off. A commit counts where the `shell` call runs (its `workdir`, a `cd` before it, or `git -C`), so one in a folder outside the session's is not refused. The lead's and its delegates' calls are checked against the lead's refs. `execute.before` refuses the call, which ends as an error with the reason.

## Sessions, settling and restart

OpenCode runs many sessions in one server, with one plugin instance per location. The plugin creates one core per lead session (a session with no parent), lazily at that session's first context hook or first tool call, or for a session with saved state at the next setup or its first event; it does not wait for `session.created`. A lead's plan, pending closes and unfinished delegate cleanups belong to its core. Events are handled one after another per session: a session whose handler waits for Kata does not hold up the events of another.

| Moment | What the plugin does |
| --- | --- |
| End of each lead turn (`session.execution.succeeded`, `failed`, `interrupted`) | Settles: drains pending closes and hands back exited delegates. Never closes the automatic parent. |
| `session.deleted`, `session.archived` | Ends the lead: drains, releases the tasks it holds (an item whose close Kata deferred keeps its holder until that close is made), and closes the automatic parent when its children are closed. This is the only place the automatic parent closes. An automatic parent the core leaves open on purpose (every item dropped, for example) is not work left. When a close or delegate cleanup is still owed (Kata is unreachable or throttled, or a delegate is still running), this is an ended session: its saved state is kept, and it ends again as soon as that work is done, provided OpenCode still reports the session deleted or archived, or else at the next setup; otherwise the lead forgets its saved state. |
| Location eviction (idle, default 60 minutes) or server exit | Cleanup drains what fits and saves the rest. It closes and releases nothing, because the session can resume. |
| Next plugin setup (reload, restart, resumed session) | Binds each lead of the location that has saved retries, pending closes or delegates, and finishes that work. An ended session is finished in the background, so setup does not wait for Kata, and then forgotten; so is a saved session OpenCode no longer holds (deleted while no instance of the location ran). `session.unarchived`, or new activity in the session, stops it being an ended session: an unarchived session is never finished by a later restart. |

State lives in OpenCode's per-plugin `ctx.storage`, which is shared by every location and survives restarts. Keys are `session/<session id>/<part>`: `entries` (the core's saved state, delegate records included, with the folder it belongs to; a lead resumes from it only in the same folder), `accepted` (the last accepted list's contents) and `ended` (marks an ended session: deleted or archived with work left). Ending a lead clears all its parts once nothing is left to finish. A deleted or archived lead drops the `subagent` calls it still had pending, so what they reserved is free if the session is unarchived.

Every close the plugin makes runs `kata close` with `KATA_TRANSCRIPT_AGENT=opencode` and `KATA_TRANSCRIPT_SESSION_ID=<session id>` in that call's environment, plus `KATA_CLOSE_TRANSCRIPT_ENABLED=true` unless the server's environment already sets it. The server hosts every session, so the pair is set per call, never in the process environment. `KATA_CLOSE_TRANSCRIPT_ENABLED=false` in the server's environment stops closes recording the session ([Record agent sessions on closes](../how-to/record-session-transcripts.md)).

See [limits](../explanation/limits.md).
