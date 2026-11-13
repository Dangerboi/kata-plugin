import type { DelegateEvent, DelegateOutcome, Reservation } from "./delegates";
import { teammateFor } from "./delegates";
import type { Lead } from "./lead";
import type { Seam } from "./seam";

// A `subagent` call a lead made: matched against the plan before it runs, then against the child session it creates.
interface Call {
	id: string;
	prompt: string;
	description: string;
	background: boolean;
	// What the plan check matched the prompt to; held against other calls of this lead until the child is bound.
	reserved?: Reservation;
	// A follow-up: the delegate record (the child's session id) it wakes.
	followUp?: string;
	// Set once the child's first context hook bound it.
	childID?: string;
}

const ENDED: Record<string, DelegateOutcome> = {
	"session.execution.succeeded": "completed",
	"session.execution.failed": "failed",
	"session.execution.interrupted": "aborted",
};

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
	const drop = (leadID: string, call: Call) => {
		const list = calls.get(leadID);
		const index = list?.indexOf(call) ?? -1;
		if (index >= 0) list!.splice(index, 1);
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
			background: input.background === true,
		};
		// One call at a time: the refs another pending call reserved are read and this one's are added in the same step.
		await lead.exclusive(async () => {
			const list = callsOf(lead.id);
			if (typeof input.sessionID === "string" && input.sessionID) {
				// A follow-up stays on its delegate's record and issue; nothing is matched or reserved, and one with no record is untracked.
				call.followUp = input.sessionID;
			} else {
				const held = list.flatMap(other => other.reserved?.ref ? [other.reserved.ref] : []);
				[call.reserved] = await lead.core.delegates.check([{ text: call.prompt, label: call.description }], held);
			}
			list.push(call);
		});
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
			// A background call has returned by now: nothing is left to wait for.
			if (call.background) drop(lead.id, call);
			if (follow) await send(lead, { type: "woken", id: event.sessionID, sessionId: event.sessionID });
			else await send(lead, {
				type: "started", id: event.sessionID, sessionId: event.sessionID, leadSessionId: lead.id, leadTeammate: seam.settings.teammate ?? "",
				teammate: teammateFor(event.sessionID, lead.id), text: call.prompt, label: call.description, name: call.description || undefined, single: true, reserved: call.reserved,
			});
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
		drop(lead.id, call);
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

	// A child's end, for the background calls: its last assistant text is its report.
	seam.events(Object.keys(ENDED), async event => {
		const childID: string | undefined = event.data?.sessionID;
		if (!childID) return;
		const session = await seam.sessionOf(childID);
		if (session?.parentID === undefined) return;
		const lead = await seam.savedLead(session.parentID);
		const record = lead?.delegates.get(childID);
		if (!lead || !record || record.exited) return;
		const messages: any[] = await seam.ctx.session.context({ sessionID: childID });
		const last = [...messages].reverse().find(message => message?.type === "assistant" && textOf(message).trim());
		if (last) await send(lead, { type: "reported", id: record.id, text: textOf(last) });
		await send(lead, { type: "exited", id: record.id, outcome: ENDED[event.type] });
	});

	// A deleted or archived lead's pending calls are gone with it.
	seam.events(["session.deleted", "session.archived"], event => { if (event.data?.sessionID) calls.delete(event.data.sessionID); });
}
