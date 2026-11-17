import { expect, mock, test } from 'claude-code/testing'

// Wiring only: the engine's own host loads the module and answers `$` with stubs. Kata itself runs in the repository's
// tests/claude-*.test.ts (a real Kata needs a process, which this sandbox lacks).

// The kit's `$` has no tool.list, so a second plugin asks for it.
const lister = { name: 'lister', register(on: any) { on('command.run', { command: 'lst' }, async ($: any) => ({ text: JSON.stringify(await $.tool.list()) })) } }

test('tool.list swaps the task tools for todo', { plugins: [lister] }, async ($, on) => {
  on('tool.list', () => ({ value: ['TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TodoWrite', 'TaskStop', 'Bash'].map(name => ({ name, description: '', mcp: false })) }))
  const names = JSON.parse((await $.command.run({ command: 'lst', args: '' } as any)).text!).map((t: { name: string }) => t.name).sort()
  expect(names).toEqual(['Bash', 'TaskStop', 'todo'])
})

test('a todo call is refused before Kata for a bad op, and for a subagent', async ($, on) => {
  mock.store(on, {})
  mock.clock(on)
  on('session.id', () => ({ value: '11111111-1111-4111-8111-111111111111' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.stat', () => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: '/work' } }))
  const bad = await $.tool.call({ tool: 'todo', op: 'bogus' } as any)
  expect(bad.isError).toBe(true)
  expect(String(bad.result)).toContain('todo needs op')
  const sub = await $.tool.call({ tool: 'todo', op: 'view', agentId: 'a1' } as any)
  expect(String(sub.result)).toContain('lead session')
})
