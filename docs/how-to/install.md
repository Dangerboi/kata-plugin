# Install

Install Kata 0.21.0 or later. Oh-my-pi and pi need no Kata project in the folder: a folder without a Kata project uses `KATA_DEFAULT_PROJECT` or its inferred project (see the [oh-my-pi reference](../reference/oh-my-pi.md)). These plugins use `agent-contract-hook`, revision guards, typed evidence, `audit closes`, and `events`.

## Oh-my-pi

```sh
omp plugin marketplace add /path/to/kata-plugin
omp plugin install kata@kata-plugin
```

Restart omp. There is no `todo.enabled` step: the plugin's `todo` replaces the built-in one, and omp's own todo reminders, nudges and HUD have nothing to track. A `todo.enabled: false` you set earlier keeps working.

Optional: send the plans of repos that have no Kata project to one Kata project, labeled with the repo name, by exporting it where omp runs:

```sh
export KATA_DEFAULT_PROJECT=vault
```

Optional: record the agent session on each close, with a link to it in AgentsView. See [Record agent sessions on closes](record-session-transcripts.md).

To try it without installing:

```sh
omp --no-extensions -e /path/to/kata-plugin/plugins/oh-my-pi/kata.ts
```

Tested with oh-my-pi 18.16.0. To check another omp release, run `bun run smoke:omp` from a checkout (see [development](../development.md#smoke-test-against-a-real-omp)).

## Pi

```sh
pi install /path/to/kata-plugin/plugins/pi
```

The root manifest supports `pi install git:github.com/Dangerboi/kata-plugin`. Pi 1.0.2 cannot select a repository subdirectory through a Git URL; appending `/plugins/pi` changes the clone URL. Use the root shim or a local plugin directory.

For one run: `pi --no-extensions -e /path/to/kata-plugin/plugins/pi/kata.ts`. Remove any other todo extension first. Keep each plugin directory intact: its adjacent `kata-core.ts` and `plan-parent.ts` are required. Do not overwrite the native adapter at the user extension path `kata.ts`.

The omp marketplace identifies the plugin as `kata@kata-plugin`. The same catalog lists `kata-pi` (source `plugins/pi`) so tools that read the catalog, such as Skillshare, can install the pi build from the Git URL; it is for pi, and under omp its entry exits without loading. The npm package names `kata-omp` and `kata-pi` identify the portable packages. The root pi shim does not make the OMP package a pi extension.
