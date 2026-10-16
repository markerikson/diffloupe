import { describe, expect, test } from "bun:test";
import { mergePrompt, slicePrompt } from "./prompts.ts";

const intent = { title: "t", body: "b", commits: "c" };
const slice = (instructions?: string) =>
  slicePrompt({
    unit: { id: "u", title: "Unit", files: ["a.ts"] },
    diff: "",
    intent,
    registry: "",
    prior: "",
    mapNote: "",
    outFile: "/tmp/out.json",
    ...(instructions !== undefined ? { instructions } : {}),
  });
const merge = (instructions?: string) =>
  mergePrompt({
    findings: [],
    intent,
    files: ["a.ts"],
    prior: "",
    outFile: "/tmp/out.json",
    ...(instructions !== undefined ? { instructions } : {}),
  });

describe("repo instructions", () => {
  test("reach both the reviewers and the coordinator", () => {
    const text = "Recorded tables are append-only.";
    for (const prompt of [slice(text), merge(text)]) {
      expect(prompt).toContain("## Instructions for reviewing this repository");
      expect(prompt).toContain(text);
    }
  });

  test("leave no section when absent or blank", () => {
    for (const prompt of [slice(), slice("  "), merge(), merge("")]) {
      expect(prompt).not.toContain("Instructions for reviewing this repository");
    }
  });
});
