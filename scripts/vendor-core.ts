import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Every core module goes into each of the three self-contained plugin directories, under a first line that names its source.
// A copy whose core module is gone is an orphan: the build deletes it, and the check rejects it.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const marker = (name: string) => `// Generated from core/${name}; edit there.\n`;
const modules = readdirSync(path.join(root, "core")).filter(name => name.endsWith(".ts"));
for (const plugin of ["oh-my-pi", "pi", "opencode"]) {
	const dir = path.join(root, "plugins", plugin);
	for (const name of modules) {
		const target = path.join(dir, name);
		const wanted = marker(name) + readFileSync(path.join(root, "core", name), "utf8");
		if (!check) writeFileSync(target, wanted);
		else if (!existsSync(target) || readFileSync(target, "utf8") !== wanted) throw new Error(`plugins/${plugin}/${name} is stale; run bun run build:plugins.`);
	}
	for (const name of readdirSync(dir).filter(name => name.endsWith(".ts") && !modules.includes(name))) {
		if (!readFileSync(path.join(dir, name), "utf8").startsWith("// Generated from core/")) continue;
		if (check) throw new Error(`plugins/${plugin}/${name} is a copy of a core module that no longer exists; run bun run build:plugins.`);
		rmSync(path.join(dir, name));
	}
}
console.log(check ? "Vendored plugin sources match." : "Vendored shared core into self-contained plugin directories.");
