import type { Hook } from "claude-code";
import type { InboxStream, LiveInbox } from "../core/inbox";
import type { Engine } from "./engine";

// Live inbox delivery: the main session follows `kata events --tail` and each request addressed to it reaches the model
// without waiting for a prompt. The core decides what is a request (own actor only, a clear delivers nothing, once per
// request) and frames the text as untrusted data; this module is the host's two halves, the stream child and the delivery.

// Whether the main loop is working. `turn.start` and `turn.complete` are the only signal there is: Claude Code has no
// event for "the session went idle". A subagent's turns never count.
let busy = false;

export const onTurnStart: Hook<"turn.start"> = async ($, e, next) => {
	if (e.agentId === undefined) busy = true;
	return next(e);
};

// Called first by the turn-complete hook in prompt.ts, ahead of the settle: a request that arrives while it runs starts a
// turn instead of waiting. One `turn.complete` hook serves both (the engine refuses a second one without a matcher).
export function turnEnded(e: { agentId?: string }) {
	if (e.agentId === undefined) busy = false;
}

export const resetInbox = () => {
	busy = false;
};

// `kata events --tail --json` as a child of the host: no shell. The child lives while the loop below reads it; `kill` ends
// the loop, which ends the child. Pieces are text as it came, so a line can span two of them. stderr is dropped.
// The stream is the child's only handle: `$.process.spawn` documents `return()` on it as the kill, with a pull pending (the
// loop always has one), and `next.signal` or the module unloading as the other ends. The mod has no process id to signal.
function spawnEvents($: Engine, executable: string, cwd: string, cursor: number | undefined): InboxStream {
	const stream = $.process.spawn({
		argv: [executable, "events", "--tail", "--json", "--workspace", cwd, ...(cursor ? ["--last-event-id", String(cursor)] : [])],
		cwd
	});
	const pieces = stream[Symbol.asyncIterator]();
	let ended!: () => void;
	const exited = new Promise<void>(resolve => {
		ended = resolve;
	});
	async function* lines(): AsyncGenerator<string> {
		let pending = "";
		try {
			for (;;) {
				const step = await pieces.next();
				if (step.done) return;
				const piece = step.value;
				if (piece.stream !== "stdout") continue;
				const parts = (pending + piece.text).split("\n");
				pending = parts.pop() ?? "";
				for (const line of parts) if (line.trim()) yield line;
			}
		} finally {
			ended();
		}
	}
	return {
		lines: lines(),
		exited,
		kill: () => {
			void pieces.return?.(undefined as never).catch(() => undefined);
			ended();
		}
	};
}

// An idle session starts a turn on the request; a working one takes it with its next request, in the same turn. A refusal
// (the person pressed Stop and has not typed since) is thrown so the core's debug log names it.
async function deliverTo($: Engine, text: string): Promise<void> {
	if (busy) {
		const done = await $.session.append({ message: { type: "user", content: [{ type: "text", text }] } });
		if (done.deny) throw new Error(`inbox request not appended: ${done.deny}`);
		return;
	}
	const sent = await $.prompt.submit({ text });
	if ("drop" in sent && sent.drop) throw new Error(`inbox request not submitted: ${sent.drop}`);
}

// What the core takes as `host.liveInbox`.
export function liveInboxOf($: Engine, executable: string): LiveInbox {
	return { spawn: (cwd, cursor) => spawnEvents($, executable, cwd, cursor), deliver: text => deliverTo($, text) };
}
