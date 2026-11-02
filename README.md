# Kata Plugin

Kata work tracking for oh-my-pi and pi. Delegated work and todo plans become Kata issues with attributed ownership and evidence for completion. Kata validates each close; automatic session parents close after their children finish.

| Plugin | Tracks |
| --- | --- |
| [oh-my-pi](docs/reference/oh-my-pi.md) | Todo plans and task subagents |
| [pi](docs/reference/pi.md) | Todo plans and child Pi processes |

Oh-my-pi:

```sh
omp plugin marketplace add Dangerboi/kata-plugin
omp plugin install kata@kata-plugin
```

That is the whole setup. The plugin replaces omp's built-in `todo` with Kata in every folder, with no configuration. A repo with no Kata project plans in the project named by `KATA_DEFAULT_PROJECT` (labeled with the repo), or else in its inferred project, which the plugin registers in the daemon without writing files into the repo.

Pi:

```sh
pi install git:github.com/Dangerboi/kata-plugin
# or, from a local clone:
pi install ./kata-plugin/plugins/pi
```

Requires Kata 0.19 (0.20 tested), plus the selected harness. The omp plugin delegates session attention to `kata agent-hook attention-native`, and settle comments use Kata 0.19 comment idempotency keys. Tested host versions are oh-my-pi 18.15.0 and pi 1.0.2. Bun and Node are needed for development.

Start with the [first session tutorial](docs/tutorials/first-session.md), [installation guide](docs/how-to/install.md), or [development guide](docs/development.md). See [completion rules](docs/reference/closing-rules.md) and [limits](docs/explanation/limits.md) before adopting automatic closure.

Claude Code is no longer supported here. Use Kata's own hook instead: `kata agent-hook install claude --attention`. Existing Claude installs of this plugin stay on adapter 0.2.0.

Originally created by [salmonumbrella](https://github.com/salmonumbrella).
