# kata-cc

[Kata](https://github.com/kenn-io/kata) work tracking for Claude Code. The plugin keeps Claude Code's plan in Kata, a local-first issue tracker for people and coding agents: each plan item is an issue, the delegates that work an item claim it, and every close records evidence and the session that made it. Kata checks each close, and the automatic parent of a session's plan closes once its children are done.

It is a Claude Code mod (a hooks module, `hooks/register.ts`), so it runs inside Claude Code. It works in the terminal, the desktop Code tab and the VS Code chat panel; `claude -p` and the Agent SDK run its hooks and draw nothing.

## Requirements

- Claude Code 2.1.326, the tested version. The mod API is early access, so a later Claude Code release can need a plugin update.
- Kata 0.23.0 or later, with `kata` on `PATH` (or set `kataExecutable`). The plugin does nothing useful without it.
- Recommended: `kata agent-hook install claude --attention`, which adds Kata's contract, inbox and session attention to each prompt.

## Install

```
/plugin install kata-cc --marketplace Dangerboi/kata-plugin
```

Or `claude plugin marketplace add Dangerboi/kata-plugin` and `claude plugin install kata-cc@kata-plugin` from a shell.

## What it does

- Replaces `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate` and `TodoWrite` with one Kata-backed `todo` tool (`init`, `start`, `done`, `drop`, `block`, `append`, `view` and the rest). A plan item can name an existing ticket as `<project>#<id>: <action>`.
- Adds the current plan to each prompt as hidden context, and keeps the model working at the end of a turn while a task is still open.
- Gives each `Agent` subagent, Workflow agent or teammate the plan item or ticket its task names, and settles it when the agent exits.
- Keeps a session's plan across `/resume`, `/clear` and `/branch`, and finishes what a session left open when it is resumed.
- Draws a plan band above the prompt, a checklist card under each `todo` call, `#` ticket completion in the prompt and a `/todo` command.
- Delivers Kata inbox requests to the main session as they arrive.

## What it runs, changes, sends and stores

The plugin makes no network requests of its own. Everything it records goes to Kata through the `kata` command.

- **Processes.** It runs the `kata` executable (or `kataExecutable`) to read and change issues: create, claim, comment, label and close. With the live inbox on, it keeps one `kata events --tail` process running for the main session. When the session has no plan parent yet and neither `KATA_AUTHOR` nor `USER` is set, it runs `git config user.name` for the user's name.
- **What Kata receives.**
  - Plan item text and delegate assignments.
  - The lead session's id, as metadata on the plan's issues and delegated issues and in the automatic parent's body, and the workspace's absolute path, as metadata on the automatic parent.
  - A delegate's final report: as a comment on its issue when it left none itself or ran as a follow-up, or, for an untracked delegate, in a closed mission issue together with the delegate's task prompt and the lead session's id.
  - On every close, the agent name `claude` and the lead session's id. Unless Claude Code's environment sets `KATA_CLOSE_TRANSCRIPT_ENABLED`, the plugin sets it to `true` on each close, so Kata records the session that closed the issue even where Kata's own config leaves that off. `KATA_CLOSE_TRANSCRIPT_ENABLED=false` stops Kata recording it; the id is still passed, and still stored in the metadata above.
- **Tool list.** It removes the task tools listed above and adds `todo`. The plugin answers `todo` calls itself, so they need no permission prompt.
- **Bash commands.** A `kata close` in a `Bash` call is rewritten to start with `env KATA_TRANSCRIPT_AGENT='claude' KATA_TRANSCRIPT_SESSION_ID='<session id>' KATA_CLOSE_TRANSCRIPT_ENABLED='true'` (the switch as Claude Code's environment sets it). A delegate's `kata` commands get `--teammate`, `--workspace` and `--project` for its assignment, and a delegate's `--as` is refused. Other commands are left alone.
- **Permissions.** That rewrite stops an allow rule such as `Bash(kata *)` from matching. When Claude Code's own rules would ask about a rewritten call, the plugin allows it only if the command the model wrote is allowed outright. Deny rules, asks from hooks or other plugins, and every other verdict stand. Under auto permission mode the plugin refuses the call instead and tells the model the exact command to run.
- **Delegate spawns.** When an `Agent` subagent, Workflow agent or teammate starts on a plan item or ticket, it appends the assignment (issue, teammate, and the commands to comment on and close it) to the agent's prompt, plus the Kata contract with `contract` on. A resumed agent's prompt is left alone. It refuses a spawn whose item or ticket is already delegated, whose prompt names two tickets, or whose ticket cannot be delegated.
- **Prompts it submits.** When `KATA_INBOX_USER` names a session address (`<actor>/<name>`), the main session follows that inbox and submits each new request from the same actor into the session, starting a turn if the session is idle. Turn this off with `liveInbox` off or `KATA_CLAUDE_LIVE_INBOX=0`.
- **Local storage.** Each session's plan record is saved in Claude Code's plugin store under `session/<session id>`. Ended sessions' records are dropped after 7 days, or 30 days when the session left work open. With `debugFile` set, the plugin writes a diagnostic log there, capped at its last 1,000,000 characters.
- **Environment.** It reads `KATA_REF`, `KATA_DEFAULT_PROJECT`, `KATA_AUTHOR`, `KATA_TEAMMATE`, `KATA_INBOX_USER`, `KATA_HOME`, `KATA_ATTENTION_HOST`, `KATA_CLOSE_TRANSCRIPT_ENABLED`, `KATA_CLAUDE_LIVE_INBOX`, `KATA_CLAUDE_EXECUTABLE`, `KATA_CLAUDE_DEBUG` and `USER`, and writes none.

## Settings

Set with `/plugin configure kata-cc@kata-plugin` or `--config KEY=VALUE` at install. Nothing has to be set.

| Option | Variable | Default | Meaning |
| --- | --- | --- | --- |
| `liveInbox` | `KATA_CLAUDE_LIVE_INBOX` | on | Deliver inbox requests as they arrive. Either one set off turns it off. |
| `contract` | | off | Add the Kata contract and inbox to each prompt. Leave off when `kata agent-hook install claude` is set up. |
| `kataExecutable` | `KATA_CLAUDE_EXECUTABLE` | `kata` | The Kata executable the plugin runs. |
| `debugFile` | `KATA_CLAUDE_DEBUG` | none | Path of the diagnostic log. |

## Documentation

- [Claude Code reference](https://github.com/Dangerboi/kata-plugin/blob/main/docs/reference/claude-code.md)
- [Install guide](https://github.com/Dangerboi/kata-plugin/blob/main/docs/how-to/install.md)
- [Closing rules](https://github.com/Dangerboi/kata-plugin/blob/main/docs/reference/closing-rules.md) and [limits](https://github.com/Dangerboi/kata-plugin/blob/main/docs/explanation/limits.md)
- [Changelog](https://github.com/Dangerboi/kata-plugin/blob/main/plugins/claude-code/CHANGELOG.md)

## License

MIT. See [LICENSE](https://github.com/Dangerboi/kata-plugin/blob/main/LICENSE).
