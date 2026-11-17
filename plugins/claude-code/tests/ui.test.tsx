import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// The band and the todo card draw from `$.state`, which the lead's plan fills (hooks/plan.ts); these tests fill it directly.
// Kata and the lead's runtime are covered by tests/claude-ui.test.ts.

// The test's `$` has no `state` noun; its stubs answer the plugin's reads. `held` is what the plugin's `$.state.get` finds.
const held = new Map<string, unknown>()
const standing = (on: On, entries: [string, unknown][]) => {
  held.clear()
  for (const [id, value] of entries) held.set(id, value)
  on('state.get', (_, e: { key: string; id?: string }) => ({ value: { value: held.get(e.id ?? e.key), version: 1 } }))
}
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value))
const SURFACES = ['terminal', 'desktop'] as const

const VIEW: any = {
  parent: 'proj#top1',
  phases: [
    { name: 'Build', tasks: [
      { content: 'Write the parser', status: 'completed', ref: 'proj#aa11' },
      { content: 'Wire the CLI', status: 'in_progress', ref: 'proj#bb22' },
      { content: 'Publish', status: 'blocked', ref: 'proj#cc33', blocker: 'waiting for a release' },
    ] },
    { name: 'Docs', tasks: [{ content: 'Write the guide', status: 'abandoned', ref: 'proj#dd44' }] },
  ],
}

for (const surface of SURFACES) {
  const band = { plugin: 'kata-cc', surface, component: 'AbovePrompt' } as const
  const props = { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 8, bodyColumns: 100 }

  test(`the band counts done tasks and names the active one on ${surface}`, async ($, on) => {
    standing(on, [['plan', copy(VIEW)]])
    const ui = await $.ui.mount({ ...band, props } as any)
    const bar = await ui.find({ type: 'Text', text: /Kata plan 1\/4 · 1 blocked · ▶ Wire the CLI/ })
    expect(bar).toBeDefined()
    await ui.unmount()
  })

  test(`the band follows the plan when it changes on ${surface}`, async ($, on) => {
    standing(on, [['plan', copy(VIEW)]])
    const ui = await $.ui.mount({ ...band, props } as any)
    const done = copy(VIEW)
    done.phases[0].tasks[1].status = 'completed'
    held.set('plan', done)
    await ui.redraw()
    expect(await ui.find({ type: 'Text', text: /Kata plan 2\/4 · 1 blocked/ })).toBeDefined()
    await ui.unmount()
  })

  test(`with no plan, or a survey, the band leaves the row to the engine on ${surface}`, async ($, on) => {
    standing(on, [])
    const ui = await $.ui.mount({ ...band, props } as any)
    expect(await ui.find({ type: 'Text', text: /Kata plan/ })).toBeUndefined()
    await ui.unmount()
    held.set('plan', copy(VIEW))
    const surveyed = await $.ui.mount({ ...band, props: { ...props, hasSurvey: true } } as any)
    expect(await surveyed.find({ type: 'Text', text: /Kata plan/ })).toBeUndefined()
    await surveyed.unmount()
  })

  test(`the band shows the core's one line when the plan is unavailable on ${surface}`, async ($, on) => {
    standing(on, [['plan', { phases: [], error: 'Kata is unreachable\nmore' }]])
    const ui = await $.ui.mount({ ...band, props } as any)
    expect(await ui.find({ type: 'Text', text: /Kata: Kata is unreachable/ })).toBeDefined()
    await ui.unmount()
  })

  test(`the todo result is a checklist card with refs and blocker notes on ${surface}`, async ($, on) => {
    standing(on, [['tu1', { text: 'the plan', view: copy(VIEW) }]])
    const ui = await $.ui.mount({ plugin: 'kata-cc', surface, component: 'ToolResult', requestId: 'tu1', props: { tool_use_id: 'tu1', tool: 'todo', output: 'the plan', isErrored: false } } as any)
    for (const text of [/Todo 2\/4/, /proj#top1/, /Wire the CLI/, /proj#bb22/, /waiting for a release/, /Write the guide/]) {
      expect(await ui.find({ type: 'Text', text })).toBeDefined()
    }
    await ui.unmount()
  })

  test(`a todo result without a card, and an error, keep the engine's row on ${surface}`, async ($, on) => {
    standing(on, [['tu2', { text: 'no tasks' }]])
    for (const [id, isErrored, tool] of [['tu2', false, 'todo'], ['tu3', false, 'todo'], ['tu2', true, 'todo'], ['tu2', false, 'Bash']] as const) {
      const ui = await $.ui.mount({ plugin: 'kata-cc', surface, component: 'ToolResult', requestId: id, props: { tool_use_id: id, tool, output: 'x', isErrored } } as any)
      expect(await ui.find({ type: 'Text', text: /Todo/ })).toBeUndefined()
      await ui.unmount()
    }
  })

  test(`a todo call row reads Todo <op> <task> on ${surface}`, async ($, on) => {
    standing(on, [])
    const ui = await $.ui.mount({ plugin: 'kata-cc', surface, component: 'ToolUse', requestId: 'tu4', props: { tool_use_id: 'tu4', tool: 'todo', input: { op: 'start', task: 'Wire the CLI' }, isRunning: false, isErrored: false, isInterrupted: false } } as any)
    expect(await ui.find({ type: 'Text', text: /start Wire the CLI/ })).toBeDefined()
    await ui.unmount()
  })
}

// Kata is a process, which this sandbox lacks: its stub answers like a Kata that is down or hangs.
const BASE = '11111111-1111-4111-8111-111111111111'
function booted(on: On, run: () => Promise<any>) {
  mock.store(on, {})
  mock.env(on, {})
  const clock = mock.clock(on)
  on('session.id', () => ({ value: BASE }))
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.stat', () => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: '/work' } }))
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', (() => ({ value: undefined })) as any)
  on('process.run', run)
  on('prompt.autocomplete', () => ({ suggestions: [] }))
  return clock
}
const ask = ($: any) => $.prompt.autocomplete({ text: 'fix #ab', cursor: 7, token: '#ab', start: 4 })

test('the typeahead adds no row before the session is bound, and never throws', async ($, on) => {
  on('prompt.autocomplete', () => ({ suggestions: [] }))
  const out = await ask($)
  expect(out.suggestions).toEqual([])
})

test('an unreachable Kata adds no row to the typeahead', async ($, on) => {
  booted(on, () => { throw new Error('spawn kata ENOENT') })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect((await ask($)).suggestions).toEqual([])
})

test('a Kata that never answers holds the typeahead for the core\'s wait and adds no row', async ($, on) => {
  const clock = booted(on, () => new Promise(() => undefined))
  const started = $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  for (let i = 0; i < 12; i++) await clock.advance(1000)
  await started
  const pending = ask($)
  for (let i = 0; i < 3; i++) await clock.advance(400)
  expect((await pending).suggestions).toEqual([])
})
