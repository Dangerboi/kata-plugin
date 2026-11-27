# Claude Code reference

Plugin: `kata-cc` in the `kata-plugin` marketplace; entry: `plugins/claude-code`, a Claude Code mod (a hooks module, not a settings hook). Requires Claude Code 2.1.332 (the tested version) and Kata 0.23.0 or later, checked before CLI use; see [runtime compatibility](../how-to/install.md#runtime-compatibility). The mod API is early access: Claude Code may change it between releases without notice, so a new Claude Code release can break the mod until the plugin follows. There is no npm package; installs come from the marketplace's Git repository.

The plugin name shows wherever Claude Code names the source of a mod: a message the mod sends into the session (a live inbox request) is framed as "The kata-cc plugin sent a message", and its settings are listed under `kata-cc`.

The mod replaces Claude Code's task tools with one Kata-backed `todo` tool, adds the plan to each prompt, gives each delegate (an `Agent` subagent, a Workflow agent or a teammate) its assignment from the plan ([Delegates](#delegates)), rewrites Kata commands in `Bash` ([Shell](#shell)), follows the session inbox live, and draws the plan in the terminal UI ([Display](#display)). It does not inject the Kata contract or session attention by default: `kata agent-hook install claude` supplies them (see [Use with Kata agent hooks](../how-to/use-with-kata-agent-hooks.md#claude-code)).

## Settings

Plugin options are set with `claude plugin install kata-cc@kata-plugin --config KEY=VALUE` or `/plugin configure kata-cc@kata-plugin`; each falls back to a variable in the environment Claude Code runs in, where there is one. For the text options the option wins when both are set, and a text value counts only when it is non-blank (it is trimmed). `liveInbox` is a switch, not a value: live delivery runs unless the option is off or `KATA_CLAUDE_LIVE_INBOX=0`, so either one turns it off, and the variable still turns it off while the option is on, which is its default.

| Option | Variable | Meaning |
| --- | --- | --- |
| `liveInbox` | `KATA_CLAUDE_LIVE_INBOX` | Default on. Delivers inbox requests to the main session as they arrive. Off, by the option or `KATA_CLAUDE_LIVE_INBOX=0`: no live follower runs, and the inbox reaches the model only through the per-prompt inbox section of Kata's hook (or the mod's, with `contract` on). |
| `contract` | | Default off. On, the mod adds the Kata contract and the inbox to the prompt itself. Leave it off when `kata agent-hook install claude` is set up, which owns both: with both on the model reads the contract twice. The section's request text is escaped: `&`, `<` and `>` are written as `&amp;`, `&lt;` and `&gt;`. Not applied on the default inbox path (`kata agent-hook install claude`, `contract` off), where Kata writes the section. |
| `refGuard` | `KATA_REF_GUARD` | Default on. Refuses a write or commit that names a Kata ref ([Kata refs in repository content](#kata-refs-in-repository-content)). Off, by the option or `KATA_REF_GUARD=off` (or `0`). |
| `kataExecutable` | `KATA_CLAUDE_EXECUTABLE` | The Kata executable the mod runs; defaults to `kata`. The `Bash` tool is not rewritten to use it. |
| `debugFile` | `KATA_CLAUDE_DEBUG` | Optional diagnostic log: the mod rewrites the file with its last 1,000,000 characters plus each new line, and writes the errors its hooks swallow there, except those of the plan band's state and toast writes and of stopping the live inbox's stream. |

These variables, shared with the other hosts, are read from Claude Code's environment when the mod starts (changing one needs a new session): `KATA_REF`, `KATA_DEFAULT_PROJECT`, `KATA_AUTHOR`, `KATA_TEAMMATE`, `KATA_INBOX_USER`, `KATA_HOME`, `KATA_ATTENTION_HOST` (which the mod never sets itself), `KATA_CLOSE_TRANSCRIPT_ENABLED`, `KATA_REF_GUARD`, `HOME` (where a leading `~` of a path points) and `USER`. A variable the mod does not name is invisible to it. After an install Claude Code 2.1.332 prints `5 userConfig options not yet set`, also for the three options that have a default: nothing has to be set. `liveInbox`, `refGuard` and `contract` apply their defaults, and `kataExecutable` and `debugFile` fall back to their variable, then to `kata` and no log.

Where the plan lives follows the [oh-my-pi rules](oh-my-pi.md#where-the-plan-lives): `KATA_REF`, then the plan parent saved for the session, then the folder's Kata project, then `KATA_DEFAULT_PROJECT`, then the inferred project. Nothing is created until the first plan change.

## The `todo` tool

The mod removes `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate` and `TodoWrite` from the tool list and adds `todo`; `TaskStop` stays, because it stops background tasks. The tool is the plugin's own, the one the [Pi reference](pi.md) describes, not omp's native `todo`: `init`, `start`, `done`, `rm`, `drop`, `block`, `unblock`, `append` and `view`, with the same phases, ticket items (`<project>#<short_id>: <action>`), refusals and [closing rules](closing-rules.md). `done` takes the message and evidence, and `init` takes `replace` and `ref`, as in Pi; omp's native `todo` takes none of these. A `todo` call needs no permission prompt: the mod answers it. A delegate's call works its own assigned issue ([Delegates](#delegates)).

Each prompt carries the plan as hidden context after the user's text. A section the model already holds is not sent again until it changes or the conversation is compacted.

Every close records the lead's session ([Record agent sessions on closes](../how-to/record-session-transcripts.md)): `KATA_TRANSCRIPT_AGENT=claude` and the lead's session id, plus `KATA_CLOSE_TRANSCRIPT_ENABLED=true` unless Claude Code's environment sets it. A close the plugin makes, a delegate's `todo` close included, carries them in that call's environment; a `kata close` the lead or a delegate runs in `Bash` carries them as variables the rewrite sets for that command ([Shell](#shell)). A delegate has no session of its own: its transcript is part of the lead's, so its closes record the lead's session. `KATA_CLOSE_TRANSCRIPT_ENABLED=false` in Claude Code's environment stops it.

## Delegates

A delegate is an agent the lead starts: an `Agent` call, a Workflow agent or a teammate. The mod matches it to a plan item or a named ticket with the rules of the [oh-my-pi reference](oh-my-pi.md): the same naming rules, the same refusals, the same hand back. What differs is how Claude Code lets the mod see each step.

| Step | What the mod does |
| --- | --- |
| Spawn (`agent.spawn`) | Matches the agent's prompt, description and name against the plan. An item or ticket already delegated, two tickets in one prompt, or a ticket that cannot be delegated refuses the spawn with the core's error; nothing is written. A Kata that cannot be reached refuses nothing: the spawn runs and its assignment is retried on the delegate's next use. A spawn that matches nothing runs as an untracked delegate, whose run becomes a mission when it ends with a report. The assignment is appended to the agent's prompt: its issue, its teammate, and the commands to comment and to close it, or to leave it open when its task text says not to close issues. |
| Slow assignment | The spawn's waits for the assignment (those before Claude Code's own spawn, and one after it) share the hook's 10 s: the waits before the spawn share 7 s and keep 3 s for the engine's spawn, the wait after keeps 0.5 s for the hook's return, so together they take up to about 9.5 s. A slower Kata starts the agent without it; the agent still gets its issue, and learns of it from its first `todo` call. |
| A tool call of the delegate | Marks the delegate as having acted, so its assignment is no longer rolled back at exit. Its `todo` calls plan under its own issue and never touch the lead's. A call from an agent the lead does not track is refused with an error telling it to report in its reply. |
| The agent's turn ends | Its answer is its report: the delegate exits `completed`, `failed` or `aborted`. |
| A follow-up (resume) | The agent goes on with the record it has: its issue while that is open, else its mission. |

A fork no tool call starts (`/btw`, `/fork`) is no delegation and runs as it is. A delegate's own subagents are never matched against the lead's plan. At exit the core settles each delegate as for omp: a delegate that closed its issue returns it to the lead; one that exited without running any tool is rolled back; one that ran a tool and left the issue open flags it with `needs-review` and hands it back. See the [limits](../explanation/limits.md#claude-code) for the delegates the mod cannot see.

## Shell

A `kata close` in a `Bash` call, the lead's or a delegate's, is rewritten to set `KATA_TRANSCRIPT_AGENT='claude'`, `KATA_TRANSCRIPT_SESSION_ID='<lead session id>'` and `KATA_CLOSE_TRANSCRIPT_ENABLED` (as Claude Code's environment sets it, else `'true'`) for that command, unless the command already sets those values.

A delegate assigned an issue, and any delegate the mod can name, also runs `kata` commands in `Bash` under its own teammate: the command is rewritten to add `--teammate <teammate>` (an earlier one is replaced), and `--workspace` and `--project` of the assignment unless the command sets them. A delegate's `--as` is refused. Only commands in command position are touched, and rewriting is lexical, not a sandbox.

At the permission check (`tool.check`) a rewritten call that Claude Code's own rules would ask about is allowed when the command the model wrote is allowed outright. An ask from a hook (a `PreToolUse` guard, another plugin) stands, as does every other verdict.

Under auto permission mode Claude Code refuses a tool call a hook changed after the classifier read it. Then the mod denies the call instead, with the exact command to run (`… Run it again exactly like this: …`), and the model's next call already carries the change. A delegate spawned under auto mode is refused before the rewrite is tried; the lead's call is refused once Claude Code refuses the rewrite.

## Kata refs in repository content

Kata refs resolve only in the local tracker, so the plugin refuses a `Write`, `Edit`, `NotebookEdit` or `Bash` call that puts a ref the session works (the plan parent and items, the assigned or claimed issue, a delegate's issue) into a file under the session's folder or into a `git commit` message, and the model rewrites it to describe the behaviour. A qualified ref counts only when its project is one the session knows, so `README.md#tasks` passes. A bare short id counts only when the session knows it. Only added text is checked: refs the replaced text or the file already holds, removed and context lines, hashline headers, files outside the folder, internal URLs and the bodies of `kata comment`, `kata close` and `kata create` are not. The check waits at most 2 seconds and lets the call through on an error. `KATA_REF_GUARD=off` (or `0`) turns it off. The `tool.call` hook denies the call with the reason, for the lead and for delegates; it runs after the todo hooks, which still see the denial.

## Sessions, settling and restart

| Moment | What the mod does |
| --- | --- |
| Session start | Takes up the plan: a resumed session's saved plan, pending closes and unfinished delegates resume with it. Registers the `/todo` command. A slow Kata holds the session start (and the first hook of a new session id) for at most 5 s; the session then goes on without its plan, which binds when Kata answers. |
| `/clear`, `/resume`, `/branch` | These fire no session start, so the next hook finds the new session id and switches the core to it, releasing the tasks the old session held. A fork made in the session (`/branch`) shares the source's plan when `classic.SessionStart` runs (not under a managed-settings guard, see [limits](../explanation/limits.md#claude-code)): the fork starts from what its source saved. `claude --resume <id> --fork-session` starts a new session that names no source to the mod, so it starts from a plan of its own ([limits](../explanation/limits.md#claude-code)). |
| End of each lead turn | Retries due closes and hands back exited delegates. When a task is still open, the end-of-turn Stop hook returns the core's reminder so the model keeps working. |
| Compaction | The plan is sent again with the next prompt. |
| Session end | Closes the automatic parent when its children are closed, within the 1.5 s Claude Code gives the whole end chain (the core's shutdown gets at most 1.2 s of it, then the mod saves the record). What does not fit stays in the saved record for the session's resume. `/clear` and `/resume` end nothing. |

A session's saved state lives in Claude Code's plugin store under the key `session/<session id>`. The store is one file for every session on the machine, shared by every mod and limited to 4 MiB, so the mod keeps its records small: an ended session's record is dropped after 7 days, any record untouched for 30 days is dropped, and when the records pass 2 MiB the oldest ended sessions that owe nothing go first, then the oldest ended sessions that owe work (a full store would fail the saves of the running session). A session that ends with a task still open, whatever holds the plan (an automatic or explicit parent, ticket items or a session-local plan), or with closes it still owes keeps its record for `claude --resume`, for 30 days instead of 7; a session with neither saves nothing.

Closing the terminal or killing Claude Code runs no hooks: work left open is finished when the session is resumed with `claude --resume`, not before.

## Display

The mod draws in the terminal UI, and in the desktop Code tab and the VS Code chat panel where Claude Code draws mods. `claude -p` and the Agent SDK run the hooks and draw nothing.

- **Plan band** above the prompt: `Kata plan 2/5 · 1 blocked · ▶ active task`, with a progress bar.
- **Checklist card** under each of the lead's `todo` calls, with the result's notice (a deleted parent, a close Kata deferred) above the checklist. A delegate's `todo` call keeps the engine's own row. A session-local plan (kept while Kata is unreachable) draws no band and no card.
- **`#` ticket completion** in the prompt, with the same tokens as the [omp ticket references](oh-my-pi.md#ticket-references-in-the-prompt). A loaded list answers at once, whatever Kata is doing; only the first fill of a session's list waits, for 400 ms at most, beside the rows of other plugins.
- **`/todo`** shows the plan; the subcommands `start`, `done`, `drop`, `rm`, `append`, `block`, `unblock` and `takeover` change it, as in Pi.

## Live inbox

With `KATA_INBOX_USER` set to a session address, `<actor>/<name>`, the main session follows `kata events --tail` and delivers each new request from its own actor. An idle session starts a turn on the request. A working session takes it with its next request, in the same turn: Claude Code appends the row at the end of the conversation, so a row added in a turn's final step rides the next turn. After the person presses Stop, delivery is refused until they type again. Subagents never follow the inbox, and the follower never delivers a request addressed to someone else's actor. A delivered request's sender, comment, notice kind and message are written with `&`, `<` and `>` as `&amp;`, `&lt;` and `&gt;`, so request text cannot open a tag; the issue ref in the first line is escaped too. The clear command uses the issue's ref, or its short id when the ref is not a plain word, so it carries no markup from the ref; the session's address is its own and is quoted when it is not a plain word. `liveInbox: false` or `KATA_CLAUDE_LIVE_INBOX=0` turns the follower off; the inbox is then read once per prompt, by Kata's hook or by the mod with `contract` on. In `claude -p` each delivery uses one of `--max-turns`.

## Testing the mod

`bun run validate:claude` runs `claude plugin validate` on the marketplace and on the mod, and `bun run test:claude` runs `claude plugin test`. Both need Claude Code on `PATH`, so they run locally and not in CI. `bun run smoke:claude` runs a real headless `claude -p`; it needs a login and is paid ([development](../development.md#smoke-test-against-a-real-claude-code)).

See [limits](../explanation/limits.md#claude-code).
