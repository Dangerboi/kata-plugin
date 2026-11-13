import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

test("the OpenCode manifest resolves a local folder and an npm install to the plugin entry", () => {
  const dir = path.join(root, "plugins", "opencode");
  const manifest = json("plugins/opencode/package.json");
  expect(manifest.name).toBe("@dangerboi/kata-opencode");
  expect(manifest.type).toBe("module");
  // OpenCode resolves `<name>/server`, then `<name>`, through exports; a folder with a package name and exports resolves the same way.
  expect(manifest.exports["."]).toBe("./kata.ts");
  expect(manifest.exports["./server"]).toBeUndefined();
  expect(Bun.resolveSync(manifest.name, dir)).toBe(path.join(dir, "kata.ts"));
  expect(manifest.publishConfig.access).toBe("public");
  expect(manifest.dependencies).toBeUndefined();
  // Trusted publishing names publish-pi.yml, so the OpenCode package publishes from a job in that file.
  expect(existsSync(path.join(root, ".github/workflows/publish-opencode.yml"))).toBe(false);
  const flow = readFileSync(path.join(root, ".github/workflows/publish-pi.yml"), "utf8");
  expect(flow).toContain("publish-opencode:");
  expect(flow).toContain("working-directory: plugins/opencode");
  expect(flow).toContain("id-token: write");
  // Each package releases on its own tag. GitHub's "v*" filter does not match "opencode-v*", so both are listed.
  expect(flow).toContain('tags: ["v*", "opencode-v*"]');
  const jobs = flow.split(/^jobs:\n/m)[1];
  const [piJob, openCodeJob] = jobs.split(/^  publish-opencode:\n/m);
  expect(piJob).toContain("if: startsWith(inputs.tag || github.ref_name, 'v')");
  expect(openCodeJob).toContain("if: startsWith(inputs.tag || github.ref_name, 'opencode-v')");
  expect(openCodeJob).toContain('[ "$TAG" != "opencode-v$version" ]');
  expect(openCodeJob).toContain("exit 1");
});

test("pi reads the newest changelog entry as the published version", () => {
  // pi's package changelog parser: a "## " heading that starts with a version, else the section is skipped.
  const versions = readFileSync(path.join(root, "CHANGELOG.md"), "utf8").split("\n")
    .filter(line => line.startsWith("## ")).map(line => line.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/)?.[1]).filter(Boolean);
  expect(versions[0]).toBe(json("plugins/pi/package.json").version);
  expect(json("package.json").version).toBe(json("plugins/pi/package.json").version);
});

for (const [plugin, modules] of [["pi", ["kata-core.ts"]], ["opencode", ["kata-core.ts", "seam.ts", "settings.ts", "todowrite.ts", "subagents.ts"]]] as const) {
  test(`the ${plugin} npm tarball carries the license, changelog and every module, and leaves the folder clean`, () => {
    const dir = path.join(root, "plugins", plugin);
    const run = Bun.spawnSync(["npm", "pack", "--dry-run", "--json"], { cwd: dir, stderr: "pipe" });
    expect(run.exitCode).toBe(0);
    const out = run.stdout.toString();
    const files = JSON.parse(out.slice(out.indexOf("[")))[0].files.map((f: { path: string }) => f.path);
    expect(files).toEqual(expect.arrayContaining(["LICENSE", "CHANGELOG.md", "README.md", "package.json", "kata.ts", ...modules]));
    // Every module the entry reaches ships: the tarball holds each .ts file the folder has.
    for (const file of readdirSync(dir).filter(name => name.endsWith(".ts"))) expect(files).toContain(file);
    expect(existsSync(path.join(dir, "LICENSE")) || existsSync(path.join(dir, "CHANGELOG.md"))).toBe(false);
  });
}

test("each distributable keeps its complete local import graph inside its folder", () => {
  for (const plugin of ["oh-my-pi", "pi", "opencode"]) {
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
