import { expect, test } from "bun:test";
import { offendingRefs } from "../core/ref-guard";
import { assertIsolated } from "./isolation";
assertIsolated();

// The matcher on its own: which known refs a tool call would put into files under /work.
const refs = new Set(["demo#ab3d", "demo#k9m2"]);
const projects = new Set(["demo"]);
const inWorkspace = async (file: string) => file.startsWith("/work/") || file.startsWith("src/");
const check = (tool: string, input: unknown, known = refs) => offendingRefs({ tool, input, refs: known, projects, inWorkspace });

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
  expect(await offendingRefs({ tool: "edit", input, refs: known, projects: new Set(["a.md"]), inWorkspace })).toEqual([]);
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
  expect(await offendingRefs({ tool: "write", input: { path: "src/a.ts", content: "demo#ab3d" }, refs: new Set(), projects: new Set(), inWorkspace })).toEqual([]);
});
