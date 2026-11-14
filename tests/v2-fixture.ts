import { afterAll, afterEach, beforeAll, beforeEach, expect } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { assertIsolated } from "./isolation";
import { adoptIsolatedKata, isolatedKata } from "./kata-fixture";
import { daemonUnavailable, siblingThrottle } from "./kata-errors";
import { ompHost } from "./omp-host";
import { TRANSCRIPT_ENV } from "../core/kata-cli";

// One counter for every fixture in the process. The omp adapter keeps delegate and lead records per session id in module
// state, so when several of these files run in one `bun test` process (KATA_TEST_JOBS=1) their session ids must not repeat.
let sequence = 0;
const unique = () => ++sequence;

/**
 * The omp adapter against a real Kata: a scratch workspace, its own store and daemon, and a fake omp host per call.
 * Call it once at the top of a test file; it registers that file's hooks, so every file gets its own store.
 */
export function v2Fixture() {
  const binary = process.env.KATA_TEST_EXECUTABLE!;
  if (!binary || !path.isAbsolute(binary)) throw new Error("Set KATA_TEST_EXECUTABLE to the absolute Kata binary.");
  const scratch = mkdtempSync(path.join(process.env.KATA_TEST_ROOT!, "v2-"));
  const cwd = path.join(scratch, "workspace"), outside = path.join(scratch, "outside");
  mkdirSync(cwd); mkdirSync(outside);
  const env = { ...process.env, KATA_HOME: path.join(scratch, "home"), KATA_AUTHOR: "v2-builder" };
  for (const key of ["KATA_SERVER", "KATA_DAEMON", "KATA_AUTH_TOKEN", "KATA_REF", "KATA_TEAMMATE", "KATA_INBOX_USER"]) delete env[key];
  assertIsolated();
  const run = isolatedKata(binary, env, cwd, 5000);
  async function kata(args: string[], workspace = cwd): Promise<any> {
    const out = await run(args, workspace);
    if (out.code) throw new Error(out.stderr);
    return JSON.parse(out.stdout);
  }
  const show = async (ref: string) => kata(["show", ref, "--json"]);
  async function issue(title = "Explicit parent") { return (await kata(["create", `${title} ${unique()}`, "--force-new", "--json"])).issue.short_id; }
  function host(options: any = {}) {
    const sid = options.sid === null ? undefined : options.sid || `v2-${unique()}`;
    const app = ompHost({
      run: (args, opts) => run(args, opts.cwd, opts.timeout), cwd: options.cwd || cwd, sid, agent: options.agent, entries: options.entries,
      sessionFile: options.sessionFile || `${scratch}/${sid}.jsonl`, header: options.header, snapshot: options.snapshot, before: options.before,
      // The adapter spawns closes itself while a transcript session is exported, so a host that must see or fail closes runs without one; `transcript: true` keeps it.
      afterEvent: () => { if (!options.transcript) for (const key of TRANSCRIPT_ENV) delete process.env[key]; },
    });
    return { ...app,
      async init(items = ["Implement fixture", "Verify fixture"]) { const result = await app.call({ op: "init", items }); expect(result.isError).toBeUndefined(); return result.details.kata.parent; },
    };
  }

  // Like omp: the host owns retry timers, and sweeps whatever is pending on shutdown.
  function throttledClose() {
    const timers = new Set<{ run: () => void }>();
    let throttled = true, reached!: () => void;
    const closing = new Promise<void>(resolve => reached = resolve);
    const app = host({ before: (a: string[]) => {
      if (a[0] !== "close") return undefined;
      if (throttled) return siblingThrottle();
      reached();
      return undefined;
    } });
    app.ctx.setTimeout = (callback: () => void) => { const timer = { run: callback }; timers.add(timer); return timer; };
    app.ctx.clearTimer = (timer: any) => { timers.delete(timer); };
    return { app, timers, closing, lift: () => { throttled = false; } };
  }
  // A delegate that exits having run no tool has its assignment rolled back; these tests need one that did work.
  async function ran(lead: ReturnType<typeof host>, id: string, sessionFile: string) {
    await host({ sessionFile, agent: { kind: "sub", id, parentId: lead.ctx.agent.id } }).event("tool_call", { toolName: "read", input: { path: "README.md" } });
  }
  // The transcript session each close of an issue recorded; the store holds every earlier test's events, so page through all.
  async function closeSessions(shortId: string) {
    const closed: any[] = [];
    for (let after = 0;;) {
      const page = await kata(["events", "--after", String(after), "--limit", "500", "--json"]);
      closed.push(...page.events.filter((e: any) => e.type === "issue.closed" && e.issue_short_id === shortId));
      if (page.events.length < 500) break;
      after = page.next_after_id;
    }
    return closed.map((e: any) => e.payload?.transcript?.session_id);
  }
  const total = async () => (await kata(["list", "--status", "all", "--limit", "0", "--json"])).issues.length;
  const commentsOf = async (ref: string): Promise<string[]> => ((await show(ref)).comments ?? []).map((c: any) => c.body);
  async function sessionParents(sid: string) { return (await kata(["list", "--status", "all", "--meta", `omp.session_id=${sid}`, "--json"])).issues; }

  beforeAll(async () => { const out = await run(["init", "--project", "v2test"]); if (out.code) throw new Error(out.stderr); });
  let restore: (() => void) | undefined;
  beforeEach(() => { restore = adoptIsolatedKata(binary, env.KATA_HOME); process.env.KATA_AUTHOR = "v2-builder"; for (const key of ["KATA_REF", "KATA_TEAMMATE", "KATA_INBOX_USER", ...TRANSCRIPT_ENV]) delete process.env[key]; });
  afterEach(() => restore?.());
  afterAll(async () => { await run(["daemon", "stop"]); });

  return {
    binary, scratch, cwd, outside, env, run, kata, show, issue, unique, host,
    down: daemonUnavailable,
    evidence: ["test:bun test fixture"],
    message: "Implemented this isolated fixture and verified its behavior with the regression suite.",
    throttledClose, ran, closeSessions, total, commentsOf, sessionParents,
  };
}
