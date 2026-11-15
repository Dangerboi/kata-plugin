import { expect, test } from "bun:test";
import { itemTicket, qualifiedRefs, type Status, type Task } from "../core/model";
import { namedTargets, namedTasks, Refusal, resolve } from "../core/delegates";

const task = (ref: string, content: string, status: Status = "pending", extra: Partial<Task> = {}): Task => ({ ref, content, phase: "Tasks", status, ...extra });
const NONE: ReadonlySet<string> = new Set();
// What a text works in a plan of these tasks: the ref resolve() decides, or nothing when it names nothing or is refused.
function pick(tasks: Task[], text: string, unavailable: string[] = [], parent?: string) {
  try { return resolve(text, { tasks, parent }, new Set(unavailable), NONE).ref; }
  catch (error) { if (error instanceof Refusal) return undefined; throw error; }
}

// Spawn texts from the 2026-10-19 eval: they describe a plan task without naming it.
const omp = [
  task("e#53ab", "Implement word_count and top_words in textstats", "in_progress"),
  task("e#3ke1", "Write unittest suite covering word_count, top_words, and empty input"),
  task("e#run1", "Run the test suite with python3 -m unittest"),
  task("e#cmt1", "Commit the work"),
];

test("a spawn that only describes a task binds nothing, whatever its words or name", () => {
  expect(pick(omp, "WriteTests\nWrite the textstats unittest suite in tests/ per the contract above")).toBeUndefined();
  expect(pick(omp, "Write the textstats unittest suite, then run python3 -m unittest.\nWriteTests")).toBeUndefined();
  expect(pick(omp, "Complete the current task and commit it.")).toBeUndefined();
  expect(pick(omp, "Reply with exactly: SUBAGENT-OK")).toBeUndefined();
});

test("exact titles, qualified refs and bare short ids bind directly", () => {
  expect(pick(omp, `Do "${omp[3].content}" now`)).toBe("e#cmt1");
  expect(pick(omp, "Work on e#run1")).toBe("e#run1");
  expect(pick([...omp, task("p#7x3g", "Write tests for textstats")], "read issue 7x3g and write tests/test_textstats.py")).toBe("p#7x3g");
});

test("a short title inside a longer one does not count as naming it", () => {
  const plan = [task("m#t1ab", "Write tests"), task("m#t2ab", "Write tests for parser edge cases"), task("m#t3ab", "Implement parser", "in_progress")];
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

test("a ticket item's ticket is worked when the item is named by title or by the ticket's ref, not as the plan parent, and not once the ticket is taken", () => {
  const epic = task("item:epic", "k#epc1: full suite, deep-review rounds until clean", "pending", { ticket: "k#epc1" });
  expect(resolve(`Work "${epic.content}"`, { tasks: [epic] }, NONE, NONE)).toEqual({ ref: "k#epc1", ticket: true, title: "full suite, deep-review rounds until clean" });
  expect(pick([epic], "Work k#epc1 in the background")).toBe("k#epc1");
  expect(pick([epic], "Review the diff; the plan parent is k#epc1.", [], "k#epc1")).toBeUndefined();
  expect(pick([epic], `Work "${epic.content}"`, ["k#epc1"])).toBeUndefined();
});

test("an item named only by a ref hides no other named item", () => {
  const plain = task("p#pa11", "write the parser"), docs = task("item:doc", "p#abcd: write the parser docs", "pending", { ticket: "p#abcd" });
  expect(namedTasks([plain, docs], "Write the parser. See p#abcd for the API.").map(t => t.ref).sort()).toEqual(["item:doc", "p#pa11"]);
  const short = task("item:fix", "p#abcd: fix parser", "pending", { ticket: "p#abcd" }), long = task("item:fxt", "p#abcd: fix parser tests", "pending", { ticket: "p#abcd" });
  expect(() => resolve("Handle p#abcd", { tasks: [short, long] }, NONE, NONE)).toThrow(/other open plan items name it/);
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

test("qualifiedRefs counts only refs of the given registered projects", () => {
  const projects = new Set(["kata-plugin", "other.proj"]);
  expect(qualifiedRefs("Fix README.md#tasks and CHANGELOG.md#added", projects)).toEqual([]);
  expect(qualifiedRefs("see kata-plugin#bc7q and README.md#tasks and other.proj#ce9x", projects)).toEqual(["kata-plugin#bc7q", "other.proj#ce9x"]);
});

test("a ref binds even when the text also describes another task", () => {
  const plan = [task("w#aa11", "Write widget tests"), task("w#bb22", "Write widget docs")];
  expect(pick(plan, "Write the widget tests (w#bb22 covers it)")).toBe("w#bb22");
  expect(pick(plan, "Please write the widget tests for the parser: w#bb22.")).toBe("w#bb22");
});

test("a text naming several plan tasks binds none", () => {
  const plan = [task("w#aa11", "Write widget tests"), task("w#bb22", "Write widget docs"), task("w#cc33", "Write widget tests for parser edge cases")];
  expect(pick(plan, "Write widget tests for w#bb22 and w#aa11")).toBeUndefined();
  expect(pick(plan, "Write widget tests and then Write widget docs")).toBeUndefined();
  expect(pick(plan, 'Do "Write widget tests" and "Write widget docs"')).toBeUndefined();
});

test("tickets outside the plan are named targets, and the plan parent is not", () => {
  const plan = [task("w#aa11", "Write widget tests")];
  const all = new Set(["w", "other"]);
  expect(namedTargets(plan, "work on other#zz99 now", all, "w#pa4e")).toEqual({ tasks: [], tickets: ["other#zz99"] });
  expect(namedTargets(plan, "w#aa11 and other#zz99", all, "w#pa4e")).toMatchObject({ tickets: ["other#zz99"], tasks: [{ ref: "w#aa11" }] });
  expect(namedTargets(plan, "inside w#pa4e do w#aa11", all, "w#pa4e")).toMatchObject({ tickets: [], tasks: [{ ref: "w#aa11" }] });
  expect(namedTargets(plan, "Reply with exactly: OK", all).tickets).toEqual([]);
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
    const ref = pick(tasks, phrase(Math.floor(random() * 6)), unavailable);
    if (!ref) continue;
    const chosen = tasks.find(t => t.ref === ref)!;
    expect(["pending", "in_progress"]).toContain(chosen.status);
    expect(chosen.delegated).toBe(false);
    expect(unavailable).not.toContain(ref);
  }
});

test("an item names a ticket only with a qualified ref prefix and a colon", () => {
  expect(itemTicket("kata-plugin#bc7q: write the smoke script")).toEqual({ ref: "kata-plugin#bc7q", action: "write the smoke script" });
  expect(itemTicket("  other.proj#ce9x:   fetch inbox\neach turn")).toEqual({ ref: "other.proj#ce9x", action: "fetch inbox\neach turn" });
  for (const text of ["bc7q: write the script", "write the script for kata-plugin#bc7q", "see kata-plugin#bc7q: write", "kata-plugin#bc7q write the script",
    "kata-plugin#bc7q:", "kata-plugin#bc7q:write", "kata-plugin#abl6: write", "update CHANGELOG", "#bc7q: write"]) expect(itemTicket(text)).toBeUndefined();
});

test("a task another session started is never matched to a delegate", () => {
  const tasks = [task("s#held", "Write the parser tests", "in_progress", { holder: "session-a" }), task("s#free", "Write the parser docs")];
  expect(pick(tasks, "Write the parser tests")).toBeUndefined();
  expect(pick(tasks, "Write the parser docs")).toBe("s#free");
});
