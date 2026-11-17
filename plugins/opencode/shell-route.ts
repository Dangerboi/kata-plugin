import { delegateCommand, envPrefix, kataCommands, shellOptions } from "./shell";
import { closeEnv } from "./kata-cli";
import { nodePlatform } from "./node-host";
import { EXECUTABLE_VARS, NAMESPACE } from "./settings";
import { CallRefused, type Seam } from "./seam";

// Kata in the `shell` tool. A child session's commands run under its teammate (its delegate record's, or the one derived for
// a child the lead does not track) and its own transcript pair, and `--as` is refused. Every Kata command carries the
// configured author (and a lead its teammate), because the server's environment may not hold them; a lead's `close` also
// carries the lead's transcript pair (the server's environment cannot hold one per session). The command is otherwise left as
// written, so bare `kata` stays `kata`; the configured executable only lets the plugin recognise Kata invocations here and
// runs its own Kata calls.
export function install(seam: Seam): void {
	const executable = seam.settings.executable;

	// A lead's Kata commands: edits go from the end of the command so earlier offsets stay valid.
	function route(command: string, leadID: string): string {
		for (const invocation of kataCommands(nodePlatform.path, command, executable, EXECUTABLE_VARS).reverse()) {
			const prefix = envPrefix({ ...closeEnv(nodePlatform.env, shellOptions(invocation.words).args, NAMESPACE, leadID), ...seam.settings.kataEnv });
			if (prefix) command = command.slice(0, invocation.executable.start) + prefix + command.slice(invocation.executable.start);
		}
		return command;
	}

	seam.before(async event => {
		if (event.tool !== "shell" || typeof event.input?.command !== "string") return;
		let command: string = event.input.command;
		if (!kataCommands(nodePlatform.path, command, executable, EXECUTABLE_VARS).length) return;
		const role = await seam.roleOf(event.sessionID);
		// A session that cannot be read runs the command as written: a failed lookup never refuses a call.
		if (role.kind === "other") return;
		if (role.kind === "lead") command = route(command, event.sessionID);
		else {
			// The child keeps its own teammate (--teammate); only the author comes from the settings.
			const { KATA_AUTHOR } = seam.settings.kataEnv;
			try { command = delegateCommand(nodePlatform.path, command, executable, EXECUTABLE_VARS, role.teammate, role.assignment?.binding, { env: nodePlatform.env, agent: NAMESPACE, id: event.sessionID }, KATA_AUTHOR ? { KATA_AUTHOR } : {}); }
			catch (error) { throw new CallRefused(error instanceof Error ? error.message : String(error)); }
		}
		if (command !== event.input.command) event.input = { ...event.input, command };
	});
}
