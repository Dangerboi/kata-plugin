# Metadata and labels

These keys describe observed execution and plan state. `work.*` belongs to the current writer; closed issues do not receive `work.*` updates.

| Keys | Purpose |
| --- | --- |
| `omp.auto_parent`, `pi.auto_parent` | Typed boolean granting automatic-parent authority. Explicit bindings revoke that authority locally. |
| `omp.session_id`, `pi.session_id` | Session identity for recovery and idempotency. |
| `omp.workspace`, `pi.workspace` | Pinned original workspace. |
| `pi.subagent_id` | Child Pi session identity and task reservation. |
| `omp.subagent_id`, `omp.parent_agent_id`, `omp.status` | OMP delegation identity and outcome. |
| `todo.phase`, `todo.status`, `todo.removed` | Phase and plan state: pending, in_progress, blocked, completed, or abandoned. `todo.removed` is a separate boolean. |
| `todo.session` | The lead session that created the plan item, then the one that last started or blocked it. While the item is open and in progress or blocked, only that session (or a fork of it) may change it, unless another lead takes it over. |
| (none) | An item naming a ticket (`<project>#<short_id>: <action>`) writes only `todo.status`, `work.attention` and `work.attention_msg` on that ticket, never `todo.phase`. The item-to-ticket record is kept in the session snapshot, not in Kata. |
| `work.attention`, `work.attention_msg`, `work.attention_session` | Guarded attention state where the adapter owns that transition. |

Labels `omp-session` and `pi-session` identify session parents. `needs-review` marks unverified work or rejected automatic closure. The automatic marker must be boolean `true`, not the string `"true"`.

A status report is not a close. Kata issue status and accepted close-event evidence determine completion. Qualified refs and original project/workspace routing are retained separately from display text.
