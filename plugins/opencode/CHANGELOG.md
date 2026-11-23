# Changelog

All notable changes to `@dangerboi/kata-opencode` are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package uses [semantic versioning](https://semver.org/spec/v2.0.0.html). Releases are tagged `opencode-v<version>`.

## [Unreleased]

### Fixed

#### Plans

- Restarting a closed task you own with `todowrite` reopens it, instead of failing with "no longer owned" when Kata cleared the owner on close.

## [1.2.1] - 2026-11-18

### Fixed

#### Plans

- A plan item named as the plan view lists it, `<content> (<ticket or ref>)`, is that item for every op.
  - `init` and `append` drop that suffix, and a ticket item's own ref repeated after its action, so an item copied from the view keeps its content and shows its ticket once.
  - The stop reminder lists open items the same way, followed by their status.

#### Delegates

- A `subagent` call that names a ticket goes ahead while Kata cannot be reached, and its delegate's assignment is retried on its next use, instead of the call being refused with Kata's error.

#### Inbox and attention

- A request sent while an earlier inbox read was still answering shows in that turn's `<kata_inbox>` section, not only on the next turn.

## [1.2.0] - 2026-11-16

### Changed

#### Plans

- Deleting or archiving a session releases the items it started at once, as omp and pi do when a session ends. Only an item whose close Kata deferred keeps its holder, so the retry still closes it.
- One `todowrite` call runs as one job, so a delegate event or retry timer no longer runs between its steps, and one session waiting on Kata no longer delays another session's turn end, delegate exits or deletion.
- `init` with `takeover: true` is refused and changes nothing; `takeover` applies to ops that name a task.

#### Delegates

- **Breaking:** Delegate records that ended with an issue are kept with the lead's saved state instead of a separate storage entry, so a follow-up to a delegate that ended before the upgrade starts a new, untracked record. Send such follow-ups before upgrading, or name the item again in a new `subagent` call.

### Fixed

#### Plans

- `todowrite` advice speaks `todowrite`'s words.
  - A session OpenCode cannot read is told so, instead of being called a delegate.
  - A first list under a `ref` that leaves out the issue's open items is told to send them, not to pass `replace: true`.
  - The refusals for a delegated task and for held tasks left out of an `init` no longer name ops `todowrite` does not have.
- A session deleted or archived with work left is finished as soon as that work is done, without a restart; one deleted while no instance of its folder ran is ended by the next setup; and a saved session is no longer picked up after the plugin stopped.
- A task whose session ended normally is held again by the session that next starts it; before, any other session could change it without a takeover.
- A session that ends while Kata has deferred a close keeps that task's hold, so the retry still closes it. Before, the release voided the close.
- Two tasks with the same title dropped for the same reason get distinct close messages, which Kata's close throttle no longer refuses.
- A `todowrite` item completed with blank evidence is refused with the plugin's guidance instead of Kata's error, and blank entries beside real evidence are left out of the close.
- Reading the plan retries a held ticket close in a plan of ticket items alone, as every change does.
- An automatic parent's title made from a long message or session name is cut to 120 characters.

#### Delegates

- A subagent is bound to the call whose prompt is its first message, not to an earlier call whose prompt that message merely ends with.
- A `subagent` call that another plugin's hook refuses, or whose background child never starts, frees its plan item at the end of the lead's turn instead of leaving it "already delegated".
- A late end event of a delegate's earlier run no longer ends its follow-up run; a delegate whose session is gone at its end event still exits, and one whose own session is deleted or archived exits as aborted.
- Kata commands in `shell` from a child session the lead does not track run under a teammate derived from the session, and `--as` is refused. Before, they ran as the lead.
- A failed storage or session read in a hook no longer fails a child session's tool calls.
- Archiving or deleting a lead frees the plan items its pending `subagent` calls held, so they can be delegated again after an unarchive.
- A delegate whose assignment failed on an issue another teammate owns no longer comments on, labels or notifies that issue when it exits.
- A mission whose close Kata throttled is saved at once, so a lead that ends or is killed before the retry still closes it when resumed.
- A delegate that starts without a checked `subagent` call follows the same rules as the check.
  - A spawn that names a blocked ticket item runs untracked, as one naming a blocked plan task does.
  - One that names a ticket it cannot take (closed, or another teammate's) is untracked and leaves a mission, instead of failing with its report lost.
  - A ticket Kata could not be read for is no such refusal: the assignment is retried on the delegate's next use, and a delegate that exits before it was decided leaves its report as a mission.

## [1.1.0] - 2026-11-15

### Added

#### Plans

- An automatic parent whose only children besides retired tasks are missions closes as `audit-no-change` instead of staying open for review.
  - A mission adds no evidence to a parent that closes as done, so it never leaves that parent `needs-review`.
  - A mission left open because the plugin could not close it (a pi child's close was throttled or cut off by its shutdown budget, a kill) is closed by the parent's audit once nothing else under the parent is open.

#### Delegates

- A follow-up to an untracked delegate posts its new report on that delegate's mission, also after a restart.
- An untracked delegate (an omp `task` subagent, a pi child or an OpenCode subagent whose task names no plan item or ticket) that exits with a report leaves a mission: a closed child issue of the plan parent with its task, its agent and its report.
  - The plugin makes and closes the mission itself, as `audit-no-change`, so a delegate without `bash` such as omp's `scout` gets one too. Any change the run made is the lead's to verify.
  - With no plan parent, the plugin creates the automatic parent for it; it never creates one beside an explicit parent.

### Changed

#### Plans

- A `todowrite` call, a session start and a turn end make 11–14% fewer Kata calls, which matters most with a Kata daemon over the network.
  - An issue read twice in one call is read once, until anything in the same process writes to Kata. Changes made elsewhere show from the next call on, as before.
  - The effective actor is read once per session and project instead of before every task change, and session start checks that Kata answers once.

#### Delegates

- A delegate is bound to a plan item only when its task text names the item: its title (quoted, as the whole text, or three or more words), its ref, its short id after `issue`, `kata`, `ref`, `task` or `#`, or for a ticket item its ticket's ref.
  - Word overlap, the item marked for delegation and the "current task" handoff no longer bind anything.
  - A spawn that only describes an item's work, such as a reviewer or scout, runs untracked and no longer claims or closes that item; the lead finishes it in `todowrite`.
  - A ticket item whose ticket is the plan parent is not named by that ref, so a delegate's task text may cite the parent.

### Fixed

#### Delegates

- A delegation call with several spawns that name no plan item is no longer refused with "Ticket … is already delegated" when the plan has an open ticket item.
  - A ticket item whose ticket another spawn or delegate has already reserved is not matched again.
- A delegate leaves its issue open when its task text says not to close issues or to leave the issue open; it is handed back (`needs-review`) and the lead closes it after its own checks.

## [1.0.0] - 2026-11-13

### Added

#### Requirements

- The plugin needs OpenCode 2.2.7 or later and Kata 0.23.0 or later, and checks the Kata version before it uses the CLI.
  - It was tested with OpenCode 2.2.7 and Kata 0.23.0.

#### Install and update

- A new plugin package, `@dangerboi/kata-opencode`, keeps OpenCode's todo plans and delegates in Kata.
  - Add it to the `plugins` list of `opencode.json`, or point `plugins` at the `plugins/opencode` directory of a checkout.
  - Plugin options (`executable`, `ref`, `defaultProject`, `author`, `teammate`, `debugFile`) fall back to `KATA_*` variables in the OpenCode server's environment.
  - Run `kata agent-hook install opencode` for Kata's contract, inbox and attention; the plugin does not add them.
  - The TUI sidebar shows the plan with no extra setting; `experimental.todo: true` is needed only for the desktop composer pill.

#### Plans

- `todowrite` is backed by Kata. The model sends the whole list on every call, and the plugin compares it with the Kata plan.
  - New items become issues, `in_progress` starts a task, `completed` closes it with a message and evidence, `cancelled` drops it with a reason, and `blocker` pauses it.
  - A call whose list disagrees with the plan is refused, changes nothing and carries the current list to send back. That covers an open item missing from the list, a started item sent back as `pending` and an item Kata already closed.
  - An item added in Kata outside the session is asked back unchanged, with no offer to cancel it.
  - A second lead session on the same parent can take over an item the first started and lost to a crash: `takeover: true` on the call, recorded on each issue. Refusal texts speak `todowrite`.
  - Content is kept exactly as written, including surrounding spaces, newlines and long text.
  - A content that appears twice in a plan made elsewhere is one item whose changes apply to every open copy. Copies that name the same ticket cannot be changed from `todowrite`; the refusal asks the model to have the user remove the duplicate.
  - Copies closed both ways (some completed, some cancelled) accept either closed status.
  - A session's automatic parent closes when the session is deleted or archived. An automatic parent Kata leaves open on purpose, such as one whose items were all dropped, does not count as work left.
  - When a close or a delegate cleanup is still owed (Kata was unreachable or throttled, or a delegate is still running), the session becomes an ended session and its saved state is kept. The next plugin setup finishes the work in the background, without delaying startup, and then forgets the session.
  - Unarchiving the session, or new activity in it, stops it being an ended session, so a restart never finishes a session that was unarchived.

#### Delegates

- A `subagent` call that names a plan item or a ticket gets that issue, and its session works it as its own teammate.
  - The assignment happens before the delegate's first model call. A task or ticket that is already delegated refuses the call, also for two parallel calls.
  - An assigned delegate's `todowrite` plans under its issue.
- A delegate that exits is rolled back or handed back in Kata.
  - One that exits without running a tool is rolled back.
  - One that leaves its issue open flags it for review and hands it back to the lead with `needs-review`.
- A `subagent` call with `sessionID` stays on the same issue.
  - An open issue is assigned again, and a closed one gets the report as a comment and stays closed.
- Pending delegate work resumes after a restart of the OpenCode server.
- Kata commands in the `shell` tool are routed by session.
  - A delegate's commands get its teammate and the configured author, and `--as` is refused. The lead's commands get the configured author and teammate.
  - A `kata close` records the session that ran it. The lead's close sets `KATA_CLOSE_TRANSCRIPT_ENABLED=true` unless the server sets it.
  - The TUI keeps showing the command the model wrote.

#### Development

- `bun run smoke:opencode` runs the OpenCode plugin in a real headless OpenCode with a scripted model provider and checks the result in a real Kata daemon. It runs locally and is not part of CI.

[Unreleased]: https://github.com/Dangerboi/kata-plugin/compare/opencode-v1.2.1...HEAD
[1.2.1]: https://github.com/Dangerboi/kata-plugin/compare/opencode-v1.2.0...opencode-v1.2.1
[1.2.0]: https://github.com/Dangerboi/kata-plugin/compare/opencode-v1.1.0...opencode-v1.2.0
[1.1.0]: https://github.com/Dangerboi/kata-plugin/compare/opencode-v1.0.0...opencode-v1.1.0
[1.0.0]: https://github.com/Dangerboi/kata-plugin/releases/tag/opencode-v1.0.0
