import { delegateCommand, kataCommands, quote, shellOptions } from "./shell";
import type { Seam } from "./seam";

// Kata in the `shell` tool. A delegate's commands run under its teammate and its own transcript pair, and `--as` is refused
// (delegateCommand throws, which ends the call as an error). A lead's commands are left alone except that a `close` carries
// the lead's transcript pair (the server's environment cannot hold one per session) and bare `kata` becomes the configured
// executable. OpenCode's TUI keeps showing the command the model wrote; the rewritten one is what runs.
const EXECUTABLE_VARS = ["KATA_OPENCODE_EXECUTABLE"] as const;

export function install(seam: Seam): void {
	const executable = seam.settings.executable;

	// Edits go from the end of the command so earlier offsets stay valid.
	function route(command: string, leadID?: string): string {
		for (const invocation of kataCommands(command, executable, EXECUTABLE_VARS).reverse()) {
			const word = invocation.executable;
			const bare = word.value === "kata" && executable !== "kata";
			const close = shellOptions(invocation.words).args[0] === "close";
			if (!bare && !close) continue;
			// The plugin's own closes turn transcripts on unless the server's environment opts out; a shell close does the same.
			const enable = close && process.env.KATA_CLOSE_TRANSCRIPT_ENABLED === undefined ? "KATA_CLOSE_TRANSCRIPT_ENABLED=true " : "";
			const pair = close && leadID !== undefined ? `env KATA_TRANSCRIPT_AGENT=opencode KATA_TRANSCRIPT_SESSION_ID=${quote(leadID)} ` : "";
			const prefix = pair + enable;
			if (!bare && !prefix) continue;
			command = command.slice(0, word.start) + prefix + (bare ? quote(executable) : command.slice(word.start, word.end)) + command.slice(word.end);
		}
		return command;
	}

	seam.before(async event => {
		if (event.tool !== "shell" || typeof event.input?.command !== "string") return;
		let command: string = event.input.command;
		if (!kataCommands(command, executable, EXECUTABLE_VARS).length) return;
		const session = await seam.sessionOf(event.sessionID);
		if (!session) return;
		if (session.parentID === undefined) command = route(command, event.sessionID);
		else {
			const owner = await seam.delegateOf(event.sessionID);
			if (!owner) return;
			const { record, assignment } = owner;
			command = route(delegateCommand(command, executable, EXECUTABLE_VARS, record.teammate, assignment?.binding, { agent: "opencode", id: record.sessionId }));
		}
		if (command !== event.input.command) event.input = { ...event.input, command };
	});
}
