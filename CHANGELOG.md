# Changelog

All notable changes to kata-plugin are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [semantic versioning](https://semver.org/spec/v2.0.0.html). A release carries the root version, which kata-pi shares, and names both plugin versions on its first line.

## [Unreleased]

## [1.7.0] - 2026-11-08

kata-omp 2.7.0 and kata-pi 1.7.0.

### Added

#### Install and update

- pi: `kata-pi` is on npm and in the [Pi package gallery](https://pi.dev/packages); install it with `pi install npm:kata-pi`.
  - The package carries the license and this changelog, so pi shows the new entries after an update.
  - Its manifest points the gallery at a preview image and a short silent video in `docs/media/`.

#### Plans

- omp: `todo` results give each task its `ref` in `details.kata.phases`, add `local` for a session-local plan, and add `notice` for text the result shows before the plan (an error, a close Kata deferred, a deleted parent).

#### Display

- omp in Tern: the plan looks like omp's own todo.
  - Each `todo` result is a checklist card: `Todo 1/4` with the parent ref, and each task with its Kata ref.
  - The progress line above the input is now the dock pill, with the plan in its popover. It replaces the text line, which Tern drew under its context meter.
  - Other terminals, and omp's RPC and print modes, keep the text result and the one-line progress widget.

### Changed

#### Install and update

- Release headings follow Keep a Changelog, `## [1.6.1] - 2026-11-08`, with the plugin versions on the line below. pi still reads the version from the heading.

#### Plans

- The `todo` tool description says the tool does the Kata bookkeeping for its tasks and ticket items: it claims them, keeps their `work.attention` and closes them.
  - It tells the model not to run `kata claim`, `kata meta set … work.attention` or `kata close` for them, and not to plan that bookkeeping as items. Kata's agent contract asks agents to claim and set attention, so models did both by hand.

#### Delegates

- The `todo` tool description tells the lead that a delegate bound to a plan item or ticket closes that issue itself once its work is verified, so the item shows done without the lead's `done`.
  - Leads used to report the delegate's close as unexpected.
- omp: a `task` that would delegate a ticket is refused while another open plan item names the same ticket.
  - The delegate closes the whole ticket, so the lead's other items on it could no longer be marked done and the plan stayed unfinished.
  - Delegate the ticket once it is the last open item for it, or plan the work as child issues (`todo init` with the ticket as `ref`) and delegate one of those.

#### Development

- Releases add an `npm publish` from `plugins/pi`; see [development](docs/development.md#releases).

### Fixed

#### Plans

- omp: a turn end right after one you interrupted with Esc gives the open-task reminder again.
  - When the earlier turn's delegate hand back finished during the first 250 ms of the next turn end, that turn end returned no reminder.

#### Display

- The `#` ticket menu shows the whole title and lists Kata tickets first.
  - A row shows the qualified ref, which accepting inserts, with the title beside it. Both hosts cut the first column at 32 characters, so titles used to stop mid-word.
  - On omp, prompt actions such as "Copy whole prompt" came first, so Tab copied the prompt instead of inserting the ticket.

## [1.6.1] - 2026-11-08

kata-omp 2.6.1 and kata-pi 1.6.1.

### Added

#### Delegates

- omp: resuming a lead session finishes the delegate cleanups it never finished.
  - The lead's saved state keeps each delegate not yet handed back or rolled back, and whether it ran a tool. Resuming hands its issue back for review, or rolls it back if the delegate did nothing, in the background.
  - `/exit`, Ctrl+C, a crash or a slow shutdown no longer leaves the issue on the delegate's teammate for good. A session you never resume still does.
  - A delegate the saved state shows still running counts as aborted, so resume a lead session only after the omp that had it open has exited.
  - A forked session leaves them to the session it was forked from.

#### Development

- The scripted `resume` smoke scenario kills omp (SIGKILL) while two delegates run, resumes the lead with `--resume`, and checks that the delegate that ran a tool is handed back and the other is rolled back.

### Changed

#### Requirements

- Tested with oh-my-pi 18.18.1. Kata 0.21.0 is still required (0.22.0 tested).

#### Development

- The scripted `workers` scenario no longer reads the plan after each delegate report to wait for cleanups; it relies on the end-of-turn wait.

### Fixed

#### Delegates

- omp: delegate hand backs and rollbacks survive a busy turn end.
  - When a lead turn ends while exited delegates are not yet handed back or rolled back, the plugin waits up to 15 s (was 0.25 s) for those cleanups. A turn with nothing to clean up still ends within 0.25 s.
  - With many delegates, omp's 2 s shutdown limit used to cut off cleanups still queued at exit: the issue kept the delegate's teammate and `omp.status running`, with no `needs-review` and no inbox request.
  - `/exit` or Ctrl+C while delegates run is still cut off after 2 s; see [Limits](docs/explanation/limits.md) (Shutdown budget).
- A delegate whose issue was deleted while it ran is let go instead of retried at every cleanup pass (omp and pi).

## [1.6.0] - 2026-11-08

kata-omp 2.6.0 and kata-pi 1.6.0.

### Added

#### Development

- Every test runner and `smoke:omp` refuse to start while a vendored copy in `plugins/*` differs from `core/`; run `bun run build:plugins` after a `core/` edit.
- The `workers-slow-kata` smoke scenario reruns `workers` with every plugin Kata call 25 ms late (`scripts/smoke-slow-kata.sh`), so the delegate wait is checked on a slow Kata.
- The scripted `workers` scenario follows every delegate, those on worker threads included, to the end of its task: some close their issue, some run a tool and are handed back, some answer without a tool and are rolled back.

### Changed

#### Requirements

- Tested with oh-my-pi 18.18.0, which fixed scripted worker delegates failing at their first model call. Kata 0.21.0 is still required (0.22.0 tested).
  - Known limit: omp gives an extension's shutdown 2 s, so delegate hand backs, pending closes and the automatic parent's close still queued when omp exits can be cut off. See [Limits](docs/explanation/limits.md) (Shutdown budget).

#### Install and update

- Each plugin folder gains `model.ts`, `kata-cli.ts`, `shell.ts` and `autocomplete.ts`; copy the folder whole when installing by hand.
  - The shared core is split by job, and the oh-my-pi adapter's source lives in `plugins/oh-my-pi/kata.ts` instead of a generated copy of a root file.

#### Plans

- Both hosts show the same `todo` parameter descriptions.
- A task completed while Kata was unreachable replays blocked unless its message has 40 characters after runs of whitespace are collapsed, the same rule `done` applies.

#### Inbox and attention

- **Breaking:** pi: the plugin no longer pre-fills Kata's native attention record or clears `KATA_REF` in the main session. If you have not run `kata agent-hook install pi --attention` since upgrading Kata to 0.21 or later, run it and restart pi.
  - Kata 0.21's pi hook keeps child sessions off the lead's attention itself. A hook generated by an older Kata lacks that guard, so a pi child that does not load this plugin takes over the lead's attention and marks the lead's issue `needs-human` when it quits.
  - Commands the main session's `bash` tool starts now inherit its `KATA_REF`. A child that loads the plugin still drops the inherited `KATA_REF` and works its own issue.

### Fixed

#### Delegates

- Large delegations on a busy machine keep their issues.
  - A delegate's first prompt waits up to 15 s (was 3 s) for its Kata issue, and stops waiting as soon as the issue is assigned.
  - The lead assigns delegates one at a time, about fifteen Kata calls each, so the later subagents of a large `task` call used to start with no issue in their prompt and no tracked close: about half of a fourteen-delegate call on a loaded machine.
- omp: a delegate's own `todo` close records the delegate's session even when an event from another agent identity reaches its handlers while the close runs.
  - The close used to take the identity of the latest event, so it could record no session, or that identity's.

## [1.5.1] - 2026-11-07

kata-omp 2.5.1 and kata-pi 1.5.1.

### Added

#### Plans

- Close transcripts record omp and pi sessions once `[close.transcript] enabled = true` is in Kata's `config.toml`.
  - The plugin's own closes and the agent's `kata close` calls record `omp <id>` or `pi <id>`; `session_id_env` is no longer needed for omp or pi.
  - omp delegates record their own session on every close they run: a `kata close` in `bash`, and their own `todo` `done`, `drop` and `rm`.
  - Another harness launched from omp's or pi's `bash` tool inherits the pair, so its closes link the launching session.

#### Inbox and attention

- omp: a `kata notify` reaches the agent right away. The main session follows `kata events --tail` and delivers each new trusted request as an aside.
  - An idle agent starts a turn on it; a working agent gets it at its next step boundary without its tool batch being interrupted (a pending approval or `ask` stays pending).
  - The message is cut at 1024 bytes like the inbox section's, and marked as untrusted data, not instructions.
  - The `<kata_inbox>` section is kept current from the same stream, so a prompt no longer starts a `kata inbox` read. A failed first read is retried with backoff (1 s to 30 s), and a stream that keeps dropping backs off instead of restarting every second.
  - A later session start in the same process, in any workspace of the same project, reads the event log on from the position it already knew.
  - `KATA_OMP_LIVE_INBOX=0` keeps the per-turn read; tern-kata sets it for agents that load its own delivery extension. Delegates and pi still read their inbox every turn.

#### Delegates

- omp: delegates on worker threads are tracked.
  - omp 18.17 runs a subagent on a worker thread, with its own copy of the plugin, once nine or more run at once. That copy asks the lead's copy on the main thread for its assignment.
  - The delegate sees its issue in its prompt, its `todo` works under that issue, its `kata` commands carry its teammate, and its tool use reaches the lead's rollback and hand back.

#### Development

- Run the suite against the installed Kata with `KATA_TEST_EXECUTABLE="$(readlink -f "$(command -v kata)")" bun run test`. Error fixtures are re-captured from Kata 0.21.0.
- The default `smoke:omp` scenario turns transcripts on and checks that the plugin's close and a delegate's close record omp sessions.
- The `workers` scenario delegates fourteen plan tasks at once and checks that every delegate, those on worker threads included, sees its own task. With `--live`, it checks that worker delegates plan and close through their own `todo` and `kata close`, and are handed back after using a tool.

### Changed

#### Requirements

- **Breaking:** requires Kata 0.21.0 (was 0.19; 0.20 and 0.22.0 tested). The CLI and the daemon both need 0.21.0. Tested with oh-my-pi 18.17.0.
  - Kata 0.21.0's schema 43 and 0.22.0's schema 46 are one-way: older binaries can't open an upgraded store, and rolling back needs the pre-upgrade backup plus its matching binary.
  - Re-run `kata agent-hook install pi` so the installed pi hook includes the child-session guard.
  - Session transcripts for agents other than Claude Code and Codex need daemon API 0.34.0. An older daemon warns and closes without the transcript.

#### Plans

- Session shutdown waits up to 10 s (was 250 ms) for the automatic parent to close, so a slow Kata no longer leaves it open when omp or pi exits.
- A close that keeps failing for a reason other than Kata's sibling throttle is retried on up to three settlement passes, then dropped and labelled `needs-review` with a comment naming Kata's error code.
  - It used to be retried for the rest of the session. Passes while Kata is unreachable don't count, so an outage never drops a close.
- An unregistered folder takes the project name to register from Kata's structured `project_not_initialized` data (project, then alias), then the folder name. No code path reads Kata's message wording.

#### Inbox and attention

- Only an `<actor>/<name>` address in `KATA_INBOX_USER` is read as a session inbox.
  - A bare `<actor>`, as set for tern-kata's Attention Page or `kata inbox`, is that person's inbox, holding requests agents wrote for them; omp and pi sessions used to put it into every system prompt. It is now skipped with a one-line notice per session.
  - To steer a plain omp session through its inbox, start it with `KATA_INBOX_USER=<actor>/<name>` and notify that address.
- Only your own requests steer a session: the inbox section shows only requests whose sender is the session's own actor.
  - On a daemon without authentication the sender is self-declared, so this stops other people's requests, not impersonation (see [Limits](docs/explanation/limits.md)).
  - The section is capped like `kata inbox --context` (8 KB, with an `[N request(s) omitted…]` line), and a reply row for a comment reads as Kata prints it.
  - Under Kata's native pi adapter (`kata agent-hook install pi --attention`), which inserts the inbox itself, this filter does not apply.

#### Delegates

- A delegate that exits without having run a tool has its assignment rolled back (omp and pi): claim, teammate, status, attention and subagent key are restored, and nothing is labelled `needs-review`.
  - One that ran a tool and left its issue open is commented, set to `work.attention needs-human` and handed back.
  - A failed assignment is retried on the delegate's next prompt or `todo` call.
- pi: a child that matches no plan task and names no ticket is untracked, like an omp `task` that matches nothing.
  - It no longer creates a `Subagent <id>` issue, gets the untracked context, and its `kata` calls are rewritten with its teammate.
  - An assigned child's `todo` plans under its own issue, and its assignment is saved in its session, so a resumed child keeps it.

### Fixed

#### Plans

- A deleted automatic parent no longer locks up the `todo` tool. Kata 0.22's TUI deletes an issue with `X`.
  - Every `todo` call, `view` and `init` included, used to fail with `issue not found`, a resumed session failed the same way, and a pi lead could not launch a pi child; only `kata restore` helped.
  - Now the plan goes with the parent, together with its pending closes. Every `todo` result and `/todo` says the parent was deleted until a new plan starts, and its tasks stay in Kata as they were.
  - `append` with no plan left asks for an `init`, and `init`, or a pi lead launching a child, creates a new parent under a key derived from the deleted one's.
  - A deleted explicit parent (`KATA_REF`, an init `ref`, an adopted issue) is still an error.
- After `kata move`, new plan tasks, delegated work and ticket items follow the issue to its current project instead of landing in the old one.
- A child closed with Kata 0.21 `attachment` evidence no longer leaves the automatic parent `needs-review`; the parent closes with the children's other evidence and stays open for review only if none remains.
- Appending a ticket item that is already open in the plan does nothing. It used to create a stray child issue under the parent, or throw in a plan of only ticket items.
- A Kata error that follows a warning line, as Kata 0.21 prints when close transcripts are on and no session is set, is still read by its code, so a throttled or refused close is handled as such.
- An automatic parent its audit labelled `needs-review` is checked again only when its revision or its children change, instead of being audited and labelled on every turn.
- A close of an automatic parent that Kata throttles is retried without labelling the parent `needs-review`.
- In a plan of only ticket items, a `todo` target shaped like an issue id that names no issue reports Kata's error instead of a Node `TypeError`.

#### Inbox and attention

- omp: after a `kata purge`, a session start no longer replays old inbox requests. The live follower used to take the purge marker for the newest event.
- pi: the pre-filled attention baseline is marked as not started, so Kata 0.21's pi hook sends no `attention-native … end` when a session without `KATA_REF` quits.

#### Delegates

- omp: a delegate whose assignment failed is handed back when it exits, like a delegate that left its issue open: `needs-review`, an inbox request to the lead, and the task back on the lead's teammate.
  - It used to keep the delegate's teammate, refuse the lead's `todo done`, and keep the automatic parent open for good.

#### Development

- The pi close-transcript test reads every event in its store, not only the first 500.

## [1.4.0] - 2026-11-03

kata-omp 2.4.0 and kata-pi 1.4.0.

### Added

#### Development

- The `untracked` smoke scenario sends a `scout` that matches no plan item and checks that it leaves no issue, `needs-review` label or inbox request, and that the parent closes from the plan's own items (scripted and `--live`).

### Changed

#### Delegates

- omp: a `task` that matches no plan item and names no ticket gets no Kata issue.
  - It used to get a `Subagent` issue that an agent without `bash` (the `scout`) could not close: an open issue, a `needs-review` label, a `kata notify` and a parent that never closed.
  - Such a subagent gets a short note instead of a binding, and its `todo` uses omp's own list (an error on an omp without `ctx.invokeTool`).
  - A delegation no longer creates the automatic parent, which closes from the plan's own items. pi is unchanged.

## [1.3.0] - 2026-11-03

kata-omp 2.3.0 and kata-pi 1.3.0.

### Added

#### Plans

- Todo items can work existing tickets: an item that starts with `<project>#<short_id>: ` works that ticket instead of creating an issue.
  - `start` claims it and marks it in progress, `done` comments on it, and the last open item naming it closes it with that item's evidence. `drop` and `rm` only comment.
  - If Kata refuses that close because the ticket's children are still open and they are all tasks of this plan, the plugin closes it once they close; children outside the plan leave it open for you.
  - A plan whose items all name tickets creates no parent issue. An unresolvable or closed ref is an error and creates nothing.

#### Delegates

- A `task` whose prompt names exactly one ticket gives the subagent that ticket, with no `Subagent` issue. A prompt naming several tickets or plan items is refused: name one per task.

#### Display

- Type `#` to pick a ticket: in an interactive omp or pi session, `#` plus part of a short id or title word offers open Kata issues next to the host's own items, and inserts the qualified ref. A digits-only `#1234` stays GitHub's.

#### Development

- `bun run smoke:omp` runs the omp plugin in a real headless omp with a scripted model (default, inbox, tickets, fork and claimed scenarios).
  - `--live --model <provider/model>` runs them with a real model through an API-key login only; OAuth logins are never copied.

### Changed

#### Requirements

- Tested with oh-my-pi 18.16.0, scripted and live, and installed through the marketplace; and with pi 1.5.0, installed with `pi install`.

#### Install and update

- The repository moved to [Dangerboi/kata-plugin](https://github.com/Dangerboi/kata-plugin).

#### Plans

- **Breaking:** an `init` whose new list leaves out open tasks changes nothing and names them; pass `replace: true` to replace them. Callers that re-`init` to drop open tasks must add it.
  - A list that keeps every open task goes through. omp's `todo.eager` reminder (first prompt, and after every compaction) could otherwise make the model re-`init` and close real tasks.
- The plugin passes `--json` and branches on Kata's error and exit codes (`daemon_unavailable`, `project_not_initialized`, `sibling_throttle`), not on message wording.

#### Inbox and attention

- The inbox is read every turn, so a `kata notify` sent mid-session reaches the agent on that turn or the next. The contract is still fetched once per session.

#### Delegates

- A delegate's first prompt waits up to 3 s (was 250 ms) for its issue binding, so a slow Kata no longer leaves it without its issue.

### Removed

#### Install and update

- The Claude Code adapter. Use Kata's own hook: `kata agent-hook install claude`. Existing Claude installs stay on adapter 0.2.0.

#### Development

- The `test:claude` and `validate` scripts.

### Fixed

#### Plans

- omp: a forked session keeps its source's plan instead of starting an empty parent. It does not take over the source's pending close retries or offline plan, and the shared parent still closes only when every task is closed.
- omp: `todo` in a `/tan` side conversation uses omp's own session-only list and leaves Kata alone, instead of failing with a binding error.
- omp: the close retry timer runs on omp's session timer, so shutdown clears it.

#### Delegates

- omp: a `revive` of a parked subagent does no Kata work.

## [1.2.0] - 2026-10-31

kata-omp 2.2.0 and kata-pi 1.2.0.

### Changed

#### Install and update

- Installing the oh-my-pi plugin is the whole setup: Kata becomes the only todo system, in every folder. The `todo.enabled: false` step is gone, and the setting keeps working.

#### Plans

- **Breaking:** omp: the plugin's `todo` replaces the built-in one, and its results carry the plan under `details.kata` instead of `details.phases`, so omp's own reminders, mid-run nudge and HUD have nothing to track. Scripts reading `details.phases` must read `details.kata.phases`.
- A folder with no Kata project plans in `KATA_DEFAULT_PROJECT` (issues labeled with the repo), or in its inferred project, registered with `kata projects create`; no `kata init`, no files in the repo. `project_not_initialized` no longer produces a session-local plan.
- If Kata is unusable (missing executable, unreachable daemon), the plan is session-local with one warning per session, and it replays into Kata when Kata returns.
- The automatic session parent is created on the first todo mutation, so a session that never plans leaves no issue.
  - The pi adapter shares the project resolution, lazy parent and replay changes.

### Fixed

#### Inbox and attention

- omp: the plugin skips its Kata contract when the system prompt already carries it.

[Unreleased]: https://github.com/Dangerboi/kata-plugin/compare/v1.7.0...HEAD
[1.7.0]: https://github.com/Dangerboi/kata-plugin/compare/v1.6.1...v1.7.0
[1.6.1]: https://github.com/Dangerboi/kata-plugin/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/Dangerboi/kata-plugin/compare/v1.5.1...v1.6.0
[1.5.1]: https://github.com/Dangerboi/kata-plugin/compare/v1.4.0...v1.5.1
[1.4.0]: https://github.com/Dangerboi/kata-plugin/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/Dangerboi/kata-plugin/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/Dangerboi/kata-plugin/compare/v1.1.1...v1.2.0
