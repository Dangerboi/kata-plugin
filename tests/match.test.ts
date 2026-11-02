import { expect, test } from "bun:test";
import { itemTicket, matchDelegation, namedTargets, namedTasks, QUALIFIED_REF, qualifiedRefs, taskTokens, type Status, type Task } from "../core/kata-core";

const task = (ref: string, content: string, status: Status = "pending", extra: Partial<Task> = {}): Task => ({ ref, content, phase: "Tasks", status, ...extra });
const pick = (tasks: Task[], text: string, unavailable: string[] = [], single = true) => matchDelegation(tasks, text, { unavailable: new Set(unavailable), single })?.ref;

// Spawn texts from the 2026-10-19 eval, where every binding went wrong.
const omp = [
  task("e#53ab", "Implement word_count and top_words in textstats", "in_progress"),
  task("e#3ke1", "Write unittest suite covering word_count, top_words, and empty input"),
  task("e#run1", "Run the test suite with python3 -m unittest"),
  task("e#cmt1", "Commit the work"),
];
const pi = [
  task("p#vd94", "Implement word_count and top_words", "in_progress"),
  task("p#4kwf", "Delegate: subagent writes unittest suite in tests/ for both functions"),
  task("p#run2", "Run python3 -m unittest"),
];

test("eval delegations bind the tests task, never the lead's active task", () => {
  expect(pick(omp, "WriteTests\nWrite the textstats unittest suite in tests/ per the contract above")).toBe("e#3ke1");
  expect(pick(pi, "You are a test writer. Write a unittest suite in tests/test_textstats.py covering word_count and top_words including empty input.")).toBe("p#4kwf");
  expect(pick(omp, "Reply with exactly: SUBAGENT-OK")).toBeUndefined();
});

// The 2026-10-20 re-eval: a long spec overlaps the run task too ("Do NOT run
// the suite ... repo root"); omp's short task name decides it.
const rerun = [
  task("r#4mpk", "Implement word_count and top_words in textstats/__init__.py", "in_progress"),
  task("r#t3st", "Write unittest suite in tests/ covering both functions incl. empty input (delegated to subagent)"),
  task("r#rvn2", "Run python3 -m unittest from repo root, all green"),
  task("r#cm7t", "Commit functions and tests"),
];
const rerunSpec = "# Target\nCreate `tests/__init__.py` (empty file) and `tests/test_textstats.py` in the current repo workspace. Do NOT create or modify anything else \u2014 in particular do NOT touch or create the `textstats/` package; its implementation lands in parallel and importing it now may fail.\n\n# Change\n1. `tests/__init__.py` \u2014 empty, so `python3 -m unittest` discovery from the repo root finds the suite.\n2. `tests/test_textstats.py` \u2014 unittest suite (e.g. TestWordCount, TestTopWords classes) covering: empty string and whitespace-only input for BOTH functions; basic multi-word counts; tabs/newlines/repeated spaces as separators; mixed-case collapsing to lowercase; tie-breaking alphabetical by word; `n == 0`; `n` greater than the number of distinct words; exact ordering of the returned list of tuples. Deterministic, stdlib only, no file/network I/O.\n\n# Acceptance\nBoth files exist and `python3 -m py_compile tests/test_textstats.py` succeeds. Do NOT run the suite against the package (implementation is mid-flight); a failing import at this stage is expected, not yours to fix.";
test("a long delegation spec binds by its task name", () => {
  expect(matchDelegation(rerun, rerunSpec, { label: "WriteTests" })?.ref).toBe("r#t3st");
  expect(matchDelegation(rerun, rerunSpec, { label: "RunUnittest" })?.ref).toBe("r#rvn2");
  expect(matchDelegation(rerun, rerunSpec)?.ref).toBe("r#t3st"); // without a name, the task marked for delegation
});

test("exact titles, qualified refs and bare short ids bind directly", () => {
  expect(pick(omp, `Do "${omp[3].content}" now`)).toBe("e#cmt1");
  expect(pick(omp, "Work on e#run1")).toBe("e#run1");
  expect(pick([...pi, task("p#7x3g", "Write tests for textstats")], "read issue 7x3g and write tests/test_textstats.py")).toBe("p#7x3g");
});

