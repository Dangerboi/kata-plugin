import { afterEach, beforeEach, expect } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { siblingThrottle } from "./kata-errors";
import { EVIDENCE, MESSAGE, realKata, unique } from "./kata-fixture";
import { openCodeHost, type FakeSession, type OpenCodePlugin, type OpenCodeInstance } from "./opencode-host";
import opencode from "../plugins/opencode/kata";
import { eventsHandled } from "../plugins/opencode/seam";

export const PROJECT = "pi-port-opencode";
const AUTHOR = "opencode-builder";

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
/** The end of the storage keys a session's saved parts live under, named once for `savedOf` and for tests that gate a read of one. */
export const SAVED = { entries: "/entries", ended: "/ended" };

export const todos = (...items: ([string, string] | Record<string, unknown>)[]) => ({
	todos: items.map(item => (Array.isArray(item) ? { content: item[0], status: item[1] } : item)),
});
export const write = (host: OpenCodeInstance, id: string, input: unknown) => host.callTool(id, "todowrite", input);
export const qref = (issue: any): string => issue.qualified_id ?? `${PROJECT}#${issue.short_id}`;
export const statusOf = (child: any) => (child.status === "closed" ? `closed:${child.closed_reason}` : child.metadata?.["todo.status"]);
/** The list a refused todowrite ends with, to send back. */
export const currentList = (text: string) => JSON.parse(text.slice(text.lastIndexOf('{"todos"'))).todos;

/**
 * What the delegate's prompt holds for it: its issue, its teammate and the close command it is told to run, with the two
 * placeholders (the message and the evidence) still to fill. `close` is undefined when the prompt has no such command.
 */
export function assignmentOf(system: string) {
	const ref = /Your Kata issue is (\S+?);/.exec(system)?.[1] ?? "";
	const teammate = /your teammate is ([a-z0-9._-]+?)\. Keep/.exec(system)?.[1] ?? "";
	const close = /YOU must then run: (.+?) --message '<[^']*>' --evidence '<[^']*>'/.exec(system)?.[1];
	return { ref, teammate, close };
}

/**
 * A real Kata for OpenCode adapter tests (`realKata`, adopted, one project) and the pieces they share. The adapter's
 * executable is a wrapper that records every call, and the files below switch its behaviour (all removed before each test):
 * `throttleCloses` makes `kata close` fail with the sibling throttle, as Kata does after a burst of closes; `holdCalls`
 * makes the calls of one verb (or all) wait until `releaseCalls`. Everything else goes to the real binary. Hosts a test
 * starts are shut down after it.
 */
