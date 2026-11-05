# Development

**Run every test and live experiment with an explicit throwaway `KATA_HOME`. Never point experiments at a normal store or a real project.** The root test runner creates a marked temporary root, clears inherited remote/issue routing, and passes isolated stores to the suites. Real-Kata fixtures stop their own daemons.

```sh
bun install --ignore-scripts
KATA_TEST_EXECUTABLE="$(readlink -f "$(command -v kata)")" bun run test
bun run check:plugins
bun run typecheck
```

The real native pi adapter tests need `kata agent-hook install pi` (Kata 0.21.0); against a Kata without it they are skipped with that reason, never faked. `test` runs OMP/pi tests, real-Kata integration tests, and revision conformance.

Focused runners retain the isolation wrapper:

```sh
KATA_TEST_EXECUTABLE=/absolute/path/to/guarded-kata bun run test:todo
KATA_TEST_EXECUTABLE=/absolute/path/to/guarded-kata bun run test:revisions
```

The semantic canary copies the default database and WAL into a disposable directory. SQLite opens only that copy. It requires the same schema version, no new projects, and no new events from test actors or project names. Ordinary background sync and WAL/SHM churn are ignored. Unreadable, invalid, or unstable copies fail closed. Update fixture actor/project coverage in `tests/isolation.ts` when adding cases; never disable the canary to obtain a pass.

## Source layout

`core/kata-core.ts` holds the shared engine. `core/plan-parent.ts` decides which plan parent and workspace a plan serves, as a pure function with no Kata calls. `core/settlement.ts` owns the closes the plugin still owes a session: throttled task closes, ticket closes waiting on children and the automatic parent's close, with one drain, one timer, one snapshot and one verdict memory; its clock and timer are injected, so `tests/settlement.test.ts` drives time with a fake clock against real Kata. `core/inbox.ts` holds the session inbox: the trust rule, the `<kata_inbox>` render, the delivery text, and the live follower with its seed retry, head cache and restart backoff. The omp adapter spawns `kata events --tail` and hands that to the follower through its dependencies; pi reads the inbox per turn only. Root `kata.ts` is the canonical OMP adapter. `plugins/pi/kata.ts` is the canonical pi adapter. `bun run build:plugins` vendors every `core/*.ts` module into both plugin folders and regenerates the portable OMP entry. `check:plugins` rejects stale generated sources. Each portable plugin's local imports stay inside its directory.

Kata failures are read from Kata's `--json` error envelope and exit code, never from message wording: the core adds `--json` to every call (except the contract hook) and branches on `daemon_unavailable` (exit 7), `project_not_initialized` and `sibling_throttle`. A missing executable or a killed call is detected from the exec result. The project name to register in an unregistered folder comes from the structured `data` on `project_not_initialized` (`project`, else `alias`), else the folder name; no code path reads a Kata message. Test fixtures in `tests/kata-errors.ts` are real Kata output.

For live smoke tests, use a fresh Git folder and throwaway store as in the [tutorial](tutorials/first-session.md). Point `KATA_OMP_EXECUTABLE` or `KATA_PI_EXECUTABLE` at the guarded binary before launch. Inspect actual issues and close events; stop the test daemon and close any terminal panes you created. Keep transcripts and temporary reports outside the repository.

## Smoke test against a real omp

`bun run smoke:omp` loads `plugins/oh-my-pi/kata.ts` into a real, headless `omp -p` and checks the result in a real Kata daemon. Run it after each omp release and move the tested version in the README and install guide once it passes. It needs `omp` and `kata` on `PATH` and no credentials: a smoke-only extension (`scripts/smoke-omp-provider.ts`) registers a scripted model provider through `pi.registerProvider`, so the model calls are fixed. Each run uses a fresh Git folder, `KATA_HOME` and `PI_CODING_AGENT_DIR` set on the omp and Kata child processes only (your `~/.omp` and Kata store are never touched), and stops its Kata daemon at the end, pass or fail. It prints one `PASS`/`FAIL` line per check and exits non-zero on any failure.

The default scenario checks that `todo init` creates the automatic parent and its plan tasks, that a `task` delegation binds to its plan task (the delegate carries `omp.subagent_id`, which proves omp's undocumented `task:subagent:lifecycle` payload still works), that `todo done` closes with the given evidence, and that session shutdown closes the automatic parent. The `fork` scenario forks the session over RPC and checks that the fork's plan changes land under the source's parent. The `tickets` scenario covers ticket-named plan items. The `untracked` scenario sends a `scout` that matches no plan item and checks that it creates no issue, `needs-review` label or inbox request, and that the automatic parent still closes from the plan's own items.

```sh
bun run smoke:omp                       # every scenario, scripted model
bun run smoke:omp --scenario default    # one scenario
bun run smoke:omp --verbose             # also print omp's JSON event stream
bun run smoke:omp --live --model openrouter/<model>   # same checks with a real model
```

The `inbox` and `inbox-per-turn` scenarios drive one long-lived `omp --mode rpc` session, running `kata notify` against the throwaway store (the notify sender and the session share `KATA_AUTHOR`, so the trust rule accepts it) and checking what the scripted provider recorded per request. `inbox` checks live delivery with no prompt: a notify starts a turn on an idle agent (the delivered text names the sender, the issue and how to clear it), reaches a working agent (a scripted slow `bash` step) after its tool result without interrupting it, is delivered once, and a clear delivers nothing; the `<kata_inbox>` section shows the request on the next prompt and drops it after the clear. It also sends a request as another actor (`KATA_AUTHOR=mallory`, a forged sender) and checks that it starts no turn and its text reaches no system prompt or user message. `inbox-per-turn` runs with `KATA_OMP_LIVE_INBOX=0`: nothing is delivered live, the request must appear as `<kata_inbox>` within two turns (a read slower than the hook's budget lands on the next turn) and disappear within two turns of clearing it. Both are scripted-only and skipped by `--live`.

Scenarios are data in `scripts/smoke-omp-scenarios.ts`: scripted turns per agent (a turn may be a function of the conversation so far) plus assertions over the store. Add one by appending an entry to `SCENARIOS`; a scenario that only scripts turns and checks the store needs no driver or provider changes, but one that needs a new RPC command or a persisted session (like `fork`) also extends the driver.

`--live` has the real model do the work from a plain-language prompt, so it needs a login. The driver clones `agent.db` from `$PI_CODING_AGENT_DIR` (default `~/.omp/agent`) into the throwaway agent directory with a read-only SQLite backup and keeps only API-key logins: refreshing a copied OAuth login rotates its refresh token and can log your own omp out. So `--model` must name a provider you log into with an API key (OpenRouter, for example). Nothing else from your omp config is used. Live runs spend tokens and can fail on model behaviour rather than plugin behaviour.

## Releases

Installs come from the marketplace (`kata@kata-plugin`) and Git; nothing is published to npm.

1. Bump `version` by hand in each changed plugin's `plugins/*/package.json`. Keep the root `package.json` version equal to pi's: the root manifest is what `pi install git:…` installs.
2. Add a `CHANGELOG.md` heading naming each plugin version and the date, for example `## oh-my-pi 2.2.0 / pi 1.2.0 — 2026-10-31`.
3. After the change merges, tag `main` as `v<root version>` and publish a GitHub release from that tag with the changelog section as its notes.
