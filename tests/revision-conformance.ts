// Separate from the extension suite: checks the daemon's lifecycle CAS contract.
import { kataStore } from "./kata-fixture";

const store = kataStore("revisions", "revision-a");
const { binary, scratch, text: command } = store;
const kata = (args: string[]) => store.kata([...args, "--json"]);
try {
  await command(["init", "--project", "revision-conformance"]);
  const original = (await kata(["create", "Ownership revision contract", "--force-new"])).issue;
  const claimed = (await kata(["claim", original.short_id, "--if-unowned"])).issue;
  const reassigned = (await kata(["claim", original.short_id, "--as", "revision-b", "--force"])).issue;
  const closed = (await kata(["close", original.short_id, "--wontfix", "--message", "Retired the isolated ownership revision conformance fixture after validating the daemon contract."])).issue;
  const reopened = (await kata(["reopen", original.short_id])).issue;
  const ownerChangeInvalidatesCAS = claimed.owner === "revision-a" && reassigned.owner === "revision-b" && claimed.revision > original.revision && reassigned.revision > claimed.revision;
  const closureInvalidatesCAS = closed.status === "closed" && closed.revision > reassigned.revision;
  const reopenAdvancesOnce = reopened.status === "open" && reopened.revision === closed.revision + 1;
  console.log(JSON.stringify({ binary, version: (await command(["version"])).trim(), scratch, revisions: [original.revision, claimed.revision, reassigned.revision, closed.revision, reopened.revision], ownerChangeInvalidatesCAS, closureInvalidatesCAS, reopenAdvancesOnce }, null, 2));
  if (!ownerChangeInvalidatesCAS || !closureInvalidatesCAS || !reopenAdvancesOnce) process.exitCode = 1;
} finally { await command(["daemon", "stop"]); }
