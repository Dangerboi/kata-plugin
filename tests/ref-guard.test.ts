import { expect, test } from "bun:test";
import { offendingRefs } from "../core/ref-guard";
import { assertIsolated } from "./isolation";
assertIsolated();

// The matcher on its own: which known refs a tool call would put into files under /work.
const refs = new Set(["demo#ab3d", "demo#k9m2"]);
// Files under /work or src/ are in the workspace; `files` is what they currently hold.
const files: Record<string, string> = {};
const locate = async (file: string) => file === "/work" || file.startsWith("/work/") || file.startsWith("src/") ? file : undefined;
const read = async (file: string) => { if (file in files) return files[file]; throw new Error("no such file"); };
const check = (tool: string, input: unknown, known = refs) => offendingRefs({ tool, input, refs: known, locate, read });

test("each way of adding text to a file flags a known ref", async () => {
  const text = "// see demo#ab3d for why";
  const cases: [string, unknown][] = [
    ["write", { path: "src/a.ts", content: text }],
    ["Write", { file_path: "/work/a.ts", content: text }],
    ["edit", { input: `[src/a.ts#1a2b]\nPUT 3.=4:\n+${text}\n+more` }],
    ["edit", { path: "src/a.ts", old_string: "x", new_string: text }],
    ["edit", { path: "src/a.ts", edits: [{ oldText: "x", newText: text }] }],
    ["edit", { path: "src/a.ts", oldText: "x", newText: text }],
    ["edit", { path: "src/a.ts", oldString: "x", newString: text }],
    ["Edit", { file_path: "/work/a.ts", old_string: "x", new_string: text }],
    ["NotebookEdit", { notebook_path: "/work/n.ipynb", new_source: text }],
    ["apply_patch", { input: `*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+${text}\n*** End Patch` }],
    ["patch", { patchText: `*** Begin Patch\n*** Add File: src/new.ts\n+${text}\n*** End Patch` }],
    ["ast_edit", { ops: [{ pat: "foo($A)", out: `bar($A) ${text}` }], paths: ["src/"] }],
    ["bash", { command: `git commit -m "fix: close demo#ab3d"` }],
    ["shell", { command: `git add -A && git commit --message='wip demo#ab3d'` }],
    ["bash", { command: `git commit -am "demo#ab3d"` }],
  ];
  for (const [tool, input] of cases) expect(await check(tool, input), `${tool} ${JSON.stringify(input)}`).toEqual(["demo#ab3d"]);
});

test("a short id counts only when the session knows it, on its own", async () => {
  expect(await check("write", { path: "src/a.ts", content: "fixes ab3d now" })).toEqual(["ab3d"]);
  expect(await check("write", { path: "src/a.ts", content: "fixes zz9z now" })).toEqual([]);
  expect(await check("write", { path: "src/a.ts", content: "const xab3d = 1; ab3d-more; ./ab3d" })).toEqual([]);
});

test("look-alikes of unknown projects and unknown ids pass", async () => {
  expect(await check("write", { path: "src/a.md", content: "see README.md#tasks and other#ab3d and #ab3d" })).toEqual([]);
  expect(await check("write", { path: "src/a.md", content: "demo#zz9z is another ticket" })).toEqual(["demo#zz9z"]);
  expect(await check("write", { path: "src/a.md", content: "a token abcd here" })).toEqual([]);
});

test("a hashline header tag is not flagged, only the added rows", async () => {
  const known = new Set(["a.md#1234"]);
  const input = { input: "[a.md#1234]\nPUT 1:\n+plain text" };
  expect(await offendingRefs({ tool: "edit", input, refs: known, locate, read })).toEqual([]);
  expect(await check("edit", { input: "[src/a.md#1234]\nPUT 1:\n+plain" })).toEqual([]);
  expect(await check("edit", { input: "[src/a.md#1234]\nCUT 2=3\nPUT 1:\n+plain" })).toEqual([]);
});

test("removed and context lines of a patch are not added text", async () => {
  const input = { input: "*** Update File: src/a.ts\n-demo#ab3d old\n context demo#ab3d\n+clean" };
  expect(await check("apply_patch", input)).toEqual([]);
});

test("kata's own command bodies are not checked", async () => {
  expect(await check("bash", { command: `kata comment demo#ab3d -m "done, see demo#k9m2"` })).toEqual([]);
  expect(await check("bash", { command: `kata close demo#ab3d --done --message "fixed demo#ab3d in the parser" --test "bun test"` })).toEqual([]);
  expect(await check("bash", { command: `git commit -m "fix" && kata comment demo#ab3d -m "ok"` })).toEqual([]);
});

test("a commit message in a heredoc is checked when git reads it from stdin", async () => {
  const body = "subject\n\nCloses demo#k9m2\n";
  expect(await check("bash", { command: `git commit -F - <<'EOF'\n${body}EOF` })).toEqual(["demo#k9m2"]);
  expect(await check("bash", { command: `git commit --file - <<EOF\n${body}EOF\n` })).toEqual(["demo#k9m2"]);
  expect(await check("bash", { command: `git commit -m "$(cat <<'EOF'\n${body}EOF\n)"` })).toEqual(["demo#k9m2"]);
  expect(await check("bash", { command: `cat > notes.txt <<'EOF'\n${body}EOF` })).toEqual([]);
  expect(await check("bash", { command: `git -C /work commit -m "demo#ab3d"` })).toEqual(["demo#ab3d"]);
  expect(await check("bash", { command: `git log --grep demo#ab3d` })).toEqual([]);
});

