import { describe, expect, test } from "bun:test";
import { loadFixture } from "./__fixtures__/load.ts";
import { anchorLocation, fenceLanguage, findingMarkdown, runMarkdown, SEVERITY_ORDER, sortFindings } from "./export.ts";
import type { RunFinding } from "../types/review-run.ts";

const largePr = loadFixture("large-pr").build();
const renames = loadFixture("renames").build();
const smallCommit = loadFixture("small-commit").build();

function finding(over: Partial<RunFinding> = {}): RunFinding {
  return {
    id: "f1",
    file: "src/a.ts",
    anchor: { file: "src/a.ts", side: "additions", kind: "line", line: 10, cited: { line: 10 } },
    severity: "should-fix",
    category: "correctness",
    title: "Off by one",
    explanation: "The loop stops one early.",
    evidence: "`i < n - 1`",
    confidence: "high",
    ...over,
  };
}

describe("findingMarkdown", () => {
  test("heading, location, explanation, evidence", () => {
    expect(findingMarkdown(finding())).toBe(
      [
        "### [should-fix] Off by one",
        "`src/a.ts:10` · id `f1`",
        "The loop stops one early.",
        "**Evidence:** `i < n - 1`",
      ].join("\n\n"),
    );
  });

  test("accepted and dismissed findings are labeled, with the dismissal note", () => {
    const state = {
      findingStatus: { f1: "dismissed" as const },
      findingNotes: { f1: { reason: "wrong" as const, note: "Guarded upstream.", at: "t" } },
    };
    const md = findingMarkdown(finding(), state);
    expect(md).toStartWith("### [should-fix] Off by one (dismissed: wrong)");
    expect(md).toContain("> Dismissed: Guarded upstream.");
    expect(findingMarkdown(finding(), { findingStatus: { f1: "accepted" } })).toStartWith(
      "### [should-fix] Off by one (accepted)",
    );
  });

  test("line range", () => {
    const f = finding({ anchor: { ...finding().anchor, endLine: 14 } });
    expect(findingMarkdown(f)).toContain("`src/a.ts:10-14`");
  });

  test("nearby anchors cite the original line; base side is marked", () => {
    expect(
      anchorLocation({ file: "a.ts", side: "additions", kind: "nearby", line: 20, cited: { line: 40, endLine: 42 } }),
    ).toBe("a.ts:40-42");
    expect(anchorLocation({ file: "a.ts", side: "deletions", kind: "line", line: 3, cited: { line: 3 } })).toBe(
      "a.ts:3 (old)",
    );
    expect(anchorLocation({ file: "a.ts", side: "additions", kind: "file", line: 0, cited: { line: 0 } })).toBe("a.ts");
  });

  test("suggested code is fenced with the file's language", () => {
    const md = findingMarkdown(finding({ suggestion: "Use <=.", suggestedCode: "for (i = 0; i <= n; i++) {}\n" }));
    expect(md).toContain("**Suggestion:** Use <=.\n\n```ts\nfor (i = 0; i <= n; i++) {}\n```");
  });

  test("a fence widens past backticks in the suggested code", () => {
    const md = findingMarkdown(finding({ file: "README.md", suggestedCode: "```sh\nls\n```" }));
    expect(md).toContain("````md\n```sh\nls\n```\n````");
  });

  test("fixture finding with suggested code", () => {
    const f = smallCommit.findings.find((x) => x.suggestedCode)!;
    expect(findingMarkdown(f)).toContain(`\`\`\`${fenceLanguage(f.file)}\n`);
  });

  test("carried and repeated findings say so", () => {
    expect(findingMarkdown(finding({ carriedFrom: "run-1", repeatOf: 7 }))).toContain(
      "_Open since run run-1. Repeats PR comment #7._",
    );
  });
});

