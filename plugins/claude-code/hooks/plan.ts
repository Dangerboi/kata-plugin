import type { PlanView } from '../core/kata-core'
import type { Engine } from './engine'
import type { KataTodoCard } from 'claude-code'

// What the lead's plan leaves in `$.state` for the band and the todo cards. A render hook reads it and never runs Kata.

const plan = { plugin: 'kata-cc', key: 'plan' } as const
const cards = { plugin: 'kata-cc', key: 'cards' } as const
const cardIds = { plugin: 'kata-cc', key: 'cardIds' } as const

// Cards kept for the transcript's todo results; an older one is replaced by the null the render hook passes over.
const KEPT_CARDS = 40

// The context's `ui` for the core: it pushes the plan to `setWidget` whenever it changes (a todo call, /todo, a delegate
// closing its task, a replayed local plan) and warnings to `notify`. Nothing here may fail the call that caused it.
export function planUi($: Engine) {
  return {
    setWidget(_key: string, content: unknown) {
      const shown = content === undefined ? null : Array.isArray(content) ? { phases: [], error: String(content[0] ?? '') } : (content as PlanView)
      try { $.state.set(plan, shown).catch(() => undefined) } catch { /* The band keeps its last plan. */ }
    },
    notify(message: string) {
      try { $.ui.toast(message) } catch { /* A session with no surface has nobody to tell. */ }
    },
  }
}

// The checklist card of a finished `todo` call: the plan as the call left it, read from what the core just pushed. An error
// keeps the engine's own row (the text the model read).
export async function rememberCard($: Engine, id: string, ran: { result?: unknown; isError?: boolean } | undefined) {
  if (ran === undefined || ran.isError === true || typeof ran.result !== 'string') return
  const view = (await $.state.get(plan)).value ?? undefined
  const card: KataTodoCard = { text: ran.result, ...(view?.phases.some(p => p.tasks.length) ? { view } : {}) }
  await $.state.set({ ...cards, id }, card)
  const ids = [...((await $.state.get(cardIds)).value ?? []).filter(known => known !== id), id]
  for (const old of ids.splice(0, Math.max(0, ids.length - KEPT_CARDS))) await $.state.set({ ...cards, id: old }, null)
  await $.state.set(cardIds, ids)
}
