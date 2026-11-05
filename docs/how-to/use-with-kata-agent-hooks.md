# Use with Kata agent hooks

Kata's native hooks (Claude Code uses them directly: `kata agent-hook install claude --attention`) provide contract/inbox context and optional session attention. This repository adds delegated issue tracking or todo plans. The omp plugin requires Kata 0.19; the pi plugin requires Kata 0.21.

## Pi

```sh
kata agent-hook install pi --attention
```

The pi plugin checks the native adapter registry at prompt time. When a contract-enabled adapter covers the current folder, native code alone fetches and inserts contract/inbox sections. Otherwise, the plugin provides those sections. The `kata_todo` section is separate and other extensions' sections are preserved.

Kata 0.21 fixes native pi attention for child sessions with `KATA_ATTENTION_HOST` and skips the pi adapter on OMP hosts. Upgrade Kata and rerun the install command above to refresh an older generated adapter, then restart pi. The plugin leaves native attention baselines alone and retains the main process's `KATA_REF`. Child processes also inherit the plugin's own parent marker (including the parent's provider, model and thinking level), receive a distinct teammate and issue binding, and always receive their contract. Children still clear the inherited lead `KATA_REF` for their own binding. Todo start/block operations still update their task's guarded attention; unfinished children request review on their own issues. See the [pi reference](../reference/pi.md).

## Oh-my-pi

Kata has no omp harness, so there is nothing to install. For a `KATA_REF` session the omp plugin checks the actor and teammate, then calls `kata agent-hook attention-native pi start|end` itself; pi is the closest harness and only selects payload parsing and the session token. Do not install another session-attention writer for the same issue alongside it. Subagents receive their own binding and do not run the lead's attention transitions.
