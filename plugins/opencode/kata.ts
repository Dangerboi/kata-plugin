import { createSeam, type Seam } from "./seam";
import { resolveSettings } from "./settings";
import { install as installShellRoute } from "./shell-route";
import { install as installSubagents } from "./subagents";
import { install as installTodowrite } from "./todowrite";

// Kata plans for OpenCode: `todowrite` backed by Kata, one core per lead session, state saved in `ctx.storage`.
// Plugin options (opencode.json): executable, ref, defaultProject, author, teammate, debugFile; each falls back to the server's
// environment (KATA_OPENCODE_EXECUTABLE, KATA_REF, KATA_DEFAULT_PROJECT, KATA_AUTHOR, KATA_TEAMMATE, KATA_OPENCODE_DEBUG).
// The Kata contract and inbox reach the agent through `kata agent-hook install opencode`, not through this plugin.

// Modules that add behaviour through the seam (see seam.ts), installed in this order. One `import` above and one line here per module.
const MODULES: ((seam: Seam) => void | Promise<unknown>)[] = [
	installTodowrite,
	installSubagents,
	installShellRoute,
];

const LEAD_ENDED = ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"] as const;
const SESSION_ENDED = ["session.deleted", "session.archived"] as const;

export default {
	id: "kata",
	async setup(ctx: any) {
		const settings = resolveSettings(ctx.options);
		const registry = createSeam(ctx, settings);
		const { seam } = registry;

		// A lead's core is created at the lead's first context hook or first tool call, never at its `session.created` (not delivered).
		seam.before(async event => { await seam.leadOf(event.sessionID); });
		seam.context(async event => {
			const session = await seam.sessionOf(event.sessionID);
			if (!session || session.parentID !== undefined) return;
			const text = await (await seam.leadOf(event.sessionID))?.planSection();
			if (text) event.system.push({ type: "text", text });
		});
		// Events of sessions that are not leads of this instance find no lead and do nothing.
		seam.events(LEAD_ENDED, async event => { if (event.data?.sessionID) await (await seam.savedLead(event.data.sessionID))?.settle(); });
		seam.events(SESSION_ENDED, async event => { if (event.data?.sessionID) await seam.endLead(event.data.sessionID); });
		for (const install of MODULES) await install(seam);

		await ctx.tool.hook("execute.before", registry.hooks.before);
		await ctx.tool.hook("execute.after", registry.hooks.after);
		await ctx.session.hook("context", registry.hooks.context);

		const stream = new AbortController();
		const types = registry.eventTypes();
		const consumer = (async () => {
			for await (const event of ctx.event.subscribe({ types, signal: stream.signal })) await registry.dispatchEvent(event);
		})().catch(seam.debug);
		await registry.resumeSaved();

		// Location eviction or server exit: the session may resume later, so nothing is closed or released.
		return async () => {
			stream.abort();
			await consumer;
			await registry.suspendAll();
		};
	},
};
