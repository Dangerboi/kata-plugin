import { expect, test } from "bun:test";
import { posix } from "node:path";
import { offendingRefs } from "../core/ref-guard";
import { assertIsolated } from "./isolation";
assertIsolated();

// The matcher on its own: which known refs a tool call would put into files under /work.
const refs = new Set(["demo#ab3d", "demo#k9m2"]);
// Files under /work or src/ are in the workspace; `files` is what they currently hold.
const files: Record<string, string> = {};
// The workspace is /work; a relative path is under it, and `..` is resolved, so a path that climbs out of it is outside.
const locate = async (file: string) => { const at = posix.resolve("/work", file); return at === "/work" || at.startsWith("/work/") ? at : undefined; };
const read = async (file: string) => { const name = file.replace(/^\/work\//, ""); if (name in files) return files[name]; throw new Error("no such file"); };
const check = (tool: string, input: unknown, known = refs) => offendingRefs({ tool, input, known: async () => known, locate, read });

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
  expect(await offendingRefs({ tool: "edit", input, known: async () => known, locate, read })).toEqual([]);
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
  expect(await offendingRefs({ tool: "write", input: { path: "src/a.ts", content: "demo#ab3d" }, known: async () => new Set(), locate, read })).toEqual([]);
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
  expect(await check("edit", { path: "src/held.md", old_string: "details", new_string: "demo#ab3d details" })).toEqual([]);
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

test("held refs are the replaced text's and the file's, for every kind of edit", async () => {
  files["src/h2.md"] = "demo#k9m2 sits elsewhere\nline two\n";
  const gone = "src/gone.md";
  files[gone] = "old demo#k9m2\n";
  expect(await check("edit", { path: "src/h2.md", old_string: "line two", new_string: "line two demo#k9m2" })).toEqual([]);
  expect(await check("edit", { path: "src/h2.md", edits: [{ oldText: "line two", newText: "demo#k9m2" }] })).toEqual([]);
  expect(await check("edit", { path: "src/h2.md", oldText: "line two", newText: "demo#k9m2" })).toEqual([]);
  expect(await check("edit", { input: "[src/h2.md#1a2b]\nPUT 2.=2:\n+demo#k9m2 two" })).toEqual([]);
  expect(await check("apply_patch", { input: "*** Update File: src/h2.md\n+demo#k9m2\n" })).toEqual([]);
  expect(await check("apply_patch", { input: `*** Update File: ${gone}\n*** Move to: src/moved.md\n+demo#k9m2 kept\n` })).toEqual([]);
  expect(await check("edit", { path: "src/h2.md", old_string: "line two", new_string: "demo#ab3d" })).toEqual(["demo#ab3d"]);
});

test("omp's sloppy edit mode is checked: the replacement text, not the find side", async () => {
  files["src/s.ts"] = "const a = 1;\n";
  const patch = (body: string) => ({ input: `*** Edit File: src/s.ts\n${body}` });
  expect(await check("edit", patch("*** Find\nconst a = 1;\n*** Replace\nconst a = 2; // demo#ab3d\n"))).toEqual(["demo#ab3d"]);
  expect(await check("edit", patch("*** Find\nconst a = 1; // demo#ab3d\n*** Replace\nconst a = 2;\n"))).toEqual([]);
  expect(await check("edit", patch("*** Find\nconst a = 1;\n*** Paste After\n// demo#k9m2\n"))).toEqual(["demo#k9m2"]);
  expect(await check("edit", patch("*** Replace Block: function f() {\n  return 1; // demo#k9m2\n}\n"))).toEqual(["demo#k9m2"]);
  expect(await check("edit", patch("*** Find\nconst a = 1;\n*** Cut\n"))).toEqual([]);
  expect(await check("edit", { input: "*** Edit File: /tmp/out.ts\n*** Find\na\n*** Replace\ndemo#ab3d\n" })).toEqual([]);
});

test("a commit runs where the bash call's cwd is, and -C is relative to it", async () => {
  const commit = `git commit -m "demo#ab3d"`;
  expect(await check("bash", { command: commit, cwd: "/tmp/elsewhere" })).toEqual([]);
  expect(await check("bash", { command: commit, cwd: "/work/sub" })).toEqual(["demo#ab3d"]);
  expect(await check("bash", { command: `git -C ../x commit -m "demo#ab3d"`, cwd: "/tmp/elsewhere" })).toEqual([]);
  expect(await check("bash", { command: `git -C sub commit -m "demo#ab3d"`, cwd: "/work" })).toEqual(["demo#ab3d"]);
});

test("a commit message attached to its flag, or given as a here-string, is checked", async () => {
  for (const command of [`git commit -m"fix demo#ab3d"`, `git commit -am"fix demo#ab3d"`, `git commit -a -m'demo#ab3d'`, `git commit -F - <<< "fix demo#ab3d"`, `git commit --file=- <<<'demo#ab3d'`])
    expect(await check("bash", { command }), command).toEqual(["demo#ab3d"]);
  expect(await check("bash", { command: `git commit -m"fix" -- ab3d.ts` })).toEqual([]);
  expect(await check("bash", { command: `git commit -F msg.txt <<< "demo#ab3d"` })).toEqual([]);
});

test("each patch format is read with its own grammar", async () => {
  files["src/s.ts"] = "x\n";
  // In a sloppy replacement a row that looks like a hashline header is text.
  expect(await check("edit", { input: "*** Edit File: src/s.ts\n*** Find\nx\n*** Replace\n[demo#ab3d]\n" })).toEqual(["demo#ab3d"]);
  // Omp matches the header loosely: case, leading space, a trailing ` all`, a JSON-quoted path.
  for (const header of ["*** edit file: src/s.ts", "  *** Edit File: src/s.ts all", '*** Edit File: "src/s.ts"'])
    expect(await check("edit", { input: `${header}\n*** Find\nx\n*** Replace\ndemo#ab3d\n` }), header).toEqual(["demo#ab3d"]);
  expect(await check("edit", { input: '*** Edit File: "/tmp/s.ts"\n*** Find\nx\n*** Replace\ndemo#ab3d\n' })).toEqual([]);
  // A sloppy patch's `+` row is not special; an apply_patch's raw row is not text.
  expect(await check("edit", { input: "*** Edit File: src/s.ts\n*** Replace\n+demo#ab3d\n" })).toEqual(["demo#ab3d"]);
  expect(await check("apply_patch", { input: "*** Begin Patch\n*** Update File: src/s.ts\n@@\n*** Replace\ndemo#ab3d\n*** End Patch" })).toEqual([]);
});

test("git -C values fold in order, and a cd moves the folder of later commands", async () => {
  const msg = `-m "demo#ab3d"`;
  expect(await check("bash", { command: `git -C /tmp/x -C /work commit ${msg}` })).toEqual(["demo#ab3d"]);
  expect(await check("bash", { command: `git -C /work -C /tmp/x commit ${msg}` })).toEqual([]);
  expect(await check("bash", { command: `git -C /work -C sub commit ${msg}` })).toEqual(["demo#ab3d"]);
  expect(await check("bash", { command: `cd /tmp/x && git commit ${msg}` })).toEqual([]);
  expect(await check("bash", { command: `cd /tmp/x; cd /work; git commit ${msg}` })).toEqual(["demo#ab3d"]);
  expect(await check("bash", { command: `cd sub && git commit ${msg}`, cwd: "/tmp/x" })).toEqual([]);
  expect(await check("bash", { command: `cd .. && git -C work commit ${msg}`, cwd: "/work/sub" })).toEqual(["demo#ab3d"]);
  expect(await check("bash", { command: `cd ../.. && git commit ${msg}`, cwd: "/work/sub" })).toEqual([]);
  expect(await check("bash", { command: `git -C ../../tmp commit ${msg}`, cwd: "/work/sub" })).toEqual([]);
});

test("a sloppy opener without a path continues the current file", async () => {
  files["src/s2.ts"] = "demo#k9m2 is here\n";
  const reps = (ref: string) => `*** Find\nx\n*** Replace\n${ref}\n`;
  // `all` alone is the flag, not a file; an empty path keeps the file too.
  expect(await check("edit", { input: `*** Edit File: src/s.ts\n*** Find\ny\n*** Edit File: all\n${reps("demo#ab3d")}` })).toEqual(["demo#ab3d"]);
  expect(await check("edit", { input: `*** Edit File: src/s.ts\n*** Find\ny\n*** Edit File: \n${reps("demo#ab3d")}` })).toEqual(["demo#ab3d"]);
  expect(await check("edit", { input: `*** Edit File: /tmp/o.ts\n${reps("demo#k9m2")}*** Edit File: all\n${reps("demo#ab3d")}` })).toEqual([]);
  expect(await check("edit", { input: `*** Edit File: src/s2.ts\n*** Find\ny\n*** Edit File:\n${reps("demo#k9m2")}` })).toEqual([]);
  expect(await check("edit", { input: `*** Edit File: src/s2.ts all\n${reps("demo#ab3d")}` })).toEqual(["demo#ab3d"]);
});

test("a sloppy action line is read as loosely as its opener", async () => {
  expect(await check("edit", { input: "*** Edit File: src/s.ts\n  *** Find\nx\n\t*** REPLACE\ndemo#ab3d\n" })).toEqual(["demo#ab3d"]);
  expect(await check("edit", { input: "*** Edit File: src/s.ts\n *** paste after\ndemo#k9m2\n" })).toEqual(["demo#k9m2"]);
  expect(await check("edit", { input: "*** Edit File: src/s.ts\n  *** Find\ndemo#ab3d\n  *** Cut\n" })).toEqual([]);
});
