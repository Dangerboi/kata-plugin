import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { userMessage, type FakeSession, type OpenCodeInstance } from "./opencode-host";
import { assignmentOf } from "./kata-fixture";
import { openCodeKata, qref, todos } from "./opencode-fixture";
import { SUBAGENT_PREFIX } from "../plugins/opencode/subagents";
import { teammateFor } from "../core/delegates";
import { argvProbe } from "./argv-probe";

const { binary, cwd, kata, sh, closeEvents, startHost, startLead, parentOf } = openCodeKata("opencode-shell");

// A foreground delegate bound to a plan item. `work` gets its session and its prompt's system text; what it throws fails
// the test, because the host turns an error thrown inside a tool's execute into an error result the caller never sees.
async function delegate(host: OpenCodeInstance, leadID: string, prompt: string, work: (child: FakeSession, system: string) => Promise<void>) {
	const failures: unknown[] = [];
	const result = await host.callTool(leadID, "subagent", { agent: "general", description: "Work item", prompt }, {
		execute: async given => {
			const child = host.createSession({ parentID: leadID, messages: [userMessage(SUBAGENT_PREFIX + given.prompt)] });
			try { await work(child, (await host.context(child.id)).system.join("\n")); }
			catch (error) { failures.push(error); throw error; }
			host.addAssistantText(child.id, "Done.");
			return { output: { sessionID: child.id, status: "completed", output: "Done." }, content: "Done.", metadata: { sessionID: child.id, status: "completed" } };
		},
	});
	if (failures.length) throw failures[0];
	expect(result.status, result.text).toBe("completed");
}
const shell = (host: OpenCodeInstance, id: string, command: string) => host.callTool(id, "shell", { command }, { execute: () => "ok" });
const closeCommand = (ref: string) => `kata close ${ref} --done --message "Implemented the item and verified it in the shell suite." --test "bun test opencode shell"`;

test("a delegate's kata close runs under its teammate with its own transcript pair", async () => {
	const { host, id } = await startLead({ executable: binary });
	await host.callTool(id, "todowrite", todos(["Implement shell routing", "in_progress"]));
	let ref = "", teammate = "", childID = "", ran: any, out: { code: number; stderr: string } | undefined;
	await delegate(host, id, "Please implement shell routing.", async (child, system) => {
		({ ref, teammate } = assignmentOf(system));
		childID = child.id;
		ran = await shell(host, child.id, closeCommand(ref));
		out = await sh(ran.input.command);
	});
	expect(ran.status, ran.text).toBe("completed");
	expect(out!.code, out!.stderr).toBe(0);
	expect(ran.input.command).toContain(`--teammate '${teammate}'`);
	expect(ran.input.command).toContain(`KATA_TRANSCRIPT_SESSION_ID='${childID}'`);
	expect(ran.input.command).toContain(" kata --teammate ");
	expect(ran.input.command).not.toContain(binary);
	const view = await kata(["show", ref, "--json"]);
	expect(view.issue.status).toBe("closed");
	const close = (await closeEvents()).find(e => e.issue_uid === view.issue.uid);
	expect(close.payload.transcript).toMatchObject({ agent: "opencode", session_id: childID });
	expect((view.comments ?? []).map((comment: any) => comment.teammate)).toContain(teammate);
});

test("--as is refused for a delegate and the command does not run", async () => {
	const { host, id } = await startLead({ executable: binary });
	await host.callTool(id, "todowrite", todos(["Implement shell guard", "in_progress"]));
	let refused: any;
	await delegate(host, id, "Please implement shell guard.", async (child, system) => {
		refused = await shell(host, child.id, `kata comment ${assignmentOf(system).ref} --as someone-else --body "hi"`);
	});
	expect(refused.status).toBe("error");
	expect(refused.text).toContain("--as is not permitted");
	expect(refused.executed).toBe(false);
});

