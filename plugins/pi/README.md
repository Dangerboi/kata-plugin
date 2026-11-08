# kata-pi

[Kata](https://github.com/kenn-io/kata) work tracking for [pi](https://pi.dev). Pi's todo plans, and the child pi processes that work their items or name a ticket, become Kata issues with attributed ownership and evidence for completion. Kata validates each close; automatic session parents close after their children finish.

```sh
pi install npm:kata-pi
```

Requires Kata 0.21.0 or later and a running Kata daemon. Tested with pi 1.5.0 and Kata 0.22.0. Remove any other todo extension first.

- `/todo` and the `todo` tool plan into Kata. A repo with no Kata project plans in the project named by `KATA_DEFAULT_PROJECT` (labeled with the repo), or else in its inferred project.
- An item named `<project>#<short_id>: <action>` works and logs on that existing ticket.
- Typing `#` and part of a ticket id or title in the editor offers matching open Kata issues.
- A child `pi` started from the main session gets its own Kata issue and teammate. If it exits with the issue open, the issue goes back to the lead for review, or is restored if the child ran no tool.
- Kata inbox requests for `KATA_INBOX_USER` (`<actor>/<name>`) are read before each prompt.

Documentation: [first session](https://github.com/Dangerboi/kata-plugin/blob/main/docs/tutorials/first-session.md), [installation](https://github.com/Dangerboi/kata-plugin/blob/main/docs/how-to/install.md), [pi reference](https://github.com/Dangerboi/kata-plugin/blob/main/docs/reference/pi.md), [completion rules](https://github.com/Dangerboi/kata-plugin/blob/main/docs/reference/closing-rules.md), [limits](https://github.com/Dangerboi/kata-plugin/blob/main/docs/explanation/limits.md). Installing from a folder instead of npm: keep the folder intact; every `.ts` file next to `kata.ts` is a required module.

MIT licensed. Source: [Dangerboi/kata-plugin](https://github.com/Dangerboi/kata-plugin).