test("a short title inside a longer one does not count as naming it", () => {
  const plan = [task("m#t1ab", "Write tests"), task("m#t2ab", "Write tests for parser edge cases"), task("m#t3ab", "Implement parser", "in_progress")];
  expect(pick(plan, "Write tests for the parser edge cases")).toBe("m#t2ab");
  expect(pick(plan, 'Complete "Write tests for parser edge cases"')).toBe("m#t2ab");
  expect(pick(plan, 'Do "Write tests" now')).toBe("m#t1ab");
});

test("a named task that is taken binds nothing else", () => {
  const plan = [task("x#aa11", "Write widget tests", "in_progress", { delegated: true }), task("x#bb22", "Write widget test docs")];
  expect(namedTasks(plan, 'Complete "Write widget tests"').map(t => t.ref)).toEqual(["x#aa11"]);
  expect(pick(plan, 'Complete "Write widget tests"')).toBeUndefined();
  expect(pick(plan, "continue task aa11 and write the widget test docs")).toBeUndefined();
  expect(pick([task("y#cc33", "Write gadget tests"), task("y#dd44", "Write gadget test docs")], 'Complete "Write gadget tests"', ["y#cc33"])).toBeUndefined();
});

test("a short id only counts as a whole word after a marker", () => {
  const plan = [task("m#resh", "Implement cache"), task("m#erjg", "Write cache tests")];
  expect(namedTasks(plan, "refresh the cache")).toEqual([]);
  expect(namedTasks(plan, "see other#erjg first")).toEqual([]);
  expect(namedTasks(plan, "this is kata issue erjg").map(t => t.ref)).toEqual(["m#erjg"]);
  expect(namedTasks(plan, "work on #erjg").map(t => t.ref)).toEqual(["m#erjg"]);
});

test("qualified refs are found as whole tokens, distinct and in order", () => {
  expect(qualifiedRefs("see kata-plugin#bc7q, then (v2.test#ce9x). Again kata-plugin#bc7q!")).toEqual(["kata-plugin#bc7q", "v2.test#ce9x"]);
  expect(qualifiedRefs("kata-plugin#bc7q: write the script")).toEqual(["kata-plugin#bc7q"]);
});

test("only a project name with a valid short id is a qualified ref", () => {
  expect(qualifiedRefs("bc7q and #bc7q and kata#abc kata#abcu kata#ABCD")).toEqual([]);
  expect(qualifiedRefs("kata#abcde1x extra")).toEqual(["kata#abcde1x"]);
  expect(qualifiedRefs(`kata#${"a".repeat(27)}`)).toEqual([]);
  expect(qualifiedRefs("kata#bc7q-2 and kata#bc7qX")).toEqual([]);
});

test("the ref grammar parses a strict prefix", () => {
  const prefix = new RegExp(`^${QUALIFIED_REF}`);
  expect(prefix.exec("kata-plugin#bc7q: write the script")?.[0]).toBe("kata-plugin#bc7q");
  expect(prefix.exec("do kata-plugin#bc7q: write the script")).toBeNull();
  expect(prefix.exec("bc7q: write the script")).toBeNull();
});

test("an explicit ref wins over a better word overlap", () => {
  const plan = [task("w#aa11", "Write widget tests"), task("w#bb22", "Write widget docs")];
  expect(pick(plan, "Write the widget tests (w#bb22 covers it)")).toBe("w#bb22");
  expect(pick(plan, "Please write the widget tests for the parser: w#bb22.")).toBe("w#bb22");
});

test("a text naming several plan tasks binds none, whatever the overlap", () => {
  const plan = [task("w#aa11", "Write widget tests"), task("w#bb22", "Write widget docs"), task("w#cc33", "Write widget tests for parser edge cases")];
  expect(pick(plan, "Write widget tests for w#bb22 and w#aa11")).toBeUndefined();
  expect(pick(plan, "Write widget tests and then Write widget docs", [], false)).toBeUndefined();
  expect(pick(plan, 'Do "Write widget tests" and "Write widget docs"')).toBeUndefined();
});

test("tickets outside the plan are named targets, and the plan parent is not", () => {
  const plan = [task("w#aa11", "Write widget tests")];
  expect(namedTargets(plan, "work on other#zz99 now", "w#pa4e")).toEqual({ tasks: [], tickets: ["other#zz99"] });
  expect(namedTargets(plan, "w#aa11 and other#zz99", "w#pa4e")).toMatchObject({ tickets: ["other#zz99"], tasks: [{ ref: "w#aa11" }] });
  expect(namedTargets(plan, "inside w#pa4e do w#aa11", "w#pa4e")).toMatchObject({ tickets: [], tasks: [{ ref: "w#aa11" }] });
  expect(namedTargets(plan, "Reply with exactly: OK").tickets).toEqual([]);
});