describe("runMarkdown", () => {
  test("orders by severity, then file, then line", () => {
    const sorted = sortFindings([...largePr.findings, ...renames.findings]);
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1]!;
      const b = sorted[i]!;
      const bySeverity = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
      expect(bySeverity).toBeLessThanOrEqual(0);
      if (bySeverity === 0) {
        const byFile = a.file.localeCompare(b.file);
        expect(byFile).toBeLessThanOrEqual(0);
        if (byFile === 0) expect(a.anchor.line).toBeLessThanOrEqual(b.anchor.line);
      }
    }
    const md = runMarkdown(largePr);
    const headings = md.split("\n").filter((l) => l.startsWith("### "));
    expect(headings).toEqual(sortFindings(largePr.findings).map((f) => `### [${f.severity}] ${f.title}`));
  });

  test("header names the target, base and head", () => {
    const md = runMarkdown(renames);
    expect(md.split("\n")[0]).toBe("# Review findings: commit HEAD");
    expect(md).toContain(`Base \`${renames.base.slice(0, 12)}\`, head \`${renames.head.slice(0, 12)}\``);
  });

  test("a re-review states its round and scope on the base line", () => {
    const run = { ...renames, round: 2, meta: { ...renames.meta, reviewScope: "incremental" as const, reviewedFiles: 2 } };
    const md = runMarkdown(run);
    expect(md.split("\n\n")[1]).toEndWith(". Round 2: only the 2 files changed since the last review were reviewed again.");
    expect(runMarkdown(renames).split("\n\n")[1]).not.toContain("Round");
  });

  test("over-cap findings only when asked", () => {
    expect(largePr.overCapFindings.length).toBeGreaterThan(0);
    const without = runMarkdown(largePr);
    const withOverCap = runMarkdown(largePr, { includeOverCap: true });
    for (const f of largePr.overCapFindings) {
      expect(without).not.toContain(f.title);
      expect(withOverCap).toContain(`### [${f.severity}] ${f.title}`);
    }
    expect(withOverCap).toContain(`## Over the posting cap (${largePr.overCapFindings.length})`);
  });

  test("a run with no findings", () => {
    expect(runMarkdown(loadFixture("docs-only").build()).split("\n\n")[2]?.trim()).toBe("No issues found.");
  });

  test("count line comes before the findings", () => {
    const line = runMarkdown(largePr).split("\n\n")[2];
    expect(line).toMatch(new RegExp(`^${largePr.findings.length} findings: `));
    expect(line).toContain(`${largePr.overCapFindings.length} more over the posting cap.`);
  });

  test("pre-existing findings get their own section and count", () => {
    const run = {
      ...smallCommit,
      findings: [
        finding({ id: "a", title: "new bug", severity: "blocker" }),
        finding({ id: "b", title: "old bug", severity: "should-fix", preexisting: true }),
      ],
      overCapFindings: [],
    };
    const md = runMarkdown(run);
    expect(md.split("\n\n")[2]).toBe("1 finding: 1 blocker. 1 pre-existing.");
    const section = md.indexOf("## Pre-existing (not introduced by this change)");
    expect(section).toBeGreaterThan(md.indexOf("### [blocker] new bug"));
    expect(md.indexOf("### [should-fix] old bug")).toBeGreaterThan(section);
  });

  test("a run whose only findings are pre-existing", () => {
    const run = {
      ...smallCommit,
      findings: [finding({ title: "old bug", preexisting: true })],
      overCapFindings: [],
    };
    expect(runMarkdown(run).split("\n\n")[2]).toBe("No issues found in this change. 1 pre-existing.");
  });

  test("dismissed findings are left out unless asked for", () => {
    const run = {
      ...smallCommit,
      findings: [finding({ id: "a", title: "kept" }), finding({ id: "b", title: "dropped" })],
      overCapFindings: [],
    };
    const state = { findingStatus: { a: "accepted" as const, b: "dismissed" as const } };
    const md = runMarkdown(run, { state });
    expect(md.split("\n\n")[2]).toBe("1 finding: 1 should-fix. 1 dismissed finding left out.");
    expect(md).toContain("### [should-fix] kept (accepted)");
    expect(md).not.toContain("dropped");
    expect(runMarkdown(run, { state, includeDismissed: true })).toContain("### [should-fix] dropped (dismissed)");
  });

  test("snapshot", () => {
    expect(runMarkdown(largePr, { includeOverCap: true })).toMatchSnapshot();
  });
});
