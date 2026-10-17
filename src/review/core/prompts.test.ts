import { describe, expect, test } from "bun:test";
import { resetRunState, setRunState } from "./config.ts";
import { instructionsHash, mergePrompt, promptVersion, SINCE_LAST_FOCUS, slicePrompt } from "./prompts.ts";

describe("prompt version", () => {
  test("is stable, follows the system prompt, and ignores the repository name", () => {
    const v = promptVersion("system");
    expect(v).toMatch(/^[0-9a-f]{12}$/);
    expect(promptVersion("system")).toBe(v);
    expect(promptVersion("other")).not.toBe(v);
    setRunState({ repoName: "acme/widgets" });
    try {
      expect(promptVersion("system")).toBe(v);
    } finally {
      resetRunState();
    }
  });

  test("instructions hash ignores surrounding whitespace and is absent without instructions", () => {
    expect(instructionsHash(" do X ")).toBe(instructionsHash("do X"));
    expect(instructionsHash("  ")).toBeUndefined();
    expect(instructionsHash(undefined)).toBeUndefined();
  });
});

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

describe("pre-existing hint", () => {
  const f = (line: number) => ({
    file: "a.ts",
    line,
    severity: "should-fix" as const,
    category: "bug",
    title: `at ${line}`,
    explanation: "e",
    evidence: "v",
    confidence: "high" as const,
  });

  test("marks only findings whose cited line is outside the changed hunks", () => {
    const prompt = mergePrompt({
      findings: [f(10), f(200)],
      intent,
      files: ["a.ts"],
      prior: "",
      outFile: "/tmp/out.json",
      changedLines: new Map([["a.ts", [{ start: 8, end: 12 }]]]),
    });
    expect(prompt.match(/cited line is outside the changed hunks/g)).toHaveLength(2);
    expect(prompt).toMatch(/"title": "at 200",[^}]*"hint": "cited line is outside the changed hunks"/);
    expect(prompt).not.toMatch(/"title": "at 10",[^}]*"hint"/);
  });

  test("states the separate pre-existing cap and the new-finding cap", () => {
    const prompt = mergePrompt({ findings: [], intent, files: ["a.ts"], prior: "", outFile: "/tmp/o.json", maxNew: 5 });
    expect(prompt).toContain("at most 5 new findings");
    expect(prompt).toContain("at most 3 pre-existing");
  });
});

describe("re-review", () => {
  test("slices get the changes since the last review and the focus rule", () => {
    const prompt = slicePrompt({
      unit: { id: "u", title: "Unit", files: ["a.ts"] },
      diff: "",
      intent,
      registry: "",
      prior: "",
      mapNote: "",
      outFile: "/tmp/out.json",
      sinceLast: "+const fixed = 1;",
    });
    expect(prompt).toContain("## Changes since the last review");
    expect(prompt).toContain(SINCE_LAST_FOCUS);
    expect(prompt).toContain("+const fixed = 1;");
    expect(slice()).not.toContain("## Changes since the last review");
  });

  test("the coordinator hears which files were reviewed again", () => {
    const prompt = mergePrompt({ findings: [], intent, files: ["a.ts", "b.ts"], prior: "", outFile: "/tmp/o.json", sinceLast: ["b.ts"] });
    expect(prompt).toContain("## This is a re-review");
    expect(prompt).toContain("`b.ts`");
    expect(prompt).toContain(SINCE_LAST_FOCUS);
    expect(merge()).not.toContain("## This is a re-review");
  });
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
