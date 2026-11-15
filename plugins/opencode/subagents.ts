import type { DelegateEvent } from "./delegates";
import { teammateFor } from "./delegates";
import { speak } from "./todowrite";
import type { Lead } from "./lead";
import { EXECUTION_ENDED, SESSION_ENDED, type Seam } from "./seam";

// A `subagent` call a lead made: read against the plan before it runs (the core keeps what it reserved under the call's id),
// then matched to the child session it creates.
interface Call {
	id: string;
	prompt: string;
	description: string;
	// The agent the call starts (`general`, `explore`, ...), when it names one.
	agent?: string;
	background: boolean;
	// A follow-up: the delegate record (the child's session id) it goes on with.
	followUp?: string;
	// Set once the child's first context hook bound it.
	childID?: string;
}
// Everything the lead gave the spawn, as the core reads it for what it names.
const textFor = (call: Call) => [call.prompt, call.description].filter(Boolean).join("\n");

// The text of a message as OpenCode keeps it: a user message has `text`, an assistant message a list of content parts.
function textOf(message: any): string {
	if (typeof message?.text === "string") return message.text;
	const parts = Array.isArray(message?.content) ? message.content : [];
	return parts.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("");
}

// The report of a finished foreground call: the child's final reply, without the `<subagent ...>` wrapper of the result text.
function reportOf(result: any): string {
	if (typeof result?.output?.output === "string") return result.output.output;
	const text = (Array.isArray(result?.content) ? result.content : []).map((part: any) => part?.text ?? "").join("\n");
	return /^<subagent\b[^>]*>\n?([\s\S]*?)\n?<\/subagent>$/.exec(text.trim())?.[1] ?? text;
}

