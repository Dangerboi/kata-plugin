# Oh-my-pi reference

Plugin ID: `kata@kata-plugin`; package: `kata-omp`. The canonical adapter is root `kata.ts`; the portable entry is `plugins/oh-my-pi/kata.ts`.

The adapter uses session start/shutdown, tree navigation, input, prompt/stop hooks, tool calls/results, `before_subagent_spawn`, and `task:subagent:lifecycle`. A shared coordinator joins final subagent IDs to child sessions. Only `ctx.agent.kind === "main"` can bind the main plan, draw its progress widget, or change main session attention. A tracked worker can use todo under its own assigned issue and teammate; it cannot reuse the coordinator’s adapter context or inherited parent reference.

| Variable | Meaning |
| --- | --- |
| `KATA_OMP_EXECUTABLE` | Kata executable; defaults to `kata`. |
| `KATA_REF` | Explicit main parent and main session-attention target. |
| `KATA_DEFAULT_PROJECT` | Existing Kata project that collects the plans of folders without a project. Issues carry a label naming the repo. omp gives extensions no per-plugin settings, so this variable is the only switch. |
| `KATA_AUTHOR`, `KATA_TEAMMATE` | Existing actor and optional main teammate. |
| `KATA_INBOX_USER` | Inbox recipient override. |
| `KATA_OMP_DEBUG` | Optional append-only diagnostic log. |

The todo tool supports `init`, `append`, `start`, `block`, `unblock`, `done`, `drop`, `rm`, `view`. `/todo` supports `start`, `done`, `drop`, `rm`, `append`, `block`, and `unblock`; with no subcommand it shows the plan. Phases and task refs are retained in Kata. Local plans and queued close retries persist in custom session entries and resume with a saved session. Explicit `/todo done` records the user's completion attestation as external evidence. Removed items are retired, never deleted.

