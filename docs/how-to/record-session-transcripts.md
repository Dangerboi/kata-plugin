# Record agent sessions on closes

Kata can record which agent session closed an issue, and link it to that session in [AgentsView](https://github.com/kenn-io/agentsview). Needs Kata 0.21.0.

Kata keeps this off by default and reads the setting only from its own config file, `$KATA_HOME/config.toml` (`~/.kata/config.toml` when `KATA_HOME` is unset). That file also configures the daemon, so the plugin never edits it: turning transcripts on is a one-time step you take yourself.

## Turn it on

Add to `~/.kata/config.toml`:

```toml
[close.transcript]
enabled = true
agentsview_url = "https://agentsview.example" # optional: your AgentsView address
```

Without `agentsview_url`, Kata records the agent and session ID without a link. No daemon restart is needed. The setting covers every `kata close` on this machine, so Claude Code and Codex closes, which Kata detects by itself, record their sessions too.

## What records a session

Once transcripts are on, the oh-my-pi and pi plugins record the session on every close they can see; you add nothing else.

- The plugin's own closes: `todo done`, `drop` and `rm`, the automatic parent's close, and the close of a superseded plan parent when the session adopts another parent.
- A `kata close` run in the harness's `bash` tool: the agent closing an issue itself, or a delegate closing its own issue.

Each session start exports `KATA_TRANSCRIPT_AGENT` (`omp` or `pi`) and `KATA_TRANSCRIPT_SESSION_ID` (the session's ID) in the harness process. Neither plugin clears them at shutdown: a reload or new session starts in the same process and overwrites the pair, and clearing after a slow cleanup could delete the new pair. Kata uses the pair only when both are set. Kata builds the link from the agent name (`<agentsview_url>/sessions/omp/<id>`).

- **oh-my-pi delegates** run inside the lead's process. A delegate's `kata close` in its `bash` tool records the delegate's own session, which AgentsView lists as a child of the lead's. If the plugin cannot read the delegate's session ID, the close records the lead's session.
- **pi children** are separate processes, and each records its own session.
- **Other harnesses** started from the `bash` tool (for example `claude -p`) inherit the pair, and Kata prefers it over their own session variable. Their closes record the oh-my-pi or pi session that launched them. Unset both variables in the command to record the child's own session.

## `session_id_env`

You do not need Kata's `[close.transcript.session_id_env]` table for oh-my-pi or pi: the explicit pair above takes precedence over it. Without the plugin, oh-my-pi and pi both pass the session ID as `PI_SESSION_ID`, so mapping that variable to `pi` would record oh-my-pi closes as pi sessions that AgentsView cannot open.

## Check it

After a close, read the session back from the close event:

```sh
kata events --project <project> --limit 100 --json \
  | jq '.events[] | select(.type == "issue.closed") | {issue: .issue_short_id, transcript: .payload.transcript}'
```

A recorded close shows `{"agent": "omp", "session_id": "<id>"}`, plus a `url` ending in `/sessions/omp/<id>` when `agentsview_url` is set.