test("files outside the workspace and internal URLs are not repository content", async () => {
  const text = "demo#ab3d";
  expect(await check("write", { path: "/tmp/scratch.md", content: text })).toEqual([]);
  expect(await check("write", { path: "local://notes.md", content: text })).toEqual([]);
  expect(await check("write", { path: "agent://1/out", content: text })).toEqual([]);
  expect(await check("ast_edit", { ops: [{ pat: "a", out: text }], paths: ["/tmp/x"] })).toEqual([]);
  expect(await check("edit", { input: `[/tmp/a.md#1a2b]\nPUT 1:\n+${text}` })).toEqual([]);
});

test("a session that knows no refs refuses nothing", async () => {
  expect(await offendingRefs({ tool: "write", input: { path: "src/a.ts", content: "demo#ab3d" }, refs: new Set(), locate, read })).toEqual([]);
});

test("a ref the file or the replaced text already holds is not added", async () => {
  files["src/held.md"] = "see demo#ab3d for details\n";
  expect(await check("write", { path: "src/held.md", content: "see demo#ab3d for more details\n" })).toEqual([]);
  expect(await check("write", { path: "src/held.md", content: "see demo#ab3d and demo#k9m2\n" })).toEqual(["demo#k9m2"]);
  expect(await check("edit", { path: "src/held.md", old_string: "see demo#ab3d for", new_string: "read demo#ab3d for" })).toEqual([]);
  expect(await check("edit", { path: "src/held.md", edits: [{ oldText: "demo#ab3d", newText: "demo#ab3d and demo#k9m2" }] })).toEqual(["demo#k9m2"]);
  expect(await check("edit", { path: "src/held.md", oldString: "ab3d", newString: "ab3d ab3d" })).toEqual([]);
  expect(await check("edit", { input: "[src/held.md#1a2b]\nPUT 1.=1:\n+see demo#ab3d for more\n" })).toEqual([]);
  expect(await check("apply_patch", { input: "*** Update File: src/held.md\n-see demo#ab3d for details\n+see demo#ab3d for more\n" })).toEqual([]);
  expect(await check("edit", { path: "src/held.md", old_string: "details", new_string: "demo#ab3d details" })).toEqual(["demo#ab3d"]);
});

test("a leading ~ is the home folder, not a folder of the workspace", async () => {
  const located: string[] = [];
  const home = async (file: string) => { located.push(file); return file.startsWith("~") ? undefined : file; };
  expect(await offendingRefs({ tool: "write", input: { path: "~/notes.md", content: "demo#ab3d" }, refs, locate: home, read })).toEqual([]);
  expect(located).toEqual(["~/notes.md"]);
});

test("a created file's patch body is checked whole, an updated file's only by its + rows", async () => {
  expect(await check("edit", { path: "src/new.ts", edits: [{ op: "create", diff: "// demo#ab3d\nplain\n" }] })).toEqual(["demo#ab3d"]);
  expect(await check("edit", { path: "src/a.ts", edits: [{ op: "update", diff: " demo#ab3d context\n-demo#k9m2 gone\n+plain" }] })).toEqual([]);
  expect(await check("edit", { path: "src/a.ts", edits: [{ op: "update", diff: "+demo#k9m2 added" }] })).toEqual(["demo#k9m2"]);
});

test("a commit behind env, command, time, if or ! is checked", async () => {
  for (const command of [`env GIT_X=1 git commit -m "demo#ab3d"`, `command git commit -m "demo#ab3d"`, `time git commit -m "demo#ab3d"`, `if git commit -m "demo#ab3d"; then echo ok; fi`, `! git commit -m "demo#ab3d"`])
    expect(await check("bash", { command }), command).toEqual(["demo#ab3d"]);
});

test("a heredoc body belongs to the command whose line holds its <<", async () => {
  expect(await check("bash", { command: "git commit -F - <<'EOF' && git push\nCloses demo#k9m2\nEOF" })).toEqual(["demo#k9m2"]);
  expect(await check("bash", { command: "git push && cat <<'EOF' | git commit -F -\nCloses demo#k9m2\nEOF" })).toEqual(["demo#k9m2"]);
  expect(await check("bash", { command: "git commit -m fix && cat <<'EOF'\nCloses demo#k9m2\nEOF" })).toEqual([]);
});

test("only the commit message is checked, in a workspace repo", async () => {
  expect(await check("bash", { command: `git commit --author "ab3d <a@b.c>" --trailer "Ref: demo#k9m2" -m "fix" ab3d.ts` })).toEqual([]);
  expect(await check("bash", { command: `git commit -m "fix" -- ab3d.ts` })).toEqual([]);
  expect(await check("bash", { command: `git commit --message=demo#ab3d` })).toEqual(["demo#ab3d"]);
  expect(await check("bash", { command: `git -C /tmp/elsewhere commit -m "demo#ab3d"` })).toEqual([]);
  expect(await check("bash", { command: `git -C /work commit -m "demo#ab3d"` })).toEqual(["demo#ab3d"]);
});
