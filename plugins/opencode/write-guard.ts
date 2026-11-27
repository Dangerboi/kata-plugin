import { CallRefused, type Seam } from "./seam";

// Refuses a write, an edit, a patch or a `git commit`, `merge`, `tag` or `notes` message that puts a Kata ref into the repository (the core decides: see `tools.guard`).
// A session that cannot be read is let through, like every lookup that fails.
export function install(seam: Seam): void {
	seam.before(async event => {
		const role = await seam.roleOf(event.sessionID);
		if (role.kind === "other") return;
		const reason = await role.lead.guard(event.sessionID, { tool: event.tool, input: event.input });
		if (reason) throw new CallRefused(reason);
	});
}
