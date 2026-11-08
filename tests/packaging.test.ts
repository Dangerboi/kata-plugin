import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { assertIsolated } from "./isolation";
assertIsolated();
const root = path.resolve(import.meta.dir, "..");
const json = (name: string) => JSON.parse(readFileSync(path.join(root, name), "utf8"));

test("host manifests expose only the intended host and declare pi's supplied peers", () => {
  const omp = json("plugins/oh-my-pi/package.json");
  expect(omp.pi).toBeUndefined();
  expect(omp.omp.extensions).toEqual(["./kata.ts"]);
  expect(json("package.json").pi.extensions).toEqual(["./plugins/pi/kata.ts"]);
  const pi = json("plugins/pi/package.json");
  expect(pi.pi.extensions).toEqual(["./kata.ts"]);
  expect(json("package.json").keywords).toContain("pi-package");
  expect(pi.keywords).toContain("pi-package");
  // pi supplies these at run time; bundling them would load a second copy.
  expect(pi.peerDependencies).toMatchObject({ "@earendil-works/pi-coding-agent": "*", typebox: "*" });
  expect(pi.dependencies).toBeUndefined();
});

test("pi reads the newest changelog entry as the published version", () => {
  // pi's package changelog parser: a "## " heading that starts with a version, else the section is skipped.
  const versions = readFileSync(path.join(root, "CHANGELOG.md"), "utf8").split("\n")
    .filter(line => line.startsWith("## ")).map(line => line.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/)?.[1]).filter(Boolean);
  expect(versions[0]).toBe(json("plugins/pi/package.json").version);
  expect(json("package.json").version).toBe(json("plugins/pi/package.json").version);
});

test("the npm tarball carries the license and changelog and leaves the folder clean", () => {
  const dir = path.join(root, "plugins", "pi");
  const run = Bun.spawnSync(["npm", "pack", "--dry-run", "--json"], { cwd: dir, stderr: "pipe" });
  expect(run.exitCode).toBe(0);
  const out = run.stdout.toString();
  const files = JSON.parse(out.slice(out.indexOf("[")))[0].files.map((f: { path: string }) => f.path);
  expect(files).toEqual(expect.arrayContaining(["LICENSE", "CHANGELOG.md", "README.md", "package.json", "kata.ts", "kata-core.ts"]));
  expect(existsSync(path.join(dir, "LICENSE")) || existsSync(path.join(dir, "CHANGELOG.md"))).toBe(false);
});

test("each distributable keeps its complete local import graph inside its folder", () => {
  for (const plugin of ["oh-my-pi", "pi"]) {
    const dir = path.join(root, "plugins", plugin);
    const visited = new Set<string>();
    const visit = (file: string) => {
      expect(file.startsWith(dir + path.sep)).toBe(true);
      if (visited.has(file)) return;
      visited.add(file);
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*["'](\.[^"']+)["']/g)) {
        visit(path.resolve(path.dirname(file), match[1] + (path.extname(match[1]) ? "" : ".ts")));
      }
    };
    visit(path.join(dir, "kata.ts"));
    expect(visited.has(path.join(dir, "kata-core.ts"))).toBe(true);
  }
});
