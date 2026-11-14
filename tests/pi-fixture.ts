import { afterAll, beforeAll, beforeEach, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { assertIsolated } from "./isolation";
import { isolatedKata } from "./kata-fixture";
import { daemonUnavailable } from "./kata-errors";
import piKata from "../plugins/pi/kata";
import { TRANSCRIPT_ENV } from "../core/kata-cli";

// One counter for every fixture in the process. The pi adapter keeps lead and delegate records per session id in module
// state, so when several pi files run in one `bun test` process (KATA_TEST_JOBS=1) their session ids must not repeat.
let sequence = 0;
const unique = () => ++sequence;

const nativeKey = Symbol.for("kata.pi.native.v1");
const globalRegistry = globalThis as any;

/**
 * The pi adapter against a real Kata: a scratch workspace, its own store and daemon, and a fake pi host per call.
 * Await it once at the top of a test file; it registers that file's hooks, so every file gets its own store.
 */
export async function piFixture() {
  assertIsolated();
  const binary = process.env.KATA_TEST_EXECUTABLE!;
  if (!binary || !path.isAbsolute(binary)) throw new Error("Set KATA_TEST_EXECUTABLE to the guarded Kata binary.");
  const scratch = mkdtempSync(path.join(process.env.KATA_TEST_ROOT!, "pi-"));
  const cwd = path.join(scratch, "workspace"), outside = path.join(scratch, "outside");
  mkdirSync(cwd); mkdirSync(outside);
  const env = { ...process.env, KATA_HOME: path.join(scratch, "home"), KATA_AUTHOR: "pi-builder" };
  for (const key of ["KATA_SERVER", "KATA_DAEMON", "KATA_AUTH_TOKEN", "KATA_REF", "KATA_TEAMMATE", "KATA_INBOX_USER", "KATA_PI_PARENT"]) delete env[key];
  const run = isolatedKata(binary, env, cwd);
  async function kata(args: string[], workspace = cwd): Promise<any> {
    const out = await run(args, workspace);
    if (out.code) throw new Error(out.stderr);
    return JSON.parse(out.stdout);
  }
  const show = (ref: string) => kata(["show", ref, "--json"]);
  const previousRegistry = globalRegistry[nativeKey];
  async function host(options: any = {}) {
    const sid = options.sid || `pi-${unique()}`;
    const contractReady = Promise.withResolvers<void>(), inboxReady = Promise.withResolvers<void>();
    let tool: any;
    const handlers = new Map<string, any>(), commands = new Map<string, any>();
    const entries: any[] = options.entries || [], calls: string[][] = [], notices: any[] = [], widgets: any[] = [], messages: any[] = [], models: any[] = [], thinking: any[] = [];
    const ctx: any = {
      cwd: options.cwd || cwd, hasUI: options.hasUI ?? true, mode: options.mode || "tui",
      sessionManager: { getSessionId: () => sid, getBranch: () => entries, getHeader: () => options.header },
      model: options.model, modelRegistry: options.modelRegistry,
      ui: { notify: (...args: any[]) => notices.push(args), setWidget: (...args: any[]) => widgets.push(args) },
    };
    const api: any = {
      ...(options.omp ? { zod: {} } : {}),
      registerTool: (value: any) => tool = value,
      getSessionName: () => options.sessionName,
      registerCommand: (name: string, value: any) => commands.set(name, value),
      appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
      sendMessage: (...args: any[]) => messages.push(args),
      setModel: async (model: any) => { models.push(model); return true; },
      getThinkingLevel: () => options.thinking,
      setThinkingLevel: (level: any) => thinking.push(level),
      on: (name: string, callback: any) => handlers.set(name, [...(handlers.get(name) || []), callback]),
      async exec(file: string, args: string[], opts: any) {
        calls.push(args);
        if (options.exec) return options.exec(file, args, opts);
        const result = await options.before?.(args, opts) ?? await run(args, opts.cwd, opts.timeout);
        if (args[0] === "agent-contract-hook") contractReady.resolve();
        if (args[0] === "inbox") inboxReady.resolve();
        return result;
      },
    };
    const native = async () => {
      const source=readFileSync(path.join(cwd,".pi/extensions/kata.js"), "utf8");
      const url=`data:text/javascript;base64,${Buffer.from(source + `\n// test session ${sid}`).toString("base64")}`;
      (await import(url)).default(api);
    };
    if (options.nativeOrder === "native-first") await native();
    await piKata(api);
    if (options.nativeOrder === "plugin-first") await native();
    return { ctx, sid, tool, entries, calls, notices, widgets, messages, handlers, commands, models, thinking,
      contextReady: Promise.all([contractReady.promise, inboxReady.promise]),
      event: async (name: string, data: any = {}) => { let result; for (const callback of handlers.get(name) || []) { const next=await callback(data,ctx); if(next!==undefined) result=next; } return result; },
      call: (params: any) => tool.execute("fixture", params, undefined, undefined, ctx),
      command: (args: string) => commands.get("todo").handler(args, ctx),
      async init(items = ["Implement pi fixture", "Verify pi fixture"]) {
        const result = await tool.execute("fixture", { op: "init", items }, undefined, undefined, ctx);
        expect(result.isError).toBeUndefined(); return result.details.kata.parent;
      },
    };
  }

  // Use Kata 0.23.0 or later for native pi attention coexistence. Tests that load
  // the native adapter run only when Kata can install it; they never fake it.
  const nativeHelp = await run(["agent-hook", "install", "--help"]);
  const nativeMissing = nativeHelp.code ? "Kata under test lacks `agent-hook install`; use Kata 0.23.0 or later" : undefined;
  if (nativeMissing) console.warn(`Skipping real native pi adapter tests: ${nativeMissing}`);
  beforeAll(async () => {
    const out = await run(["init", "--project", "pitest"]); if (out.code) throw new Error(out.stderr);
    if (nativeMissing) return;
    const native = await run(["agent-hook", "install", "pi", "--scope", "project", "--executable", binary]);
    if (native.code) throw new Error(native.stderr);
  });
  beforeEach(() => {
    process.env.KATA_AUTHOR = "pi-builder";
    process.env.KATA_PI_EXECUTABLE = binary;
    for (const key of ["KATA_REF", "KATA_TEAMMATE", "KATA_INBOX_USER", "KATA_PI_PARENT", ...TRANSCRIPT_ENV]) delete process.env[key];
    globalRegistry[nativeKey] = { adapters: new Map() };
  });
  afterAll(async () => { await run(["daemon", "stop"]); delete process.env.KATA_PI_EXECUTABLE; globalRegistry[nativeKey] = previousRegistry; });

  return {
    binary, scratch, cwd, outside, env, run, kata, show, unique, host, nativeKey, globalRegistry, nativeMissing,
    down: daemonUnavailable,
    evidence: ["test:bun test pi fixture"],
    message: "Implemented the stock pi fixture and verified it with the isolated integration suite.",
  };
}
