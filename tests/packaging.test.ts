import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { assertIsolated } from "./isolation";
assertIsolated();
const root = path.resolve(import.meta.dir, "..");
const json = (name: string) => JSON.parse(readFileSync(path.join(root, name), "utf8"));
// npm's trusted publisher names this one workflow file for every package. Its jobs, by name:
const flow = readFileSync(path.join(root, ".github/workflows/publish-pi.yml"), "utf8");
const publishJobs = Object.fromEntries(flow.split(/^jobs:\n/m)[1].split(/^(?=  [\w-]+:\n)/m).map(job => [job.match(/^  ([\w-]+):/)![1], job]));

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
  // Trusted publishing names publish-pi.yml, so every package publishes from a job in that file.
  expect(existsSync(path.join(root, ".github/workflows/publish-opencode.yml"))).toBe(false);
  expect(Object.keys(publishJobs)).toEqual(["verify", "publish-pi", "publish-omp", "publish-opencode"]);
  // The job with publish rights runs pinned actions, and only after the verify job.
  for (const name of ["publish-pi", "publish-omp", "publish-opencode"]) expect(publishJobs[name]).toContain("needs: verify");
  expect([...flow.matchAll(/uses: (\S+)/g)].map(match => match[1]).filter(use => !use.startsWith("./") && !/@[0-9a-f]{40}$/.test(use))).toEqual([]);
  expect(publishJobs["publish-opencode"]).toContain("working-directory: plugins/opencode");
  expect(flow).toContain("id-token: write");
});

test("the omp package is listed as an omp plugin and has a publish job of its own", () => {
  const manifest = json("plugins/oh-my-pi/package.json");
  // omp keys installed plugins by package name; the marketplace and npm installs share it, so they cannot load twice.
  expect(manifest.name).toBe("@dangerboi/kata-omp");
  // omppackages.com lists npm packages carrying one of its omp keywords.
  expect(manifest.keywords).toContain("omp-plugin");
  expect(manifest.publishConfig.access).toBe("public");
  expect(manifest.dependencies).toBeUndefined();
  expect(publishJobs["publish-omp"]).toContain("working-directory: plugins/oh-my-pi");
});

test("each plugin's newest changelog release is the version its manifest ships", () => {
  const manifests = { pi: "package.json", "oh-my-pi": "package.json", opencode: "package.json", "claude-code": ".claude-plugin/plugin.json" };
  for (const [plugin, manifest] of Object.entries(manifests)) {
    // pi's package changelog parser: a "## " heading that starts with a version, else the section is skipped.
    const versions = readFileSync(path.join(root, "plugins", plugin, "CHANGELOG.md"), "utf8").split("\n")
      .filter(line => line.startsWith("## ")).map(line => line.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/)?.[1]).filter(Boolean);
    // Claude Code has no release yet.
    if (versions.length) expect({ plugin, version: versions[0] }).toEqual({ plugin, version: json(`plugins/${plugin}/${manifest}`).version });
  }
  // `pi install git:…` installs the root manifest, so it carries pi's version.
  expect(json("package.json").version).toBe(json("plugins/pi/package.json").version);
});

for (const plugin of ["pi", "oh-my-pi", "opencode"]) {
  test(`the ${plugin} npm tarball carries the license, changelog and every module, and leaves the folder clean`, () => {
    const dir = path.join(root, "plugins", plugin);
    const run = Bun.spawnSync(["npm", "pack", "--dry-run", "--json"], { cwd: dir, stderr: "pipe" });
    expect(run.exitCode).toBe(0);
    const out = run.stdout.toString();
    const files = JSON.parse(out.slice(out.indexOf("[")))[0].files.map((f: { path: string }) => f.path);
    expect(files).toEqual(expect.arrayContaining(["LICENSE", "CHANGELOG.md", "README.md", "package.json"]));
    // Every module the entry reaches ships: the tarball holds each .ts file the folder has.
    for (const file of readdirSync(dir).filter(name => name.endsWith(".ts"))) expect(files).toContain(file);
    expect(existsSync(path.join(dir, "LICENSE"))).toBe(false);
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

test("the Claude marketplace lists the plugin folder under the plugin manifest's own name and version", () => {
  const marketplace = json(".claude-plugin/marketplace.json");
  const manifest = json("plugins/claude-code/.claude-plugin/plugin.json");
  expect(marketplace.plugins).toHaveLength(1);
  const [listed] = marketplace.plugins;
  expect(listed).toMatchObject({ name: manifest.name, version: manifest.version });
  expect(existsSync(path.join(root, listed.source, ".claude-plugin/plugin.json"))).toBe(true);
});
