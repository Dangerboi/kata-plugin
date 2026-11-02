# Changelog

## Unreleased

The repository moved to Dangerboi/kata-plugin. Versions are bumped at release time.

- **Todo items can work existing tickets.** An item that starts with `<project>#<short_id>: ` works that ticket instead of creating an issue. `start` claims it and marks it in progress, `done` comments on it, and the last open item naming it closes it with that item's evidence. `drop` and `rm` only comment. A plan whose items all name tickets creates no parent issue. An unresolvable or closed ref is an error and creates nothing.
- **A `task` naming a ticket binds to it.** A prompt that names exactly one ticket gives the subagent that ticket, with no "Subagent" issue. A prompt naming several tickets or plan items is refused: name one per task.
- **Type `#` to pick a ticket.** In an interactive omp or pi session, `#` plus part of a short id or title word offers open Kata issues next to the host's own items, and inserts the qualified ref. A digits-only `#1234` stays GitHub's.
- **The inbox is read every turn.** A `kata notify` sent mid-session reaches the agent on that turn or the next. The contract is still fetched once per session.
- **Delegates get their binding.** A delegate's first prompt waits up to 3 s for its issue binding instead of 250 ms, so a slow Kata no longer leaves it without its issue.
- **Kata errors are read from codes.** The plugin passes `--json` and branches on Kata's error codes and exit codes (`daemon_unavailable`, `project_not_initialized`, `sibling_throttle`), not on message wording.
- omp: a `revive` of a parked subagent does no Kata work, and the close retry timer runs on omp's session timer, so shutdown clears it.
- **Claude Code adapter removed.** Use Kata's own hook: `kata agent-hook install claude`. Existing Claude installs stay on adapter 0.2.0. The `test:claude` and `validate` scripts are gone.
- Development: `bun run smoke:omp` runs the omp plugin in a real headless omp with a scripted model. Tested with oh-my-pi 18.15.0.

## oh-my-pi 2.2.0 / pi 1.2.0 — 2026-10-31

Installing the oh-my-pi plugin now makes Kata the only todo system, in every folder, with no setup.

- **Takes over omp's todo.** The `todo.enabled: false` step is gone. The plugin's tool replaces the built-in one, and its results carry the plan under `details.kata` instead of `details.phases`, so omp's own reminders, mid-run nudge and HUD have nothing to track. `todo.enabled: false` keeps working.
- **No silent session-local plans.** A folder with no Kata project plans in `KATA_DEFAULT_PROJECT` (issues labeled with the repo), or in its inferred project, registered with `kata projects create` (no `kata init`, no files in the repo). `project_not_initialized` no longer produces a local plan.
- **Outages degrade visibly.** If Kata is unusable (missing executable, unreachable daemon) the plan is session-local with one warning per session, and it replays into Kata when Kata returns.
- **Lazy parent.** The automatic session parent is created on the first todo mutation, so a session that never plans leaves no issue.
- **No double contract.** The omp plugin skips its contract if the system prompt already carries it.
- The pi adapter shares the resolution, lazy parent and replay changes. Claude Code is unchanged.
- Breaking for scripts reading `details.phases` from omp `todo` results: use `details.kata.phases`.
