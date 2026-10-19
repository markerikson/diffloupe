import { describe, expect, test } from "bun:test";
import { parseIntentDraft } from "./intent-draft.ts";

describe("parseIntentDraft", () => {
  test("reads a complete draft and trims its fields", () => {
    expect(
      parseIntentDraft({ title: " Add retries ", goal: "Retries uploads.", expected_changes: ["loop", " ", 3, "config"] }),
    ).toEqual({ title: "Add retries", goal: "Retries uploads.", expected_changes: ["loop", "config"] });
  });

  test("keeps a draft whose expected changes are missing", () => {
    expect(parseIntentDraft({ title: "t", goal: "g" })).toEqual({ title: "t", goal: "g", expected_changes: [] });
  });

  test("returns undefined without a title or goal", () => {
    for (const payload of [null, undefined, [], "text", { title: "t" }, { goal: "g" }, { title: "", goal: "g" }]) {
      expect(parseIntentDraft(payload)).toBeUndefined();
    }
  });
});
