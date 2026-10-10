import type { GroupsEvent } from "../server/types.ts";
import type { ReviewRun } from "../types/review-run.ts";

/** The run with the groups from a `groups` event in place of its current ones. */
export function withGroups<R extends ReviewRun>(run: R, e: GroupsEvent): R {
  const byPath = new Map(e.files.map((f) => [f.path, f]));
  return {
    ...run,
    groups: e.groups,
    files: run.files.map((f) => {
      const g = byPath.get(f.path);
      return g ? { ...f, groupId: g.groupId, classification: g.classification } : f;
    }),
  };
}

export function groupsEvent(run: Pick<ReviewRun, "groups" | "files">): GroupsEvent {
  return {
    type: "groups",
    groups: run.groups,
    files: run.files.map((f) => ({ path: f.path, groupId: f.groupId, classification: f.classification })),
  };
}
