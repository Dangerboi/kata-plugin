# Record agent sessions on closes

Kata can record which agent session closed an issue, and link it to that session in [AgentsView](https://github.com/kenn-io/agentsview). Needs Kata 0.23.0.

Kata keeps this off by default. The oh-my-pi and pi plugins turn it on for their own sessions: each session start sets `KATA_CLOSE_TRANSCRIPT_ENABLED=true` in the harness process unless the variable is already set, so there is nothing to configure. The plugin never edits `$KATA_HOME/config.toml` (`~/.kata/config.toml` when `KATA_HOME` is unset), which also configures the daemon.

## Add links

Without `agentsview_url`, Kata records the agent and session ID without a link. To add links, put your AgentsView address in `~/.kata/config.toml`:

```toml
[close.transcript]
agentsview_url = "https://agentsview.example"
```

Kata still reads `agentsview_url` from the file when the variable turns transcripts on. No daemon restart is needed.

## Turn it off

Set `KATA_CLOSE_TRANSCRIPT_ENABLED=false` in the environment that launches omp or pi. The plugin leaves a value that is already set alone, and pi delegates inherit it. The plugin does not read Kata's config, so `enabled = false` under `[close.transcript]` does not stop omp and pi sessions.

## What records a session

The oh-my-pi and pi plugins record the session on every close they can see; you add nothing else.

- The plugin's own closes: `todo done`, `drop` and `rm`, the automatic parent's close, and the close of a superseded plan parent when the session adopts another parent.
- A `kata close` run in the harness's `bash` tool: the agent closing an issue itself, or a delegate closing its own issue.

Each session start exports `KATA_CLOSE_TRANSCRIPT_ENABLED` (unless already set), `KATA_TRANSCRIPT_AGENT` (`omp` or `pi`) and `KATA_TRANSCRIPT_SESSION_ID` (the session's ID) in the harness process. Neither plugin clears the pair at shutdown: a reload or new session starts in the same process and overwrites the pair, and clearing after a slow cleanup could delete the new pair. Kata uses the pair only when both are set. Kata builds the link from the agent name (`<agentsview_url>/sessions/omp/<id>`).

- **oh-my-pi delegates** run inside the lead's process. A delegate's `kata close` in its `bash` tool and its own `todo` closes (`done`, `drop`, `rm`) record the delegate's own session, which AgentsView lists as a child of the lead's. If the plugin cannot read the delegate's session ID yet, a `bash` close records the lead's session and a `todo` close records no session.
- **pi children** are separate processes, and each records its own session.
- **Other harnesses** started from the `bash` tool (for example `claude -p`) inherit the switch and the pair, and Kata prefers the pair over their own session variable. Their closes record the oh-my-pi or pi session that launched them. Unset the pair in the command to record the child's own session.
- **Harnesses outside omp and pi**, run in their own terminal, get no switch from the plugin: add `enabled = true` under `[close.transcript]` in Kata's config to record their closes. Kata then finds Claude Code and Codex sessions by itself. Other harnesses need their own session pair or a `[close.transcript.session_id_env]` mapping (see below).

## `session_id_env`

You do not need Kata's `[close.transcript.session_id_env]` table for oh-my-pi or pi: the explicit pair above takes precedence over it. Without the plugin, oh-my-pi and pi both pass the session ID as `PI_SESSION_ID`, so mapping that variable to `pi` would record oh-my-pi closes as pi sessions that AgentsView cannot open.

## Check it

After a close, read the session back from the close event:

```sh
kata events --project <project> --limit 100 --json \
  | jq '.events[] | select(.type == "issue.closed") | {issue: .issue_short_id, transcript: .payload.transcript}'
```

A recorded close shows `{"agent": "omp", "session_id": "<id>"}`, plus a `url` ending in `/sessions/omp/<id>` when `agentsview_url` is set.
