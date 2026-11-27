import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createKataCore } from '../core/kata-core';
import { nodePlatform } from '../core/node-host';
import { memoryDelegateStore } from './kata-fixture';
import { assertIsolated } from './isolation';
assertIsolated();
function setup(isMain: (ctx: any) => boolean = () => true) {
 const cwd = mkdtempSync(path.join(process.env.KATA_TEST_ROOT!, 'learn-'));
 writeFileSync(path.join(cwd, '.kata.toml'), 'version = 1\n[project]\nname = "demo"\n');
 const core = createKataCore({ platform: nodePlatform, isMain, appendEntry() {}, delegateStore: memoryDelegateStore(), exec: async () => ({ code: 1, stdout: '', stderr: 'offline' }) }, { namespace: 'test', executable: 'kata', executableVars: [] });
 const ctx = { cwd };
 const call = (command: string) => core.tools.guard(ctx, { tool: 'bash', input: { command } });
 const result = (command: string, content: string) => core.tools.result(ctx, { toolName: 'bash', input: { command }, content } as any);
 return { cwd, core, ctx, call, result, commit: (text: string) => call(`git commit -m "${text}"`) };
}

test('delegate calls do not teach the lead', async () => {
 const h = setup(ctx => ctx.agent?.kind !== 'sub');
 await h.core.tools.guard({ cwd: h.cwd, agent: { kind: 'sub' } }, { tool: 'bash', input: { command: 'kata comment e7x2' } });
 expect(await h.commit('e7x2')).toBeUndefined();
});

test('symlinked plan workspace supplies project to a canonical invocation', async () => {
 const root = mkdtempSync(path.join(process.env.KATA_TEST_ROOT!, 'symlink-plan-'));
 const actual = path.join(root, 'actual'), link = path.join(root, 'link'); mkdirSync(actual); symlinkSync(actual, link);
 const core = createKataCore({ platform: nodePlatform, appendEntry() {}, delegateStore: memoryDelegateStore(), exec: async (_file, args) => {
  if (args.includes('version')) return { code: 0, stdout: JSON.stringify({ kata_api_version: 1, version: '1.0.0' }), stderr: '' };
  if (args.includes('projects')) return { code: 0, stdout: JSON.stringify({ projects: [{ id: 1, name: 'demo' }] }), stderr: '' };
  return { code: 0, stdout: JSON.stringify({ issue: { short_id: 'q7x2', project_id: 1, status: 'open', metadata: {} }, children: [] }), stderr: '' };
 } }, { namespace: 'test', executable: 'kata', executableVars: [] });
 const ctx = { cwd: link, sessionManager: { getSessionId: () => 'symlink', getBranch: () => [{ type: 'custom', customType: 'io.kata.test.parent', data: { parent: 'demo#q7x2', workspace: link, sessionId: 'symlink', auto: false } }] } };
 const started = await core.session.start(ctx, { wait: 10000 });
 expect(started?.parent).toBe('demo#q7x2');
 await core.tools.result({ ...ctx, cwd: actual }, { toolName: 'bash', input: { command: 'kata next --agent' }, content: 'OK next z7x2' });
 expect(core.tools.refs(ctx).refs).toContain('demo#z7x2');
});

test('call-time learning', async () => {
 {
 const h = setup(); expect(await h.call('kata comment q7x2 -m ok && git commit -m "fix q7x2"')).toContain('q7x2');
 }
 {
 const h = setup(); await h.call('kata search foreign#r7x2'); await h.call('kata comment q7x2 -m foreign#t7x2');
 expect(await h.commit('r7x2')).toContain('r7x2'); expect(await h.commit('t7x2')).toContain('t7x2');
 }
 {
 const h = setup(), sub = path.join(h.cwd, 'sub'); mkdirSync(sub); writeFileSync(path.join(sub, '.kata.toml'), 'version = 1\n[project]\nname = "inner"\n');
 await h.call('cd sub && kata comment q7x2 -m done'); expect(await h.commit('inner#r7x2')).toContain('inner#r7x2');
 }

});

test('lone output learns', async () => {
 {
 const h = setup(); await h.result('kata next --json', '{"issue":{"short_id":"q7x2"}}');
 expect(await h.commit('q7x2')).toContain('q7x2');
 }
 {
 const h = setup(); await h.result('kata list --all --agent', '- issue=other#data status=open title=test'); expect(await h.commit('other#data')).toContain('other#data'); expect(await h.commit('data')).toBeUndefined();
 }
 {
 const h = setup();
 await h.result('kata create title --agent', 'OK create a7x2');
 await h.result('kata next --agent --project other', 'OK next issue=b7x2');
 for (const id of ['a7x2', 'b7x2']) expect(await h.commit(id)).toContain(id);
 expect(h.core.tools.refs(h.ctx).refs).toContain('other#b7x2');
 expect(h.core.tools.refs(h.ctx).refs).not.toContain('demo#b7x2');
 }
 {
 const h = setup();
 await h.result('kata search data', '{"issues":[{"qualified_id":"other#data","short_id":"data"}]}');
 expect(await h.commit('other#data')).toContain('other#data');
 expect(await h.commit('data')).toBeUndefined();
 }

 {
 const h = setup();
 await h.result('kata show q7x2 --agent', 'OK show q7x2\nLinks:\n  type=related issue=other#r7x2\n  type=related issue=third#t7x2');
 expect(await h.commit('r7x2')).toContain('r7x2');
 expect(await h.commit('t7x2')).toContain('t7x2');
 }
});

test('workspace file uses v1 and stops at a nested git root', async () => {
 {
 const h = setup();
 writeFileSync(path.join(h.cwd, '.kata.toml'), '  version = 1\n  [project] # workspace\n  name = "indented"\n');
 expect(await h.commit('indented#z7x2')).toContain('indented#z7x2');
 }
 {
 const h = setup();
 writeFileSync(path.join(h.cwd, '.kata.toml'), 'version = 1\n[project]\n  [other]\n  name = "other"\n');
 expect(await h.commit('other#z7x2')).toBeUndefined();
 }
 {
 const h = setup();
 const nested = path.join(h.cwd, 'nested'); mkdirSync(nested); mkdirSync(path.join(nested, '.git'));
 const nestedGuard = (command: string) => h.core.tools.guard({ cwd: nested }, { tool: 'bash', input: { command } });
 await nestedGuard('kata comment b7x2');
 expect(await nestedGuard('git commit -m "demo#r7x2"')).toBeUndefined();
 }
 {
 const h = setup();
 writeFileSync(path.join(h.cwd, '.kata.toml'), 'version = 2\n[project]\nversion = 1\nname = "future"\n');
 expect(await h.commit('future#z7x2')).toBeUndefined();
 }
});
