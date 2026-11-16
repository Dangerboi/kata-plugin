import { afterAll, beforeAll, beforeEach } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { EVIDENCE, fakeHost, MESSAGE, realKata, unique } from "./kata-fixture";
import { daemonUnavailable } from "./kata-errors";
import piKata from "../plugins/pi/kata";

const nativeKey = Symbol.for("kata.pi.native.v1");
const globalRegistry = globalThis as any;

/**
 * The pi adapter against a real Kata: a scratch workspace with Kata's native pi adapter installed, its own store and
 * daemon, and a fake pi host per call. Call it once at the top of a test file; it registers that file's hooks, so every
 * file gets its own store.
 */
export function piFixture() {
  const store = realKata({ prefix: "pi", author: "pi-builder", project: "pitest", process: { KATA_PI_EXECUTABLE: process.env.KATA_TEST_EXECUTABLE! } });
  const { binary, scratch, cwd, run } = store;
  const outside = path.join(scratch, "outside");
  mkdirSync(outside);
  const previousRegistry = globalRegistry[nativeKey];
  async function host(options: any = {}) {
    const sid = options.sid || `pi-${unique()}`;
    const app = fakeHost({ run: (args, opts) => run(args, opts.cwd, opts.timeout), cwd: options.cwd || cwd, sid, header: options.header, entries: options.entries,
      before: options.before, exec: options.exec });
    const commands = new Map<string, any>(), messages: any[] = [], models: any[] = [], thinking: any[] = [];
    const { ctx } = app;
    Object.assign(ctx, { hasUI: options.hasUI ?? true, mode: options.mode || "tui", model: options.model, modelRegistry: options.modelRegistry });
    const api: any = {
      ...app.api,
      ...(options.omp ? { zod: {} } : {}),
      getSessionName: () => options.sessionName,
      registerCommand: (name: string, value: any) => commands.set(name, value),
      sendMessage: (...args: any[]) => messages.push(args),
      setModel: async (model: any) => { models.push(model); return true; },
      getThinkingLevel: () => options.thinking,
      setThinkingLevel: (level: any) => thinking.push(level),
    };
    const native = async () => {
      const source = readFileSync(path.join(cwd, ".pi/extensions/kata.js"), "utf8");
      const url = `data:text/javascript;base64,${Buffer.from(source + `\n// test session ${sid}`).toString("base64")}`;
      (await import(url)).default(api);
    };
    if (options.nativeOrder === "native-first") await native();
    await piKata(api);
    if (options.nativeOrder === "plugin-first") await native();
    return { ctx, sid, tool: app.tool, entries: app.entries, calls: app.calls, notices: app.notices, widgets: app.widgets, handlers: app.handlers,
      messages, commands, models, thinking, event: app.event, call: (params: any) => app.call(params),
      contextReady: Promise.all([app.answered("agent-contract-hook"), app.answered("inbox")]),
      command: (args: string) => commands.get("todo").handler(args, ctx),
      init: (items = ["Implement pi fixture", "Verify pi fixture"]) => app.init(items),
    };
  }
  // The next host is a pi process the lead spawned: it inherits the lead's marker (the environment's, or `marker`, one
  // saved earlier) under another pid.
  const asChild = (marker = process.env.KATA_PI_PARENT!) => { process.env.KATA_PI_PARENT = JSON.stringify({ ...JSON.parse(marker), pid: process.pid + 1 }); };

  beforeAll(async () => { await store.text(["agent-hook", "install", "pi", "--scope", "project", "--executable", binary]); });
  beforeEach(() => { globalRegistry[nativeKey] = { adapters: new Map() }; });
  afterAll(() => { globalRegistry[nativeKey] = previousRegistry; });

  return {
    ...store, outside, unique, host, asChild, nativeKey, globalRegistry,
    down: daemonUnavailable,
    evidence: EVIDENCE,
    message: MESSAGE,
  };
}
