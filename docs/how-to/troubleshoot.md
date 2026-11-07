# Troubleshoot

| Symptom | Check |
| --- | --- |
| Todo remains local | The plan is session-local only while Kata is unreachable (the first reply says so and a warning appears once). Check `kata list` from the folder, the executable (`KATA_OMP_EXECUTABLE`) and the daemon; the plan replays on the next todo call or within a minute of Kata returning. Tracked workers use their assigned issue. |
| Plan lands in a project you did not expect | A folder with no Kata project uses `KATA_DEFAULT_PROJECT`, else registers its inferred project. Bind explicitly with `init ref` or `KATA_REF`, or run `kata init --project <name>` in the folder. |
| `todo` says the default project is missing | `KATA_DEFAULT_PROJECT` must name an existing project; create it with `kata projects create <name>`. |
| Todo state unavailable | Read the reported Kata error. Once the service recovers, call `view`; failed bindings and reads are retried without presenting cached tasks as current. |
| Close succeeds with “transcript: current session unavailable or invalid” | Transcripts are on, but this close carried no session pair. The omp and pi plugins export it at session start, so this is a close run outside the harness (a plain terminal, or after the session ended) or with the variables unset; see [Record agent sessions on closes](record-session-transcripts.md). The close itself succeeded. |
| Close succeeds with “transcript: ambiguous current session” | More than one `[close.transcript.session_id_env]` variable is set, for example `pi` and `omp` both mapped to `PI_SESSION_ID`. The omp and pi plugins need no mapping: remove it. |
| AgentsView says the linked session is not found | The close recorded another agent name, usually from a `[close.transcript.session_id_env]` mapping that names the wrong harness (`PI_SESSION_ID` mapped to `pi` while you use oh-my-pi), or the AgentsView address is wrong. Remove the mapping: the plugin sets the right agent itself. |
| Close refused | Inspect the actual Kata error, evidence, owner, teammate, and current children. Do not force a completed display state. |
| Parent stays open | Check all current children, pending/running delegates, lead settlement, and `needs-review`. Explicit parents stay open by design. |
| Duplicate todo tool | Disable OMP's native todo or remove another pi todo extension. |
| No visible error | Hooks are deliberately quiet. Enable `KATA_OMP_DEBUG`, or `KATA_PI_DEBUG`. |
| Git install cannot find pi subdirectory | Install the repository root shim or clone and install the local `plugins/pi` directory. |
| Pi child changed lead attention | The installed pi hook predates Kata 0.21. Rerun `kata agent-hook install pi --attention` to regenerate it, then restart pi. Kata's `KATA_ATTENTION_HOST` guard keeps child sessions off the lead's attention; the plugin no longer clears the lead's `KATA_REF`. |

## Skillshare snapshot ownership conflict

An update can fail when Skillshare stores a local plugin source with `~` but the snapshot owner records its absolute path. In the affected configuration, restore the source to the same absolute spelling used when adding the plugin, then retry the update. Do not delete another source's snapshot or force ownership. A later config save may shorten the path again. This workaround is documented in [runkids/skillshare#461](https://github.com/runkids/skillshare/issues/461).

## Unavailable Kata

Foreground hooks return within a short budget and retain retryable work. Ordinary todo CLI calls allow up to 120 seconds. Main-session todo close retries persist in saved session entries. An outage should leave work open. Correct the route or executable and resume; do not point a test at a normal store to bypass isolation.