export function openCodeKata(prefix: string) {
	const store = realKata({ prefix, author: AUTHOR, project: PROJECT, adopt: true });
	const { binary, scratch, cwd, env, show } = store;

	const wrapper = path.join(scratch, "kata-wrapper.sh");
	const calls = path.join(scratch, "calls.log"), throttle = path.join(scratch, "throttle"), hold = path.join(scratch, "hold");
	writeFileSync(wrapper, `#!/bin/sh
echo "$@" >> "${calls}"
while [ -e "${hold}" ] && { [ "$(cat "${hold}")" = "*" ] || [ "$(cat "${hold}")" = "$1" ]; }; do sleep 0.05; done
if [ "$1" = close ] && [ -e "${throttle}" ]; then
	printf '%s\\n' '${siblingThrottle().stderr.trim()}' >&2
	exit 1
fi
exec "${binary}" "$@"
`);
	chmodSync(wrapper, 0o755);
	const kataCalls = () => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean) : []);
	const forgetCalls = () => rmSync(calls, { force: true });
	const throttleCloses = (on = true) => (on ? writeFileSync(throttle, "") : rmSync(throttle, { force: true }));
	const holdCalls = (verb = "*") => writeFileSync(hold, verb);
	const releaseCalls = () => rmSync(hold, { force: true });

	const hosts: OpenCodeInstance[] = [];
	beforeEach(() => { forgetCalls(); throttleCloses(false); releaseCalls(); });
	afterEach(async () => {
		// A shutdown waits for what a held call blocks.
		releaseCalls();
		await Promise.all(hosts.splice(0).map(host => host.shutdown()));
	});

	/** A fresh host with the plugin set up; `options` are the plugin's options (the executable defaults to the wrapper). */
	async function startHost({ executable = wrapper, plugin = opencode, ...options }: { executable?: string; plugin?: OpenCodePlugin; [option: string]: unknown } = {}) {
		const host = await openCodeHost({ plugin, directory: cwd, options: { executable, author: AUTHOR, ...options }, eventsHandled });
		hosts.push(host);
		return host;
	}
	const newSession = (host: OpenCodeInstance): FakeSession => host.createSession({ id: `oc-${unique()}` });
	async function startLead(options: Parameters<typeof startHost>[0] = {}) {
		const host = await startHost(options);
		const session = newSession(host);
		return { host, id: session.id, session };
	}
	/** A server restart on the same storage and sessions: the new instance is shut down after the test like the others. */
	async function restart(host: OpenCodeInstance) {
		const restarted = await host.restart();
		hosts.push(restarted);
		return restarted;
	}

	/** A ticket outside any plan, qualified, with a body. */
	const ticketRef = async (title: string, body: string) => `${PROJECT}#${await store.issue(title, { body, project: PROJECT })}`;
	async function parentOf(id: string): Promise<any> {
		const list = await store.sessionParents("opencode", id, true);
		expect(list).toHaveLength(1);
		return list[0];
	}
	async function childrenOf(ref: string): Promise<any[]> {
		return [...(await show(ref)).children ?? []].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
	}
	const itemsOf = async (id: string) => childrenOf(qref(await parentOf(id)));
	const closeEvents = async () => (await store.events()).filter(event => event.type === "issue.closed");
	const labelsOf = async (issue: any): Promise<string[]> => ((await show(qref(issue))).labels ?? []).map((label: any) => label.label);

	/** Runs a shell command as a delegate's shell would, against this store: the `kata` on PATH is the adopted binary. `without` names variables the command's environment must not hold. */
	async function sh(command: string, without: string[] = []) {
		const commandEnv = { ...env, PATH: process.env.PATH };
		for (const key of without) delete commandEnv[key];
		const proc = Bun.spawn(["bash", "-c", command], { cwd, env: commandEnv, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		return { code: await proc.exited, stdout, stderr };
	}
	/** The close command the delegate's prompt hands it, with the message and the evidence filled in. */
	async function closeAs(system: string) {
		const { close } = assignmentOf(system);
		if (!close) throw new Error(`The delegate's prompt holds no close command:\n${system}`);
		const out = await sh(`${close} --message ${quote(MESSAGE)} --evidence ${quote(EVIDENCE[0])}`);
		if (out.code) throw new Error(out.stderr);
	}

	/**
	 * What the fake host's storage holds for a session, named once: whether it has saved entries (a pending close, a delegate)
	 * and whether it is flagged as an ended session. `any`: it holds anything at all, so false is a forgotten session.
	 */
	function savedOf(host: OpenCodeInstance, id: string) {
		const keys = [...host.shared.kv.keys()].filter(key => key.includes(`/${id}/`));
		return { any: keys.length > 0, entries: keys.some(key => key.endsWith(SAVED.entries)), ended: keys.some(key => key.endsWith(SAVED.ended)) };
	}
	const forgotten = (host: OpenCodeInstance, id: string) => !savedOf(host, id).any;

	return {
		...store, wrapper, kataCalls, forgetCalls, throttleCloses, holdCalls, releaseCalls,
		startHost, startLead, newSession, restart,
		parentOf, ticketRef, childrenOf, itemsOf, closeEvents, labelsOf, sh, closeAs, savedOf, forgotten,
	};
}
