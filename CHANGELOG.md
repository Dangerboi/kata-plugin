# Changelog

## oh-my-pi 2.5.0 / pi 1.5.0 — 2026-11-05

**Requires Kata 0.21.0** (was 0.19; 0.20 tested). The CLI and the daemon both need 0.21.0.

- **Close transcripts record omp and pi sessions.** Once `[close.transcript] enabled = true` is in Kata's `config.toml`, the plugin's own closes and the agent's `kata close` calls record `omp <id>` or `pi <id>`. `session_id_env` is no longer needed for omp or pi. omp delegates record their own session on the closes they run. Another harness launched from omp's or pi's bash tool inherits the pair, so its closes link the launching session.
- **Moved issues stay together.** After `kata move`, new plan tasks, delegated work and ticket items follow the issue to the project it now lives in, instead of landing in the old project.
- **Attachment evidence no longer stalls the automatic parent.** A child closed with Kata 0.21 `attachment` evidence used to leave the parent `needs-review`. The parent now closes with the children's other evidence, and stays open for review only if none remains.
- An unregistered folder takes the project name to register from Kata's structured `project_not_initialized` data (project, then alias), then the folder name. No code path reads Kata's message wording.
- pi: the pre-filled attention baseline is marked as not started, so Kata 0.21's pi hook sends no `attention-native … end` when a session without `KATA_REF` quits.
- Appending a ticket item that is already open in the plan does nothing. It used to create a stray child issue under the parent, or throw in a plan of only ticket items, which has no parent.
- A Kata error that follows a warning line (Kata 0.21 prints one when close transcripts are on and no session is set) is still read by its code, so a throttled or refused close is handled as such instead of as a generic failure.
- **A person's own inbox no longer reaches agents.** A bare `KATA_INBOX_USER=<actor>` (as set for tern-kata's Attention Page or `kata inbox`) is that person's inbox, holding requests agents wrote for them, and omp and pi sessions used to put it into every system prompt. Now only an `<actor>/<name>` address is read as a session inbox; a bare one is skipped with a one-line notice per session. To steer a plain omp session through its inbox, start it with `KATA_INBOX_USER=<actor>/<name>` and notify that address.
- Development: run the suite against the installed Kata with `KATA_TEST_EXECUTABLE="$(readlink -f "$(command -v kata)")" bun run test`. Error fixtures are re-captured from Kata 0.21.0. The default `smoke:omp` scenario turns transcripts on and checks that the plugin's close and a delegate's close record omp sessions.

Upgrade notes:

- Kata 0.21.0's schema 43 is one-way. Older binaries can't open the upgraded store; rolling back needs the pre-upgrade backup plus its matching binary.
- Re-run `kata agent-hook install pi` so the installed pi hook includes the child-session guard.
- Session transcripts for agents other than Claude Code and Codex need daemon API 0.34.0. An older daemon warns and closes without the transcript.

## oh-my-pi 2.4.0 / pi 1.4.0 — 2026-11-03

- omp: a `task` that matches no plan item and names no ticket gets no Kata issue. It used to get a `Subagent` issue that an agent without `bash` (the `scout`) could not close, which left an open issue, a `needs-review` label, a `kata notify` and a parent that never closed. Now only a delegation matched to a plan item or naming a ticket binds an issue; any other subagent gets a short note instead of a binding, its `todo` uses omp's own list (an error on an omp without `ctx.invokeTool`), and the automatic parent closes from the plan's own items. A delegation no longer creates the automatic parent. pi is unchanged.
- Development: the `untracked` smoke scenario sends a `scout` that matches no plan item and checks that it leaves no issue, `needs-review` label or inbox request, and that the parent closes from the plan's own items (scripted and `--live`).

## oh-my-pi 2.3.0 / pi 1.3.0 — 2026-11-03

The repository moved to Dangerboi/kata-plugin, and the Claude Code plugin is gone.

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
