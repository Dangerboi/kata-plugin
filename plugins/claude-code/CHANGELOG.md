# Changelog

All notable changes to the `kata-cc` Claude Code plugin are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package uses [semantic versioning](https://semver.org/spec/v2.0.0.html). Releases are tagged `claude-code-v<version>`. It is a new plugin: an earlier Claude Code adapter (0.2.0) was removed in kata-plugin 1.3.0 in favour of `kata agent-hook install claude`.

## [Unreleased]

### Fixed

#### Repository content

- The ref guard also reads `git commit` and `git tag` `--trailer` values, the messages of `git merge`, `git tag` and `git notes add` or `append`, and a heredoc or here-string message read with `-F -`, `-F /dev/stdin` or `--file=/dev/stdin`, so a Kata ref the session works is denied there too. Thanks to @salmonumbrella ([#104](https://github.com/Dangerboi/kata-plugin/pull/104)).

## [1.2.0] - 2026-11-26

### Added

#### Repository content

- A `Write`, `Edit`, `NotebookEdit` or `Bash` `git commit` call that adds a Kata ref the session works to a file under the project folder or to a commit message is denied, for the lead and its delegates, and the reason tells the model to describe the behaviour instead. Kata refs only resolve in the local tracker.
  - Turn it off with the `refGuard` option or `KATA_REF_GUARD=off` (or `0`).
  - The mod reads `HOME` to resolve a leading `~` in a path the guard checks.

### Fixed

#### Inbox and attention

- A request's text can no longer close the `<kata_inbox>` section or open a tag: `&`, `<` and `>` are written as `&amp;`, `&lt;` and `&gt;` in the mod's section (with the `contract` option on) and in a live delivery.

## [1.1.0] - 2026-11-23

### Added

#### Install and update

- The plugin folder has a listing icon and a README that lists what the mod runs, changes, sends and stores, for Anthropic's plugin directory.

### Fixed

#### Plans

- Restarting a closed task you own with `todo` reopens it, instead of failing with "no longer owned" when Kata cleared the owner on close.

## [1.0.0] - 2026-11-18

### Added

#### Requirements

- Tested with Claude Code 2.1.326 and Kata 0.23.0. The mod API is early access, so a later Claude Code release can need a plugin update.

#### Install and update

- The `kata-cc` plugin installs from the repository's marketplace with `/plugin install kata-cc --marketplace Dangerboi/kata-plugin`, or `claude plugin install kata-cc@kata-plugin` from a shell. It has no npm package: updates come from `claude plugin marketplace update kata-plugin` and `claude plugin update kata-cc@kata-plugin`, and reach an installed copy when the plugin's version moves.
  - To replace the earlier Claude Code adapter, `kata@kata-plugin` 0.2.0, run `claude plugin uninstall kata@kata-plugin`, then `claude plugin marketplace update kata-plugin` and `claude plugin install kata-cc@kata-plugin`. With both installed, a delegate's work is recorded twice.
- The options `liveInbox`, `contract`, `kataExecutable` and `debugFile` are declared by the plugin and set with `/plugin configure` or `--config KEY=VALUE`, each with an environment variable where there is one (`KATA_CLAUDE_LIVE_INBOX`, `KATA_CLAUDE_EXECUTABLE`, `KATA_CLAUDE_DEBUG`). Claude Code prints `4 userConfig options not yet set` after an install; nothing has to be set.

#### Plans

- A Kata-backed `todo` tool replaces `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate` and `TodoWrite`, with the same ops, ticket items and closing rules as omp. Each prompt carries the plan, and every close records the lead's session.
  - A `kata close` the lead or a delegate runs in `Bash` records it too, and keeps the permission an allow rule such as `Bash(kata *)` gives the command the model wrote.
  - A session's plan survives `/resume`, `/clear` and `/branch`, and what a session left owing is finished when it is resumed. The session end has 1.5 s, so work that does not fit waits for the resume.
  - A session that ends with a task still open keeps its saved plan for `claude --resume`, whether its parent is automatic or explicit, its items are tickets or the plan is session-local. A fork made in the session starts with its source's plan; `claude --resume <id> --fork-session` names no source to the plugin and starts from a plan of its own.
  - Kata's contract, inbox and session attention come from `kata agent-hook install claude`; the plugin adds the contract only with `contract` on.

#### Delegates

- `Agent` subagents, Workflow agents and teammates take the plan item or ticket their task names as their assignment, and their `kata` commands in `Bash` run under their own teammate. Under auto permission mode the plugin denies such a command with the exact command to run, because Claude Code refuses a rewrite there.
  - Code Review workflows and a Workflow agent's stall retries are untracked.
  - The waits for an assignment share the spawn hook's 10 s, so a slow Kata starts the agent without its assignment instead of overrunning the hook.

#### Inbox and attention

- The main session follows the session inbox live and delivers each request without waiting for a prompt; one that arrives in a turn's final step rides the next turn. Either `liveInbox` off or `KATA_CLAUDE_LIVE_INBOX=0` turns it off.

#### Display

- The plan band above the prompt, a checklist card under each of the lead's `todo` calls, `#` ticket completion and `/todo` show the plan in the terminal UI.
  - The card shows the result's notice (a deleted parent, a close Kata deferred). A session-local plan draws no band and no card.
  - A loaded ticket list answers `#` completion at once; only the first fill waits, 400 ms at most.

#### Development

- `bun run validate:claude` and `bun run test:claude` run `claude plugin validate` and `claude plugin test`, and `bun run smoke:claude` runs a real headless `claude -p` on haiku against a throwaway Kata store. The smoke run needs a Claude Code login and is paid; none of them runs in CI.

[Unreleased]: https://github.com/Dangerboi/kata-plugin/compare/claude-code-v1.2.0...HEAD
[1.2.0]: https://github.com/Dangerboi/kata-plugin/compare/claude-code-v1.1.0...claude-code-v1.2.0
[1.1.0]: https://github.com/Dangerboi/kata-plugin/compare/claude-code-v1.0.0...claude-code-v1.1.0
[1.0.0]: https://github.com/Dangerboi/kata-plugin/releases/tag/claude-code-v1.0.0
