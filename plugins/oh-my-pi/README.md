# kata-omp

[Kata](https://github.com/kenn-io/kata) work tracking for [oh-my-pi](https://github.com/can1357/oh-my-pi). omp's todo plans, and the `task` subagents that work their items or name a ticket, become Kata issues with attributed ownership and evidence for completion. Kata validates each close; automatic session parents close after their children finish.

```sh
omp plugin install @dangerboi/kata-omp
```

Or from the plugin marketplace, which loads under the same package name, so install one or the other:

```sh
omp plugin marketplace add Dangerboi/kata-plugin
omp plugin install kata@kata-plugin
```

A marketplace install from before the npm package is still named `kata-omp`, and omp loads it beside the npm package. Upgrade it first (`omp plugin marketplace update kata-plugin`, then `omp plugin upgrade kata@kata-plugin`) or uninstall it; if both are already installed, uninstall one.

Restart omp, then pick Kata under `/settings` → Tools → Todos → Todo Backend (`todo.backend: kata`); until then omp's todo list stays out of Kata. Requires oh-my-pi 19.1.1 or later, Kata 0.23.0 or later and a running Kata daemon. Tested with oh-my-pi 19.1.1 and Kata 0.23.0. For stock pi, install [`@dangerboi/kata-pi`](https://www.npmjs.com/package/@dangerboi/kata-pi) instead.

- omp's own `todo`, `/todo` and HUD keep running; the plugin mirrors each change to the list into Kata, with every task a child issue. A repo with no Kata project plans in the project named by `KATA_DEFAULT_PROJECT` (labeled with the repo), or else in its inferred project.
- `todo done` on a task whose Kata issue is still open is refused with the `kata close` command to run first, so every close carries evidence Kata accepted.
- An item named `<project>#<short_id>: <action>` works and logs on that existing ticket.
- Typing `#` and part of a ticket id or title in the prompt offers matching open Kata issues.
- A `task` subagent whose task names a plan item or a ticket works that issue. Any other subagent that exits with a report leaves a closed mission issue under the plan.
- Kata inbox requests for `KATA_INBOX_USER` (`<actor>/<name>`) reach the main session live, even while it is idle.

Documentation: [first session](https://github.com/Dangerboi/kata-plugin/blob/main/docs/tutorials/first-session.md), [installation](https://github.com/Dangerboi/kata-plugin/blob/main/docs/how-to/install.md), [oh-my-pi reference](https://github.com/Dangerboi/kata-plugin/blob/main/docs/reference/oh-my-pi.md), [completion rules](https://github.com/Dangerboi/kata-plugin/blob/main/docs/reference/closing-rules.md), [limits](https://github.com/Dangerboi/kata-plugin/blob/main/docs/explanation/limits.md). Installing from a folder instead of npm: keep the folder intact; every `.ts` file next to `kata.ts` is a required module.

MIT licensed. Source: [Dangerboi/kata-plugin](https://github.com/Dangerboi/kata-plugin).