test("a child session the lead does not track runs Kata under a teammate derived from its session, and --as is refused", async () => {
	const { host, id } = await startLead({ executable: binary });
	await host.callTool(id, "todowrite", todos(["Lead item", "pending"]));
	// No `subagent` call of the lead made these sessions: a delegate's own subagent, or a child from before a restart.
	const child = host.createSession({ parentID: id }), grandchild = host.createSession({ parentID: child.id });
	for (const session of [child, grandchild]) {
		const teammate = teammateFor(session.id, id);
		const listed = await shell(host, session.id, "kata list --agent");
		expect(listed.input.command).toBe(`/usr/bin/env KATA_AUTHOR='opencode-builder' kata --teammate '${teammate}' list --agent`);
		const closed = await shell(host, session.id, "kata close x#1 --done");
		expect(closed.input.command).toContain(`KATA_TRANSCRIPT_SESSION_ID='${session.id}'`);
		expect(closed.input.command).toContain(`kata --teammate '${teammate}' close x#1 --done`);
		const refused = await shell(host, session.id, 'kata comment x#1 --as someone-else --body "hi"');
		expect(refused.status).toBe("error");
		expect(refused.text).toContain("--as is not permitted");
		expect(refused.executed).toBe(false);
	}
});

test("a lead's command is unchanged apart from the author and the close transcript pair", async () => {
	const { host, id } = await startLead({ executable: binary });
	await host.callTool(id, "todowrite", todos(["Lead item", "pending"]));
	const author = "KATA_AUTHOR='opencode-builder'";
	const pair = `/usr/bin/env KATA_TRANSCRIPT_AGENT='opencode' KATA_TRANSCRIPT_SESSION_ID='${id}' KATA_CLOSE_TRANSCRIPT_ENABLED='true' ${author} `;
	let result = await shell(host, id, "kata close x#1 --done --as someone");
	expect(result.input.command).toBe(`${pair}kata close x#1 --done --as someone`);
	result = await shell(host, id, "kata list --agent && kata show x#1");
	expect(result.input.command).toBe(`/usr/bin/env ${author} kata list --agent && /usr/bin/env ${author} kata show x#1`);
	result = await shell(host, id, `'${binary}' close x#1`);
	expect(result.input.command).toBe(`${pair}'${binary}' close x#1`);
});

