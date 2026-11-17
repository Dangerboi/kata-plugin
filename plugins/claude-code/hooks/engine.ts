import type { EngineInterface, MatchedHook } from 'claude-code'

// The `$` a hook gets. Every helper that takes it is declared at the top of its file: `claude plugin validate` follows `$` only through those.
export type Engine = EngineInterface

// A `ui.render` hook for one component, as `on('ui.render', { component }, hook)` types it.
export type Render<C extends string> = MatchedHook<'ui.render', { readonly component: C }>
