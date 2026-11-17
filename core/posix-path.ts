import type { PathOps } from "./kata-cli";

// The slash-separated path operations for a host without Node (the `path` of its Platform). They follow
// path.posix; a relative path with no absolute base stays relative, since the core has no process cwd to anchor it.

function normalize(parts: string[], absolute: boolean): string[] {
	const out: string[] = [];
	for (const part of parts) {
		if (!part || part === ".") continue;
		if (part === "..") { if (out.length && out.at(-1) !== "..") out.pop(); else if (!absolute) out.push(".."); }
		else out.push(part);
	}
	return out;
}

export function resolve(...segments: string[]): string {
	let joined = "";
	for (let i = segments.length - 1; i >= 0 && !joined.startsWith("/"); i--) if (segments[i]) joined = joined ? `${segments[i]}/${joined}` : segments[i];
	const absolute = joined.startsWith("/");
	const body = normalize(joined.split("/"), absolute).join("/");
	return absolute ? `/${body}` : body || ".";
}

export function join(...segments: string[]): string {
	const joined = segments.filter(Boolean).join("/");
	if (!joined) return ".";
	const absolute = joined.startsWith("/"), body = normalize(joined.split("/"), absolute).join("/");
	return absolute ? `/${body}` : body || ".";
}

export function basename(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

export function dirname(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	const at = trimmed.lastIndexOf("/");
	if (!trimmed && path) return "/";
	return at < 0 ? "." : at === 0 ? "/" : trimmed.slice(0, at).replace(/\/+$/, "") || "/";
}

export const posixPath: PathOps = { resolve, join, basename, dirname };
