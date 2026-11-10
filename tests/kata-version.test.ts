import { expect, test } from "bun:test";
import fc from "fast-check";
import { createKata, isUnusable, type Exec } from "../core/kata-cli";

function client(exec: Exec) {
  return createKata({ exec, executable: "/fixture/kata", teammate: () => "lead", ctx: () => "event", session: () => "session", debug() {} });
}
const reply = (version: string) => ({ code: 0, stdout: JSON.stringify({ kata_api_version: 1, name: "kata", version }) });

async function checkVersion(version: string, supported: boolean, guidance = "Upgrade Kata") {
  const calls: string[][] = [];
  const kata = client(async (_file, args) => { calls.push(args); return args[0] === "version" ? reply(version) : { code: 0, stdout: "ok" }; });
  if (supported) expect(await kata.run(["create", "fixture"], "/fixture")).toBe("ok");
  else {
    try { await kata.run(["create", "must not write"], "/fixture"); throw new Error("accepted unsupported Kata"); }
    catch (error) {
      expect((error as Error).message).toContain("requires Kata >=0.23.0");
      expect((error as Error).message).toContain(guidance);
      expect(isUnusable(error)).toBe(false);
    }
    expect(calls).toHaveLength(1);
  }
}

for (const [version, supported] of [
  ["0.22.9", false], ["v0.22.0-40-gabcdef0", false],
  ["0.23.0-rc.1", false], ["v0.23.0-rc.1-5-gabcdef0", false],
  ["0.23.0", true], ["v0.23.0", true], ["v0.23.0+build.1", true],
  ["v0.23.0-dirty", true], ["v0.23.0-4-g4aea65239", true],
  ["v0.23.0-4-g4aea65239-dirty", true], ["v0.24.1-2-gabcdef0", true],
  ["0.23.1-rc.1", true], ["0.24.0-rc.1+build.1", true], ["1.0.0-0", true],
] as const) test(`version boundary ${version}: ${supported ? "accepted" : "refused"}`, () => checkVersion(version, supported));

for (const version of ["dev", "g4aea652", "g4aea652-dirty", "4aea652", "", "0.23", "garbage",
  "v0.23.0+.", "v0.23.0+a..b", "0.24.0-01", "0.24.0-rc..1", "0.24.0-rc.01", "v00.24.0"]) {
  test(`unprovable version ${JSON.stringify(version)} gives installation guidance`, () => checkVersion(version, false, "Install a versioned release"));
}

const patch = fc.integer({ min: 0, max: 10000 });
const newerRelease = fc.oneof(
  fc.integer({ min: 1, max: 10000 }).map(p => `0.23.${p}`),
  fc.tuple(fc.integer({ min: 24, max: 10000 }), patch).map(([minor, p]) => `0.${minor}.${p}`),
  fc.tuple(fc.integer({ min: 1, max: 10000 }), patch, patch).map(([major, minor, p]) => `${major}.${minor}.${p}`),
);
const releaseVariant = fc.tuple(fc.boolean(), fc.constantFrom("", "-rc.1", "+build.1", "-rc.1+build.1"));
test("releases strictly above the minimum accept semver variants", async () => {
  await fc.assert(fc.asyncProperty(newerRelease, releaseVariant, (base, [prefix, suffix]) => checkVersion(`${prefix ? "v" : ""}${base}${suffix}`, true)), { numRuns: 100 });
});
test("releases below the minimum reject semver variants", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 22 }), patch, releaseVariant,
    (minor, p, [prefix, suffix]) => checkVersion(`${prefix ? "v" : ""}0.${minor}.${p}${suffix}`, false)), { numRuns: 100 });
});
test("tagged source builds at or above the minimum accept describe and dirty variants", async () => {
  await fc.assert(fc.asyncProperty(fc.oneof(fc.constant("0.23.0"), newerRelease), fc.nat({ max: 10000 }), fc.boolean(),
    (base, count, dirty) => checkVersion(`v${base}-${count}-g4aea65239${dirty ? "-dirty" : ""}`, true)), { numRuns: 100 });
});

for (const identity of [
  { kata_api_version: 2, version: "v0.24.0" },
  { kata_api_version: "1", version: "v0.24.0" },
  { version: "v0.24.0" }, null, [],
]) test(`rejects unknown version schema ${JSON.stringify(identity)}`, async () => {
  const calls: string[][] = [];
  const kata = client(async (_file, args) => { calls.push(args); return { code: 0, stdout: JSON.stringify(identity) }; });
  await expect(kata.run(["create", "must not write"], "/fixture")).rejects.toThrow("Install a versioned release");
  expect(calls).toHaveLength(1);
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
  await expect(kata.run(["list"], "/fixture")).rejects.toThrow("Install a versioned release");
});
