import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Each plugin directory gets the core modules its own files import, and the core modules those import in turn, under a
// first line that names the source. A copy no longer reached is an orphan: the build deletes it, and the check rejects it.
// The Claude Code mod runtime has no Node, so it keeps its copies in their own folder; it never imports the Node host.
// publish-pi.yml runs this file with plain `node`, which only strips types: keep it erasable (no enums, no parameter properties).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const GENERATED = "// Generated from core/";
const marker = (name: string) => `// Generated from core/${name}; edit there.\n`;
const coreDir = path.join(root, "core");
const core = new Set(readdirSync(coreDir).filter(name => name.endsWith(".ts")));
const targets = [
	{ dir: "plugins/oh-my-pi", importers: ["plugins/oh-my-pi"], deep: false },
	{ dir: "plugins/pi", importers: ["plugins/pi"], deep: false },
	{ dir: "plugins/opencode", importers: ["plugins/opencode"], deep: false },
	{ dir: "plugins/claude-code/core", importers: ["plugins/claude-code/hooks", "plugins/claude-code/tests"], deep: true },
];

const SPECIFIER = /(?:from|import\s*\()\s*"(\.[^"]*)"/g;
const sourcesIn = (dir: string, deep: boolean): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) return deep && entry.name !== "node_modules" ? sourcesIn(file, deep) : [];
		return /\.tsx?$/.test(entry.name) && !readFileSync(file, "utf8").startsWith(GENERATED) ? [file] : [];
	});
const importsOf = (file: string) => [...readFileSync(file, "utf8").matchAll(SPECIFIER)].map(match => path.resolve(path.dirname(file), match[1]));

function reached(target: { dir: string; importers: string[]; deep: boolean }): string[] {
	const seen = new Set<string>();
	const visit = (resolved: string) => {
		const name = path.basename(resolved) + ".ts";
		if (!core.has(name) || seen.has(name)) return;
		seen.add(name);
		for (const next of importsOf(path.join(coreDir, name))) if (path.dirname(next) === coreDir) visit(next);
	};
	const here = path.join(root, target.dir);
	for (const importer of target.importers) {
		const dir = path.join(root, importer);
		if (!existsSync(dir)) continue;
		for (const file of sourcesIn(dir, target.deep)) for (const next of importsOf(file)) if (path.dirname(next) === here) visit(next);
	}
	return [...seen].sort();
}

for (const target of targets) {
	const dir = path.join(root, target.dir);
	const modules = reached(target);
	if (!check) mkdirSync(dir, { recursive: true });
	for (const name of modules) {
		const copy = path.join(dir, name);
		const wanted = marker(name) + readFileSync(path.join(coreDir, name), "utf8");
		if (!check) writeFileSync(copy, wanted);
		else if (!existsSync(copy) || readFileSync(copy, "utf8") !== wanted) throw new Error(`${target.dir}/${name} is stale; run bun run build:plugins.`);
	}
	for (const name of readdirSync(dir).filter(name => name.endsWith(".ts") && !modules.includes(name))) {
		if (!readFileSync(path.join(dir, name), "utf8").startsWith(GENERATED)) continue;
		if (check) throw new Error(`${target.dir}/${name} is a generated copy no file reaches any more; run bun run build:plugins.`);
		rmSync(path.join(dir, name));
	}
}
console.log(check ? "Vendored plugin sources match." : "Vendored shared core into self-contained plugin directories.");
