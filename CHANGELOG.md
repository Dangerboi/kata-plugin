# Changelog

## Unreleased

The repository moved to Dangerboi/kata-plugin. Versions are bumped at release time.

- **`init` no longer drops open tasks by surprise.** An `init` whose new list leaves out open tasks changes nothing and names them; pass `replace: true` to replace them. A list that keeps every open task goes through. omp's `todo.eager` reminder (first prompt, and after every compaction) could otherwise make the model re-`init` and close real tasks. Breaking for callers that re-`init` to drop open tasks: add `replace: true`.
- **Todo items can work existing tickets.** An item that starts with `<project>#<short_id>: ` works that ticket instead of creating an issue. `start` claims it and marks it in progress, `done` comments on it, and the last open item naming it closes it with that item's evidence. If Kata refuses that close because the ticket's children are still open and they are all tasks of this plan (as when you claim a ticket, which makes it the plan parent), the plugin closes it once they close; children outside the plan leave it open for you. `drop` and `rm` only comment. A plan whose items all name tickets creates no parent issue. An unresolvable or closed ref is an error and creates nothing.
- **A `task` naming a ticket binds to it.** A prompt that names exactly one ticket gives the subagent that ticket, with no "Subagent" issue. A prompt naming several tickets or plan items is refused: name one per task.
- **Type `#` to pick a ticket.** In an interactive omp or pi session, `#` plus part of a short id or title word offers open Kata issues next to the host's own items, and inserts the qualified ref. A digits-only `#1234` stays GitHub's.
- **The inbox is read every turn.** A `kata notify` sent mid-session reaches the agent on that turn or the next. The contract is still fetched once per session.
- **Delegates get their binding.** A delegate's first prompt waits up to 3 s for its issue binding instead of 250 ms, so a slow Kata no longer leaves it without its issue.
- **Kata errors are read from codes.** The plugin passes `--json` and branches on Kata's error codes and exit codes (`daemon_unavailable`, `project_not_initialized`, `sibling_throttle`), not on message wording.
- omp: a `revive` of a parked subagent does no Kata work, and the close retry timer runs on omp's session timer, so shutdown clears it.
- omp: a forked session keeps its source's plan instead of starting an empty parent; it does not take over the source's pending close retries or offline plan, and the shared parent still closes only when every task is closed.
- omp: `todo` in a `/tan` side conversation uses omp's own session-only list and leaves Kata alone, instead of failing with a binding error.
- **Claude Code adapter removed.** Use Kata's own hook: `kata agent-hook install claude`. Existing Claude installs stay on adapter 0.2.0. The `test:claude` and `validate` scripts are gone.
- Development: `bun run smoke:omp` runs the omp plugin in a real headless omp with a scripted model (default, inbox, tickets, fork and claimed scenarios); `--live --model <provider/model>` runs them with a real model through an API-key login only (OAuth logins are never copied). Tested with oh-my-pi 18.16.0, scripted and live (Claude Sonnet 4.5 via OpenRouter), and installed through the marketplace; and with pi 1.5.0, installed with `pi install` and driven by Claude Haiku 5.5 via OpenRouter (ticket items, a child pi process, a claimed ticket). The omp reference now says only prewalk subagents get `todo`; other subagents work their issue through `kata` commands.

## oh-my-pi 2.2.0 / pi 1.2.0 — 2026-10-31

Installing the oh-my-pi plugin now makes Kata the only todo system, in every folder, with no setup.

- **Takes over omp's todo.** The `todo.enabled: false` step is gone. The plugin's tool replaces the built-in one, and its results carry the plan under `details.kata` instead of `details.phases`, so omp's own reminders, mid-run nudge and HUD have nothing to track. `todo.enabled: false` keeps working.
- **No silent session-local plans.** A folder with no Kata project plans in `KATA_DEFAULT_PROJECT` (issues labeled with the repo), or in its inferred project, registered with `kata projects create` (no `kata init`, no files in the repo). `project_not_initialized` no longer produces a local plan.
- **Outages degrade visibly.** If Kata is unusable (missing executable, unreachable daemon) the plan is session-local with one warning per session, and it replays into Kata when Kata returns.
- **Lazy parent.** The automatic session parent is created on the first todo mutation, so a session that never plans leaves no issue.
- **No double contract.** The omp plugin skips its contract if the system prompt already carries it.
- The pi adapter shares the resolution, lazy parent and replay changes. Claude Code is unchanged.
- Breaking for scripts reading `details.phases` from omp `todo` results: use `details.kata.phases`.
