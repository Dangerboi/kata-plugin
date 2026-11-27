import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { v2Fixture } from "./v2-fixture";

const { cwd, host } = v2Fixture();
afterEach(() => { delete process.env.KATA_CONTRACT_SOURCE; });

test("contract source resolves a custom path and keeps the reserved default", async () => {
	const source = path.join(cwd, "custom-contract.md");
	writeFileSync(source, "Custom contract fixture");
	for (const [value, expected] of [[" custom-contract.md ", source], [undefined, "kata-agent-contract-hook"], ["   ", "kata-agent-contract-hook"]] as const) {
		if (value === undefined) delete process.env.KATA_CONTRACT_SOURCE;
		else process.env.KATA_CONTRACT_SOURCE = value;
		const app = host();
		await app.event("session_start");
		await app.contractReady;
		expect(app.calls.find((args: string[]) => args[0] === "agent-contract-hook")).toEqual(["agent-contract-hook", "--source", expected]);
		expect(app.notices.filter((notice: any[]) => notice[1] === "warning")).toEqual([]);
	}
});

test("missing source warns once even when a failed fetch is retried", async () => {
	process.env.KATA_CONTRACT_SOURCE = "missing.md";
	const app = host({ before: (args: string[]) => args[0] === "agent-contract-hook"
		? { code: 1, stdout: "", stderr: "contract fetch failed" } : undefined });
	await app.event("session_start");
	await app.contractReady;
	await app.event("before_agent_start", { systemPrompt: [] });
	await app.event("before_agent_start", { systemPrompt: [] });
	expect(app.calls.filter((args: string[]) => args[0] === "agent-contract-hook").length).toBeGreaterThan(1);
	expect(app.calls.filter((args: string[]) => args[0] === "agent-contract-hook").every((args: string[]) => args[2] === path.join(cwd, "missing.md"))).toBe(true);
	expect(app.notices.filter((notice: any[]) => notice[1] === "warning" && String(notice[0]).includes("contract source"))).toHaveLength(1);
});
