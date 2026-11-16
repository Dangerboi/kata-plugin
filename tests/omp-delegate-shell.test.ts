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
