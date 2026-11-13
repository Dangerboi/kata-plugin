// What the adapter reads from the host: plugin options (`ctx.options`, from opencode.json globally or per project) first,
// then the server's environment. A shell variable reaches the plugin only when the server was started from that shell
// (`opencode --standalone`): put a setting in opencode.json to make it hold for every server.
export interface Settings {
	executable: string;
	// The ticket every session plans under (like todowrite's `ref`, but fixed for the project).
	ref?: string;
	defaultProject?: string;
	author?: string;
	teammate?: string;
	debugFile?: string;
	// The core's lookup for the variables it would read from process.env (KATA_REF, KATA_AUTHOR, ...).
	env(name: string): string | undefined;
	// Added to the environment of every Kata process: the settings Kata itself reads.
	kataEnv: Record<string, string>;
}

// What a Kata close needs to record the session as its transcript. The switch stays as the server's environment set it, so
// `KATA_CLOSE_TRANSCRIPT_ENABLED=false` opts out.
export const closeTranscriptSwitch = () => ({ KATA_CLOSE_TRANSCRIPT_ENABLED: process.env.KATA_CLOSE_TRANSCRIPT_ENABLED ?? "true" });
export const transcriptEnv = (sessionID: string) => ({ KATA_TRANSCRIPT_AGENT: "opencode", KATA_TRANSCRIPT_SESSION_ID: sessionID, ...closeTranscriptSwitch() });

// option name, environment variable: the first non-empty string wins, option before variable.
const SETTINGS = {
	executable: ["executable", "KATA_OPENCODE_EXECUTABLE"],
	ref: ["ref", "KATA_REF"],
	defaultProject: ["defaultProject", "KATA_DEFAULT_PROJECT"],
	author: ["author", "KATA_AUTHOR"],
	teammate: ["teammate", "KATA_TEAMMATE"],
	debugFile: ["debugFile", "KATA_OPENCODE_DEBUG"],
} as const;

export function resolveSettings(options: Record<string, unknown> | undefined, environment: NodeJS.ProcessEnv = process.env): Settings {
	const read = (key: keyof typeof SETTINGS) => {
		const [option, variable] = SETTINGS[key];
		for (const value of [options?.[option], environment[variable]]) if (typeof value === "string" && value.trim()) return value.trim();
	};
	const settings = { ref: read("ref"), defaultProject: read("defaultProject"), author: read("author"), teammate: read("teammate") };
	return {
		executable: read("executable") ?? "kata",
		...settings,
		debugFile: read("debugFile"),
		env: name => ({ KATA_REF: settings.ref, KATA_DEFAULT_PROJECT: settings.defaultProject, KATA_AUTHOR: settings.author, KATA_TEAMMATE: settings.teammate } as Record<string, string | undefined>)[name],
		kataEnv: { ...(settings.author ? { KATA_AUTHOR: settings.author } : {}), ...(settings.teammate ? { KATA_TEAMMATE: settings.teammate } : {}) },
	};
}
