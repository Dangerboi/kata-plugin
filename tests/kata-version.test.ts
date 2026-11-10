import { expect, test } from "bun:test";
import fc from "fast-check";
import { daemonUnavailable } from "./kata-errors";
import { createKata, type Exec } from "../core/kata-cli";

function client(exec: Exec) {
  return createKata({ exec, executable: "/fixture/kata", teammate: () => "lead", ctx: () => "event", session: () => "session", debug() {} });
}
const reply = (version: string) => ({ code: 0, stdout: JSON.stringify({ kata_api_version: 1, name: "kata", version }) });

async function checkVersion(version: string, supported: boolean, guidance = "Upgrade Kata") {
  const calls: string[][] = [];
  const kata = client(async (_file, args) => { calls.push(args); return args[0] === "version" ? reply(version) : { code: 0, stdout: "ok" }; });
  if (supported) expect(await kata.run(["create", "fixture"], "/fixture")).toBe("ok");
  else {
    const error = await kata.run(["create", "must not write"], "/fixture").then(() => undefined, error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("unsupported_version");
    expect(error.unusable).toBe(false);
    expect(error.message).toContain(guidance);
    expect(error.message).toContain("requires Kata >=0.23.0");
    expect(calls).toHaveLength(1);
  }
}

for (const [version, supported] of [
  ["0.22.9", false], ["v0.22.0-40-gabcdef0", false],
  ["0.23.0-rc.1", false], ["v0.23.0-rc.1-5-gabcdef0", false],
  ["0.23.0", true], ["v0.23.0", true], ["v0.23.0+build.1", true],
  ["v0.23.0-dirty", true], ["v0.23.0-4-g4aea65239", true],
  ["v0.23.0-4-g4aea65239-dirty", true], ["v0.24.1-2-gabcdef0", true],
  ["v0.23.0-1-g5586", true], ["v0.23.0-1-g5586-dirty", true], ["1.0.0-0", true],
] as const) test(`version boundary ${version}: ${supported ? "accepted" : "refused"}`, () => checkVersion(version, supported));

for (const version of ["dev", "g4aea652", "0.23",
  "v0.23.0+a..b", "0.24.0-rc..1", "0.24.0-rc.01", "v00.24.0"]) {
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

for (const identity of [
  { kata_api_version: 2, version: "v0.24.0" },
  { kata_api_version: "1", version: "v0.24.0" },
  { version: "v0.24.0" },
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

for (const [name, failure, code, message] of [
  ["kata is missing", () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }, undefined, "could not run"],
  ["the daemon is down", daemonUnavailable, "daemon_unavailable", "selected daemon is unavailable"],
  ["the probe times out", () => ({ code: 1, stdout: "", killed: true }), undefined, "timed out after 3000ms"],
] as const) test(`unavailable version probe retries on recovery when ${name}`, async () => {
  let down = true;
  const kata = client(async (_file, args) => down ? failure() : args[0] === "version" ? reply("0.23.0") : { code: 0, stdout: "recovered" });
  await expect(kata.run(["list"], "/fixture")).rejects.toMatchObject({ code, unusable: true, message: expect.stringContaining(message) });
  down = false;
  expect(await kata.run(["list"], "/fixture")).toBe("recovered");
});

test("raw execution errors retain the executable diagnostic", async () => {
  const error = Object.assign(new Error("permission denied: /fixture/kata"), { code: "EACCES" });
  const kata = client(async () => { throw error; });
  await expect(kata.run(["list"], "/fixture")).rejects.toBe(error);
});

test("malformed version JSON remains unprovable", async () => {
  const kata = client(async () => ({ code: 0, stdout: "{" }));
  await expect(kata.run(["list"], "/fixture")).rejects.toThrow("Install a versioned release");
});

test("a failed version call is unprovable, not an outage", async () => {
  const kata = client(async () => ({ code: 1, stdout: "", stderr: 'unknown command "version"' }));
  await expect(kata.run(["list"], "/fixture")).rejects.toThrow("Install a versioned release");
});
