# Use with Kata agent hooks

Kata's native hooks (Claude Code uses them directly: `kata agent-hook install claude --attention`) provide contract/inbox context and optional session attention. This repository adds delegated issue tracking or todo plans. These plugins require Kata 0.21.0.

## Pi

```sh
kata agent-hook install pi --attention
```

The pi plugin checks the native adapter registry at prompt time. When a contract-enabled adapter covers the current folder, native code alone fetches and inserts contract/inbox sections. Otherwise, the plugin provides those sections. The `kata_todo` section is separate and other extensions' sections are preserved.

The plugin preserves the native parent attention baseline regardless of startup handler order, then clears `KATA_REF` from the parent process environment. Child processes inherit the plugin's own parent marker instead (including the parent's provider, model and thinking level), receive a distinct teammate and issue binding, and always receive their contract. Native child startup/shutdown therefore cannot target the lead issue. Kata 0.21's pi hook also ignores child sessions once regenerated with `kata agent-hook install pi`; the plugin keeps clearing `KATA_REF` because it cannot see which Kata version generated the installed hook. Todo start/block operations still update their task's guarded attention; unfinished children request review on their own issues. See the [pi reference](../reference/pi.md).

## Oh-my-pi

Kata has no omp harness, so there is nothing to install. For a `KATA_REF` session the omp plugin checks the actor and teammate, then calls `kata agent-hook attention-native pi start|end` itself; pi is the closest harness and only selects payload parsing and the session token. Kata 0.21's pi hook does nothing inside omp (`pi.zod`), so a `PI_CODING_AGENT_DIR` shared with omp no longer adds a second attention writer. Do not install another session-attention writer for the same issue alongside it. Subagents receive their own binding and do not run the lead's attention transitions.
