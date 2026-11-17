// What the plugin keeps in `$.state` (it survives a hot reload; /clear, /resume and /branch reset it, and the next bind refills it).
// Self-contained, as the engine requires of a contract: `Plan` is the core's `PlanView` (core/kata-core.ts), restated.
declare module 'claude-code' {
  interface KataPlan {
    parent?: string
    workspace?: string
    label?: string
    local?: true
    phases: { name: string; tasks: { content: string; status: 'pending' | 'in_progress' | 'blocked' | 'completed' | 'abandoned'; ref: string; blocker?: string }[] }[]
  }
  interface KataTodoCard {
    text: string
    // What the result said before the plan: a close Kata deferred, a deleted parent.
    notice?: string
    view?: KataPlan
  }
  interface PluginState {
    'kata-cc': {
      // The lead's plan as the core last pushed it to its widget; the band above the prompt draws from it. `error`: the core
      // shows one line instead of a plan.
      plan: (KataPlan & { error?: string }) | null
      // The checklist card of one `todo` call, by tool_use_id: the plan as that call left it. null: evicted.
      cards: StateFamily<KataTodoCard | null>
      // The ids of the newest cards, oldest first.
      cardIds: string[]
    }
  }
}
