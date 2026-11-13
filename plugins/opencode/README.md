# kata-opencode

[Kata](https://github.com/kenn-io/kata) work tracking for [OpenCode](https://opencode.ai). OpenCode's todo plans, and the delegates that work their items or name a ticket, become Kata issues with attributed ownership and evidence for completion. Kata validates each close. The automatic parent of a session's plan closes when the session is deleted or archived and its children are closed.

Add the package to the `plugins` list in `opencode.json` (global or per project); OpenCode installs it on the next start:

```json
{ "plugins": ["@dangerboi/kata-opencode"] }
```

Requires OpenCode 2.2.7 or later, Kata 0.23.0 or later and a running Kata daemon. Tested with OpenCode 2.2.7 and Kata 0.23.0. Remove any other todo plugin first. Run `kata agent-hook install opencode` for Kata's contract, inbox and attention; the plugin does not add them.

- `todowrite` plans into Kata. A call whose list disagrees with the Kata plan is refused and carries the current list. A repo with no Kata project plans in the project named by `defaultProject` (labeled with the repo), or else in its inferred project.
- An item named `<project>#<short_id>: <action>` works and logs on that existing ticket.
- A delegate started by the lead (a `subagent` call) gets its own Kata issue and teammate when its prompt names a plan item or a ticket. If it ends with the issue open, the issue goes back to the lead for review. A follow-up to the same delegate stays on its issue.
- A subagent's `kata` commands in the `shell` tool run as its teammate; `--as` is refused.
- Settings are plugin options in `opencode.json` (`executable` (the Kata executable the plugin runs), `ref`, `defaultProject`, `author`, `teammate`, `debugFile`), each falling back to a `KATA_*` variable in the server's environment. Put them in the entry's `options`:

```json
{ "plugins": [{ "package": "@dangerboi/kata-opencode", "options": { "defaultProject": "vault" } }] }
```

Documentation: [OpenCode reference](https://github.com/Dangerboi/kata-plugin/blob/main/docs/reference/opencode.md), [installation](https://github.com/Dangerboi/kata-plugin/blob/main/docs/how-to/install.md), [completion rules](https://github.com/Dangerboi/kata-plugin/blob/main/docs/reference/closing-rules.md), [limits](https://github.com/Dangerboi/kata-plugin/blob/main/docs/explanation/limits.md). Installing from a checkout instead of npm: put the absolute path of the `plugins/opencode` directory in `plugins`. Its `package.json` `exports` resolves the plugin, so no wrapper is needed; keep the folder intact, because every `.ts` file next to `kata.ts` is a required module.

MIT licensed. Source: [Dangerboi/kata-plugin](https://github.com/Dangerboi/kata-plugin).