// Binds a lead's `subagent` calls to its plan items and settles them: the core's delegate rules decide what a spawn works,
// the child session's first context hook binds it before its first model call, and the lead's turn end hands back what is left open.
export function install(seam: Seam): void {
	// A lead's calls still waiting for their child (or, foreground, for their result), in creation order.
	const calls = new Map<string, Call[]>();
	const callsOf = (leadID: string) => calls.get(leadID) ?? (calls.set(leadID, []), calls.get(leadID)!);
	// The call is over: it leaves the list, and what it reserved and no child took is free again.
	const drop = (lead: Lead, call: Call) => {
		const list = calls.get(lead.id);
		const index = list?.indexOf(call) ?? -1;
		if (index >= 0) list!.splice(index, 1);
		lead.core.delegates.release(call.id);
	};
	const send = (lead: Lead, event: DelegateEvent) => lead.core.delegates.apply(event);

	seam.before(async event => {
		const session = await seam.sessionOf(event.sessionID);
		if (!session) return;
		if (session.parentID !== undefined) {
			// A delegate's tool call: it did something, so its assignment is no longer rolled back at exit.
			const delegate = await seam.delegateOf(event.sessionID);
			if (delegate && !delegate.record.ranTool) await send(delegate.lead, { type: "ranTool", id: delegate.record.id });
			return;
		}
		if (event.tool !== "subagent") return;
		const lead = await seam.leadOf(event.sessionID);
		if (!lead) return;
		await lead.ready;
		const input = event.input ?? {};
		const call: Call = {
			id: event.id,
			prompt: typeof input.prompt === "string" ? input.prompt : "",
			description: typeof input.description === "string" ? input.description : "",
			agent: typeof input.agent === "string" && input.agent ? input.agent : undefined,
			background: input.background === true,
		};
		// A follow-up stays on its delegate's record and issue: nothing is matched or reserved for it.
		if (typeof input.sessionID === "string" && input.sessionID) call.followUp = input.sessionID;
		// After any todowrite call still running, so the check reads the plan that call leaves.
		else await lead.exclusive(async () => {
			try { await lead.core.delegates.check([{ text: textFor(call) }], call.id); }
			catch (error) {
				// The refusal reaches the model of a plugin whose tool is todowrite, not the omp todo tool.
				throw new Error(speak(error instanceof Error ? error.message : String(error)));
			}
		});
		callsOf(lead.id).push(call);
	});

	seam.context(async (event, { first }) => {
		const session = await seam.sessionOf(event.sessionID);
		if (session?.parentID === undefined) return;
		const lead = await seam.leadOf(event.sessionID);
		if (!lead) return;
		await lead.ready;
		const pending = callsOf(lead.id);
		let record = lead.delegates.get(event.sessionID);
		const follow = pending.find(call => call.followUp === event.sessionID && !call.childID);
		const fresh = !record && first ? pending.find(call => !call.followUp && !call.childID && call.prompt && (event.messages?.[0] ? textOf(event.messages[0]).endsWith(call.prompt) : false)) : undefined;
		const call = follow ?? fresh;
		if (call) {
			call.childID = event.sessionID;
			// A follow-up goes on with its delegate's record and matches nothing again (`untracked`); a follow-up to a session the
			// lead holds no record of is not tracked.
			if (record || fresh) await send(lead, {
				type: "started", id: event.sessionID, sessionId: event.sessionID, leadSessionId: lead.id, leadTeammate: seam.settings.teammate ?? "",
				teammate: teammateFor(event.sessionID, lead.id), text: textFor(call), name: call.description || undefined, agent: call.agent, call: call.id, untracked: !!follow,
			});
			// A background call has returned by now: nothing is left to wait for.
			if (call.background) drop(lead, call);
			record = lead.delegates.get(event.sessionID);
		}
		if (!record) return;
		const delegateCore = lead.delegateCore(event.sessionID);
		// A later prompt retries an assignment that failed; the first one already waited for the binding.
		const { sections } = await delegateCore.core.session.beforePrompt(delegateCore.coreCtx, { context: false, after: call ? undefined : send(lead, { type: "nextUse", id: record.id }) });
		if (sections.assignment) event.system.push({ type: "text", text: sections.assignment });
	});

	// A foreground call ends with its result; a background one is still running (its child's exit event ends it).
	seam.after(async event => {
		if (event.tool !== "subagent") return;
		const session = await seam.sessionOf(event.sessionID);
		if (session?.parentID !== undefined) return;
		const lead = await seam.savedLead(event.sessionID);
		const call = lead && callsOf(lead.id).find(other => other.id === event.id);
		if (!lead || !call) return;
		const running = event.status !== "error" && (event.result?.metadata?.status ?? event.result?.output?.status) === "running";
		if (running && !call.childID) return;
		drop(lead, call);
		if (!call.childID || running) return;
		const record = lead.delegates.get(call.childID);
		if (!record) return;
		if (event.status === "error") {
			const message: string = event.error?.message ?? "the call failed";
			await send(lead, { type: "reported", id: record.id, text: `Failed: ${message}` });
			await send(lead, { type: "exited", id: record.id, outcome: /\bcancelled\b/i.test(message) ? "aborted" : "failed" });
			return;
		}
		const report = reportOf(event.result);
		if (report.trim()) await send(lead, { type: "reported", id: record.id, text: report });
		await send(lead, { type: "exited", id: record.id, outcome: "completed" });
	});

	seam.events(Object.keys(EXECUTION_ENDED), async event => {
		const sessionID: string | undefined = event.data?.sessionID;
		if (!sessionID) return;
		const session = await seam.sessionOf(sessionID);
		if (!session) return;
		if (session.parentID === undefined) {
			// The lead's turn ended. A call still without a child is over: a later hook refused it (neither the tool nor
			// `execute.after` ran), or its background child never reached a context hook. What it reserved is free again, so the
			// item can be delegated anew; a background child that reaches its first context hook only now is not tracked.
			const lead = await seam.savedLead(sessionID);
			if (lead) for (const call of [...callsOf(lead.id)]) if (!call.childID) drop(lead, call);
			return;
		}
		// A child's end, for the background calls: its last assistant text is its report.
		const lead = await seam.savedLead(session.parentID);
		const record = lead?.delegates.get(sessionID);
		if (!lead || !record || record.exited) return;
		const messages: any[] = await seam.ctx.session.context({ sessionID });
		const last = [...messages].reverse().find(message => message?.type === "assistant" && textOf(message).trim());
		if (last) await send(lead, { type: "reported", id: record.id, text: textOf(last) });
		await send(lead, { type: "exited", id: record.id, outcome: EXECUTION_ENDED[event.type] });
	});

	seam.events(SESSION_ENDED, event => { if (event.data?.sessionID) calls.delete(event.data.sessionID); });
}
