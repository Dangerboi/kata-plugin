import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Every core module goes into both self-contained plugin directories.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
for (const name of readdirSync(path.join(root, "core")).filter(name => name.endsWith(".ts"))) {
  const source = readFileSync(path.join(root, "core", name), "utf8");
  for (const plugin of ["oh-my-pi", "pi", "opencode"]) {
    const target = path.join(root, "plugins", plugin, name);
    if (!check) writeFileSync(target, source);
    else if (!existsSync(target) || readFileSync(target, "utf8") !== source) throw new Error(`plugins/${plugin}/${name} is stale; run bun run build:plugins.`);
  }
}
console.log(check ? "Vendored plugin sources match." : "Vendored shared core into self-contained plugin directories.");
