import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function assertIsolated(env: NodeJS.ProcessEnv = process.env) {
  const root = env.KATA_TEST_ROOT;
  const home = env.KATA_HOME;
  if (!root || !home || env.KATA_SERVER || env.KATA_DAEMON || env.KATA_AUTH_TOKEN) throw new Error("Tests require an explicit throwaway KATA_HOME and no remote Kata routing. Use bun run test.");
  const resolvedRoot = realpathSync(root);
  const resolvedHome = existsSync(home) ? realpathSync(home) : path.join(realpathSync(path.dirname(home)), path.basename(home));
  const tmp = realpathSync(os.tmpdir());
  if (!resolvedRoot.startsWith(tmp + path.sep) || !resolvedHome.startsWith(resolvedRoot + path.sep) || !existsSync(path.join(resolvedRoot, ".omp-kata-test")) || resolvedHome === path.join(os.homedir(), ".kata")) throw new Error("KATA_HOME is not inside the marked throwaway test root.");
}

// Include every fixture actor/project, including live proof runs. Keep this list
// next to the guard so additions to fixtures have one explicit canary boundary.
const actors = new Set(["actor-a", "actor-b", "v2-builder", "revision-a", "revision-b", "omp-v2-proof", "pi-builder", "opencode-builder", "configured-author", "pi-port-proof", "integration-actor", "assemble-proof"]);
const testProject = /(?:^|[^a-z0-9_-])(?:realtest|fixture|assemble-[a-z0-9_-]+|omptest|v2test|v2other|v2evidence|pitest|piother|pi-port-[a-z0-9_-]+|revision-conformance|omp-v2-[a-z0-9_-]+)(?=$|[^a-z0-9_-])/i;
type Snapshot = { present: boolean; schema?: string; projects: string[]; forbidden: string[] };

function stamp(file: string): string {
  try { const s = statSync(file, { bigint: true }); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`; }
  catch (error: any) { if (error.code === "ENOENT") return "missing"; throw error; }
}

export function snapshot(root = path.join(os.homedir(), ".kata")): string {
  const source = path.join(root, "kata.db");
  if (stamp(source) === "missing") return JSON.stringify({ present: false, projects: [], forbidden: [] });
  const copy = mkdtempSync(path.join(os.tmpdir(), "omp-kata-canary-copy-"));
  const target = path.join(copy, "kata.db");
  try {
    // Never open the live DB through SQLite (even readonly can write its SHM).
    // Copy the DB and WAL during a stable interval, then rebuild SHM only in
    // the disposable copy. A racing checkpoint retries, never silently passes.
    let stable = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const before = [stamp(source), stamp(source + "-wal")];
      try {
        copyFileSync(source, target);
        rmSync(target + "-wal", { force: true });
        if (before[1] !== "missing") copyFileSync(source + "-wal", target + "-wal");
      } catch (error) {
        if (before.join() === [stamp(source), stamp(source + "-wal")].join()) throw error;
        continue;
      }
      if (before.join() === [stamp(source), stamp(source + "-wal")].join()) { stable = true; break; }
    }
    if (!stable) throw new Error("Could not obtain a stable default Kata DB copy.");
    const db = new Database(target, { readonly: true });
    try {
      const check = db.query("PRAGMA integrity_check").all() as any[];
      if (check.length !== 1 || check[0].integrity_check !== "ok") throw new Error("Default Kata DB copy failed integrity check.");
      const schema = (db.query("SELECT value FROM meta WHERE key='schema_version'").get() as any)?.value;
      if (!/^\d+$/.test(String(schema))) throw new Error("Default Kata DB has no valid schema version.");
      const projects = (db.query("SELECT uid, name FROM projects").all() as any[]).map(p => JSON.stringify([p.uid, p.name])).sort();
      const forbidden = (db.query("SELECT uid, actor, project_name, payload FROM events").all() as any[])
        .filter(e => actors.has(e.actor) || testProject.test(e.project_name) || testProject.test(e.payload))
        .map(e => createHash("sha256").update(JSON.stringify(e)).digest("hex")).sort();
      return JSON.stringify({ present: true, schema: String(schema), projects, forbidden });
    } finally { db.close(); }
  } finally { rmSync(copy, { recursive: true, force: true }); }
}

export function assertUnchanged(before: string, root?: string) {
  const previous: Snapshot = JSON.parse(before), current: Snapshot = JSON.parse(snapshot(root));
  if (previous.present !== current.present || previous.schema !== current.schema) throw new Error("Default Kata canary failed: database/schema version changed.");
  if (current.projects.some(p => !previous.projects.includes(p))) throw new Error("Default Kata canary failed: new projects detected.");
  if (current.forbidden.some(e => !previous.forbidden.includes(e))) throw new Error("Default Kata canary failed: events from test actors or test projects detected.");
}
