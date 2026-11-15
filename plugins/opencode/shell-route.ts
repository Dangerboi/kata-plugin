import { delegateCommand, envPrefix, kataCommands, shellOptions } from "./shell";
import { transcriptEnv } from "./kata-cli";
import { EXECUTABLE_VARS } from "./settings";
import { CallRefused, type Seam } from "./seam";

// Kata in the `shell` tool. A child session's commands run under its teammate (its delegate record's, or the one derived for
// a child the lead does not track) and its own transcript pair, and `--as` is refused. Every Kata command carries the
// configured author (and a lead its teammate), because the server's environment may not hold them; a lead's `close` also
// carries the lead's transcript pair (the server's environment cannot hold one per session). The command is otherwise left as
// written, so bare `kata` stays `kata`; the configured executable only lets the plugin recognise Kata invocations here and
// runs its own Kata calls.
export function install(seam: Seam): void {
	const executable = seam.settings.executable;

	// Edits go from the end of the command so earlier offsets stay valid.
	function route(command: string, actor: Record<string, string>, leadID?: string): string {
		for (const invocation of kataCommands(command, executable, EXECUTABLE_VARS).reverse()) {
			const word = invocation.executable;
			const close = leadID !== undefined && shellOptions(invocation.words).args[0] === "close";
			const prefix = envPrefix({ ...(close ? transcriptEnv("opencode", leadID) : {}), ...actor });
			if (prefix) command = command.slice(0, word.start) + prefix + command.slice(word.start);
		}
		return command;
	}

	seam.before(async event => {
		if (event.tool !== "shell" || typeof event.input?.command !== "string") return;
		let command: string = event.input.command;
		if (!kataCommands(command, executable, EXECUTABLE_VARS).length) return;
		const role = await seam.roleOf(event.sessionID);
		if (role.kind === "other") return;
		if (role.kind === "lead") command = route(command, seam.settings.kataEnv, event.sessionID);
		else {
			try { command = delegateCommand(command, executable, EXECUTABLE_VARS, role.teammate, role.assignment?.binding, { agent: "opencode", id: event.sessionID }); }
			catch (error) { throw new CallRefused(error instanceof Error ? error.message : String(error)); }
			// The child keeps its own teammate (--teammate); only the author comes from the settings.
			const { KATA_AUTHOR } = seam.settings.kataEnv;
			command = route(command, KATA_AUTHOR ? { KATA_AUTHOR } : {});
		}
		if (command !== event.input.command) event.input = { ...event.input, command };
	});
}
