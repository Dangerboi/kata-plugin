// Actual bash-tool inheritance proof, with a credential-free provider and synthetic homes.
// OMP_BIN=/path/to/omp PI_BIN=/path/to/pi bun scripts/smoke-omp-attention.ts
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
const repo = process.cwd(), scratch = mkdtempSync(path.join(os.tmpdir(), "omp-attention-"));
const pi = process.env.PI_BIN || path.join(repo, "node_modules/.bin/pi"), omp = process.env.OMP_BIN || "omp";
const env = { ...process.env, HOME: scratch, XDG_CONFIG_HOME: path.join(scratch, "config"), KATA_HOME: path.join(scratch, "kata"), KATA_AUTHOR: "probe", PI_CODING_AGENT_DIR: path.join(scratch, "agent"), OMP_CONFIG_DIR: path.join(scratch, "omp") };
for (const key of Object.keys(env)) if (/^(KATA_(SERVER|DAEMON|AUTH_TOKEN|REF|TEAMMATE|INBOX_USER|PI_PARENT|PI_EXECUTABLE|OMP_EXECUTABLE|ATTENTION_HOST|TRANSCRIPT_.*|CLOSE_TRANSCRIPT_ENABLED)|CODEX_HOME|CLAUDE_CONFIG_DIR|OMP_AGENT_DIR)$/.test(key)) delete env[key];
const work = path.join(scratch, "repo"); mkdirSync(work); mkdirSync(env.PI_CODING_AGENT_DIR);
function run(file: string, args: string[], extra = {}) {
  const r = spawnSync(file, args, { env: { ...env, ...extra }, cwd: work, encoding: "utf8", timeout: 120000 });
  if (r.status !== 0) throw new Error(`${file} ${args}: ${r.status}: ${r.stderr}\n${r.stdout}`);
  return r.stdout;
}
const kata = (args: string[]) => run("kata", args);
try {
  run("git", ["init", "-q"]);
  kata(["init", "--project", "session-probe"]);
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
    const refs = ["lead", "other"].map(role => `session-probe#${JSON.parse(kata(["create", `${host} ${role}`, "--force-new", "--json"])).issue.short_id}`);
    for (const ref of refs) kata(["claim", ref]);
    const args = host === "pi" ? ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-session", "-e", native, "-e", path.join(repo, "plugins/pi/kata.ts")]
      : ["--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-title", "--no-session", "-e", path.join(repo, "plugins/oh-my-pi/kata.ts")];
    args.push("-e", provider, "--model", "probe/dummy", "--mode", "json", "-p", "lead");
    console.log(run(host === "pi" ? pi : omp, args, { KATA_REF: refs[0], ATTENTION_OTHER_REF: refs[1], ATTENTION_HOST: host, PI_CODING_AGENT_DIR: path.join(scratch, host + "-agent") }));
  }
  const rows = readFileSync(results, "utf8").trim().split("\n").map(line => JSON.parse(line));
  if (rows.length !== 2 || rows[0].host !== "pi" || rows[1].host !== "omp") throw new Error("Both hosts must execute their bash proof");
  console.log("ATTENTION_RESULTS " + JSON.stringify(rows));
} finally {
  spawnSync("kata", ["daemon", "stop"], { env, cwd: work, timeout: 15000 });
  rmSync(scratch, { recursive: true, force: true });
}
