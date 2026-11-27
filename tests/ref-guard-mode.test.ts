import { expect, test } from "bun:test";
import { refGuardMode } from "../core/kata-cli";

test("ref guard mode parses configured values", () => {
	for (const [value, mode] of [["off", "off"], ["0", "off"], ["warn", "warn"], ["WARN ", "warn"], ["unknown", "block"], [undefined, "block"]] as const) expect(refGuardMode(value)).toBe(mode);
});

test("warnings forwarded through nested calls are taken once", async () => {
	const { createKataCore } = await import("../core/kata-core");
	const { nodePlatform } = await import("../core/node-host");
	const { memoryDelegateStore } = await import("./kata-fixture");
	const core = createKataCore({ platform: nodePlatform, appendEntry() {}, exec: async () => ({ code: 1, stdout: "", stderr: "" }), delegateStore: memoryDelegateStore() }, {
		namespace: "pi", executable: "kata", executableVars: [], explicitRef: () => "demo#ab3d", env: name => name === "KATA_REF_GUARD" ? "warn" : undefined,
	});
	const ctx = { cwd: process.cwd() };
	const call = { tool: "bash", input: { command: 'git commit -m "demo#ab3d"' } };
	for (const id of ["child-a", "child-b", "grandchild"]) expect(await core.tools.guard(ctx, { ...call, id })).toBeUndefined();
	expect(await core.tools.guard(ctx, call)).toContain("Refused:");
	expect(core.tools.warning("grandchild", "child-b")).toBeUndefined();
	expect(core.tools.warning("child-b", "outer")).toBeUndefined();
	expect(core.tools.warning("child-a", "outer")).toBeUndefined();
	const reason = core.tools.warning("outer");
	expect(reason?.match(/Kata refs only resolve/g)).toHaveLength(3);
	expect(reason).toContain("bash");
	expect(reason).toContain("demo#ab3d");
	expect(reason).toContain("asked to put");
	expect(reason).not.toContain("Refused:");
	expect(reason).not.toContain("retry");
	expect(core.tools.warning("outer")).toBeUndefined();
});
