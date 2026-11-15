import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertIsolated, snapshot, assertUnchanged } from "./isolation";
assertIsolated();
// Scratch directories live under the run's root, which the runner removes.
const scratch = (prefix: string) => mkdtempSync(path.join(process.env.KATA_TEST_ROOT!, prefix));

test("isolation rejects defaults, remote routing, unmarked stores and escaped homes", () => {
  const root = scratch("omp-kata-guard-");
  const env = { KATA_TEST_ROOT: root, KATA_HOME: path.join(root, "home") };
  mkdirSync(env.KATA_HOME);
  expect(() => assertIsolated(env)).toThrow();
  writeFileSync(path.join(root, ".omp-kata-test"), "throwaway\n");
  expect(() => assertIsolated(env)).not.toThrow();
  for (const override of [{ KATA_HOME: path.join(os.homedir(), ".kata") }, { KATA_HOME: root + "-escape" }, { KATA_SERVER: "localhost" }, { KATA_DAEMON: "default" }]) {
    expect(() => assertIsolated({ ...env, ...override })).toThrow();
  }
});

function fixture() {
  const root = scratch("omp-kata-canary-");
  const db = new Database(path.join(root, "kata.db"));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta VALUES ('schema_version', '26');
    CREATE TABLE projects (uid TEXT, name TEXT);
    INSERT INTO projects VALUES ('user-project', 'personal');
    CREATE TABLE events (id INTEGER PRIMARY KEY, uid TEXT, actor TEXT, project_name TEXT, payload TEXT);`);
  return { root, db };
}

test("semantic canary ignores normal sync, fixture names in real sessions' text and WAL/checkpoint changes without modifying source", () => {
  const { root, db } = fixture();
  try {
    const before = snapshot(root);
    db.exec(`INSERT INTO events VALUES (1, 'normal', 'user', 'personal', '{}')`);
    // A real session working during the run whose task text names fixtures and fixture refs.
    db.exec(`INSERT INTO events VALUES (2, 'mission', 'user', 'personal', '{"title":"Run the fixture suite against omptest#abcd"}')`);
    expect(() => assertUnchanged(before, root)).not.toThrow();
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(() => assertUnchanged(before, root)).not.toThrow();
  } finally { db.close(); }
});

for (const [name, sql] of [
  ["schema migration", "UPDATE meta SET value='27'"],
  ["new project", "INSERT INTO projects VALUES ('new', 'new-project')"],
  ["test actor", "INSERT INTO events VALUES (1, 'leak', 'v2-builder', 'personal', '{}')"],
  ["test project name", "INSERT INTO events VALUES (1, 'leak', 'user', 'v2test', '{}')"],
  ["unreadable schema", "DROP TABLE events"],
]) test(`semantic canary rejects ${name}, including changes still in WAL`, () => {
  const { root, db } = fixture();
  try { const before = snapshot(root); db.exec(sql); expect(() => assertUnchanged(before, root)).toThrow(); }
  finally { db.close(); }
});

test("semantic canary fails closed on invalid databases and missing schema versions", () => {
  const root = scratch("omp-kata-canary-");
  writeFileSync(path.join(root, "kata.db"), "not a database");
  expect(() => snapshot(root)).toThrow();
  const f = fixture();
  try { f.db.exec("DELETE FROM meta"); expect(() => snapshot(f.root)).toThrow(); }
  finally { f.db.close(); }
});
