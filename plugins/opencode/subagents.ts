import { Refusal, type DelegateOutcome } from "./delegates";
import { lastText, textOf } from "./model";
import type { Lead } from "./lead";
import { CallRefused, EXECUTION_ENDED, SESSION_ENDED, type Seam } from "./seam";

// What OpenCode puts in front of a `subagent` call's prompt to make the child's first message.
export const SUBAGENT_PREFIX = "You are a subagent spawned by another session.\n";

// One run of a delegate's child session, from the context hook that bound its call until its exit.
interface Run {
	childID: string;
	startedAt: number;
	over: boolean;
}
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
	// The lead's turn ended with the call still without a child: what it reserved is free, and it binds a late child, losing a tie to a newer call.
	late?: boolean;
	// The run it started, once the child's first context hook bound it.
	run?: Run;
}
// Everything the lead gave the spawn, as the core reads it for what it names.
const textFor = (call: Call) => [call.prompt, call.description].filter(Boolean).join("\n");

// The call a child's first message comes from: the one whose prompt is the whole message after OpenCode's preamble, else the
// one with the longest prompt the message ends with (one prompt can be the end of another).
function callFor(calls: Call[], message: any): Call | undefined {
	// A user message keeps its text in `text`, an assistant message in content parts.
	const text = textOf(message?.text ?? message?.content);
	const matching = calls.filter(call => !call.followUp && call.prompt && text.endsWith(call.prompt));
	// A late call is the older one: it loses only a tie.
	const byLateness = (a: Call, b: Call) => Number(!!a.late) - Number(!!b.late);
	const exact = matching.filter(call => text === SUBAGENT_PREFIX + call.prompt).sort(byLateness)[0];
	return exact ?? matching.sort((a, b) => b.prompt.length - a.prompt.length || byLateness(a, b))[0];
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
	const drop = (lead: Lead, call: Call) => {
		const list = calls.get(lead.id);
		const index = list?.indexOf(call) ?? -1;
		if (index >= 0) list!.splice(index, 1);
		lead.releaseSpawn(call.id);
	};
	const runs = new Map<string, Run>();
	// A run ends once, with its report: by its foreground call's result or by the child's own end, whichever comes first.
	async function exit(lead: Lead, run: Run, outcome: DelegateOutcome, report?: string) {
		if (run.over) return;
		run.over = true;
		if (runs.get(run.childID) === run) runs.delete(run.childID);
		if (report?.trim()) await lead.delegateEvent({ type: "reported", id: run.childID, text: report });
		await lead.delegateEvent({ type: "exited", id: run.childID, outcome });
	}

	seam.before(async event => {
		const role = await seam.roleOf(event.sessionID);
		if (role.kind === "delegate") {
			// A delegate's tool call: it did something, so its assignment is no longer rolled back at exit.
			if (role.record && !role.record.ranTool) await role.lead.delegateEvent({ type: "ranTool", id: role.record.id });
			return;
		}
		if (role.kind !== "lead" || event.tool !== "subagent") return;
		const { lead } = role;
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
		else {
			try { await lead.checkSpawn(call.id, textFor(call)); }
			catch (error) {
				if (error instanceof Refusal) throw new CallRefused(error.message);
				// A spawn Kata could not be asked about runs unreserved: its child decides from the call's text when it starts.
				seam.debug(error);
			}
		}
		callsOf(lead.id).push(call);
	});

	seam.context(async (event, { first }) => {
		const role = await seam.roleOf(event.sessionID);
		if (role.kind !== "delegate") return;
		const { lead } = role;
		await lead.ready;
		const pending = callsOf(lead.id).filter(call => !call.run);
		// A child with no record yet is bound from the call that spawned it, also when a follow-up to it was sent first.
		const call = (!role.record && first ? callFor(pending, event.messages?.[0]) : undefined) ?? pending.find(other => other.followUp === event.sessionID);
		// A follow-up goes on with its delegate's record and matches nothing again (`untracked`); a follow-up to a session the
		// lead holds no record of is not tracked.
		const begins = !!call && (!!role.record || !call.followUp);
		if (call && begins) {
			runs.set(event.sessionID, call.run = { childID: event.sessionID, startedAt: Date.now(), over: false });
			await lead.began(event.sessionID, { text: textFor(call), name: call.description || undefined, agent: call.agent, call: call.id, untracked: !!call.followUp });
		}
		// A background call has returned by now: nothing is left to wait for.
		if (call?.background) drop(lead, call);
		if (!role.record && !begins) return;
		// A later prompt retries an assignment that failed; the first one already waited for the binding.
		const text = await lead.assignmentSection(event.sessionID, call ? undefined : lead.delegateEvent({ type: "nextUse", id: event.sessionID }));
		if (text) event.system.push({ type: "text", text });
	});

	// A foreground call ends with its result; a background one is still running (its child's end event ends it).
	seam.after(async event => {
		if (event.tool !== "subagent") return;
		const role = await seam.roleOf(event.sessionID);
		const call = role.kind === "lead" ? callsOf(role.lead.id).find(other => other.id === event.id) : undefined;
		if (role.kind !== "lead" || !call) return;
		const running = event.status !== "error" && (event.result?.metadata?.status ?? event.result?.output?.status) === "running";
		// OpenCode 2.4.2 has no `background` input: a result that is still running says the call is a background one.
		if (running) call.background = true;
		if (running && !call.run) return;
		drop(role.lead, call);
		if (!call.run || running) return;
		if (event.status === "error") {
			const message: string = event.error?.message ?? "the call failed";
			await exit(role.lead, call.run, /\bcancelled\b/i.test(message) ? "aborted" : "failed", `Failed: ${message}`);
		} else await exit(role.lead, call.run, "completed", reportOf(event.result));
	});

	seam.events(Object.keys(EXECUTION_ENDED), async (event, role) => {
		const sessionID = event.data.sessionID;
		if (role.kind === "lead") {
			// The lead's turn ended. A call still without a child either was refused by a later hook (neither the tool nor
			// `execute.after` ran) or has a background child that has not reached a context hook yet (every call on OpenCode 2.4.2).
			// What it reserved is free again. A call that `execute.after` reported running stays matchable until the lead's session ends, any other is dropped: a child that starts now
			// binds from it, and the core resolves its text again.
			for (const call of [...callsOf(role.lead.id)]) {
				if (call.run) continue;
				if (call.background) { call.late = true; role.lead.releaseSpawn(call.id); }
				else drop(role.lead, call);
			}
			return;
		}
		// A child's end ends the run it is in. With no run, a call's result ended it already; and an event OpenCode made
		// before the run began is the end of an earlier run, handled late.
		const run = runs.get(sessionID);
		if (role.kind !== "delegate" || !run || (typeof event.created === "number" && event.created < run.startedAt)) return;
		// Its last assistant text is its report. A session that is gone by now has none to read, and still exits.
		let report: string | undefined;
		try {
			const messages: any[] = await seam.ctx.session.context({ sessionID });
			report = lastText(messages.filter(message => message?.type === "assistant").map(message => message.content));
		} catch (error) { seam.debug(error); }
		await exit(role.lead, run, EXECUTION_ENDED[event.type], report);
	});

	seam.events(SESSION_ENDED, async (event, role) => {
		const sessionID = event.data.sessionID;
		// The lead's calls end with it: what they reserved is free again, for a lead that stays in memory (see Lead.end) and is unarchived.
		if (role.kind === "lead") for (const call of [...callsOf(sessionID)]) drop(role.lead, call);
		calls.delete(sessionID);
		// A delegate's own session ended under it: nothing more runs there.
		const run = runs.get(sessionID);
		if (role.kind === "delegate" && run) await exit(role.lead, run, "aborted");
	});
}
