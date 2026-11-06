// Which plan parent, and which workspace, a plan serves. A pure decision over
// the sources the core gathers; it never reads the environment or calls Kata.
// Reachability of Kata (the core's `scope`) and the local plan stay outside.
import path from "node:path";

// A plan parent remembered from an earlier bind: the session's saved state, the
// fork source's, or an automatic parent found in Kata by session id.
export type SavedParent = { parent: string; workspace?: string; sessionId?: string; auto?: boolean; label?: string };

export type ParentSources = {
	cwd: string; // the session's cwd at bind time
	assigned?: { ref?: string; workspace?: string }; // an omp delegate's assignment
	explicit?: string; // the `explicitRef` option, else KATA_REF
	initRef?: string; // the `ref` of an init
	stored?: SavedParent; // the session's own snapshot, else the fork source's
	session?: () => Promise<SavedParent | undefined>; // asked only when nothing earlier decides
};

export type PlanParent = {
	// The parent that decided it, or none: a plan of only ticket items has no parent.
	parent?: string;
	provenance: "assigned" | "explicit" | "init" | "stored" | "session" | "none";
	// Always defined: the session's cwd when no parent says otherwise.
	workspace: string;
	// What the stored or session-found parent remembered (owner, automatic, label).
	saved?: SavedParent;
	// An init `ref` an explicit ref beat; the caller refuses it if it names another issue.
	overridden?: string;
};

export const isExplicitParent = (choice: PlanParent) => choice.provenance === "assigned" || choice.provenance === "explicit" || choice.provenance === "init";

// The explicit sources alone: an assignment, then `explicit`, then init's `ref`.
export function explicitParent({ cwd, assigned, explicit, initRef }: ParentSources): PlanParent | undefined {
	const here = path.resolve(cwd);
	if (assigned?.ref) return { parent: assigned.ref, provenance: "assigned", workspace: assigned.workspace || here, overridden: initRef };
	if (explicit) return { parent: explicit, provenance: "explicit", workspace: here, overridden: initRef };
	if (initRef) return { parent: initRef, provenance: "init", workspace: here };
}

export async function decidePlanParent(sources: ParentSources): Promise<PlanParent> {
	const explicit = explicitParent(sources);
	if (explicit) return explicit;
	const here = path.resolve(sources.cwd);
	if (sources.stored?.parent) return { parent: sources.stored.parent, provenance: "stored", workspace: sources.stored.workspace || here, saved: sources.stored };
	const found = await sources.session?.();
	if (found) return { parent: found.parent, provenance: "session", workspace: found.workspace || here, saved: found };
	return { provenance: "none", workspace: here };
}

// Whether `ref` names the plan parent: its current ref, a former ref from
// before `kata move`, or its short id alone.
export function namesPlanParent(parent: string | undefined, former: ReadonlySet<string>, ref: string): boolean {
	if (!parent) return false;
	return ref.includes("#") ? ref === parent || former.has(ref) : parent.split("#").pop() === ref;
}
