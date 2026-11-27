import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, renameSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { isMainThread } from "node:worker_threads";
import { quote } from "./shell";

export type Shim = { dir: string; real: string };
const marker = "__kata_omp_prefix_end;";
const source = join(dirname(fileURLToPath(import.meta.url)), "bin", "kata");
const pattern = /^omp-kata-(\d+)-[a-zA-Z0-9]{6}$/;
let owned: Shim | undefined;
let failed = false;

function userPrefix(value = ""): string {
	if (!value.startsWith("__kata_omp_prefix=")) return value;
	const end = value.indexOf(marker);
	return end < 0 ? value : value.slice(end + marker.length).trimStart();
}
export function composePrefix(shim: Shim, existing?: string): string {
	const bin = join(shim.dir, "bin");
	const user = userPrefix(existing);
	return `__kata_omp_prefix=${quote(bin)}; export PATH="$__kata_omp_prefix:\${PATH#"$__kata_omp_prefix":}" KATA_OMP_SHIM_DIR=${quote(shim.dir)} KATA_OMP_SHIM_REAL=${quote(shim.real)}; unset __kata_omp_prefix; : ${marker}${user ? ` ${user}` : ""}`;
}
function privateDir(dir: string): boolean {
	if (!isAbsolute(dir)) return false;
	try { const st = lstatSync(dir.replace(/\/+$/, "") || "/"); return st.isDirectory() && st.uid === process.getuid?.() && !(st.mode & 0o077); } catch { return false; }
}
// Only known leaf files and directories are removed; unexpected entries keep the directory intact.
function clearLayout(dir: string): void {
	const leaf = (p: string) => { try { const s = lstatSync(p); if (s.isFile() || s.isSymbolicLink()) unlinkSync(p); } catch {} };
	try {
		const bin = join(dir, "bin");
		try { if (lstatSync(bin).isDirectory()) {
			for (const name of readdirSync(bin)) {
				const path = join(bin, name);
				try { if (name !== "kata" && lstatSync(path).isSymbolicLink() && readlinkSync(path) === "kata") unlinkSync(path); } catch {}
			}
			leaf(join(bin, "kata")); rmdirSync(bin);
		} else leaf(bin); } catch {}
		for (const name of readdirSync(dir)) if (/\.env(?:\.\d+\.tmp)?$/.test(name)) leaf(join(dir, name));
		rmdirSync(dir);
	} catch {}
}
export function sweep(root: string): void {
	let names: string[]; try { names = readdirSync(root); } catch { return; }
	for (const name of names) {
		const match = pattern.exec(name); if (!match) continue;
		const pid = Number(match[1]); if (pid === process.pid) continue;
		try { process.kill(pid, 0); continue; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") continue; }
		const dir = join(root, name); if (privateDir(dir)) clearLayout(dir);
	}
}
function detach(): void {
	const old = process.env.KATA_OMP_SHIM_DIR;
	if (!old || process.env.KATA_OMP_SHIM_PID === String(process.pid)) return;
	const bin = join(old, "bin");
	process.env.PATH = (process.env.PATH ?? "").split(":").filter(p => p !== bin).join(":");
	for (const k of ["KATA_OMP_SHIM_DIR", "KATA_OMP_SHIM_REAL", "KATA_OMP_SHIM_PID"]) delete process.env[k];
	for (const k of ["PI_SHELL_PREFIX", "CLAUDE_CODE_SHELL_PREFIX"]) if (process.env[k]) process.env[k] = userPrefix(process.env[k]);
}
export function adoptShim(shim: Shim): void {
	const bin = join(shim.dir, "bin");
	process.env.PATH = [bin, ...(process.env.PATH ?? "").split(":").filter(p => p !== bin)].join(":");
	process.env.KATA_OMP_SHIM_DIR = shim.dir; process.env.KATA_OMP_SHIM_REAL = shim.real; process.env.KATA_OMP_SHIM_PID = String(process.pid);
	process.env.PI_SHELL_PREFIX = composePrefix(shim, process.env.PI_SHELL_PREFIX || process.env.CLAUDE_CODE_SHELL_PREFIX);
}
export function currentShim(): Shim | undefined {
	const { KATA_OMP_SHIM_DIR: dir, KATA_OMP_SHIM_REAL: real, KATA_OMP_SHIM_PID: pid } = process.env;
	return dir && real && pid === String(process.pid) ? { dir, real } : undefined;
}
export function installShim(executable: string, warn: (message: string) => void, options: { roots?: string[]; probe?: (path: string) => boolean; platform?: NodeJS.Platform } = {}): Shim | undefined {
	detach();
	const inherited = currentShim(); if (inherited) { adoptShim(inherited); return inherited; }
	if (!isMainThread || failed) return undefined;

	const real = executable.includes("/") ? resolve(executable) : (process.env.PATH ?? "").split(":").map(dir => resolve(dir || ".", executable)).find(path => { try { return statSync(path).isFile() && !!(statSync(path).mode & 0o111); } catch { return false; } }) ?? executable;
	const roots = options.roots ?? [process.env.XDG_RUNTIME_DIR && privateDir(process.env.XDG_RUNTIME_DIR) ? process.env.XDG_RUNTIME_DIR : undefined, tmpdir()].filter((v, i, a): v is string => !!v && a.indexOf(v) === i);
	const errors: string[] = [];
	if ((options.platform ?? process.platform) !== "win32") for (const root of roots) {
		let dir: string | undefined;
		try {
			dir = mkdtempSync(join(root, `omp-kata-${process.pid}-`)); chmodSync(dir, 0o700);
			const bin = join(dir, "bin"); mkdirSync(bin, { mode: 0o700 }); const target = join(bin, "kata"); copyFileSync(source, target); chmodSync(target, 0o700);
			const name = basename(executable);
			if (!name || name === "." || name === "..") throw new Error("invalid executable basename");
			if (name !== "kata") symlinkSync("kata", join(bin, name));
			const probe = spawnSync(target, [], { env: { PATH: "/usr/bin:/bin", KATA_SHIM_PROBE: "1" }, stdio: "ignore", timeout: 5000 });
			if (!(options.probe ? options.probe(target) : !probe.error && probe.status === 0)) throw probe.error ?? new Error(`probe exited ${probe.status}`);
			sweep(root); owned = { dir, real }; adoptShim(owned); process.once("exit", () => { if (owned) clearLayout(owned.dir); }); return owned;
		} catch (error) { if (dir) clearLayout(dir); errors.push(`${root}: ${String(error)}`); }
	}
	failed = true; warn(`Kata shell shim not installed (${errors.join("; ") || "native Windows"}); commands the plugin can see are still rewritten, but scripts, functions and bash -c can run with the lead’s identity.`); return undefined;
}
export function writeIdentity(shim: Shim, id: string | undefined, vars: Record<string, string | undefined>): void {
	if (!id || id.includes("/") || id === "." || id === "..") return;
	const target = join(shim.dir, `${id}.env`);
	const text = Object.entries(vars).map(([key, value]) => value === undefined ? `unset ${key}` : `export ${key}=${quote(value)}`).join("\n") + "\n";
	const temp = `${target}.${process.pid}.tmp`; writeFileSync(temp, text, { mode: 0o600 }); renameSync(temp, target);
}
