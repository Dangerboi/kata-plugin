import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TRANSCRIPT_ENV } from "../core/kata-cli";
import { cleanEnv } from "../scripts/smoke-lib";
import { assertIsolated, FIXTURE_ACTORS, FIXTURE_PROJECT, SCRUBBED_ENV, snapshot, assertUnchanged } from "./isolation";
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

test("every actor and project the test files name literally is in the canary lists", () => {
  const actors = new Set<string>(), projects = new Set<string>();
  for (const file of readdirSync(import.meta.dir).filter(name => name.endsWith(".ts") && !name.startsWith("isolation"))) {
    const source = readFileSync(path.join(import.meta.dir, file), "utf8");
    for (const match of source.matchAll(/\bauthor: "([^"]+)"/g)) actors.add(match[1]);
    for (const match of source.matchAll(/\bproject: "([^"]+)"|"--project", "([^"]+)"|"projects", "create", "([^"]+)"/g)) projects.add(match[1] ?? match[2] ?? match[3]);
  }
  expect([...actors].filter(actor => !FIXTURE_ACTORS.has(actor))).toEqual([]);
  expect([...projects].filter(project => !FIXTURE_PROJECT.test(project))).toEqual([]);
});

test("the scrubbed variables include every transcript variable the core exports", () => {
  for (const name of TRANSCRIPT_ENV) expect(SCRUBBED_ENV).toContain(name);
});

test("the smoke runners drop the identity and executable variables a developer's shell sets", () => {
  const names = ["KATA_TEAMMATE", "KATA_INBOX_USER", "KATA_AUTHOR", "KATA_OMP_EXECUTABLE", "KATA_OPENCODE_DEBUG", "KATA_HOME", "KEEP_ME"];
  const saved = names.map(name => [name, process.env[name]] as const);
  try {
    for (const name of names) process.env[name] = "x";
    const env = cleanEnv();
    expect(names.filter(name => name in env)).toEqual(["KEEP_ME"]);
  } finally {
    for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});
