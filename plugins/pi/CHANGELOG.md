# Changelog

All notable changes to `@dangerboi/kata-pi` are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package uses [semantic versioning](https://semver.org/spec/v2.0.0.html). Releases are tagged `pi-v<version>`. Up to 1.12.0, pi and omp released together under one kata-plugin `v<version>` tag, with pi's version; those commits carry `pi-v` tags too.

## [Unreleased]

### Added

#### Inbox and attention

- Main sessions and child processes check their session inbox on tool results while they work, so a request sent mid-run arrives on a later tool result without waiting for a new prompt.
  - A new or changed inbox is appended to the first tool result after the read has answered as a `<kata_inbox>` text part, under the same own-actor filter and escaping as the prompt's section, and the result keeps its `structuredContent`. A request this plugin's own prompt section already showed is not repeated, and an inbox that clears is announced once.
  - At most one `kata inbox` read every 15 seconds, set with `KATA_INBOX_POLL_SECONDS` (`0` for every result). The read never holds up the result; a failed read sends nothing.
  - Nested script calls carry no block. Under Kata's native pi adapter, which reads the inbox only at prompts, the main session's tool results check it too, with this plugin's filter and escaping.

## [1.13.0] - 2026-11-26

### Added

#### Repository content

- A `write`, `edit` or `bash` `git commit` call that adds a Kata ref the session works to a file under the project folder or to a commit message is refused, and the reason tells the model to describe the behaviour instead. Kata refs only resolve in the local tracker.
  - Set `KATA_REF_GUARD=off` (or `0`) to turn it off.

### Changed

#### Inbox and attention

- A child's assignment or `<kata_binding>` note names its inbox address, `<actor>/<teammate>`, when `KATA_INBOX_USER` is a session address.

### Fixed

#### Requirements

- The plugin works with pi 1.2 and later, whose `before_agent_start` also fires for runs that start from a custom message.

#### Delegates

- A child pi whose first run starts from a custom message joins the plan item that message's text names.

#### Inbox and attention

- A request's text can no longer close the `<kata_inbox>` section or open a tag: `&`, `<` and `>` are written as `&amp;`, `&lt;` and `&gt;` in the section, when the plugin reads the inbox (not under Kata's native pi adapter, which inserts it).

## [1.12.2] - 2026-11-23

### Fixed

#### Plans

- Restarting a closed task you own with `todo` reopens it, instead of failing with "no longer owned" when Kata cleared the owner on close.

## [1.12.1] - 2026-11-18

### Fixed

#### Plans

- A plan item named as the plan view lists it, `<content> (<ticket or ref>)`, is that item for every op.
  - `init` and `append` drop that suffix, and a ticket item's own ref repeated after its action, so an item copied from the view keeps its content and shows its ticket once.
  - The stop reminder lists open items the same way, followed by their status.

#### Inbox and attention

- A request sent while an earlier inbox read was still answering shows in that turn's `<kata_inbox>` section, not only on the next turn.

## [1.12.0] - 2026-11-16

### Changed

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
- `view` retries a held ticket close in a plan of ticket items alone, as every other op does.
- An automatic parent's title made from a long message or session name is cut to 120 characters.

#### Delegates

