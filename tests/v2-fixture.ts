import { mkdirSync } from "node:fs";
import path from "node:path";
import { realKata, unique } from "./kata-fixture";
import { daemonUnavailable, siblingThrottle } from "./kata-errors";
import { ompHost } from "./omp-host";
import { TRANSCRIPT_ENV } from "../core/kata-cli";

/**
 * The omp adapter against a real Kata: a scratch workspace, its own store and daemon, and a fake omp host per call.
 * Call it once at the top of a test file; it registers that file's hooks, so every file gets its own store.
 */
export function v2Fixture() {
  const store = realKata({ prefix: "v2", author: "v2-builder", project: "v2test", adopt: true });
  const { scratch, cwd, run, kata, show, events } = store;
  const outside = path.join(scratch, "outside");
  mkdirSync(outside);
  async function issue(title = "Explicit parent") { return (await kata(["create", `${title} ${unique()}`, "--force-new", "--json"])).issue.short_id; }
  function host(options: any = {}) {
    const sid = options.sid === null ? undefined : options.sid || `v2-${unique()}`;
    const app = ompHost({
      run: (args, opts) => run(args, opts.cwd, opts.timeout), cwd: options.cwd || cwd, sid, agent: options.agent, entries: options.entries,
      sessionFile: options.sessionFile || `${scratch}/${sid}.jsonl`, header: options.header, snapshot: options.snapshot, before: options.before,
      // The adapter spawns closes itself while a transcript session is exported, so a host that must see or fail closes runs without one; `transcript: true` keeps it.
      afterEvent: () => { if (!options.transcript) for (const key of TRANSCRIPT_ENV) delete process.env[key]; },
    });
    return { ...app, init: (items = ["Implement fixture", "Verify fixture"]) => app.init(items) };
  }

  // Like omp: the host owns retry timers, and sweeps whatever is pending on shutdown. Returns the timers `app` has armed.
  function hostTimers(app: ReturnType<typeof host>) {
    const timers = new Set<{ run: () => void }>();
    app.ctx.setTimeout = (callback: () => void) => { const timer = { run: callback }; timers.add(timer); return timer; };
    app.ctx.clearTimer = (timer: any) => { timers.delete(timer); };
    return timers;
  }
  function throttledClose() {
    let throttled = true, reached!: () => void;
    const closing = new Promise<void>(resolve => reached = resolve);
    const app = host({ before: (a: string[]) => {
      if (a[0] !== "close") return undefined;
      if (throttled) return siblingThrottle();
      reached();
      return undefined;
    } });
    return { app, timers: hostTimers(app), closing, lift: () => { throttled = false; } };
  }
  // A delegate that exits having run no tool has its assignment rolled back; these tests need one that did work.
  async function ran(lead: ReturnType<typeof host>, id: string, sessionFile: string) {
    await host({ sessionFile, agent: { kind: "sub", id, parentId: lead.ctx.agent.id } }).event("tool_call", { toolName: "read", input: { path: "README.md" } });
  }
  // The transcript session each close of an issue recorded.
  const closeSessions = async (shortId: string) => (await events()).filter((e: any) => e.type === "issue.closed" && e.issue_short_id === shortId).map((e: any) => e.payload?.transcript?.session_id);
  const total = async () => (await kata(["list", "--status", "all", "--limit", "0", "--json"])).issues.length;
  const commentsOf = async (ref: string): Promise<string[]> => ((await show(ref)).comments ?? []).map((c: any) => c.body);
  async function sessionParents(sid: string) { return (await kata(["list", "--status", "all", "--meta", `omp.session_id=${sid}`, "--json"])).issues; }

  return {
    ...store, outside, issue, unique, host,
    down: daemonUnavailable,
    evidence: ["test:bun test fixture"],
    message: "Implemented this isolated fixture and verified its behavior with the regression suite.",
    hostTimers, throttledClose, ran, closeSessions, total, commentsOf, sessionParents,
  };
}
