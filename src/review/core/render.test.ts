import { describe, expect, test } from "bun:test";
import { artifactName, insertCopyBlock } from "./render.ts";
import { marker } from "./lib/marker.ts";

const summaryMarker = marker("summary", { pr: "5", runs: "1", head: "a".repeat(40) });
const summary = [
  "# Review",
  "Two findings.",
  "<details><summary>Review details</summary>",
  "",
  "stats",
  "",
  "</details>",
  "",
  summaryMarker,
].join("\n");
const findings = "# Review findings: PR #5\n\n### [blocker] Off by one";

describe("insertCopyBlock", () => {
  test("goes before the Review details fold", () => {
    const out = insertCopyBlock(summary, findings);
    const block = out.indexOf("<details><summary>Copy all findings as Markdown</summary>");
    expect(block).toBeGreaterThan(out.indexOf("Two findings."));
    expect(block).toBeLessThan(out.indexOf("<details><summary>Review details</summary>"));
    expect(out).toContain("```markdown\n# Review findings: PR #5\n\n### [blocker] Off by one\n```");
    expect(out).toEndWith(summaryMarker);
  });

  // A block cut by the comment limit would leave a code fence open and swallow
  // the rest of the comment, marker included.
  test("near the limit, a pointer to the artifact replaces the block", () => {
    const artifact = artifactName(5, "a".repeat(40));
    const out = insertCopyBlock(summary, "x".repeat(500), { artifact, limit: summary.length + 300 });
    expect(out).not.toContain("Copy all findings");
    expect(out).toContain(`download the \`ai-code-review-5-aaaaaaaaa\` artifact and open \`findings.md\``);
    expect(out.length).toBeLessThanOrEqual(summary.length + 300);
    expect(out).toEndWith(summaryMarker);
  });

  test("leaves the summary alone when not even the pointer fits", () => {
    expect(insertCopyBlock(summary, findings, { limit: summary.length + 10 })).toBe(summary);
  });

  test("without a fold, goes before the summary marker", () => {
    const bare = `# Review\n\n${summaryMarker}`;
    const out = insertCopyBlock(bare, findings);
    expect(out.indexOf("Copy all findings")).toBeLessThan(out.indexOf(summaryMarker));
    expect(out).toEndWith(summaryMarker);
  });

  test("widens the fence past backticks in the findings", () => {
    const out = insertCopyBlock(summary, "```ts\nx\n```");
    expect(out).toContain("````markdown\n```ts\nx\n```\n````");
  });
});

test("artifactName uses the first nine characters of the head", () => {
  expect(artifactName(12, "0123456789abcdef")).toBe("ai-code-review-12-012345678");
});
