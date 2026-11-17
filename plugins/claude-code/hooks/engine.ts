import type { EngineInterface } from 'claude-code'

// The `$` a hook gets. Every helper that takes it is declared at the top of its file: `claude plugin validate` follows `$` only through those.
export type Engine = EngineInterface
