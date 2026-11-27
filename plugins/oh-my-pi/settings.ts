import { refGuardOff } from "./kata-cli";

export const PLUGIN_NAME = "@dangerboi/kata-omp";
export const REF_GUARD_VALUES = ["block", "off"] as const;

type Parser<T> = (value: unknown) => T | undefined;
const text: Parser<string> = value => typeof value === "string" ? value : undefined;
const boolean: Parser<boolean> = value => {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return undefined;
	switch (value.trim().toLowerCase()) {
		case "1": case "true": case "on": return true;
		case "0": case "false": case "off": return false;
		default: return undefined;
	}
};
const refGuard: Parser<typeof REF_GUARD_VALUES[number]> = value => {
	if (typeof value !== "string") return undefined;
	if (refGuardOff(value)) return "off";
	return ["block", "1", "true", "on", "yes"].includes(value.trim().toLowerCase()) ? "block" : undefined;
};
export const KEYS = {
	defaultProject: { env: "KATA_DEFAULT_PROJECT", default: "", parse: text },
	liveInbox: { env: "KATA_OMP_LIVE_INBOX", default: true, parse: boolean },
	refGuard: { env: "KATA_REF_GUARD", default: "block", parse: refGuard },
} as const;
export type StoredSettings = Record<string, unknown>;
export async function loadPluginSettings(cwd: string): Promise<StoredSettings> {
	try {
		const { getPluginSettings } = await import("@oh-my-pi/pi-coding-agent/extensibility/plugins");
		const value = await getPluginSettings(PLUGIN_NAME, cwd);
		return value && typeof value === "object" && !Array.isArray(value) ? value as StoredSettings : {};
	} catch { return {}; }
}
export function resolveSettings(stored: StoredSettings, env: Record<string, string | undefined> = process.env) {
	function fallback<T>(key: { default: T; parse: Parser<T> }, name: string): T {
		return key.parse(stored[name]) ?? key.default;
	}
	const project = fallback(KEYS.defaultProject, "defaultProject"), guard = fallback(KEYS.refGuard, "refGuard"), live = fallback(KEYS.liveInbox, "liveInbox");
	return {
		get liveInbox() { return KEYS.liveInbox.parse(env[KEYS.liveInbox.env]) ?? live; },
		env: (name: string) => name === KEYS.defaultProject.env ? KEYS.defaultProject.parse(env[name]) ?? project
			: name === KEYS.refGuard.env ? KEYS.refGuard.parse(env[name]) ?? guard : undefined,
	};
}
