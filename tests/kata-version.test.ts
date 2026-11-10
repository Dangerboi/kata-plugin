import { expect, test } from "bun:test";
import fc from "fast-check";
import { createKata, isUnusable, type Exec } from "../core/kata-cli";

function client(exec: Exec) {
  return createKata({ exec, executable: "/fixture/kata", teammate: () => "lead", ctx: () => "event", session: () => "session", debug() {} });
}
const reply = (version: string) => ({ code: 0, stdout: JSON.stringify({ name: "kata", version }) });

test("version boundaries follow release ordering, including prereleases and build metadata", async () => {
  await fc.assert(fc.asyncProperty(
    fc.tuple(fc.integer({ min: 0, max: 3 }), fc.integer({ min: 0, max: 50 }), fc.integer({ min: 0, max: 100 })),
    fc.constantFrom("", "-rc.1", "+build.1", "-rc.1+build.1"), fc.boolean(),
    async ([major, minor, patch], suffix, prefix) => {
      const version = `${prefix ? "v" : ""}${major}.${minor}.${patch}${suffix}`;
      const supported = major > 0 || minor > 23 || (minor === 23 && (patch > 0 || !suffix.startsWith("-")));
      const calls: string[][] = [];
      const kata = client(async (_file, args) => { calls.push(args); return args[0] === "version" ? reply(version) : { code: 0, stdout: "ok" }; });
      if (supported) expect(await kata.run(["list"], "/fixture")).toBe("ok");
      else {
        try { await kata.run(["create", "must not write"], "/fixture"); throw new Error("accepted old Kata"); }
        catch (error) { expect((error as Error).message).toContain("Upgrade Kata"); expect(isUnusable(error)).toBe(false); }
        expect(calls).toHaveLength(1);
      }
    }), { numRuns: 150 });
});

for (const version of ["0.22.9", "v0.23.0-rc.1", "dev", "", "0.23", "garbage"]) test(`rejects unsupported or unknown version ${JSON.stringify(version)}`, async () => {
  const kata = client(async () => reply(version));
  expect(kata.run(["list"], "/fixture")).rejects.toThrow(/requires Kata >=0\.23\.0.*Upgrade Kata/);
});

test("checks once before concurrent calls, bounded and without workspace or teammate flags", async () => {
  const calls: { args: string[]; opts: any }[] = [];
  const kata = client(async (_file, args, opts) => { calls.push({ args, opts }); return args[0] === "version" ? reply("0.23.0") : { code: 0, stdout: "ok" }; });
  await Promise.all([kata.run(["list"], "/fixture"), kata.run(["show", "demo#abcd"], "/fixture")]);
  expect(calls.filter(c => c.args[0] === "version")).toEqual([{ args: ["version", "--json"], opts: { cwd: "/fixture", timeout: 3000, ctx: "event" } }]);
});

for (const failure of [
  () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
  () => ({ code: 1, stdout: "" }),
  () => ({ code: 7, stdout: "", stderr: "daemon unavailable" }),
  () => ({ code: 1, stdout: "", killed: true }),
]) test("unavailable version probe retains fallback and retries on recovery", async () => {
  let down = true;
  const kata = client(async (_file, args) => down ? failure() : args[0] === "version" ? reply("0.23.0") : { code: 0, stdout: "recovered" });
  try { await kata.run(["list"], "/fixture"); throw new Error("accepted outage"); }
  catch (error) { expect(isUnusable(error)).toBe(true); }
  down = false;
  expect(await kata.run(["list"], "/fixture")).toBe("recovered");
});

test("a CLI too old to answer version gets upgrade guidance", async () => {
  const kata = client(async () => ({ code: 1, stdout: "", stderr: 'unknown command "version"' }));
  expect(kata.run(["list"], "/fixture")).rejects.toThrow(/requires Kata >=0\.23\.0.*Upgrade Kata/);
});
