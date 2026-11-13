import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { assertIsolated } from "./isolation";
import { isolatedKata, until } from "./kata-fixture";
import { openCodeHost, userMessage, type FakeSession, type OpenCodeInstance } from "./opencode-host";
import opencode from "../plugins/opencode/kata";
import { TRANSCRIPT_ENV } from "../core/kata-cli";
assertIsolated();
const binary = process.env.KATA_TEST_EXECUTABLE!;
if (!binary || !path.isAbsolute(binary)) throw new Error("Set KATA_TEST_EXECUTABLE to the guarded Kata binary.");
const scratch = mkdtempSync(path.join(process.env.KATA_TEST_ROOT!, "opencode-shell-"));
const cwd = path.join(scratch, "workspace");
mkdirSync(cwd);
const home = path.join(scratch, "home");
const env = { ...process.env, KATA_HOME: home, KATA_AUTHOR: "opencode-builder" };
for (const key of ["KATA_SERVER", "KATA_DAEMON", "KATA_AUTH_TOKEN", "KATA_REF", "KATA_TEAMMATE", "KATA_INBOX_USER", ...TRANSCRIPT_ENV]) delete env[key];
const run = isolatedKata(binary, env, cwd);
async function kata(args: string[]): Promise<any> {
	const out = await run(args, cwd);
	if (out.code) throw new Error(out.stderr);
	return JSON.parse(out.stdout);
}
const show = (ref: string) => kata(["show", ref, "--json"]);

const PREAMBLE = "You are a subagent spawned by another session.\n";
let sequence = 0;
const open: OpenCodeInstance[] = [];

