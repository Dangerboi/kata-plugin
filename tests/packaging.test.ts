import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
