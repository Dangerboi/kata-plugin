import { expect, test } from "bun:test";
import fc from "fast-check";
import ompKata, { nativeCache, nativePhases, syncNativePhases } from "../kata";

test("native phases preserve grouping and text without leaking or mutating Kata state", () => {
  const task = fc.record({ content: fc.string(), status: fc.constantFrom(
    "pending" as const, "in_progress" as const, "completed" as const, "abandoned" as const, "blocked" as const,
  ), blocker: fc.string() });
  fc.assert(fc.property(fc.array(fc.record({ name: fc.string(), tasks: fc.array(task) })), phases => {
    const before = structuredClone(phases);
    const native = nativePhases(phases);
    expect(native.map(p => p.name)).toEqual(phases.map(p => p.name));
    expect(native.map(p => p.tasks.map(t => t.content))).toEqual(phases.map(p => p.tasks.map(t => t.content)));
    for (const [i, phase] of native.entries()) {
      expect(Object.keys(phase).sort()).toEqual(["name", "tasks"]);
      for (const [j, item] of phase.tasks.entries()) {
        expect(Object.keys(item).sort()).toEqual(["content", "status"]);
        expect(["pending", "in_progress", "completed", "abandoned"]).toContain(item.status);
        expect(item.status === "completed").toBe(phases[i].tasks[j].status === "completed");
        expect(item.status === "abandoned").toBe(phases[i].tasks[j].status === "abandoned");
        expect(item.status === "in_progress").toBe(phases[i].tasks[j].status === "in_progress");
      }
    }
    if (native[0]?.tasks[0]) native[0].tasks[0].content = "Changed native copy";
    expect(phases).toEqual(before);
  }));
});

test("blocked tasks stay open in the native snapshot and abandoned tasks stay dropped", () => {
  expect(nativePhases([{ name: "Review", tasks: [
    { content: "Waiting", status: "blocked" }, { content: "Cancelled", status: "abandoned" },
  ] }])).toEqual([{ name: "Review", tasks: [
    { content: "Waiting", status: "pending" }, { content: "Cancelled", status: "abandoned" },
  ] }]);
});

test("the original native tool receives only session bookkeeping, with the active item restored last", async () => {
  const calls: any[] = [];
  await syncNativePhases([{ name: "Build", tasks: [
    { content: "Finished", status: "completed" }, { content: "Cancelled", status: "abandoned" },
    { content: "Waiting", status: "pending" }, { content: "Working", status: "in_progress" },
  ] }], async params => { calls.push(params); return {}; });
  expect(calls).toEqual([
    { op: "init", list: [{ phase: "Build", items: ["Finished", "Cancelled", "Waiting", "Working"] }] },
    { op: "done", task: "Finished" }, { op: "drop", task: "Cancelled" }, { op: "start", task: "Working" },
  ]);
  await expect(syncNativePhases([], async () => ({ isError: true, content: [{ text: "Native refused" }] }))).rejects.toThrow("Native refused");
});

test("repeated text across phases has unique native cache labels that resolve to original item refs", () => {
  const tasks = [
    { phase: "Build", ref: "fixture#a1", content: "Run tests", status: "completed" as const },
    { phase: "Review", ref: "fixture#a2", content: "Run tests", status: "in_progress" as const },
    { phase: "Review", ref: "fixture#a3", content: "Run tests [fixture#a1]", status: "pending" as const },
  ];
  const before = structuredClone(tasks);
  const cache = nativeCache(tasks);
  const labels = cache.phases.flatMap(p => p.tasks.map(t => t.content));
  expect(new Set(labels).size).toBe(3);
  expect(cache.phases.map(p => p.name)).toEqual(["Build", "Review"]);
  expect(cache.aliases.get(labels[0])).toBe("fixture#a1");
  expect(cache.aliases.get(labels[1])).toBe("fixture#a2");
  expect(labels[2]).toBe(tasks[2].content);
  expect(tasks).toEqual(before);
});

test("OMP's registered tool delegates ANSI and semantic rendering to the host renderer", () => {
  const marker = {};
  const native = Object.fromEntries(["renderCall", "renderResult", "describeCall", "describeResult"].map(name => [name, (...args: any[]) => ({ name, args })]));
  let tool: any;
  const schema: any = new Proxy(() => schema, { get: () => schema });
  ompKata({ pi: { todoToolRenderer: native }, zod: schema, registerTool: (t: any) => tool = t, on() {}, events: { on() {} } });
  for (const name of Object.keys(native)) expect(tool[name](marker)).toEqual({ name, args: [marker] });
  expect(tool.mergeCallAndResult).toBe(true);
});

test("a missing bundled renderer keeps session setup and readable fallback output", async () => {
  let tool: any, reads = 0;
  const handlers = new Map<string, any>();
  const schema: any = new Proxy(() => schema, { get: () => schema });
  class Text { constructor(readonly text: string) {} }
  ompKata({ pi: { Text }, zod: schema, registerTool: (t: any) => tool = t,
    on: (name: string, handler: any) => handlers.set(name, handler), events: { on() {} },
    exec: async () => ({ code: 7, stdout: "", stderr: "fixture unavailable" }), appendEntry() {},
  });
  const ctx = { cwd: "/fixture", agent: { kind: "sub", id: "fixture" }, sessionManager: { getSessionId() { reads++; return "fixture"; } } };
  await handlers.get("session_start")({}, ctx);
  await handlers.get("session_switch")({}, ctx);
  expect(reads).toBeGreaterThan(0);
  expect(tool.renderCall({}).text).toBe("Todo (Kata)");
  expect(tool.renderResult({ content: [{ type: "text", text: "Fixture plan" }] }).text).toBe("Fixture plan");
});
