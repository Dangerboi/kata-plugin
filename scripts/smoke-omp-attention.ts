// Actual bash-tool inheritance proof, with a credential-free provider and synthetic homes.
// OMP_BIN=/path/to/omp PI_BIN=/path/to/pi bun run smoke:omp-attention
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { cleanEnv, kataProject, linesIn, scratchRoot, teardown } from "./smoke-lib";
const repo = path.resolve(import.meta.dirname, ".."), scratch = scratchRoot("omp-attention-");
const pi = process.env.PI_BIN || path.join(repo, "node_modules/.bin/pi"), omp = process.env.OMP_BIN || "omp";
const env = { ...cleanEnv(/^(CODEX_HOME|CLAUDE_CONFIG_DIR|OMP_AGENT_DIR)$/), HOME: scratch, XDG_CONFIG_HOME: path.join(scratch, "config"), XDG_DATA_HOME: path.join(scratch, "data"), XDG_STATE_HOME: path.join(scratch, "state"), XDG_CACHE_HOME: path.join(scratch, "cache"), KATA_HOME: path.join(scratch, "kata"), KATA_AUTHOR: "probe", PI_CODING_AGENT_DIR: path.join(scratch, "agent") };
const work = path.join(scratch, "repo"); mkdirSync(work); mkdirSync(env.PI_CODING_AGENT_DIR);
const project = kataProject(env, work, "session-probe"), kata = project.kata;
function run(file: string, args: string[], extra = {}) {
  const r = spawnSync(file, args, { env: { ...env, ...extra }, cwd: work, encoding: "utf8", timeout: 120000 });
  if (r.status !== 0) throw new Error(`${file} ${args}: ${r.status}: ${r.stderr}\n${r.stdout}`);
  return r.stdout;
}
try {
  project.init();
  kata(["agent-hook", "install", "pi", "--scope", "project", "--executable", "kata"]);
  const native = path.join(work, ".pi/extensions/kata.js"), provider = path.join(scratch, "provider.ts"), driver = path.join(scratch, "child.ts"), results = path.join(scratch, "results.jsonl");
  // This driver is executed ONLY by the host's bash tool, inheriting its cached environment.
  writeFileSync(driver, `import {spawnSync} from 'node:child_process';
import {appendFileSync} from 'node:fs';
const show=ref=>{const r=spawnSync('kata',['show',ref,'--json'],{encoding:'utf8',timeout:15000});if(r.status!==0)throw Error(r.stderr);return JSON.parse(r.stdout).issue.metadata;};
const ref=process.env.KATA_REF, before=show(ref), marker=process.env.KATA_ATTENTION_HOST;
if(!marker||before['work.attention']!=='ok'||!before['work.attention_session'])throw Error('lead baseline missing '+JSON.stringify({marker,before}));
const child=ref=>{const r=spawnSync(${JSON.stringify(pi)},['--no-extensions','--no-skills','--no-prompt-templates','--no-session','-e',${JSON.stringify(native)},'-e',${JSON.stringify(provider)},'--model','probe/dummy','--mode','json','-p','child'],{encoding:'utf8',timeout:45000,env:{...process.env,KATA_REF:ref,ATTENTION_CHILD:'1',PI_CODING_AGENT_DIR:${JSON.stringify(path.join(scratch, "child-agent"))}}});if(r.status!==0)throw Error(r.stderr+'\\n'+r.stdout);};
child(ref);const after=show(ref);
for(const key of ['work.attention','work.attention_session'])if(JSON.stringify(before[key])!==JSON.stringify(after[key]))throw Error(key+' changed '+JSON.stringify({before,after}));
child(process.env.ATTENTION_OTHER_REF);const other=show(process.env.ATTENTION_OTHER_REF), final=show(ref);
if(other['work.attention']!=='needs-human'||!other['work.attention_session'])throw Error('different-ref child did not track its own issue '+JSON.stringify(other));
for(const key of ['work.attention','work.attention_session'])if(JSON.stringify(before[key])!==JSON.stringify(final[key]))throw Error('different-ref child changed lead '+key);
appendFileSync(${JSON.stringify(results)},JSON.stringify({host:process.env.ATTENTION_HOST,marker,before,after,other,final})+'\\n');`);
  // Import the maintained stream by file: Pi's extension loader cannot require its import-only package export.
  const streamModule = path.join(path.dirname(realpathSync(path.join(repo, "node_modules/@earendil-works/pi-coding-agent"))), "pi-ai/dist/utils/event-stream.js");
  writeFileSync(provider, `import {registerSmokeProvider} from ${JSON.stringify(path.join(repo, "scripts/smoke-provider.ts"))};
import {AssistantMessageEventStream} from ${JSON.stringify(streamModule)};
export default function(api){registerSmokeProvider(api,AssistantMessageEventStream,context=>
 !process.env.ATTENTION_CHILD&&!context.messages.some(m=>m.role==='assistant')
 ?[{tool:'bash',args:{command:${JSON.stringify(`bun '${driver.replaceAll("'", "'\\''")}'`)}}}]:['done'],'probe','dummy');}`);
  for (const host of ["pi", "omp"]) {
    const refs = ["lead", "other"].map(role => `session-probe#${project.create(`${host} ${role}`)}`);
    for (const ref of refs) kata(["claim", ref]);
    const args = host === "pi" ? ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-session", "-e", native, "-e", path.join(repo, "plugins/pi/kata.ts")]
      : ["--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-title", "--no-session", "-e", path.join(repo, "plugins/oh-my-pi/kata.ts")];
    args.push("-e", provider, "--model", "probe/dummy", "--mode", "json", "-p", "lead");
    console.log(run(host === "pi" ? pi : omp, args, { KATA_REF: refs[0], ATTENTION_OTHER_REF: refs[1], ATTENTION_HOST: host, PI_CODING_AGENT_DIR: path.join(scratch, host + "-agent") }));
    if (host === "omp") {
      // The child writes this row only after both inheritance checks have left the live lead untouched.
      const rows = linesIn<{ host: string; marker?: string; before: Record<string, unknown>; final: Record<string, unknown> }>(results);
      const lead = rows[1];
      if (rows.length !== 2 || rows[0].host !== "pi" || lead?.host !== "omp" || !lead.marker ||
          lead.before?.["work.attention"] !== "ok" || !lead.before?.["work.attention_session"] ||
          lead.final?.["work.attention"] !== "ok" || lead.final?.["work.attention_session"] !== lead.before["work.attention_session"])
        throw new Error("OMP live lead and child proof did not complete before shutdown check");
      let metadata: Record<string, unknown> = {};
      for (const end = Date.now() + 20_000; Date.now() < end;) {
        metadata = JSON.parse(kata(["show", refs[0], "--json"])).issue.metadata ?? {};
        if (metadata["work.attention"] === "needs-human" && String(metadata["work.attention_session"] ?? "").startsWith("ended:") && metadata["work.attention_msg"] === "session ended without hand-off") break;
        await sleep(100);
      }
      if (metadata["work.attention"] !== "needs-human" || !String(metadata["work.attention_session"] ?? "").startsWith("ended:") || metadata["work.attention_msg"] !== "session ended without hand-off")
        throw new Error("OMP lead attention did not end after exit: " + JSON.stringify(metadata));
      console.log("OMP lead attention ended after exit");
    }
  }
  const rows = linesIn<{ host: string }>(results);
  if (rows.length !== 2 || rows[0].host !== "pi" || rows[1].host !== "omp") throw new Error("Both hosts must execute their bash proof");
  console.log("ATTENTION_RESULTS " + JSON.stringify(rows));
} finally {
  teardown();
}
