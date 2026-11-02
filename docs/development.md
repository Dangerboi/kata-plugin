# Development

**Run every test and live experiment with an explicit throwaway `KATA_HOME`. Never point experiments at a normal store or a real project.** The root test runner creates a marked temporary root, clears inherited remote/issue routing, and passes isolated stores to the suites. Real-Kata fixtures stop their own daemons.

```sh
bun install --ignore-scripts
KATA_TEST_EXECUTABLE=/absolute/path/to/guarded-kata bun run test
bun run check:plugins
bun run typecheck
bun run validate
```

The real native pi adapter tests need `kata agent-hook install pi` (Kata 0.19); against a Kata without it they are skipped with that reason, never faked. `test` runs OMP/pi tests, Claude engine tests, property tests, real-Kata integration tests, and revision conformance. The Claude engine runner requires a valid successful native report from every file; exit zero alone is insufficient. Before the first typecheck, load the Claude plugin once in an isolated live session as described below. Claude writes version-specific API declarations to the ignored `.claude-plugin/types/` directory on live load; the engine test runner does not generate them.

Focused runners retain the isolation wrapper:

```sh
KATA_TEST_EXECUTABLE=/absolute/path/to/guarded-kata bun run test:todo
KATA_TEST_EXECUTABLE=/absolute/path/to/guarded-kata bun run test:claude
KATA_TEST_EXECUTABLE=/absolute/path/to/guarded-kata bun run test:revisions
```

The semantic canary copies the default database and WAL into a disposable directory. SQLite opens only that copy. It requires the same schema version, no new projects, and no new events from test actors or project names. Ordinary background sync and WAL/SHM churn are ignored. Unreadable, invalid, or unstable copies fail closed. Update fixture actor/project coverage in `tests/isolation.ts` when adding cases; never disable the canary to obtain a pass.

## Source layout

`core/kata-core.ts` holds the shared engine. Root `kata.ts` is the canonical OMP adapter. `plugins/pi/kata.ts` is the canonical pi adapter. `bun run build:plugins` vendors the core into both plugin folders and regenerates the portable OMP entry. `check:plugins` rejects stale generated sources. Each portable plugin's local imports stay inside its directory.

Claude hooks, typed state contracts, and tests live under `plugins/claude-code`. Its package exposes `test:engine`, `test:properties`, `test:real-kata`, `typecheck`, and `validate`; use the root wrapper for ordinary test runs so the semantic canary covers them together.

For live smoke tests, use a fresh Git folder and throwaway store as in the [tutorial](tutorials/first-session.md). Point `kataExecutable` (Claude), `KATA_OMP_EXECUTABLE`, or `KATA_PI_EXECUTABLE` at the guarded binary before launch. Inspect actual issues and close events; stop the test daemon and close any terminal panes you created. Keep transcripts and temporary reports outside the repository.

## Releases

Installs come from the marketplace (`kata@kata-plugin`) and Git; nothing is published to npm.

1. Bump `version` by hand in each changed plugin's `plugins/*/package.json` (and `plugins/claude-code/.claude-plugin/plugin.json` for Claude Code). Keep the root `package.json` version equal to pi's: the root manifest is what `pi install git:…` installs.
2. Add a `CHANGELOG.md` heading naming each plugin version and the date, for example `## oh-my-pi 2.2.0 / pi 1.2.0 — 2026-10-31`.
3. After the change merges, tag `main` as `v<root version>` and publish a GitHub release from that tag with the changelog section as its notes.
