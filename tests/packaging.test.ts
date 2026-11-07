import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { assertIsolated } from "./isolation";
assertIsolated();
const root = path.resolve(import.meta.dir, "..");
const json = (name: string) => JSON.parse(readFileSync(path.join(root, name), "utf8"));

test("vendored core and OMP adapter are current", async () => {
  const check = Bun.spawn([process.execPath, "scripts/vendor-core.ts", "--check"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(await check.exited).toBe(0);
});

test("each host manifest points at an extension file that exists, and only the intended host loads it", () => {
  const exists = (dir: string, entry: string) => existsSync(path.join(root, dir, entry));
  const omp = json("plugins/oh-my-pi/package.json");
  expect(omp.pi).toBeUndefined();
  for (const entry of omp.omp.extensions) expect(exists("plugins/oh-my-pi", entry)).toBe(true);
  for (const entry of json("package.json").pi.extensions) expect(exists(".", entry)).toBe(true);
  const pi = json("plugins/pi/package.json");
  for (const entry of pi.pi.extensions) expect(exists("plugins/pi", entry)).toBe(true);
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
