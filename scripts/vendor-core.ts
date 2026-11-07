import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const omp = readFileSync(path.join(root, "kata.ts"), "utf8").replace(/"\.\/core\/([\w-]+)"/g, '"./$1"');
const files = new Map([["plugins/oh-my-pi/kata.ts", "// Generated from root kata.ts by bun run build:plugins.\n" + omp]]);
// Every core module goes into both self-contained plugin directories.
for (const name of readdirSync(path.join(root, "core")).filter(name => name.endsWith(".ts")).sort()) {
  const source = readFileSync(path.join(root, "core", name), "utf8");
  for (const plugin of ["oh-my-pi", "pi"]) files.set(`plugins/${plugin}/${name}`, source);
}
const check = process.argv.includes("--check");
for (const [file, source] of files) {
  const target = path.join(root, file);
  if (check) {
    let actual: string | undefined;
    try { actual = readFileSync(target, "utf8"); } catch { /* Report missing generated files below. */ }
    if (actual !== source) throw new Error(`${file} is stale; run bun run build:plugins.`);
  } else {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
}
console.log(check ? "Vendored plugin sources match." : "Vendored shared core and OMP entry into self-contained plugin directories.");
