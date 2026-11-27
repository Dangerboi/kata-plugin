import { expect, test } from "bun:test";
import { realKata } from "./kata-fixture";
import { ompHost } from "./omp-host";
import { teammateFor } from "../core/delegates";

// A delegate's bash in omp runs in the lead's process: its Kata commands are rewritten for its teammate and its own session.
const { cwd, run } = realKata({ prefix: "omp-delegate-shell", author: "actor-a", project: "ompshell" });
const SID = "omp-shell-lead";

async function rewrite(command: string, agentId: string) {
  const app = ompHost({ run: args => run(args), cwd, sid: SID });
  await app.event("session_start");
  const sub = { ...app.ctx, agent: { kind: "sub", id: agentId } };
  const out = await app.event("tool_call", { toolName: "bash", input: { command } }, sub);
  return out.input.command as string;
}

test("a delegate with no record runs Kata under the teammate its record would have, salted by the lead's session", async () => {
  expect(await rewrite("kata show ab12", "scout-x")).toContain(`--teammate '${teammateFor("scout-x", SID)}'`);
});

test("a delegate's close whose own session is not known yet records nothing rather than the lead's session", async () => {
  const command = await rewrite("kata close ab12 --done", "scout-y");
  expect(command).toContain("KATA_CLOSE_TRANSCRIPT_ENABLED='false'");
  expect(command).not.toContain("KATA_TRANSCRIPT_SESSION_ID");
  expect(await rewrite("kata show ab12", "scout-y")).not.toContain("KATA_CLOSE_TRANSCRIPT_ENABLED");
});

test("lifecycle installs the shim before returning and publishes distinct session identities", async () => {
  const app = ompHost({ run: args => run(args), cwd, sid: SID });
  await app.event("session_start");
  const dir = process.env.KATA_OMP_SHIM_DIR!;
  expect(dir).toBeTruthy();
  expect(process.env.PATH?.split(":")[0]).toBe(`${dir}/bin`);
  expect(process.env.PI_SHELL_PREFIX).toContain("KATA_OMP_SHIM_DIR=");
  await app.event("before_agent_start", { reason: "prompt", systemPrompt: [] });
  const { readFileSync } = await import("node:fs");
  expect(readFileSync(`${dir}/${SID}.env`, "utf8")).toContain("KATA_AUTHOR='actor-a'");
  const sub = { ...app.ctx, agent: { kind: "sub", id: "shell-child" }, sessionManager: { getSessionId: () => "shell-child-session", getBranch: () => [], getEntries: () => [], getHeader: () => ({}), getSessionFile: () => undefined } };
  await app.event("tool_call", { toolName: "bash", input: { command: "bash -c 'kata show ab12'" } }, sub);
  const identity = readFileSync(`${dir}/shell-child-session.env`, "utf8");
  const teammate = teammateFor("shell-child", SID);
  expect(identity).toContain(`KATA_TEAMMATE='${teammate}'`);
  expect(identity).toContain(`KATA_INBOX_USER='actor-a/${teammate}'`);
  for (const event of ["session_switch", "session_branch"]) {
    await app.event(event);
    expect(process.env.KATA_OMP_SHIM_DIR).toBe(dir);
    expect(process.env.PATH?.split(":")[0]).toBe(`${dir}/bin`);
  }
});

test("publication failure warns once until a successful write and never blocks bash", async () => {
  const { existsSync, renameSync } = await import("node:fs");
  const app = ompHost({ run: args => run(args), cwd, sid: SID });
  await app.event("session_start");
  await app.event("before_agent_start", { reason: "prompt", systemPrompt: [] });
  const dir = process.env.KATA_OMP_SHIM_DIR!, held = `${dir}-held`;
  const sub = { ...app.ctx, agent: { kind: "sub", id: "failure-child" }, sessionManager: { getSessionId: () => "failure-child-session", getBranch: () => [], getEntries: () => [], getHeader: () => ({}), getSessionFile: () => undefined } };
  const call = () => app.event("tool_call", { toolName: "bash", input: { command: "ls" } }, sub);
  const before = app.notices.length;
  try {
    renameSync(dir, held);
    expect((await call())?.block).toBeUndefined();
    expect((await call())?.block).toBeUndefined();
    expect(app.notices.length - before).toBe(1);
    expect(app.notices[before][0]).toContain("identity could not be published");
    renameSync(held, dir);
    expect((await call())?.block).toBeUndefined();
    expect(existsSync(`${dir}/failure-child-session.env`)).toBe(true);
    renameSync(dir, held);
    expect((await call())?.block).toBeUndefined();
    expect(app.notices.length - before).toBe(2);
  } finally { if (existsSync(held)) renameSync(held, dir); }
});
