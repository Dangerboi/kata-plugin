# Install

Install Kata 0.23.0 or later. Oh-my-pi and pi need no Kata project in the folder: a folder without a Kata project uses `KATA_DEFAULT_PROJECT` or its inferred project (see the [oh-my-pi reference](../reference/oh-my-pi.md)). These plugins use `agent-contract-hook`, revision guards, typed evidence, `audit closes`, and `events`.

## Runtime compatibility

Both plugins check `kata version --json` before using the CLI. They require JSON schema 1 (`kata_api_version: 1`) and a version that proves Kata 0.23.0 or later. Older or unprovable versions return `unsupported_version` with installation guidance; missing executables, unreachable Kata and timed-out probes still use the local plan fallback.

Release versions such as `v0.23.0` are accepted. Source builds made with `make install` from a tagged clone are accepted when their base release is at least 0.23.0, including git-describe versions such as `v0.23.0-4-g4aea65239`, `v0.23.0-4-g4aea65239-dirty` and `v0.23.0-dirty`. The 0.23.0 prerelease is below the minimum; prereleases of later versions are accepted.

Plain `go build`, `go install …@latest` and tagless clones can report `dev` or a bare commit hash, which cannot establish the minimum. Install a versioned release at or above 0.23.0 using Homebrew, a release archive or `kata update`, or build with `make install` from a clone with release tags. Retry the plugin operation after installing or upgrading Kata.

## Oh-my-pi

```sh
omp plugin marketplace add /path/to/kata-plugin
omp plugin install kata@kata-plugin
```

Restart omp. There is no `todo.enabled` step: the plugin's `todo` replaces the built-in one, and omp's own todo reminders, nudges and HUD have nothing to track. A `todo.enabled: false` you set earlier keeps working.

To update, refresh the marketplace first: `upgrade` reads plugin versions from omp's cached copy of the marketplace, which it does not fetch, so without the first line it reports the version you already have.

```sh
omp plugin marketplace update kata-plugin
omp plugin upgrade kata@kata-plugin
```

Then restart omp.

Optional: send the plans of repos that have no Kata project to one Kata project, labeled with the repo name, by exporting it where omp runs:

```sh
export KATA_DEFAULT_PROJECT=vault
```

Optional: record the agent session on each close, with a link to it in AgentsView. See [Record agent sessions on closes](record-session-transcripts.md).

To try it without installing:

```sh
omp --no-extensions -e /path/to/kata-plugin/plugins/oh-my-pi/kata.ts
```

Tested with oh-my-pi 18.18.1. To check another omp release, run `bun run smoke:omp` from a checkout (see [development](../development.md#smoke-test-against-a-real-omp)).

## Pi

```sh
pi install npm:@dangerboi/kata-pi
# or, from a checkout:
pi install /path/to/kata-plugin/plugins/pi
```

The root manifest supports `pi install git:github.com/Dangerboi/kata-plugin`. Pi 1.0.2 cannot select a repository subdirectory through a Git URL; appending `/plugins/pi` changes the clone URL. Use the root shim or a local plugin directory.

For one run: `pi --no-extensions -e /path/to/kata-plugin/plugins/pi/kata.ts`. Remove any other todo extension first. Keep each plugin directory intact: every `.ts` file next to its `kata.ts` is a required core module. Do not overwrite the native adapter at the user extension path `kata.ts`.

The omp marketplace identifies the plugin as `kata@kata-plugin`. The same catalog lists `kata-pi` (source `plugins/pi`) so tools that read the catalog, such as Skillshare, can install the pi build from the Git URL; it is for pi, and under omp its entry exits without loading. On npm the pi build is `@dangerboi/kata-pi`; `kata-omp` names the OMP package and is not published. The root pi shim does not make the OMP package a pi extension.