const touched = ["KATA_HOME", "KATA_REF", "KATA_TEAMMATE", "KATA_INBOX_USER", "KATA_DEFAULT_PROJECT", ...TRANSCRIPT_ENV];
const previous = new Map(touched.map(key => [key, process.env[key]]));
const restore = (keys: readonly string[]) => {
	for (const key of keys) {
		const value = previous.get(key);
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
};
beforeAll(async () => {
	process.env.KATA_HOME = home;
	const out = await run(["init", "--project", "pi-port-opencode"]);
	if (out.code) throw new Error(out.stderr);
});
beforeEach(() => { for (const key of touched.slice(1)) delete process.env[key]; });
afterEach(() => restore(touched.slice(1)));
afterAll(async () => {
	await Promise.all(open.map(host => host.shutdown()));
	await run(["daemon", "stop"]);
	restore(touched);
});

async function lead() {
	const host = await openCodeHost({ plugin: opencode, directory: cwd, options: { executable: binary, author: "opencode-builder" } });
	open.push(host);
	return { host, id: host.createSession({ id: `oc-sh-${++sequence}-${Date.now().toString(36)}` }).id };
}
const todos = (...items: [string, string][]) => ({ todos: items.map(([content, status]) => ({ content, status })) });
const qref = (issue: any): string => issue.qualified_id ?? `pi-port-opencode#${issue.short_id}`;
const refIn = (system: string) => /Your Kata issue is (\S+?);/.exec(system)?.[1] ?? "";
const teammateIn = (system: string) => /your teammate is ([a-z0-9._-]+?)\. Keep/.exec(system)?.[1] ?? "";
async function closeEvents(): Promise<any[]> {
	const events: any[] = [];
	for (let after = 0; ;) {
		const page = await kata(["events", "--after", String(after), "--limit", "500", "--json"]);
		if (!page.events.length) return events.filter(e => e.type === "issue.closed");
		events.push(...page.events);
		after = page.next_after_id;
	}
}
// A foreground delegate bound to a plan item; `work` gets its session and the assignment section of its prompt.
async function delegate(host: OpenCodeInstance, leadID: string, prompt: string, work: (child: FakeSession, system: string) => Promise<void>) {
	await host.callTool(leadID, "subagent", { agent: "general", description: "Work item", prompt }, {
		execute: async given => {
			const child = host.createSession({ parentID: leadID, messages: [userMessage(PREAMBLE + given.prompt)] });
			await work(child, (await host.context(child.id)).system.join("\n"));
			host.addAssistantText(child.id, "Done.");
			return { output: { sessionID: child.id, status: "completed", output: "Done." }, content: "Done.", metadata: { sessionID: child.id, status: "completed" } };
		},
	});
}
const shell = (host: OpenCodeInstance, id: string, command: string) => host.callTool(id, "shell", { command }, { execute: () => "ok" });
// The rewritten command as the shell would run it, against the isolated store.
const runCommand = (command: string) => (async () => {
	const proc = Bun.spawn(["bash", "-c", command], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	return { code: await proc.exited, stdout, stderr };
})();
const closeCommand = (ref: string) => `kata close ${ref} --done --message "Implemented the item and verified it in the shell suite." --test "bun test opencode shell"`;

test("a delegate's kata close runs under its teammate with its own transcript pair", async () => {
	const { host, id } = await lead();
	await host.callTool(id, "todowrite", todos(["Implement shell routing", "in_progress"]));
	let ref = "", teammate = "", childID = "", ran: any;
	await delegate(host, id, "Please implement shell routing.", async (child, system) => {
		ref = refIn(system); teammate = teammateIn(system); childID = child.id;
		ran = await shell(host, child.id, closeCommand(ref));
		expect(ran.status, ran.text).toBe("completed");
		const out = await runCommand(ran.input.command);
		expect(out.code, out.stderr).toBe(0);
	});
	expect(ran.input.command).toContain(`--teammate '${teammate}'`);
	expect(ran.input.command).toContain(`KATA_TRANSCRIPT_SESSION_ID='${childID}'`);
	expect(ran.input.command).toContain(`'${binary}'`);
	const issue = (await kata(["show", ref, "--json"])).issue;
	expect(issue.status).toBe("closed");
	const close = (await closeEvents()).find(e => e.issue_uid === issue.uid);
	expect(close.payload.transcript).toMatchObject({ agent: "opencode", session_id: childID });
	const comments = (await kata(["show", ref, "--json"])).comments ?? [];
	expect(comments.map((comment: any) => comment.teammate)).toContain(teammate);
});

test("--as is refused for a delegate and the command does not run", async () => {
	const { host, id } = await lead();
	await host.callTool(id, "todowrite", todos(["Implement shell guard", "in_progress"]));
	await delegate(host, id, "Please implement shell guard.", async (child, system) => {
		const result = await shell(host, child.id, `kata comment ${refIn(system)} --as someone-else --body "hi"`);
		expect(result.status).toBe("error");
		expect(result.text).toContain("--as is not permitted");
		expect(result.executed).toBe(false);
	});
});

test("a lead's command is unchanged apart from the executable and the close transcript pair", async () => {
	const { host, id } = await lead();
	await host.callTool(id, "todowrite", todos(["Lead item", "pending"]));
	const pair = `env KATA_TRANSCRIPT_AGENT=opencode KATA_TRANSCRIPT_SESSION_ID='${id}' KATA_CLOSE_TRANSCRIPT_ENABLED=true `;
	let result = await shell(host, id, "kata close x#1 --done --as someone");
	expect(result.input.command).toBe(`${pair}'${binary}' close x#1 --done --as someone`);
	result = await shell(host, id, "kata list --agent && kata show x#1");
	expect(result.input.command).toBe(`'${binary}' list --agent && '${binary}' show x#1`);
	result = await shell(host, id, `'${binary}' close x#1`);
	expect(result.input.command).toBe(`${pair}'${binary}' close x#1`);
});

test("commands that are not Kata are untouched", async () => {
	const { host, id } = await lead();
	await host.callTool(id, "todowrite", todos(["Another item", "in_progress"]));
	const commands = ["ls -la", "echo kata close", "git commit -m 'kata close'", "cat <<EOF\nkata close x\nEOF"];
	for (const command of commands) expect((await shell(host, id, command)).input.command).toBe(command);
	await delegate(host, id, "Please do another item.", async child => {
		for (const command of commands) expect((await shell(host, child.id, command)).input.command).toBe(command);
	});
});