The plugin matches each delegation (the task item's `name`, `task` and the lifecycle `description`) against the plan when the subagent starts, so a `task` call sent in the same batch as `todo init` still binds. An open task named by its title (quoted, as the whole text, or three or more words), by qualified ref, or by short id after `issue`, `kata`, `ref`, `task` or `#` wins; if that task is already delegated the `task` call is refused. A prompt that names a ticket outside the plan by qualified ref (`<project>#<short_id>`) binds the subagent to that ticket: the plugin checks it with `kata show`, applies the same ownership, teammate and already-closed checks, creates no `Subagent` issue and needs no plan. An unresolvable or unusable ref refuses the `task` call. A prompt that names two or more tickets or plan items is refused ("name one ticket per task"); word overlap never breaks that tie. Otherwise, when nothing is named, the task with a clear weighted word overlap wins, its leading verb counted twice and the lead's active task at half weight. The active task is the fallback only for an explicit "current task" handoff. Batch tasks match by index. If no task matches, a separate child is created. One task cannot have two delegates, and a delegated task never occupies the lead's active slot. Main todo mutations cannot complete a running delegate's task: the child closes itself and `view` reloads Kata state. Delegate teammates derive from the agent id and the lead session id.

## Takeover of omp's todo

omp lets an extension re-register a built-in tool by name, so installing the plugin makes its `todo` (Kata's description and schema) the only one the model sees. omp's native todo behavior is keyed to `details.phases` on `todo` results; the plugin returns its plan under `details.kata`, so omp's stop reminder, mid-run nudge, HUD and replan titles never run next to Kata's. Two omp behaviors remain and agree with Kata: the reminder after a failed `todo` call, and the opt-in `todo.eager` prelude, both of which tell the model to call `todo`. `todo.enabled: false` still works.

## Where the plan lives

First match wins:

1. `KATA_REF`, or a worker's assigned issue.
2. The binding stored in this session.
3. The folder's own Kata project (`.kata.toml` or a registered inferred name), as before.
4. `KATA_DEFAULT_PROJECT`. The parent and every task and delegate issue carry a label naming the repo (Kata's inferred project name, else the folder name, lowercased to a valid label), so `kata list --label agentsview` finds them. The project must exist; a mistyped name fails instead of creating a project.
5. The inferred project: the name Kata would infer from the git remote, else the folder name. The plugin registers it with `kata projects create <name>` and binds to it. It never runs `kata init` and writes nothing into the repo. Inferred names are not unique: two checkouts named `app` share one project, and so does a checkout whose name matches an existing project. Set `KATA_DEFAULT_PROJECT` (issues are labeled per repo) or run `kata init --project <name>` where that matters.

Nothing is created until the first plan mutation: a session that never plans leaves no issue and no project. The first `todo init` creates one automatic session parent (a task delegation also creates it, since a delegate needs a parent to be tracked, and with it the inferred project). The parent closes from its children's evidence as before.

## When Kata is unreachable

A missing executable or an unreachable or unresponsive daemon (a Kata call that times out) is the only case that selects a session-local plan. The plugin warns once per session, keeps the plan in the session entries, and replays it into Kata when Kata answers again: on the next todo call, on resume, or on a 60-second retry. Tasks completed offline replay as closed only if they carry evidence and a 40-character message; otherwise they replay blocked so you can add evidence. `project_not_initialized` never produces a local plan, and missing projects or authentication failures are errors.

## Hooks

The plugin injects the Kata contract and runs `kata agent-hook attention-native` itself; no `kata agent-hook install` step is needed. Kata 0.20 has no `omp` installer, so nothing else adds the contract to omp. If something else already put the contract in the system prompt, the plugin skips its own copy.

Qualified explicit issue references and saved bindings take precedence over directory probing, including in unbound worktrees. An unavailable explicit issue is an error.

Subagents receive the cached contract, exact issue, teammate, and close command. Their todo children belong to that assigned issue, and CLI calls carry the worker’s teammate without changing process-wide environment variables. An untracked worker receives a binding error. Recognized standalone Kata Bash commands gain teammate and binding flags; actor impersonation is refused. A delegate that finishes without closing its issue gets `omp.status`, `needs-review`, one idempotent comment and a `kata notify` to the lead; a plan task is handed back to the lead's teammate as pending, so the lead can verify and close it (which removes `needs-review`) or delegate it again. A `task` call that never starts a subagent releases its tasks when its result arrives. Terminal outcomes never write the delegate's `work.*` or infer a close from shell text.

With `KATA_INBOX_USER` set, every turn starts a `kata inbox --context` read (the contract is cached per session); a request sent mid-session shows up in `<kata_inbox>` on that turn or the next, a failed read keeps the last inbox, and an empty answer removes the section. A `revive` of a parked subagent does no Kata work. Hooks have a 250 ms foreground budget (a delegate's first prompt waits up to 3 s for its own issue binding, because it has no other way to learn it); ordinary Kata subprocess calls have a 120-second ceiling so hosted reads are not killed after one second. Explicit todo operations await actual results. Failed startup binding is retried on the next todo call. If a read fails or returns malformed children, the widget and tool report unavailable state rather than cached task progress; `view` reloads it from Kata. Stop reminders wait for a successful refresh and do not describe a pending read as current state. Main session attention for a `KATA_REF` session checks the actor and teammate, then runs `kata agent-hook attention-native pi start|end --session <id> --host-pid <pid> --ref <ref>`; Kata owns the token and transitions. Conflicting writes are preserved. See [closing rules](closing-rules.md).

## Ticket references in the prompt

In an interactive session, typing `#` and part of a ticket id or title word offers matching open Kata issues next to omp's own `#` items (prompt actions, GitHub refs). `#bc` offers every ticket whose short id starts with `bc` or whose title has a word starting with it. Each entry shows the short id and title. Accepting one inserts the qualified ref with a trailing space, for example `kata-plugin#bc7q `.

- A digits-only token (`#3164`) stays GitHub's and offers no Kata tickets. An all-digit Kata id is reachable as `#<project>#1234`.
- `#<project>#<token>` searches that project. Otherwise the folder's bound project is searched, then `KATA_DEFAULT_PROJECT`.
- The open-issue list is cached per session and refreshed in the background (30 seconds). Typing never waits on Kata: on abort, a slow call (400 ms) or an unreachable daemon the menu shows only omp's own items, with no error.
- Subagents and non-interactive modes (print, RPC, ACP) register nothing.
