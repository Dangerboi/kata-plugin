# Pi reference

Package: `kata-pi`; portable entry: `plugins/pi/kata.ts`. The repository root has a `pi.extensions` shim for Git installation. Pi supplies TypeBox and its extension API through declared peers. The entry exits under OMP before loading TypeBox.

| Event/surface | Behavior |
| --- | --- |
| `session_start` | Restore saved plans/retries or child binding; retain the native attention baseline and clear inherited `KATA_REF`. Export the child-process marker. |
| `session_tree`, `session_shutdown` | Reload/drain reconciliation; unfinished children request review on their own issues. |
| `before_agent_start` | Bind inherited child work, inject its contract and exact issue/teammate/close command, or add the main plan and fallback context. |
| `agent_before_settle` | Add a hidden continuation for actionable unfinished main work, within a three-reminder progress budget. Questions, blockers, aborts and errors suppress it. |
| `tool_call` | Ensure a parent before a Bash command that launches `pi`; mutate Bash input in place to route bare `kata` and enforce child teammate attribution. Refuse child `--as`. |
| `tool_result` | Observe successful standalone main claims; ignore failed results. |
| `registerCommand("todo")`, `input` | Provide `/todo` and visible command replies. |

`KATA_PI_EXECUTABLE` selects the executable, falling back to `KATA_OMP_EXECUTABLE`, then `kata`. Debug output uses `KATA_PI_DEBUG`, with `KATA_OMP_DEBUG` as fallback. Existing actor identity is preserved. Explicit executable paths and quoted data are not rewritten.

Main sessions export `KATA_PI_PARENT` with their process/session identity, qualified parent ref, workspace, and teammate seed. A child Pi process inherits that marker, retains the actor, derives a distinct teammate, and sets its own inbox recipient. A child prompt is matched against every open child of the parent with the same rules as OMP: an exact title, qualified ref or bare short id, then a clear word overlap; the lead's active task only for an explicit "current task" handoff; otherwise, or when the named task is already delegated or owned by another writer, one separate child issue is created. A `KATA_TEAMMATE` the lead set for the child is kept. A child started without `--model`, `--models` or `--provider` switches to the parent's provider and model (and thinking level, unless `--thinking` is given). Revision guards prevent two children from taking the same task. Main todo mutations cannot complete delegated tasks: the child closes itself and `view` reloads Kata state. Saved child bindings retain identity when resumed. A freshly bound child that shuts down without running a tool leaves nothing behind: its own child issue closes as wontfix and a bound plan task is restored. A child that worked but left its issue open marks it `needs-review` and `needs-human`, hands a plan task back to the lead as pending, and notifies the lead; child shutdown has a 3 s budget for this. A `reload` is not an ending and changes nothing.

The main process clears `KATA_REF` from its environment after preserving the native adapter's captured baseline (or preseeding that same baseline if this plugin runs first). Its own explicit plan binding remains pinned. Children therefore cannot make native startup/shutdown change lead attention. Use the supplied qualified binding for child scripts rather than assuming inherited `KATA_REF`. The native registry controls [contract coexistence](../how-to/use-with-kata-agent-hooks.md); children always receive their own binding and contract.

Todo operations match the [OMP plan](oh-my-pi.md), including where the plan lives (`KATA_DEFAULT_PROJECT` with a repo label, else the inferred project), the lazy session parent, and replay after a Kata outage. Session-local plans (kept only while Kata is unreachable) and pending close retries persist in session custom entries and resume with the saved session. Children manage their own issues instead of mutating the main todo plan. Automatic parents reconcile from actual Kata children and accepted close evidence; explicit parents remain the lead's responsibility. See [closing rules](closing-rules.md) and [limits](../explanation/limits.md).

Typing `#` plus part of a ticket id or title word in the interactive editor offers matching open Kata issues beside Pi's own items; accepting inserts the qualified ref (`kata-plugin#bc7q `). Behavior, scoping (`#<project>#<token>`, `KATA_DEFAULT_PROJECT`, digits-only tokens left alone) and the never-block-typing rule match the [OMP reference](oh-my-pi.md#ticket-references-in-the-prompt). Pi receives `#` as an added trigger character; only the interactive main session registers it.

Items that name a ticket (`<project>#<short_id>: <action>`) work and log on that ticket exactly as in the [OMP plan](oh-my-pi.md), including the no-parent plan. Pi child processes do not bind such items: a child still follows the matching rules above.
