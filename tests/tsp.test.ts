import { expect, test } from "bun:test";
import { describeTodoResult, todoWidget } from "../plugins/oh-my-pi/tsp";

const view = {
  parent: "proj#p1", workspace: "/w",
  phases: [
    { name: "Build", tasks: [
      { content: "Write it", status: "completed" as const, ref: "proj#a1" },
      { content: "Skip it", status: "abandoned" as const, ref: "proj#a2" },
    ] },
    { name: "Ship", tasks: [
      { content: "Release it", status: "in_progress" as const, ref: "proj#b1" },
      { content: "Announce it", status: "blocked" as const, ref: "other#t9", blocker: "Waiting on legal" },
      { content: "Celebrate", status: "pending" as const, ref: "proj#b3" },
    ] },
  ],
};
const result = (details: any, text = "plan", isError?: boolean) => ({ content: [{ type: "text", text }], details, ...(isError ? { isError } : {}) });

test("the native todo card counts dropped tasks as closed, maps each status, and keeps blockers and refs", () => {
  const card: any = describeTodoResult(result({ op: "view", kata: view }));
  expect(card.tool).toMatchObject({ title: "Todo", target: "2/5", meta: ["proj#p1"] });
  const [build, ship] = card.body.at(-1).p.phases;
  expect(build.collapsed).toBe(true);
  expect(ship.collapsed).toBeUndefined();
  expect([...build.items, ...ship.items].map((item: any) => item.status)).toEqual(["done", "dropped", "active", "blocked", "pending"]);
  expect(ship.items[1]).toMatchObject({ text: [{ t: "Announce it" }, { t: "  other#t9", s: "muted" }], note: "Waiting on legal" });
});

test("the native todo card shows the text before the plan, in error tone for a failed call, and a planless result's text", () => {
  const failed: any = describeTodoResult(result({ op: "done", kata: { ...view, notice: "Kata needs evidence" } }, "Kata needs evidence\n\nplan", true));
  expect(failed.tone).toBe("error");
  expect(failed.body[0].p.spans).toEqual([{ t: "Kata needs evidence", s: "error" }]);
  expect(failed.body[1].k).toBe("checklist");
  const empty: any = describeTodoResult(result({ op: "view", kata: { phases: [] } }, "No todo plan. Use todo op=init."));
  expect(empty.body).toEqual([{ k: "text", p: { spans: [{ t: "No todo plan. Use todo op=init.", s: "muted" }], wrap: "word" } }]);
});

test("the widget is the dock checklist only where the terminal draws checklists, and the summary line elsewhere", () => {
  class Text { constructor(public text: string) {} describe?: (cx: any) => unknown; }
  const component = (todoWidget(Text, "Kata proj#p1 · 1/5 done", view) as () => Text)();
  expect(component.text).toBe("Kata proj#p1 · 1/5 done");
  const hud: any = component.describe!({ supports: (kind: string) => kind === "checklist" });
  expect(hud.p).toMatchObject({ mode: "hud", role: "omp.hud.todo" });
  expect(hud.p.phases.map((phase: any) => phase.title)).toEqual(["I. Build", "II. Ship"]);
  expect(hud.p.phases[1].items[0].text).toBe("Release it");
  expect(component.describe!({ supports: () => false })).toBeNull();
  expect(todoWidget(undefined, "Kata proj#p1 · 1/5 done", view)).toEqual(["Kata proj#p1 · 1/5 done"]);
});
