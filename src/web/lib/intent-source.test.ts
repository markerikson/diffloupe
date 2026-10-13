import { describe, expect, test } from "bun:test";
import type { ReviewTarget } from "../../types/review-run.ts";
import { intentSource } from "./intent-source.ts";

const pr: ReviewTarget = {
  kind: "pr",
  number: 1,
  url: "https://github.com/o/r/pull/1",
  title: "t",
  author: "a",
  baseRef: "main",
  headRef: "feature",
  state: "OPEN",
  isDraft: false,
};
const range: ReviewTarget = { kind: "range", spec: "a..b" };
const worktree: ReviewTarget = { kind: "worktree", branch: "main" };

describe("intentSource", () => {
  test("names what the intent was compared against", () => {
    expect(intentSource({ target: pr, intent: {} })).toBe("the description");
    expect(intentSource({ target: range, intent: {} })).toBe("the commit messages");
    expect(intentSource({ target: range, intent: { stated: "x" } })).toBe("the stated intent and commit messages");
    expect(intentSource({ target: worktree, intent: { stated: "x" } })).toBe("the stated intent");
  });

  test("is undefined when nothing was stated", () => {
    expect(intentSource({ target: worktree, intent: {} })).toBeUndefined();
    expect(intentSource({ target: { kind: "staged" }, intent: {} })).toBeUndefined();
  });
});