- A child resumed after its run ended posts its next report on its issue or mission instead of dropping it.
- A delegate whose assignment failed on an issue another teammate owns no longer comments on, labels or notifies that issue when it exits.
- A mission whose close Kata throttled is saved at once, so a lead that ends or is killed before the retry still closes it when resumed.
- A delegate that starts without a checked `task` call follows the same rules as the check.
  - A spawn that names a blocked ticket item runs untracked, as one naming a blocked plan task does.
  - One that names a ticket it cannot take (closed, or another teammate's) is untracked and leaves a mission, instead of failing with its report lost.
  - A ticket Kata could not be read for is no such refusal: the assignment is retried on the delegate's next use, and a delegate that exits before it was decided leaves its report as a mission.
- A delegate's `kata close` in the shell carries `KATA_CLOSE_TRANSCRIPT_ENABLED` with its transcript pair.

#### Inbox and attention

- Once a plan has a parent, the session inbox trusts Kata's effective actor rather than the author setting read before the plan was bound.

#### Development

- `bun run test` no longer fails its default-store check when a real session writes to `~/.kata` during the run with text that names a test fixture, such as a sub-agent task mentioning "fixture". The check counts only events from test actors or in test projects, and its lists gain the test actors and projects they were missing.
- A pull request fails when a vendored copy in any plugin folder, `plugins/opencode` included, is stale or missing. CI checks the committed copies before the tests instead of regenerating them.

## [1.11.0] - 2026-11-15

### Added

#### Plans

- An automatic parent whose only children besides retired tasks are missions closes as `audit-no-change` instead of staying open for review.
  - A mission adds no evidence to a parent that closes as done, so it never leaves that parent `needs-review`.
  - A mission left open because the plugin could not close it (a pi child's close was throttled or cut off by its shutdown budget, a kill) is closed by the parent's audit once nothing else under the parent is open.

#### Delegates

- An untracked delegate (an omp `task` subagent, a pi child or an OpenCode subagent whose task names no plan item or ticket) that exits with a report leaves a mission: a closed child issue of the plan parent with its task, its agent and its report.
  - The plugin makes and closes the mission itself, as `audit-no-change`, so a delegate without `bash` such as omp's `scout` gets one too. Any change the run made is the lead's to verify.
  - With no plan parent, the plugin creates the automatic parent for it; it never creates one beside an explicit parent.
- A child whose task names two or more tickets or plan items gets its report posted on each of them, and none is closed.
  - A child refused because its task is already delegated or held still records nothing.

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

## [1.10.0] - 2026-11-13

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

## [1.9.2] - 2026-11-10

### Fixed

#### Requirements

- Both omp and Pi now check for Kata >=0.23.0 before using the CLI and show an upgrade error for older or unrecognized versions. Missing executables and unreachable Kata still use the local plan fallback. Thanks to @salmonumbrella ([#37](https://github.com/Dangerboi/kata-plugin/pull/37)).

#### Development

- Pull requests run the full test suite, the typecheck and the vendored-copy drift check against the public Kata 0.23.0 release (`.github/workflows/compatibility.yml`). Thanks to @salmonumbrella ([#37](https://github.com/Dangerboi/kata-plugin/pull/37)).
- Pull requests that touch the plugins also run a smoke test against real omp 18.18.1 and 18.18.6 (`.github/workflows/omp-attention.yml`): an omp lead and a Pi lead each start a native Pi from their bash tool, and the lead's attention must not change. Thanks to @salmonumbrella ([#38](https://github.com/Dangerboi/kata-plugin/pull/38)).

## [1.9.1] - 2026-11-10

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

## [1.9.0] - 2026-11-09

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

## [1.8.0] - 2026-11-09

### Added

#### Plans

- `todo done` on a plan task also comments its message and evidence on the issue, so the work shows in the issue's comments and not only as its close reason.

#### Delegates

- Each delegate bound to an issue (an omp subagent or a child pi) is told to comment what it did, how it verified it and what remains before it finishes, closed or not.
  - An issue several delegates worked has one comment per delegate, beside the plugin's own hand-back note.
- A delegate that exits without commenting gets its final report posted on its issue for it, under its own teammate: its last assistant text, or what it yielded, cut at 4000 characters.

### Changed

#### Delegates

- A child pi is named by its `--name`, else by the task or ticket it works, else by the end of its session id, instead of by its session UUID.
  - Its teammate follows (`wordcounter-0c2d7b` instead of `pi-01a1bfd6-…`), and so do its instructions, report heading, hand-back comment, notify message and attention message.
  - A child resumed from an earlier version keeps its old teammate.

#### Development

- Pushing a release tag publishes the pi package from GitHub Actions through npm trusted publishing, so a release no longer needs an npm login or a one-time code; see [development](docs/development.md#releases).

## [1.7.2] - 2026-11-08

### Fixed

#### Display

- The `#` ticket menu lists each ticket once after `/new` or `/resume`.
  - omp keeps every autocomplete provider for the life of the process, and each session switch added another, so every switch repeated each ticket one more time. Now only the newest one offers tickets.

## [1.7.1] - 2026-11-08

### Changed

#### Install and update

- The npm package is `@dangerboi/kata-pi`; install it with `pi install npm:@dangerboi/kata-pi`.
  - npm refused the name `kata-pi` as too close to an existing package, so 1.7.0 never reached npm.

## [1.7.0] - 2026-11-08

### Added

#### Install and update

- The pi package is ready for npm and the [Pi package gallery](https://pi.dev/packages).
  - The package carries the license and this changelog, so pi shows the new entries after an update.
  - Its manifest points the gallery at a preview image and a short silent video in `docs/media/`.

### Changed

#### Install and update

- Release headings follow Keep a Changelog, `## [1.6.1] - 2026-11-08`, with the plugin versions on the line below. pi still reads the version from the heading.

#### Plans

- The `todo` tool description says the tool does the Kata bookkeeping for its tasks and ticket items: it claims them, keeps their `work.attention` and closes them.
  - It tells the model not to run `kata claim`, `kata meta set … work.attention` or `kata close` for them, and not to plan that bookkeeping as items. Kata's agent contract asks agents to claim and set attention, so models did both by hand.

#### Delegates

- The `todo` tool description tells the lead that a delegate bound to a plan item or ticket closes that issue itself once its work is verified, so the item shows done without the lead's `done`.
  - Leads used to report the delegate's close as unexpected.

#### Development

- Releases add an `npm publish` from `plugins/pi`; see [development](docs/development.md#releases).

### Fixed

#### Display

- The `#` ticket menu shows the whole title and lists Kata tickets first.
  - A row shows the qualified ref, which accepting inserts, with the title beside it. Both hosts cut the first column at 32 characters, so titles used to stop mid-word.
  - On omp, prompt actions such as "Copy whole prompt" came first, so Tab copied the prompt instead of inserting the ticket.

## [1.6.1] - 2026-11-08

### Fixed

#### Delegates

- A delegate whose issue was deleted while it ran is let go instead of retried at every cleanup pass (omp and pi).

## [1.6.0] - 2026-11-08

### Added

#### Development

- Every test runner and `smoke:omp` refuse to start while a vendored copy in `plugins/*` differs from `core/`; run `bun run build:plugins` after a `core/` edit.

### Changed

#### Install and update

- Each plugin folder gains `model.ts`, `kata-cli.ts`, `shell.ts` and `autocomplete.ts`; copy the folder whole when installing by hand.
  - The shared core is split by job, and the oh-my-pi adapter's source lives in `plugins/oh-my-pi/kata.ts` instead of a generated copy of a root file.

#### Plans

- Both hosts show the same `todo` parameter descriptions.
- A task completed while Kata was unreachable replays blocked unless its message has 40 characters after runs of whitespace are collapsed, the same rule `done` applies.

#### Inbox and attention

- **Breaking:** The plugin no longer pre-fills Kata's native attention record or clears `KATA_REF` in the main session. If you have not run `kata agent-hook install pi --attention` since upgrading Kata to 0.21 or later, run it and restart pi. Thanks to @salmonumbrella ([#15](https://github.com/Dangerboi/kata-plugin/pull/15)).
  - Kata 0.21's pi hook keeps child sessions off the lead's attention itself. A hook generated by an older Kata lacks that guard, so a pi child that does not load this plugin takes over the lead's attention and marks the lead's issue `needs-human` when it quits.
  - Commands the main session's `bash` tool starts now inherit its `KATA_REF`. A child that loads the plugin still drops the inherited `KATA_REF` and works its own issue.

### Fixed

#### Delegates

- Large delegations on a busy machine keep their issues.
  - A delegate's first prompt waits up to 15 s (was 3 s) for its Kata issue, and stops waiting as soon as the issue is assigned.
  - The lead assigns delegates one at a time, about fifteen Kata calls each, so the later subagents of a large `task` call used to start with no issue in their prompt and no tracked close: about half of a fourteen-delegate call on a loaded machine.

## [1.5.1] - 2026-11-07

### Added

#### Install and update

- The omp marketplace catalog also lists `kata-pi` (source `plugins/pi`), so tools that read the catalog, such as Skillshare, can install the pi build from the Git URL. Under omp its entry exits without loading. Thanks to @salmonumbrella ([#10](https://github.com/Dangerboi/kata-plugin/pull/10)).

#### Plans

- Close transcripts record omp and pi sessions once `[close.transcript] enabled = true` is in Kata's `config.toml`.
  - The plugin's own closes and the agent's `kata close` calls record `omp <id>` or `pi <id>`; `session_id_env` is no longer needed for omp or pi.
  - omp delegates record their own session on every close they run: a `kata close` in `bash`, and their own `todo` `done`, `drop` and `rm`.
  - Another harness launched from omp's or pi's `bash` tool inherits the pair, so its closes link the launching session.

#### Development

- Run the suite against the installed Kata with `KATA_TEST_EXECUTABLE="$(readlink -f "$(command -v kata)")" bun run test`. Error fixtures are re-captured from Kata 0.21.0.

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
- A child that matches no plan task and names no ticket is untracked, like an omp `task` that matches nothing.
  - It no longer creates a `Subagent <id>` issue, gets the untracked context, and its `kata` calls are rewritten with its teammate.
  - An assigned child's `todo` plans under its own issue, and its assignment is saved in its session, so a resumed child keeps it.

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

#### Inbox and attention

- The pre-filled attention baseline is marked as not started, so Kata 0.21's pi hook sends no `attention-native … end` when a session without `KATA_REF` quits.

#### Development

- The pi close-transcript test reads every event in its store, not only the first 500.

## [1.4.0] - 2026-11-03

No changes to pi; kata-plugin 1.4.0 released it with omp 2.4.0.

## [1.3.0] - 2026-11-03

### Added

#### Plans

- Todo items can work existing tickets: an item that starts with `<project>#<short_id>: ` works that ticket instead of creating an issue.
  - `start` claims it and marks it in progress, `done` comments on it, and the last open item naming it closes it with that item's evidence. `drop` and `rm` only comment.
  - If Kata refuses that close because the ticket's children are still open and they are all tasks of this plan, the plugin closes it once they close; children outside the plan leave it open for you.
  - A plan whose items all name tickets creates no parent issue. An unresolvable or closed ref is an error and creates nothing.

#### Display

- Type `#` to pick a ticket: in an interactive omp or pi session, `#` plus part of a short id or title word offers open Kata issues next to the host's own items, and inserts the qualified ref. A digits-only `#1234` stays GitHub's.

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

## [1.2.0] - 2026-10-31

Every change in this release is by @salmonumbrella ([#4](https://github.com/Dangerboi/kata-plugin/pull/4), [#5](https://github.com/Dangerboi/kata-plugin/pull/5)).

### Changed

#### Plans

- A folder with no Kata project plans in `KATA_DEFAULT_PROJECT` (issues labeled with the repo), or in its inferred project, registered with `kata projects create`; no `kata init`, no files in the repo. `project_not_initialized` no longer produces a session-local plan.
- If Kata is unusable (missing executable, unreachable daemon), the plan is session-local with one warning per session, and it replays into Kata when Kata returns.
- The automatic session parent is created on the first todo mutation, so a session that never plans leaves no issue.
  - The pi adapter shares the project resolution, lazy parent and replay changes.

### Fixed

#### Plans

- Retries and refused updates no longer drop a promised close or act on a stale plan: todo changes are tied to the current actor, teammate and plan revision.
  - An automatic parent closes only when every child has accepted evidence.
  - An interrupted parent setup recovers with its original session identity.

[Unreleased]: https://github.com/Dangerboi/kata-plugin/compare/pi-v1.13.0...HEAD
[1.13.0]: https://github.com/Dangerboi/kata-plugin/compare/pi-v1.12.2...pi-v1.13.0
[1.12.2]: https://github.com/Dangerboi/kata-plugin/compare/pi-v1.12.1...pi-v1.12.2
[1.12.1]: https://github.com/Dangerboi/kata-plugin/compare/pi-v1.12.0...pi-v1.12.1
[1.12.0]: https://github.com/Dangerboi/kata-plugin/compare/pi-v1.11.0...pi-v1.12.0
[1.11.0]: https://github.com/Dangerboi/kata-plugin/compare/pi-v1.10.0...pi-v1.11.0
[1.10.0]: https://github.com/Dangerboi/kata-plugin/compare/pi-v1.9.2...pi-v1.10.0
[1.9.2]: https://github.com/Dangerboi/kata-plugin/compare/pi-v1.9.1...pi-v1.9.2
[1.9.1]: https://github.com/Dangerboi/kata-plugin/compare/pi-v1.9.0...pi-v1.9.1
[1.9.0]: https://github.com/Dangerboi/kata-plugin/compare/pi-v1.8.0...pi-v1.9.0
[1.8.0]: https://github.com/Dangerboi/kata-plugin/compare/pi-v1.7.2...pi-v1.8.0
[1.7.2]: https://github.com/Dangerboi/kata-plugin/compare/pi-v1.7.1...pi-v1.7.2
[1.7.1]: https://github.com/Dangerboi/kata-plugin/compare/pi-v1.7.0...pi-v1.7.1
[1.7.0]: https://github.com/Dangerboi/kata-plugin/compare/pi-v1.6.1...pi-v1.7.0
[1.6.1]: https://github.com/Dangerboi/kata-plugin/compare/pi-v1.6.0...pi-v1.6.1
[1.6.0]: https://github.com/Dangerboi/kata-plugin/compare/pi-v1.5.1...pi-v1.6.0
[1.5.1]: https://github.com/Dangerboi/kata-plugin/compare/pi-v1.4.0...pi-v1.5.1
[1.4.0]: https://github.com/Dangerboi/kata-plugin/compare/pi-v1.3.0...pi-v1.4.0
[1.3.0]: https://github.com/Dangerboi/kata-plugin/compare/pi-v1.2.0...pi-v1.3.0
[1.2.0]: https://github.com/Dangerboi/kata-plugin/compare/v1.1.1...pi-v1.2.0
