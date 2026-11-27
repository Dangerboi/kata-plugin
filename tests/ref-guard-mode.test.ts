import { expect, test } from "bun:test";
import { refGuardMode } from "../core/kata-cli";

test("ref guard mode parses configured values", () => {
  for (const [value, mode] of [["off", "off"], ["0", "off"], ["warn", "warn"], ["WARN ", "warn"], ["unknown", "block"], [undefined, "block"]] as const) expect(refGuardMode(value)).toBe(mode);
});
