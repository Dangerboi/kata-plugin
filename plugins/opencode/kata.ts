import { createSeam, EXECUTION_ENDED, SESSION_ENDED, type Seam } from "./seam";
import type { Lead } from "./lead";
import { resolveSettings } from "./settings";
import { install as installShellRoute } from "./shell-route";
import { install as installWriteGuard } from "./write-guard";
import { install as installSubagents } from "./subagents";
import { install as installTodowrite } from "./todowrite";
import { clearInheritedOmpSession } from "./node-host";

// Kata plans for OpenCode: `todowrite` backed by Kata, one core per lead session, state saved in `ctx.storage`.
// Plugin options (opencode.json) and their environment fallbacks are listed in settings.ts.
// The Kata contract and inbox reach the agent through `kata agent-hook install opencode`, not through this plugin.

// Installed in this order (see Seam in seam.ts).
const MODULES: ((seam: Seam) => void | Promise<unknown>)[] = [
	installWriteGuard,
	installTodowrite,
	installSubagents,
	installShellRoute,
];

export default {
	id: "kata",
	async setup(ctx: any) {
		clearInheritedOmpSession();
		const settings = resolveSettings(ctx.options);
		const registry = createSeam(ctx, settings);
		const { seam } = registry;

		// A lead's core is created at the lead's first context hook or tool call, or for a session with saved state at the setup's
		// resume or its first event; never at its `session.created` (not delivered).
		// A lead that runs a hook or tool is alive: it is no longer an ended session. A delegate's tool call says nothing of its lead.
		seam.before(async event => {
			const role = await seam.roleOf(event.sessionID);
			if (role.kind === "lead") await role.lead.revive("alive");
		});
		seam.context(async event => {
			const role = await seam.roleOf(event.sessionID);
			if (role.kind !== "lead") return;
			await role.lead.revive("alive");
			const text = await role.lead.planSection();
			if (text) event.system.push({ type: "text", text });
		});
		// Events of sessions that are not leads of this instance find no lead and do nothing.
		const onLead = (types: readonly string[], act: (lead: Lead) => Promise<unknown>) => seam.events(types, async (_event, role) => {
			if (role.kind === "lead") await act(role.lead);
		});
		onLead(Object.keys(EXECUTION_ENDED), lead => lead.settle());
		onLead(SESSION_ENDED, lead => lead.end());
		onLead(["session.unarchived"], lead => lead.revive("alive"));
		for (const install of MODULES) await install(seam);

		await ctx.tool.hook("execute.before", registry.hooks.before);
		await ctx.tool.hook("execute.after", registry.hooks.after);
		await ctx.session.hook("context", registry.hooks.context);

		const stream = new AbortController();
		const types = registry.eventTypes();
		const consumer = (async () => {
			for await (const event of ctx.event.subscribe({ types, signal: stream.signal })) registry.dispatchEvent(event);
		})().catch(seam.debug);
		// Saved work resumes in the background: a slow or unreachable Kata never holds OpenCode's boot of the location.
		registry.resumeSaved();

		// Location eviction or server exit: the session may resume later, so nothing is closed or released.
		return async () => {
			stream.abort();
			await consumer;
			await registry.eventsHandled();
			await registry.suspendAll();
		};
	},
};
