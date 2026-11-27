# Changelog

All notable changes to `@dangerboi/kata-omp` are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package uses [semantic versioning](https://semver.org/spec/v2.0.0.html). Releases are tagged `omp-v<version>`. Up to 2.12.0, omp and pi released together under one kata-plugin `v<version>` tag, with pi's version (omp 2.12.0 is `v1.12.0`); those commits carry `omp-v` tags too.

## [Unreleased]

### Changed

#### Delegates

- The plan section of the system prompt tells the lead to delegate by putting the work in the plan, not by creating child issues for `task` subagents to claim.

## [3.1.0] - 2026-11-26

### Added

#### Inbox and attention

- Session attention also covers each ticket the lead claims with `kata claim` (or marks with `kata meta set ... work.attention ok`) and each issue it names with `/todo ref`, not only `KATA_REF`.
  - A ticket keeps attention until the session ends or switches, also after another ticket becomes the plan parent. Kata then flags an open ticket still on `ok` as `needs-human`; a ticket closed first is left alone.
  - A ticket flagged `stuck` or `needs-human` keeps its flag and gets no start, including the flag Kata wrote when an earlier session ended, after a quit and `/resume`. `kata meta set <ref> work.attention ok` run by the lead in its shell clears it and starts attention; run elsewhere it only clears the flag until the lead next claims or names the ticket. Kata leaves the old hand-off message in place.
  - A fork restarts attention for the parent it keeps; a resume in a new process does so only while the issue is still `ok` (after a crash), not after a quit.

#### Repository content

- A `write`, `edit`, `ast_edit` or `bash` `git commit` call that adds a Kata ref the session works to a file under the project folder or to a commit message is refused, for the lead and its delegates, and the reason tells the model to describe the behaviour instead. Kata refs only resolve in the local tracker.
  - Set `KATA_REF_GUARD=off` (or `0`) to turn it off.

### Fixed

#### Inbox and attention

- A subagent reads its own session inbox, `<actor>/<teammate>`, instead of the lead's, so a request can be sent to one subagent.
  - Subagents read an inbox only when `KATA_INBOX_USER` is a session address, and their assignment note names it. A subagent the plugin could not record reads none, and omp's advisor no longer shows the lead's requests.
- A request's text can no longer close the `<kata_inbox>` section or open a tag: `&`, `<` and `>` are written as `&amp;`, `&lt;` and `&gt;` in the section and in a live delivery.

## [3.0.0] - 2026-11-23

### Added

#### Plans

- `/todo ref <ref>` makes an issue the plan parent at once and loads its open children.
  - Naming the current automatic parent makes it explicit, so it no longer closes itself.
  - A plan that already has another parent keeps it, and with `KATA_REF` set the ref is not used.

### Changed

#### Requirements

- **Breaking:** the plugin requires oh-my-pi 19.1.1 or later, and Kata tracks omp's todo list only once you pick Kata as omp's todo backend.
  - Upgrade omp, then open `/settings` → Tools → Todos → Todo Backend and pick Kata (`todo.backend: kata` in omp's config). The plugin never sets it.
  - Until then todos stay omp's own: nothing reaches Kata, no `todo` call is refused, and each session shows one notice naming the setting. Kata 0.23.0 is still required.

#### Plans

- omp's own `todo` tool, `/todo`, HUD, reminders and nudges run, and the plugin's `kata` todo backend mirrors the list into Kata after omp saves each change.
  - An added task creates a child issue, starting it claims it, and dropping or removing it closes it as wontfix.
  - Changes made in Kata stand: the mirror follows what changed in omp's list, so an agent's `kata close`, a delegate's close or a hand back is not undone (except when Kata answers slower than omp's 30 s backend timeout across a `/tree` or fork; see limits).
  - A task the user marks completed through `/todo` or RPC `set_todos` while its issue is open stays open, labeled `needs-review` with one comment.
  - A task that was never in omp's list (from an adopted parent, `KATA_REF` or a claimed ticket) is never removed. Tasks are matched by text, and moving one to another phase is not mirrored.
  - While Kata is unreachable the plan is kept in the session and replays when Kata returns; omp's list is never held up by Kata.
- omp shows a warning when the mirror cannot reach Kata or Kata refuses a change.
  - "Kata did not take…" means Kata was unreachable; the next change to the list sends the whole list again.
  - "Kata refused…" names the refused tasks, if any, and comes once per distinct error and task until a change goes through. A refused removal leaves the task open in Kata.
- `todo done` on a task whose Kata issue is still open is refused, naming the issue and the `kata close <ref> --done --message '<40+ characters>' --test '<command>'` command (or `--commit`, `--pr`, `--reviewed-paths`). The agent closes the issue in its shell, then calls `done` again.
  - A ticket item's `done` that is not the ticket's last open item goes through with a plain comment on the ticket. The last open item is refused until the ticket is closed.
  - `done` on a delegated task is refused: its delegate closes it.
  - A `kata close` and a `todo done` sent in one message get the `done` refused, because omp checks every call of a message before running any; the agent retries `done` on its next turn.
- An `init` whose list leaves out open tasks is refused and lists them, also an empty list (`list: []`) and an `init` with `op` left out.
  - Tasks omp's list held: drop them first with `todo drop`, which closes them as wontfix, then `init`.
  - Tasks omp's list never held (from an adopted parent, `KATA_REF` or a claimed ticket): keep them in the list, or `append` them and then drop them.
- The plan parent comes from `KATA_REF`, a ticket the session claimed with `kata claim <ref>`, the user's `/todo ref <ref>`, or the session's existing parent; otherwise the plugin makes an automatic parent.
- An op on a task another session holds is refused and tells the model to ask the user, who runs `/todo takeover <task>`.

#### Development

- `smoke:omp` selects the `kata` todo backend for every run, scripts omp's own `todo` params, closes each plan task with `kata close` before its `done`, and checks the refusals the model is sent.

### Removed

#### Plans

- The plugin's own `todo` tool, and with it the `message`, `evidence`, `ref`, `replace` and `takeover` params; evidence goes on the agent's `kata close`.
- `block` and `unblock`: omp has had no `blocked` status since 18.20.0. Record a wait with `kata comment`; omp's own stop reminder still fires while tasks are open.
- The plugin's own stop reminder, and its handling of `/todo` subcommands other than `takeover` and `ref`; omp's own `/todo` handles them. The stop hook stays and settles the turn.

#### Display

- The plugin's Tern todo card, dock pill and progress widget. omp draws its own list.

### Fixed

#### Plans

- Restarting a closed task you own reopens it, instead of failing with "no longer owned" when Kata cleared the owner on close.

## [2.12.1] - 2026-11-18

### Fixed

#### Plans

- A plan item named as the plan view lists it, `<content> (<ticket or ref>)`, is that item for every op.
  - `init` and `append` drop that suffix, and a ticket item's own ref repeated after its action, so an item copied from the view keeps its content and shows its ticket once.
  - The stop reminder lists open items the same way, followed by their status.

#### Delegates

- A `task` call that names a ticket goes ahead while Kata cannot be reached, and its delegate's assignment is retried on its next use, instead of the call being refused with Kata's error.

#### Inbox and attention

- A request sent while an earlier inbox read was still answering shows in that turn's `<kata_inbox>` section, not only on the next turn.

## [2.12.0] - 2026-11-16

### Added

#### Install and update

- The plugin is on npm as `@dangerboi/kata-omp`, listed on [omp packages](https://omppackages.com), and installs with `omp plugin install @dangerboi/kata-omp`. Use it or the marketplace, not both.

### Changed

#### Install and update

- A marketplace install registers as `@dangerboi/kata-omp` instead of `kata-omp`, the npm package's name, so omp loads the plugin once whichever way it was installed.
  - Upgrading the marketplace install moves it to the new name. Do that, or uninstall it, before installing from npm: an install still named `kata-omp` and the npm package load the plugin twice.

#### Plans

- A failed `/todo` refreshes the plan, as the tool does.
- `init` with `takeover: true` is refused and changes nothing; `takeover` applies to ops that name a task.

#### Development

- `bun run test:todo` is now `bun run test:files`. `bun run test` stops at once without an absolute `KATA_TEST_EXECUTABLE`, ignores the developer's own Kata and plugin settings, and removes its throwaway folder after a passing run (the next run removes those of runs that died).
- `bun run typecheck` covers `scripts/`. The omp smoke provider picks an agent's script by the longest marker in its first message, as the OpenCode provider does, and interrupting `smoke:omp` or `smoke:omp-attention` stops the host and the Kata daemon and removes the throwaway folder.
- The tests and smoke runs clear one list of variables, so `smoke:omp` and `smoke:opencode` no longer run under the developer's Kata identity or executable settings. `smoke:opencode` drops `--no-plugin` and its `noop` scenario.
- Vendored plugin copies start with a line naming their core file; `build:plugins` removes a copy whose core file is gone, and `check:plugins` rejects one.
- The publish workflow pins its actions and publishes only after a verify job (`check:plugins` and `npm pack --dry-run` for every package) passes.

### Fixed

#### Plans

- A task whose session ended normally is held again by the session that next starts it; before, any other session could change it without a takeover.
- A session that ends while Kata has deferred a close keeps that task's hold, so the retry still closes it. Before, the release voided the close.
- Switching to a session whose plan parent cannot be read still releases the previous session's tasks and ends its attention.
- Two tasks with the same title dropped for the same reason get distinct close messages, which Kata's close throttle no longer refuses.
- `/todo takeover` of a blocked task takes it over without reporting an error; the task stays blocked.
- `todo done` whose evidence is blank is refused with the plugin's guidance instead of Kata's error, and blank entries beside real evidence are left out of the close.
- A lead's todo call keeps its session mark and holder checks when a subagent's session start reaches the lead mid-call.
- `view` retries a held ticket close in a plan of ticket items alone, as every other op does.
- An automatic parent's title made from a long message or session name is cut to 120 characters.

#### Delegates

- A later turn of a subagent (a revival, or its answer to a message) reports on the issue or mission of its first run, instead of creating a second mission or repeating its report.
- A background `task` whose subagent starts after the call returned still gets the plan item or ticket it named, and a second call naming it meanwhile is refused.
- A delegate whose assignment failed on an issue another teammate owns no longer comments on, labels or notifies that issue when it exits.
- A mission whose close Kata throttled is saved at once, so a lead that ends or is killed before the retry still closes it when resumed.
- A delegate that starts without a checked `task` call follows the same rules as the check.
  - A spawn that names a blocked ticket item runs untracked, as one naming a blocked plan task does.
  - One that names a ticket it cannot take (closed, or another teammate's) is untracked and leaves a mission, instead of failing with its report lost.
  - A ticket Kata could not be read for is no such refusal: the assignment is retried on the delegate's next use, and a delegate that exits before it was decided leaves its report as a mission.
- A delegate's close made before its own session is known, from its bash or its own todo plan, records no transcript instead of the lead's session. A delegate with no record runs Kata under the same teammate its record would have.
- A subagent whose task lifecycle reports `cancelled` is settled as aborted.
- A delegate's `kata close` in the shell carries `KATA_CLOSE_TRANSCRIPT_ENABLED` with its transcript pair.

#### Inbox and attention

- Once a plan has a parent, the session inbox trusts Kata's effective actor rather than the author setting read before the plan was bound.

#### Development

- `bun run test` no longer fails its default-store check when a real session writes to `~/.kata` during the run with text that names a test fixture, such as a sub-agent task mentioning "fixture". The check counts only events from test actors or in test projects, and its lists gain the test actors and projects they were missing.
- A pull request fails when a vendored copy in any plugin folder, `plugins/opencode` included, is stale or missing. CI checks the committed copies before the tests instead of regenerating them.

## [2.11.0] - 2026-11-15

### Added

#### Plans

- An automatic parent whose only children besides retired tasks are missions closes as `audit-no-change` instead of staying open for review.
  - A mission adds no evidence to a parent that closes as done, so it never leaves that parent `needs-review`.
  - A mission left open because the plugin could not close it (a pi child's close was throttled or cut off by its shutdown budget, a kill) is closed by the parent's audit once nothing else under the parent is open.

#### Delegates

- An untracked delegate (an omp `task` subagent, a pi child or an OpenCode subagent whose task names no plan item or ticket) that exits with a report leaves a mission: a closed child issue of the plan parent with its task, its agent and its report.
  - The plugin makes and closes the mission itself, as `audit-no-change`, so a delegate without `bash` such as omp's `scout` gets one too. Any change the run made is the lead's to verify.
  - With no plan parent, the plugin creates the automatic parent for it; it never creates one beside an explicit parent.

### Changed

#### Plans

- A todo call, a session start and a turn end make 11–14% fewer Kata calls, which matters most with a Kata daemon over the network.
  - An issue read twice in one call is read once, until anything in the same process writes to Kata. Changes made elsewhere show from the next call on, as before.
  - The effective actor is read once per session and project instead of before every task change, and session start checks that Kata answers once.

#### Delegates

- A delegate is bound to a plan item only when its task text names the item: its title (quoted, as the whole text, or three or more words), its ref, its short id after `issue`, `kata`, `ref`, `task` or `#`, or for a ticket item its ticket's ref.
  - Word overlap, the item marked for delegation and the "current task" handoff no longer bind anything.
  - A spawn that only describes an item's work, such as a reviewer or scout, runs untracked and no longer claims or closes that item; the lead finishes it with `todo done`.
  - A ticket item whose ticket is the plan parent is not named by that ref, so a delegate's task text may cite the parent.

#### Development

- `bun run test` runs the test files in a pool of `bun test` processes instead of one, the slowest files first: 8 workers, or fewer on a machine with fewer CPUs.
  - `KATA_TEST_JOBS=<n>` sets the pool size; `KATA_TEST_JOBS=1` runs everything in one process for debugging.
- The pull-request test check runs the test files in two parallel jobs, half the files each (`.github/workflows/compatibility.yml`).
  - `KATA_TEST_SHARD=<i>/<n>` keeps slice i of n of the test files in a full run, locally too.

### Fixed

#### Delegates

- A delegation call with several spawns that name no plan item is no longer refused with "Ticket … is already delegated" when the plan has an open ticket item.
  - A ticket item whose ticket another spawn or delegate has already reserved is not matched again.
- A delegate leaves its issue open when its task text says not to close issues or to leave the issue open; it is handed back (`needs-review`) and the lead closes it after its own checks.

## [2.10.0] - 2026-11-13

### Added

#### Plans

- `todo` takes a task over from a lead session that crashed: `takeover: true` on `start`, `done`, `drop`, `rm`, `block` or `unblock` naming the task, or `/todo takeover <task>`.
  - The takeover comments both sessions on the issue, then makes this session the task's holder.

### Fixed

#### Plans

- Two lead sessions on the same plan parent no longer change each other's started tasks, even with the same actor and no `KATA_TEAMMATE`.
  - Plan tasks record the lead session that created them, then the one that started or blocked them (`todo.session`).
  - Another lead is refused on a task in progress or blocked under a different session, including `init` with `replace: true`. Delegates are not matched to it.
  - The plan text marks such a task, and `done`, `drop` or `block` without a task name no longer guesses while one is in progress.
  - A fork counts as the session it was forked from, and a resumed session as itself.
  - A lead that shuts down or switches to another session releases the tasks it started, so the next session continues them. A pi reload keeps them. A fork that replaces its source in the same process (pi `/fork` into a saved session, an omp switch to a fork) inherits them when it works the same plan; a fork from before the plan releases them.
  - Pending and closed tasks, ticket items and tasks created by earlier versions keep the actor and teammate check alone.

## [2.9.2] - 2026-11-10

### Fixed

#### Requirements

- Both omp and Pi now check for Kata >=0.23.0 before using the CLI and show an upgrade error for older or unrecognized versions. Missing executables and unreachable Kata still use the local plan fallback. Thanks to @salmonumbrella ([#37](https://github.com/Dangerboi/kata-plugin/pull/37)).

#### Inbox and attention

- A native Pi started from the lead's bash tool with the lead's `KATA_REF` no longer takes over the lead's attention session. Thanks to @salmonumbrella ([#38](https://github.com/Dangerboi/kata-plugin/pull/38)).
  - With `KATA_REF` set, the lead publishes Kata's `KATA_ATTENTION_HOST` marker before session start or switch returns, and removes it at session end if it is still its own.
  - Session start or switch with `KATA_REF` now waits up to 10 s, not 250 ms, for the plan binding, attention and the marker.

#### Development

- Pull requests run the full test suite, the typecheck and the vendored-copy drift check against the public Kata 0.23.0 release (`.github/workflows/compatibility.yml`). Thanks to @salmonumbrella ([#37](https://github.com/Dangerboi/kata-plugin/pull/37)).
- Pull requests that touch the plugins also run a smoke test against real omp 18.18.1 and 18.18.6 (`.github/workflows/omp-attention.yml`): an omp lead and a Pi lead each start a native Pi from their bash tool, and the lead's attention must not change. Thanks to @salmonumbrella ([#38](https://github.com/Dangerboi/kata-plugin/pull/38)).

## [2.9.1] - 2026-11-10

### Fixed

#### Delegates

- A plan item a delegate closed no longer blocks the lead's next `todo init` with "belongs to a delegate".
  - When the delegate exits, its closed issue returns to the lead's teammate with `todo.status` completed (abandoned when closed as wontfix) and no subagent key; on omp, `omp.status` is set to its outcome.
  - A closed item still marked by a delegate that no unfinished delegate of the session holds (left by an earlier version, a pi child killed after closing, a lead never resumed, or another session) is returned to the lead the next time the plan touches it, as long as the lead's actor owns it.
  - A returned item can be reopened with `todo start` or by appending it again, as an item the lead closed can.

#### Development

- An interrupted test run no longer leaves Kata daemons running.
  - Ctrl-C or SIGTERM now stops the tests and the daemons in the run's throwaway root before the runner exits.
  - A run killed outright leaves them behind; the next run stops them when it starts.

## [2.9.0] - 2026-11-09

### Added

#### Development

- `bun run test:changed [ref]` runs only the test files whose imports reach a file git reports as changed, for a faster edit loop. `bun run test` is still the check before a commit; see [development](docs/development.md) for what it misses.

### Changed

#### Requirements

- **Breaking:** Requires Kata 0.23.0. On older Kata every todo create fails; upgrade Kata first.
  - Kata 0.23.0 upgrades its SQLite store in place (index-only). Back up `~/.kata` first if you may need to go back to an older Kata.
  - Restart the Kata daemon after upgrading.
  - Rerun `kata init` in a repo with a `.kata.toml` to add Kata's agent header to it.
  - If you use Kata's own pi hook, rerun `kata agent-hook install pi --attention` so it passes the session folder.
- With Kata 0.23.0, a session gets the Kata contract only in a folder with a `.kata.toml`, and the contract is Kata's shorter single-agent version.
  - Plans and assignments work in other folders as before. Running `kata init --project <name>` in a folder adds a `.kata.toml`, and that folder's new plans then go to that project instead of `KATA_DEFAULT_PROJECT`.

#### Plans

- Closes record the session transcript with no Kata config: omp and pi turn close transcripts on for their own sessions.
  - Launch omp or pi with `KATA_CLOSE_TRANSCRIPT_ENABLED=false` to turn them off; `[close.transcript] enabled = false` in Kata's config does not stop them.
  - Harnesses started from the `bash` tool, such as `claude -p`, inherit the setting and record too.
  - If you set `[close.transcript] enabled = true` only for omp and pi, you can remove it; closes from a plain terminal then stop warning about a missing session.

### Fixed

#### Plans

- Re-adding a removed item and resuming a session keep working after `[create].default_priority` changes in Kata's config; plan tasks and automatic parents no longer take the default priority.
  - Plan tasks and automatic parents made by an earlier version keep replaying too, also after their priority was edited.

## [2.8.0] - 2026-11-09

### Added

#### Plans

- `todo done` on a plan task also comments its message and evidence on the issue, so the work shows in the issue's comments and not only as its close reason.

#### Delegates

- Each delegate bound to an issue (an omp subagent or a child pi) is told to comment what it did, how it verified it and what remains before it finishes, closed or not.
  - An issue several delegates worked has one comment per delegate, beside the plugin's own hand-back note.
- A delegate that exits without commenting gets its final report posted on its issue for it, under its own teammate: its last assistant text, or what it yielded, cut at 4000 characters.

## [2.7.1] - 2026-11-08

### Fixed

#### Display

- The `#` ticket menu lists each ticket once after `/new` or `/resume`.
  - omp keeps every autocomplete provider for the life of the process, and each session switch added another, so every switch repeated each ticket one more time. Now only the newest one offers tickets.

## [2.7.0] - 2026-11-08

### Added

#### Plans

- `todo` results give each task its `ref` in `details.kata.phases`, add `local` for a session-local plan, and add `notice` for text the result shows before the plan (an error, a close Kata deferred, a deleted parent).

#### Display

- In Tern, the plan looks like omp's own todo.
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
- A `task` that would delegate a ticket is refused while another open plan item names the same ticket.
  - The delegate closes the whole ticket, so the lead's other items on it could no longer be marked done and the plan stayed unfinished.
  - Delegate the ticket once it is the last open item for it, or plan the work as child issues (`todo init` with the ticket as `ref`) and delegate one of those.

### Fixed

#### Plans

- A turn end right after one you interrupted with Esc gives the open-task reminder again.
  - When the earlier turn's delegate hand back finished during the first 250 ms of the next turn end, that turn end returned no reminder.

#### Display

- The `#` ticket menu shows the whole title and lists Kata tickets first.
  - A row shows the qualified ref, which accepting inserts, with the title beside it. Both hosts cut the first column at 32 characters, so titles used to stop mid-word.
  - On omp, prompt actions such as "Copy whole prompt" came first, so Tab copied the prompt instead of inserting the ticket.

## [2.6.1] - 2026-11-08

### Added

#### Delegates

- Resuming a lead session finishes the delegate cleanups it never finished.
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

- Delegate hand backs and rollbacks survive a busy turn end.
  - When a lead turn ends while exited delegates are not yet handed back or rolled back, the plugin waits up to 15 s (was 0.25 s) for those cleanups. A turn with nothing to clean up still ends within 0.25 s.
  - With many delegates, omp's 2 s shutdown limit used to cut off cleanups still queued at exit: the issue kept the delegate's teammate and `omp.status running`, with no `needs-review` and no inbox request.
  - `/exit` or Ctrl+C while delegates run is still cut off after 2 s; see [Limits](docs/explanation/limits.md) (Shutdown budget).
- A delegate whose issue was deleted while it ran is let go instead of retried at every cleanup pass (omp and pi).

## [2.6.0] - 2026-11-08

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

### Fixed

#### Delegates

- Large delegations on a busy machine keep their issues.
  - A delegate's first prompt waits up to 15 s (was 3 s) for its Kata issue, and stops waiting as soon as the issue is assigned.
  - The lead assigns delegates one at a time, about fifteen Kata calls each, so the later subagents of a large `task` call used to start with no issue in their prompt and no tracked close: about half of a fourteen-delegate call on a loaded machine.
- A delegate's own `todo` close records the delegate's session even when an event from another agent identity reaches its handlers while the close runs.
  - The close used to take the identity of the latest event, so it could record no session, or that identity's.

## [2.5.1] - 2026-11-07

### Added

#### Plans

- Close transcripts record omp and pi sessions once `[close.transcript] enabled = true` is in Kata's `config.toml`.
  - The plugin's own closes and the agent's `kata close` calls record `omp <id>` or `pi <id>`; `session_id_env` is no longer needed for omp or pi.
  - omp delegates record their own session on every close they run: a `kata close` in `bash`, and their own `todo` `done`, `drop` and `rm`.
  - Another harness launched from omp's or pi's `bash` tool inherits the pair, so its closes link the launching session.

#### Delegates

- Delegates on worker threads are tracked.
  - omp 18.17 runs a subagent on a worker thread, with its own copy of the plugin, once nine or more run at once. That copy asks the lead's copy on the main thread for its assignment.
  - The delegate sees its issue in its prompt, its `todo` works under that issue, its `kata` commands carry its teammate, and its tool use reaches the lead's rollback and hand back.

#### Inbox and attention

- A `kata notify` reaches the agent right away. The main session follows `kata events --tail` and delivers each new trusted request as an aside.
  - An idle agent starts a turn on it; a working agent gets it at its next step boundary without its tool batch being interrupted (a pending approval or `ask` stays pending).
  - The message is cut at 1024 bytes like the inbox section's, and marked as untrusted data, not instructions.
  - The `<kata_inbox>` section is kept current from the same stream, so a prompt no longer starts a `kata inbox` read. A failed first read is retried with backoff (1 s to 30 s), and a stream that keeps dropping backs off instead of restarting every second.
  - A later session start in the same process, in any workspace of the same project, reads the event log on from the position it already knew.
  - `KATA_OMP_LIVE_INBOX=0` keeps the per-turn read; tern-kata sets it for agents that load its own delivery extension. Delegates and pi still read their inbox every turn.

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

#### Delegates

- A delegate that exits without having run a tool has its assignment rolled back (omp and pi): claim, teammate, status, attention and subagent key are restored, and nothing is labelled `needs-review`.
  - One that ran a tool and left its issue open is commented, set to `work.attention needs-human` and handed back.
  - A failed assignment is retried on the delegate's next prompt or `todo` call.

#### Inbox and attention

- Only an `<actor>/<name>` address in `KATA_INBOX_USER` is read as a session inbox.
  - A bare `<actor>`, as set for tern-kata's Attention Page or `kata inbox`, is that person's inbox, holding requests agents wrote for them; omp and pi sessions used to put it into every system prompt. It is now skipped with a one-line notice per session.
  - To steer a plain omp session through its inbox, start it with `KATA_INBOX_USER=<actor>/<name>` and notify that address.
- Only your own requests steer a session: the inbox section shows only requests whose sender is the session's own actor.
  - On a daemon without authentication the sender is self-declared, so this stops other people's requests, not impersonation (see [Limits](docs/explanation/limits.md)).
  - The section is capped like `kata inbox --context` (8 KB, with an `[N request(s) omitted…]` line), and a reply row for a comment reads as Kata prints it.
  - Under Kata's native pi adapter (`kata agent-hook install pi --attention`), which inserts the inbox itself, this filter does not apply.

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

#### Delegates

- A delegate whose assignment failed is handed back when it exits, like a delegate that left its issue open: `needs-review`, an inbox request to the lead, and the task back on the lead's teammate.
  - It used to keep the delegate's teammate, refuse the lead's `todo done`, and keep the automatic parent open for good.

#### Inbox and attention

- After a `kata purge`, a session start no longer replays old inbox requests. The live follower used to take the purge marker for the newest event.

## [2.4.0] - 2026-11-03

### Added

#### Development

- The `untracked` smoke scenario sends a `scout` that matches no plan item and checks that it leaves no issue, `needs-review` label or inbox request, and that the parent closes from the plan's own items (scripted and `--live`).

### Changed

#### Delegates

- A `task` that matches no plan item and names no ticket gets no Kata issue.
  - It used to get a `Subagent` issue that an agent without `bash` (the `scout`) could not close: an open issue, a `needs-review` label, a `kata notify` and a parent that never closed.
  - Such a subagent gets a short note instead of a binding, and its `todo` uses omp's own list (an error on an omp without `ctx.invokeTool`).
  - A delegation no longer creates the automatic parent, which closes from the plan's own items. pi is unchanged.

## [2.3.0] - 2026-11-03

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

#### Delegates

- A delegate's first prompt waits up to 3 s (was 250 ms) for its issue binding, so a slow Kata no longer leaves it without its issue.

#### Inbox and attention

- The inbox is read every turn, so a `kata notify` sent mid-session reaches the agent on that turn or the next. The contract is still fetched once per session.

### Fixed

#### Plans

- A forked session keeps its source's plan instead of starting an empty parent. It does not take over the source's pending close retries or offline plan, and the shared parent still closes only when every task is closed.
- `todo` in a `/tan` side conversation uses omp's own session-only list and leaves Kata alone, instead of failing with a binding error.
- The close retry timer runs on omp's session timer, so shutdown clears it.

#### Delegates

- A `revive` of a parked subagent does no Kata work.

## [2.2.0] - 2026-10-31

Every change in this release is by @salmonumbrella ([#4](https://github.com/Dangerboi/kata-plugin/pull/4), [#5](https://github.com/Dangerboi/kata-plugin/pull/5)).

### Changed

#### Install and update

- Installing the oh-my-pi plugin is the whole setup: Kata becomes the only todo system, in every folder. The `todo.enabled: false` step is gone, and the setting keeps working.

#### Plans

- **Breaking:** The plugin's `todo` replaces the built-in one, and its results carry the plan under `details.kata` instead of `details.phases`, so omp's own reminders, mid-run nudge and HUD have nothing to track. Scripts reading `details.phases` must read `details.kata.phases`.
- A folder with no Kata project plans in `KATA_DEFAULT_PROJECT` (issues labeled with the repo), or in its inferred project, registered with `kata projects create`; no `kata init`, no files in the repo. `project_not_initialized` no longer produces a session-local plan.
- If Kata is unusable (missing executable, unreachable daemon), the plan is session-local with one warning per session, and it replays into Kata when Kata returns.
- The automatic session parent is created on the first todo mutation, so a session that never plans leaves no issue.
  - The pi adapter shares the project resolution, lazy parent and replay changes.

### Fixed

#### Plans

- Retries and refused updates no longer drop a promised close or act on a stale plan: todo changes are tied to the current actor, teammate and plan revision.
  - An automatic parent closes only when every child has accepted evidence.
  - An interrupted parent setup recovers with its original session identity.

#### Inbox and attention

- The plugin skips its Kata contract when the system prompt already carries it.

[Unreleased]: https://github.com/Dangerboi/kata-plugin/compare/omp-v3.1.0...HEAD
[3.1.0]: https://github.com/Dangerboi/kata-plugin/compare/omp-v3.0.0...omp-v3.1.0
[3.0.0]: https://github.com/Dangerboi/kata-plugin/compare/omp-v2.12.1...omp-v3.0.0
[2.12.1]: https://github.com/Dangerboi/kata-plugin/compare/omp-v2.12.0...omp-v2.12.1
[2.12.0]: https://github.com/Dangerboi/kata-plugin/compare/omp-v2.11.0...omp-v2.12.0
[2.11.0]: https://github.com/Dangerboi/kata-plugin/compare/omp-v2.10.0...omp-v2.11.0
[2.10.0]: https://github.com/Dangerboi/kata-plugin/compare/omp-v2.9.2...omp-v2.10.0
[2.9.2]: https://github.com/Dangerboi/kata-plugin/compare/omp-v2.9.1...omp-v2.9.2
[2.9.1]: https://github.com/Dangerboi/kata-plugin/compare/omp-v2.9.0...omp-v2.9.1
[2.9.0]: https://github.com/Dangerboi/kata-plugin/compare/omp-v2.8.0...omp-v2.9.0
[2.8.0]: https://github.com/Dangerboi/kata-plugin/compare/omp-v2.7.1...omp-v2.8.0
[2.7.1]: https://github.com/Dangerboi/kata-plugin/compare/omp-v2.7.0...omp-v2.7.1
[2.7.0]: https://github.com/Dangerboi/kata-plugin/compare/omp-v2.6.1...omp-v2.7.0
[2.6.1]: https://github.com/Dangerboi/kata-plugin/compare/omp-v2.6.0...omp-v2.6.1
[2.6.0]: https://github.com/Dangerboi/kata-plugin/compare/omp-v2.5.1...omp-v2.6.0
[2.5.1]: https://github.com/Dangerboi/kata-plugin/compare/omp-v2.4.0...omp-v2.5.1
[2.4.0]: https://github.com/Dangerboi/kata-plugin/compare/omp-v2.3.0...omp-v2.4.0
[2.3.0]: https://github.com/Dangerboi/kata-plugin/compare/omp-v2.2.0...omp-v2.3.0
[2.2.0]: https://github.com/Dangerboi/kata-plugin/compare/v1.1.1...omp-v2.2.0
