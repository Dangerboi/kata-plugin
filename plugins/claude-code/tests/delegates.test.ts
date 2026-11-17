import { expect, mock, test } from 'claude-code/testing'

// Wiring only: the engine's own host loads the module and fires the delegate events at it. Binding against Kata itself runs
// in the repository's tests/claude-delegates.test.ts (a real Kata needs a process, which this sandbox lacks); here Kata is
// unreachable, which is the case a spawn and a shell call must survive.

function engine(on: any) {
  const saved = new Map<string, unknown>()
  on('store.get', ($: unknown, e: { key: string }) => ({ value: saved.get(e.key) }))
  on('store.set', ($: unknown, e: { key: string; value: unknown }) => { saved.set(e.key, e.value); return { value: undefined } })
  on('store.delete', ($: unknown, e: { key: string }) => { saved.delete(e.key); return { value: undefined } })
  on('store.keys', () => ({ value: [...saved.keys()] }))
  on('session.id', () => ({ value: '22222222-2222-4222-8222-222222222222' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.stat', () => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: '/work' } }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'kata unavailable', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('env.get', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('turn.complete', () => ({ text: '' }))
}

// The engine's own answer to a Bash call: what would have run.
const ran = (on: any) => on('tool.call', ($: unknown, e: { command?: string }) => ({ result: e.command }))

test('a spawn that names nothing is untracked and told so even when Kata is unreachable, and its answer is taken without error', async ($, on) => {
  engine(on)
  mock.clock(on)
  let seen = ''
  on('agent.spawn', ($: unknown, e: { prompt: string }) => { seen = e.prompt; return { model: 'haiku', agentId: 'a1' } })
  await $.session.start({ surface: 'terminal', isInteractive: false, cwd: '/work' })
  const started = await $.agent.spawn({ prompt: 'Look at the build', description: 'Look' } as any)
  expect(started).toMatchObject({ model: 'haiku', agentId: 'a1' })
  // Naming nothing, it is untracked and told so.
  expect(seen.startsWith('Look at the build')).toBe(true)
  expect(seen).toContain('<kata_binding>')
  expect(seen).toContain('no Kata issue')
  const finished = await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 1, isAborted: false, usage: null, agentId: 'a1' } as any)
  expect(finished).toBeDefined()
})

test('a subagent kata command carries its teammate, --as is refused and the lead is left alone', async ($, on) => {
  engine(on)
  mock.clock(on)
  ran(on)
  await $.session.start({ surface: 'terminal', isInteractive: false, cwd: '/work' })
  const sub = await $.tool.call({ tool: 'Bash', command: 'kata list --status open', agentId: 'engine-fork-9' } as any)
  expect(String(sub.result)).toMatch(/^kata --teammate 'engine-fork-9-[0-9a-f]{6}' list --status open$/)
  const asked = await $.tool.call({ tool: 'Bash', command: 'kata close x --as me', agentId: 'engine-fork-9' } as any)
  expect(String(asked.deny)).toContain('--as is not permitted')
  const lead = await $.tool.call({ tool: 'Bash', command: 'kata list' } as any)
  expect(lead.result).toBe('kata list')
})

test('a subagent that has no issue is told so when it calls todo', async ($, on) => {
  engine(on)
  mock.clock(on)
  await $.session.start({ surface: 'terminal', isInteractive: false, cwd: '/work' })
  const sub = await $.tool.call({ tool: 'todo', op: 'view', agentId: 'a1' } as any)
  expect(sub.isError).toBe(true)
  expect(String(sub.result)).toContain('no Kata assignment')
})
