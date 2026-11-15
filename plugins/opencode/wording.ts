import { RULES } from "./kata-core";
import type { ToolWording } from "./model";

// The words of the `todowrite` tool, which takes the whole list and no ops: how the core's messages name and advise it, and
// the tool's own description.

export const WORDING: ToolWording = {
	tool: "todowrite",
	refresh: "Send the list with todowrite to refresh.",
	plan: "Send the list with todowrite.",
	planFirst: "Send the list with todowrite first.",
	// A new item cannot be cancelled, so an item to drop comes back first.
	leftOut: "Send the list again with these items in it; to drop one, cancel it with a reason in a later call.",
	retryTakeover: "send the list again with takeover: true",
	takeOverFirst: "send the list with takeover: true",
	// todowrite takes `ref` only on a session's first call, so the way out of a shared ticket is a fresh session.
	planUnder: ticket => `start a session whose first todowrite passes ref ${ticket}`,
};

export const DESCRIPTION = `${RULES.summary} Send the WHOLE list on every call: todos [{content, status}] with status pending, in_progress, completed or cancelled. Items are identified by exact content: keep the wording of an item stable between calls. Create the list before work for 3+ steps or several user requests, one item per request; mark an item in_progress when you start it and completed right after it is verified. Nothing starts on its own, and several items may be in progress.
Every call is compared with the Kata plan. A call that disagrees with it is refused and changes nothing; the error carries the current list: send it again with your changes on top.
- completed needs \`message\` (40+ characters: what changed and how it was verified) and \`evidence\` (an array: ${RULES.evidence}). Unverified work: do not complete it; pause it instead.
- cancelled needs \`reason\`. A new item cannot be cancelled: leave it out.
- To pause an item (waiting on the user, an agent or a service), keep it in_progress and set \`blocker\` to the reason; remove the blocker to resume. A started item cannot go back to pending.
- An open item missing from your list is refused: keep it, or cancel it with a reason. Items added to the plan outside this session (by the user or a teammate) are requested work: send them back unchanged.
- An item Kata has closed (a delegate closed its own issue, or the user did) stays completed or cancelled: resend it with that status and no message, evidence or reason.
- ${RULES.ticketItem}. It creates no issue: starting it claims the ticket, completing it comments on it, and the last completed item of a ticket closes it with that item's evidence. ${RULES.ticketError}
- Every other item becomes a child issue of one parent issue. On the first call pass \`ref\` with the Kata issue this plan serves (${RULES.search}); without it the session gets its own parent issue.
- The tool does the Kata bookkeeping for its items (claims, attention, closes). ${RULES.bookkeeping("an item")}
- A \`subagent\` call is bound to an item ${RULES.named("prompt", "content")} A prompt that names neither ${RULES.untracked}, and you complete the item yourself. A bound delegate closes ${RULES.ownClose("prompt")}; the item then shows completed.
- An item another session started stays that session's until it ends: a call that changes it is refused. ${RULES.takeover("send the list again")}
- Contents are kept as written (spaces and newlines included); send them back exactly as the list shows them. When the plan has the same content twice (in two phases), the list shows it once and a change to it applies to every open copy. The exception is copies that name the same ticket: todowrite cannot change them, so ask the user to remove the duplicate item. If the copies were closed both ways (some completed, some cancelled), the item may be sent as either.`;
