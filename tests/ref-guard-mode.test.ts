import { expect, test } from "bun:test";
import { refGuardMode } from "../core/kata-cli";
import { resolveSettings } from "../plugins/claude-code/hooks/settings";

test("ref guard mode parses configured values", () => {
	for (const [value, mode] of [["off", "off"], ["0", "off"], ["warn", "warn"], ["WARN ", "warn"], ["unknown", "block"], [undefined, "block"]] as const) expect(refGuardMode(value)).toBe(mode);
});


test("Claude guard settings retain booleans and combine options with environment", () => {
	for (const [option, env, expected] of [
		[false, "warn", "off"], [true, undefined, "block"], [undefined, "warn", "warn"],
		[true, "warn", "warn"], [true, "off", "off"], [false, undefined, "off"]
	] as const) {
		const values = new Map<string, string>();
		if (env !== undefined) values.set("KATA_REF_GUARD", env);
		expect(resolveSettings({ refGuard: option }, values).refGuard).toBe(expected);
	}
});
