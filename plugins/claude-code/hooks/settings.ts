import type { Engine } from './engine'

// What the adapter reads from the host: plugin options first (plugin.json userConfig), then the environment.
// `$.env.get` takes literal names only, so every variable the core or the adapter reads is spelled out here once; the
// values are read when the runtime starts and live in an in-memory map the core's Platform reads synchronously.
export async function readEnv($: Engine): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  const note = (name: string, value: string | undefined) => { if (value !== undefined && value !== '') found.set(name, value) }
  note('KATA_REF', await $.env.get('KATA_REF'))
  note('KATA_DEFAULT_PROJECT', await $.env.get('KATA_DEFAULT_PROJECT'))
  note('KATA_AUTHOR', await $.env.get('KATA_AUTHOR'))
  note('KATA_TEAMMATE', await $.env.get('KATA_TEAMMATE'))
  note('KATA_INBOX_USER', await $.env.get('KATA_INBOX_USER'))
  note('KATA_HOME', await $.env.get('KATA_HOME'))
  note('KATA_CLOSE_TRANSCRIPT_ENABLED', await $.env.get('KATA_CLOSE_TRANSCRIPT_ENABLED'))
  note('USER', await $.env.get('USER'))
  note('KATA_CLAUDE_EXECUTABLE', await $.env.get('KATA_CLAUDE_EXECUTABLE'))
  note('KATA_CLAUDE_DEBUG', await $.env.get('KATA_CLAUDE_DEBUG'))
  return found
}

export interface Settings {
  executable: string
  debugFile?: string
  // Add the contract and inbox sections to prompts. Off by default: `kata agent-hook install claude` owns them.
  contract: boolean
}

export const EXECUTABLE_VARS = ['KATA_CLAUDE_EXECUTABLE']

export function resolveSettings(options: Record<string, unknown> | undefined, env: Map<string, string>): Settings {
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)
  return {
    executable: text(options?.kataExecutable) ?? env.get('KATA_CLAUDE_EXECUTABLE') ?? 'kata',
    debugFile: text(options?.debugFile) ?? env.get('KATA_CLAUDE_DEBUG'),
    contract: options?.contract === true,
  }
}
