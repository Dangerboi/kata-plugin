import { expect, test } from "bun:test";
import path from "node:path";
import { decidePlanParent, isExplicitParent, namesPlanParent, type ParentSources, type SavedParent } from "../core/plan-parent";

const cwd = path.resolve("/work/session");
const stored: SavedParent = { parent: "p#stored", workspace: "/work/stored", sessionId: "s1", auto: true, label: "lbl" };
const found: SavedParent = { parent: "p#found", workspace: "/work/found", sessionId: "s1", auto: true };

// Every source set the core can gather, in decreasing precedence of what decides.
const table: [string, Omit<ParentSources, "cwd">, { parent?: string; provenance: string; workspace: string; overridden?: string }][] = [
	["a delegate's assignment beats everything", { assigned: { ref: "p#assigned", workspace: "/work/delegate" }, explicit: "p#env", initRef: "p#init", stored, session: async () => found }, { parent: "p#assigned", provenance: "assigned", workspace: "/work/delegate", overridden: "p#init" }],
	["an assignment without a workspace works in the session cwd", { assigned: { ref: "p#assigned" } }, { parent: "p#assigned", provenance: "assigned", workspace: cwd }],
	["an assignment with no ref is no assignment", { assigned: {}, explicit: "p#env" }, { parent: "p#env", provenance: "explicit", workspace: cwd }],
	["the explicit ref beats init's ref, stored state and the session", { explicit: "p#env", initRef: "p#init", stored, session: async () => found }, { parent: "p#env", provenance: "explicit", workspace: cwd, overridden: "p#init" }],
	["init's ref beats stored state and the session", { initRef: "p#init", stored, session: async () => found }, { parent: "p#init", provenance: "init", workspace: cwd }],
	["stored state beats the session and keeps its workspace", { stored, session: async () => found }, { parent: "p#stored", provenance: "stored", workspace: "/work/stored" }],
	["stored state without a workspace uses the session cwd", { stored: { parent: "p#stored" } }, { parent: "p#stored", provenance: "stored", workspace: cwd }],
	["the session lookup decides when nothing earlier does", { session: async () => found }, { parent: "p#found", provenance: "session", workspace: "/work/found" }],
	["a session lookup that finds nothing leaves no parent but a workspace", { session: async () => undefined }, { provenance: "none", workspace: cwd }],
	["no sources leave no parent but a workspace", {}, { provenance: "none", workspace: cwd }],
];

for (const [name, sources, expected] of table) {
	test(`plan parent: ${name}`, async () => {
		const choice = await decidePlanParent({ cwd, ...sources });
		expect(choice).toMatchObject(expected);
		expect(isExplicitParent(choice)).toBe(["assigned", "explicit", "init"].includes(expected.provenance));
	});
}

test("plan parent: stored state and the session lookup carry what they remembered", async () => {
	expect((await decidePlanParent({ cwd, stored })).saved).toBe(stored);
	expect((await decidePlanParent({ cwd, session: async () => found })).saved).toBe(found);
	expect((await decidePlanParent({ cwd, explicit: "p#env", stored })).saved).toBeUndefined();
});

test("plan parent: the session lookup runs only when nothing earlier decides", async () => {
	let asked = 0;
	const session = async () => { asked++; return found; };
	for (const sources of [{ assigned: { ref: "p#a" } }, { explicit: "p#e" }, { initRef: "p#i" }, { stored }]) await decidePlanParent({ cwd, ...sources, session });
	expect(asked).toBe(0);
	await decidePlanParent({ cwd, session });
	expect(asked).toBe(1);
});

test("plan parent: a ref names the plan parent by its current ref, a former ref or its short id", () => {
	const former = new Set(["old#abcd"]);
	expect(namesPlanParent("new#abcd", former, "new#abcd")).toBe(true);
	expect(namesPlanParent("new#abcd", former, "old#abcd")).toBe(true);
	expect(namesPlanParent("new#abcd", former, "abcd")).toBe(true);
	expect(namesPlanParent("new#abcd", former, "other#abcd")).toBe(false);
	expect(namesPlanParent("new#abcd", former, "wxyz")).toBe(false);
	expect(namesPlanParent(undefined, former, "new#abcd")).toBe(false);
});
