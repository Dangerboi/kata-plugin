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

## Map the session variable

oh-my-pi and pi both pass the running session's ID to every command their `bash` tool runs, as `PI_SESSION_ID` (oh-my-pi sets no `OMP_SESSION_ID`). Tell Kata which harness that variable belongs to:

```toml
[close.transcript.session_id_env]
omp = "PI_SESSION_ID" # oh-my-pi
# pi = "PI_SESSION_ID" # pi
```

The key is the agent name AgentsView uses for that harness's sessions: `omp` for oh-my-pi, `pi` for pi. Kata builds the link from it (`<agentsview_url>/sessions/omp/<id>`), so a wrong name gives a link AgentsView cannot open.

Map only the harness you use. Both set the same variable, so Kata cannot tell them apart: with `pi` mapped, closes made in oh-my-pi are recorded as pi sessions, and with both keys mapped Kata warns `ambiguous current session` and records none.

## What records a session

- A `kata close` run in the harness's `bash` tool: the agent closing an issue itself, or a delegate closing its own issue.
- Not the plugin's own closes: `todo done`, `drop` and `rm`, and the automatic parent's close. They run outside the `bash` tool, carry no session variable, and close normally after Kata warns `current session unavailable or invalid; skipping attachment`.

## Check it

After a close from the harness's `bash` tool, read the session back from the close event:

```sh
kata events --project <project> --limit 100 --json \
  | jq '.events[] | select(.type == "issue.closed") | {issue: .issue_short_id, transcript: .payload.transcript}'
```

A recorded close shows `{"agent": "omp", "session_id": "<id>", "url": ".../sessions/omp/<id>"}`.
