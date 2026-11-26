# Bind work to an issue

Set `KATA_REF=example#abcd` before launching a harness to bind an existing open issue. Use qualified refs when projects could be ambiguous. This is an explicit parent: the plugin never automatically closes it.

A successful main-agent `kata claim example#abcd` also establishes a binding after a fresh state check. Todo adapters additionally observe `kata meta set example#abcd work.attention ok`; they require matching ownership. Use a standalone command so the observer can identify it safely. `KATA_REF` takes precedence in the todo adapters.

On omp, a ticket bound by `kata claim` or `/todo ref <ref>` also gets session attention like `KATA_REF`: if the session ends while the issue is open and not handed back, Kata flags it `needs-human`. An issue already flagged `stuck` or `needs-human` keeps its flag.

Todo accepts `ref` on `init`; `/todo` displays the current plan. In Pi, an explicit plan parent or a delegate's assignment is authoritative: an `init` naming a different issue fails before replacing tasks. Full issue UIDs and short IDs resolve to the same qualified short reference.

omp's own `todo` has no `ref`. In omp, run `kata claim example#abcd` as above, or have the user type `/todo ref example#abcd`, which makes the issue the plan parent at once and loads its open children. Naming the session's current automatic parent with `/todo ref` makes it explicit, so it is no longer closed automatically. A plan that already has another parent keeps it.


Without an explicit binding, the first todo initialization creates a lazy session parent. An OMP delegation never creates it when it starts: it binds an existing plan item or ticket, or works no issue; a Claude Code `Agent`, Workflow agent or teammate is assigned an existing plan item or ticket the same way ([reference](../reference/claude-code.md#delegates)). An untracked delegate that exits with a report creates it when the plan has none, to hold the mission that records its run. Its typed automatic marker is what grants automatic closure.

In OMP and Pi, adopting a different explicit binding leaves a populated automatic parent and its existing child relationships intact. An owned empty automatic parent is retired as superseded. Bindings and pending operations retain their original workspace and qualified project refs. Resume validates stored state before writing. In a folder with no Kata project, the todo adapters plan in `KATA_DEFAULT_PROJECT` or the inferred project (see the [oh-my-pi reference](../reference/oh-my-pi.md)). Only while Kata is unreachable do they keep a local plan; a saved OMP/Pi session retains it, including task status and blockers, and replays it into Kata when Kata returns.