test("a lead close runs when its cleared PATH contains only Kata", async () => {
	const dir = mkdtempSync(join(tmpdir(), "opencode-kata-stub-"));
	try {
		writeFileSync(join(dir, "kata"), '#!/bin/sh\nprintf "%s/%s/%s\\n" "$KATA_TRANSCRIPT_AGENT" "$KATA_TRANSCRIPT_SESSION_ID" "$KATA_CLOSE_TRANSCRIPT_ENABLED"\n', { mode: 0o755 });
		const { host, id } = await startLead({ executable: binary });
		const result = await shell(host, id, `env -i PATH='${dir}' kata close x#1`);
		const out = await sh(result.input.command);
		expect(out.code, out.stderr).toBe(0);
		expect(out.stdout.trim()).toBe(`opencode/${id}/true`);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test.skipIf(!Bun.which("cc"))("a lead close behind exec -a keeps the target argv0 and transcript", async () => {
	const dir = mkdtempSync(join(tmpdir(), "opencode-kata-argv0-"));
	try {
		const stub = argvProbe(dir, ["KATA_TRANSCRIPT_AGENT", "KATA_TRANSCRIPT_SESSION_ID"]);
		const { host, id } = await startLead({ executable: binary });
		const result = await shell(host, id, `exec -a named '${stub}' close x#1`);
		const out = await sh(result.input.command);
		expect(out.code, out.stderr).toBe(0);
		expect(out.stdout.trim()).toBe(`named/opencode/${id}`);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("commands that are not Kata are untouched", async () => {
	const { host, id } = await startLead({ executable: binary });
	await host.callTool(id, "todowrite", todos(["Another item", "in_progress"]));
	const commands = ["ls -la", "echo kata close", "git commit -m 'kata close'", "cat <<EOF\nkata close x\nEOF"];
	for (const command of commands) expect((await shell(host, id, command)).input.command).toBe(command);
	await delegate(host, id, "Please do another item.", async child => {
		for (const command of commands) expect((await shell(host, child.id, command)).input.command).toBe(command);
	});
});

// The server's own environment holds neither setting: only the plugin options name the actor.
test("shell kata commands carry the configured author and teammate when the server environment has none", async () => {
	delete process.env.KATA_AUTHOR;
	const host = await startHost({ executable: binary, author: "configured-author", teammate: "configured-mate" });
	const id = host.createSession().id;
	await host.callTool(id, "todowrite", todos(["Configured actor item", "in_progress"]));

	const listed = await shell(host, id, "kata list --agent");
	expect(listed.input.command).toContain("KATA_AUTHOR='configured-author'");
	expect(listed.input.command).toContain("KATA_TEAMMATE='configured-mate'");

	let ref = "", childID = "", ran: any, out: { code: number; stderr: string } | undefined;
	await delegate(host, id, "Please finish the Configured actor item.", async (child, system) => {
		ref = assignmentOf(system).ref;
		childID = child.id;
		ran = await shell(host, child.id, closeCommand(ref));
		out = await sh(ran.input.command, ["KATA_AUTHOR", "KATA_TEAMMATE"]);
	});
	expect(ran.input.command).toContain("KATA_AUTHOR='configured-author'");
	expect(out!.code, out!.stderr).toBe(0);
	const issue = (await kata(["show", ref, "--json"])).issue;
	expect(issue.status).toBe("closed");
	const close = (await closeEvents()).find(e => e.issue_uid === issue.uid);
	expect(close.actor).toBe("configured-author");
	expect(close.payload.transcript).toMatchObject({ agent: "opencode", session_id: childID });
});

test("the refGuard option accepts a JSON boolean false", async () => {
	const { host, id } = await startLead({ refGuard: false });
	await host.callTool(id, "todowrite", todos(["Guarded plan item", "in_progress"]));
	const ref = qref(await parentOf(id));
	const result = await host.callTool(id, "write", { path: `${cwd}/notes.ts`, content: `// ${ref}` }, { execute: () => "ok" });
	expect(result.status, result.text).toBe("completed");
});

test("a write, patch or commit that names a ref of the plan is refused until the refGuard option is off", async () => {
	const call = (host: OpenCodeInstance, id: string, tool: string, input: Record<string, unknown>) => host.callTool(id, tool, input, { execute: () => "ok" });
	for (const off of [false, true]) {
		const { host, id } = await startLead(off ? { refGuard: "off" } : {});
		await host.callTool(id, "todowrite", todos(["Guarded plan item", "in_progress"]));
		const ref = qref(await parentOf(id));
		const file = `${cwd}/notes.ts`;
		const attempts = [
			call(host, id, "write", { path: file, content: `// tracked as ${ref}` }),
			call(host, id, "edit", { path: file, oldString: "x", newString: `// ${ref}` }),
			call(host, id, "patch", { patchText: `*** Begin Patch\n*** Update File: ${file}\n+// ${ref}\n*** End Patch` }),
			call(host, id, "shell", { command: `git commit -m "fix ${ref}"` }),
		];
		for (const result of await Promise.all(attempts)) {
			if (off) { expect(result.status, result.text).toBe("completed"); continue; }
			expect(result.status).toBe("error");
			expect(result.executed).toBe(false);
			expect(result.text).toContain(ref);
			expect(result.text).toContain("KATA_REF_GUARD=off");
		}
		for (const [tool, input] of [["write", { path: file, content: "// README.md#tasks" }], ["write", { path: "/tmp/outside-notes.ts", content: ref }], ["shell", { command: `kata comment ${ref} -m "note ${ref}"` }]] as const) {
			const result = await call(host, id, tool, { ...input });
			expect(result.status, result.text).toBe("completed");
		}
	}
});
