// What the adapter reads from the host: plugin options (`ctx.options`, from opencode.json globally or per project) first,
// then the server's environment. A shell variable reaches the plugin only when the server was started from that shell
// (`opencode --standalone`): put a setting in opencode.json to make it hold for every server.
export interface Settings {
	executable: string;
	debugFile?: string;
	// The core's lookup for the variables it would read from process.env (KATA_REF, KATA_AUTHOR, ...).
	env(name: string): string | undefined;
	// Added to the environment of every Kata process: the settings Kata itself reads.
	kataEnv: Record<string, string>;
}

// option name, environment variable: the first non-empty string wins, option before variable.
const SETTINGS = {
	executable: ["executable", "KATA_OPENCODE_EXECUTABLE"],
	ref: ["ref", "KATA_REF"],
	defaultProject: ["defaultProject", "KATA_DEFAULT_PROJECT"],
	author: ["author", "KATA_AUTHOR"],
	teammate: ["teammate", "KATA_TEAMMATE"],
	debugFile: ["debugFile", "KATA_OPENCODE_DEBUG"],
} as const;
// The variable that names the executable: shell commands that call Kata through it are Kata invocations too.
export const EXECUTABLE_VARS = [SETTINGS.executable[1]];
// The host's name: the namespace of its cores (their saved entries and Kata metadata keys) and the agent a close's transcript is for.
export const NAMESPACE = "opencode";

export function resolveSettings(options: Record<string, unknown> | undefined, environment: NodeJS.ProcessEnv = process.env): Settings {
	const read = (key: keyof typeof SETTINGS) => {
		const [option, variable] = SETTINGS[key];
		for (const value of [options?.[option], environment[variable]]) if (typeof value === "string" && value.trim()) return value.trim();
	};
	// What the core's `env` lookup and Kata's own environment get: the settings that are variables Kata reads.
	const named = (keys: (keyof typeof SETTINGS)[]) => Object.fromEntries(keys.flatMap(key => { const value = read(key); return value ? [[SETTINGS[key][1], value] as [string, string]] : []; }));
	const forCore = named(["ref", "defaultProject", "author", "teammate"]);
	return {
		executable: read("executable") ?? "kata",
		debugFile: read("debugFile"),
		env: name => forCore[name],
		kataEnv: named(["author", "teammate"]),
	};
}