// The 2026-10-20 third run: a short spec that also says "then run python3 -m
// unittest", with the plan task marked for delegation.
test("the one task marked for delegation takes a single related delegation", () => {
  const plan = [
    task("d#4mpk", "Implement word_count and top_words in textstats/__init__.py", "in_progress"),
    task("d#t3st", "Delegate unittest suite for word_count/top_words (incl. empty input) to subagent"),
    task("d#rvn2", "Run python3 -m unittest and fix any failures"),
    task("d#cm7t", "Commit work and summarize"),
  ];
  const spec = "Write tests/test_textstats.py unittest suite for textstats.word_count and textstats.top_words per the contract, then run python3 -m unittest and report results.";
  expect(matchDelegation(plan, spec, { label: "TestWriter" })?.ref).toBe("d#t3st");
  expect(matchDelegation(plan, "Reply with exactly: SUBAGENT-OK")).toBeUndefined();
  expect(matchDelegation(plan, spec, { label: "TestWriter", single: false })?.ref).not.toBe("d#4mpk");
});

test("the active task is a fallback only for an explicit current-task handoff", () => {
  const plan = [task("a#1", "Implement widget", "in_progress"), task("a#2", "Write widget tests")];
  expect(pick(plan, "Complete the current task and commit it.")).toBe("a#1");
  expect(pick(plan, "Complete the current task and commit it.", [], false)).toBeUndefined();
  expect(pick(plan, "Commit it.")).toBeUndefined();
});

test("ambiguous overlaps create a separate child instead of guessing", () => {
  expect(pick([task("c#1", "Write API tests"), task("c#2", "Write UI tests")], "Write the tests")).toBeUndefined();
  expect(pick([task("b#1", "Build alpha"), task("b#2", "Build beta")], "BuildBeta\ngo")).toBe("b#2");
});

test("tokens split camelCase, keep snake_case and count unittest as test", () => {
  expect(taskTokens("WriteTests for word_count")).toEqual(["write", "test", "word_count"]);
  expect(taskTokens("unittest suite")).toEqual(["unittest", "test", "suite"]);
});

// Property: whatever the text, the match is one available, open, unblocked,
// undelegated task. Seeded so a failure reproduces.
test("matches are always available open tasks", () => {
  let seed = 20261019;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const words = ["write", "tests", "implement", "widget", "run", "suite", "word_count", "commit", "docs", "current", "task", "build", "alpha"];
  const statuses: Status[] = ["pending", "in_progress", "blocked", "completed", "abandoned"];
  const phrase = (n: number) => Array.from({ length: n }, () => words[Math.floor(random() * words.length)]).join(" ");
  for (let run = 0; run < 2000; run++) {
    const tasks = Array.from({ length: 1 + Math.floor(random() * 5) }, (_, i) =>
      task(`r#t${i}`, phrase(1 + Math.floor(random() * 4)), statuses[Math.floor(random() * statuses.length)], { delegated: random() < 0.2 }));
    const unavailable = tasks.filter(() => random() < 0.2).map(t => t.ref);
    const ref = pick(tasks, phrase(Math.floor(random() * 6)), unavailable, random() < 0.7);
    if (!ref) continue;
    const chosen = tasks.find(t => t.ref === ref)!;
    expect(["pending", "in_progress"]).toContain(chosen.status);
    expect(chosen.delegated).toBe(false);
    expect(unavailable).not.toContain(ref);
  }
});

test("an item names a ticket only with a qualified ref prefix and a colon", () => {
  expect(itemTicket("kata-plugin#bc6m: write the real-omp smoke script")).toEqual({ ref: "kata-plugin#bc6m", action: "write the real-omp smoke script" });
  expect(itemTicket("  other.proj#ce3w:   fetch inbox\neach turn")).toEqual({ ref: "other.proj#ce3w", action: "fetch inbox\neach turn" });
  for (const text of ["bc6m: write the script", "write the script for kata-plugin#bc6m", "see kata-plugin#bc6m: write", "kata-plugin#bc6m write the script",
    "kata-plugin#bc6m:", "kata-plugin#bc6m:write", "kata-plugin#bcl6: write", "update CHANGELOG", "#bc6m: write"]) expect(itemTicket(text)).toBeUndefined();
});
