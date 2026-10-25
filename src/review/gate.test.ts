import { describe, expect, it } from "bun:test";
import { gatherReviewThreads, type GhComment, type PullRequestThreads, type ReviewThread } from "./core/context.ts";
import { marker } from "./core/lib/marker.ts";
import { evaluateGate, failsOpenGate, formatGate, gateDescription, openFindings, runGate } from "./gate.ts";

const BOT = "Bot";

function thread(id: number, rootBody: string, extra: Partial<ReviewThread> = {}, replies: string[] = []): ReviewThread {
  return {
    id: `T${id}`,
    resolved: false,
    outdated: false,
    file: "src/a.ts",
    line: 10,
    comments: [
      { id, body: rootBody, author: "github-actions", authorType: BOT, url: `https://x/c${id}` },
      ...replies.map((body, i) => ({
        id: id * 100 + i,
        body,
        author: "github-actions",
        authorType: BOT,
        url: `https://x/c${id}r${i}`,
        replyTo: id,
      })),
    ],
    ...extra,
  };
}

const inline = (fp: string, sev?: string) =>
  `#### Title ${fp}\n\n🔴 **Blocker** · bug\n\nbody\n\n${marker("inline", { file: "src/a.ts", line: 10, fp, ...(sev ? { sev } : {}) })}`;

function pr(threads: ReviewThread[], labels: string[] = []): PullRequestThreads {
  return { number: 7, url: "https://x/pr/7", author: "dev", headSha: "a".repeat(40), labels, threads };
}

function summary(lines: string[]): GhComment {
  return {
    id: 50,
    body: [...lines, marker("summary", { pr: "7", runs: "2" })].join("\n"),
    user: { login: "github-actions[bot]", type: BOT },
    html_url: "https://x/summary",
  };
}

describe("openFindings", () => {
  it("counts the bot's unresolved threads and skips resolved and settled ones", () => {
    const open = openFindings(
      pr([
        thread(1, inline("aaaaaaaaaa", "blocker")),
        thread(2, inline("bbbbbbbbbb", "blocker"), { resolved: true, resolvedBy: "reviewer" }),
        thread(3, inline("cccccccccc", "blocker"), {}, [`✅ Fixed. ${marker("reply", { of: 3, addressed: 1 })}`]),
        thread(4, inline("dddddddddd", "should-fix"), { outdated: true }),
      ]),
      null,
    );
    expect(open.map((f) => [f.fp, f.severity, f.outdated ?? false])).toEqual([
      ["aaaaaaaaaa", "blocker", false],
      ["dddddddddd", "should-fix", true],
    ]);
    expect(open[0]?.title).toBe("Title aaaaaaaaaa");
  });

  it("ignores threads someone else started, and comments that only quote the bot", () => {
    const human = thread(1, "", {
      comments: [{ id: 1, body: inline("aaaaaaaaaa", "blocker"), author: "dev", authorType: "User", url: "https://x/c1" }],
    });
    expect(openFindings(pr([human, thread(2, "just a bot note")]), null)).toEqual([]);
  });

  it("reads the badge when the marker has no severity, and reports unknown when neither is there", () => {
    const noBadge = `#### Old\n\nbody\n\n${marker("inline", { file: "a.ts", line: 1, fp: "eeeeeeeeee" })}`;
    const open = openFindings(pr([thread(1, inline("aaaaaaaaaa")), thread(2, noBadge)]), null);
    expect(open.map((f) => f.severity)).toEqual(["blocker", "unknown"]);
    expect(failsOpenGate(open, "question").map((f) => f.fp)).toEqual(["aaaaaaaaaa"]);
  });

  it("keeps counting a thread the PR author resolved unless told to accept it", () => {
    const threads = [thread(1, inline("aaaaaaaaaa", "blocker"), { resolved: true, resolvedBy: "dev" })];
    expect(openFindings(pr(threads), null)).toHaveLength(1);
    expect(openFindings(pr(threads), null, { countAuthorResolved: true })).toEqual([]);
    const byReviewer = [thread(1, inline("aaaaaaaaaa", "blocker"), { resolved: true, resolvedBy: "lead" })];
    expect(openFindings(pr(byReviewer), null)).toEqual([]);
  });

  it("marks a finding upheld after a dispute", () => {
    const reply = `Still stands. ${marker("reply", { of: 1, fp: "aaaaaaaaaa", dispute: "upheld" })}`;
    const [f] = openFindings(pr([thread(1, inline("aaaaaaaaaa", "blocker"), {}, [reply])]), null);
    expect(f?.upheld).toBe(true);
  });

  it("reads findings listed in the summary, leaving out withdrawn ones", () => {
    const s = summary([
      `  - 🟠 **Should fix** a claim — L3 ${marker("summary-item", { file: "b.ts", line: 3, fp: "1111111111", sev: "should-fix" })}`,
      `  - 🔴 **Blocker** old claim — L4 ${marker("summary-item", { file: "b.ts", line: 4, fp: "2222222222" })}`,
      `  - 🔴 **Blocker** gone — L5 ${marker("summary-item", { file: "b.ts", line: 5, fp: "3333333333", sev: "blocker" })}`,
      `- ↩️ Withdrawn: gone ${marker("dispute", { fp: "3333333333", outcome: "withdrawn" })}`,
      `- Upheld: a claim ${marker("dispute", { fp: "1111111111", outcome: "upheld" })}`,
    ]);
    const open = openFindings(pr([]), s);
    expect(open.map((f) => [f.fp, f.severity, f.where, f.upheld ?? false])).toEqual([
      ["1111111111", "should-fix", "summary", true],
      ["2222222222", "blocker", "summary", false],
    ]);
    expect(open[0]?.url).toBe("https://x/summary");
    expect(open[0]?.title).toBe("a claim");
  });
});

describe("evaluateGate", () => {
  const threads = [thread(1, inline("aaaaaaaaaa", "should-fix"))];

  it("fails only on findings at or above the threshold", () => {
    expect(evaluateGate(pr(threads), [], { failOn: "blocker" }).fails).toBe(false);
    const r = evaluateGate(pr(threads), [], { failOn: "should-fix" });
    expect(r.fails).toBe(true);
    expect(gateDescription(r)).toBe("1 open finding at should-fix or above");
    expect(formatGate(r).join("\n")).toContain("should-fix   src/a.ts:10  Title aaaaaaaaaa");
  });

  it("passes with the override label and says so", () => {
    const r = evaluateGate(pr(threads, ["ai-review-override"]), [], {
      failOn: "should-fix",
      overrideLabel: "ai-review-override",
    });
    expect(r.fails).toBe(false);
    expect(r.matched).toHaveLength(1);
    expect(gateDescription(r)).toBe("1 open finding at should-fix or above, passed by the ai-review-override label");
  });

  it("lists pre-existing findings without failing on them", () => {
    const pre = `#### Old bug\n\nbody\n\n${marker("inline", { file: "a.ts", line: 1, fp: "eeeeeeeeee", sev: "blocker", pre: 1 })}`;
    const s = summary([`- x ${marker("summary-item", { file: "b.ts", line: 2, fp: "1111111111", sev: "blocker", pre: 1 })}`]);
    const r = evaluateGate(pr([thread(1, pre)]), [s], { failOn: "blocker" });
    expect(r.open.map((f) => f.preexisting)).toEqual([true, true]);
    expect(r.fails).toBe(false);
    expect(formatGate(r).join("\n")).toContain("pre-existing, not counted");
  });

  it("with reviewMissing, fails a PR the bot never reviewed and judges a reviewed one on what is open", () => {
    const never = evaluateGate(pr([]), [], { failOn: "blocker", reviewMissing: true });
    expect(never.fails).toBe(true);
    expect(gateDescription(never)).toBe("Not reviewed: the review failed and no earlier review reached this PR");
    expect(evaluateGate(pr([], ["ok"]), [], { failOn: "blocker", reviewMissing: true, overrideLabel: "ok" }).fails).toBe(
      false,
    );
    expect(evaluateGate(pr([]), [summary([])], { failOn: "blocker", reviewMissing: true }).fails).toBe(false);
    expect(evaluateGate(pr([]), [], { failOn: "blocker" }).fails).toBe(false);
  });

  it("uses the latest summary when there are two", () => {
    const older = summary([`- x ${marker("summary-item", { fp: "1111111111", sev: "blocker" })}`]);
    const newer = { ...summary([]), id: 60 };
    expect(evaluateGate(pr([]), [older, newer], { failOn: "blocker" }).fails).toBe(false);
  });
});

describe("runGate", () => {
  it("writes the commit status on the head when no sha is given", async () => {
    const calls: string[][] = [];
    const r = await runGate(
      "o/r",
      7,
      { failOn: "should-fix", status: {} },
      {
        readThreads: async () => pr([thread(1, inline("aaaaaaaaaa", "blocker"))]),
        readComments: async () => [],
        gh: async (args) => {
          calls.push(args);
          return "{}";
        },
      },
    );
    expect(r.fails).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`repos/o/r/statuses/${"a".repeat(40)}`);
    expect(calls[0]).toContain("state=failure");
    expect(calls[0]).toContain("context=diffloupe/gate");
    expect(calls[0]).toContain("target_url=https://x/pr/7");
  });
});

describe("gatherReviewThreads", () => {
  const page = (cursor: string | null, nodes: unknown[]) =>
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            number: 7,
            url: "https://x/pr/7",
            headRefOid: "b".repeat(40),
            author: { login: "dev" },
            labels: { nodes: [{ name: "ai-review-override" }] },
            reviewThreads: { pageInfo: { hasNextPage: cursor !== null, endCursor: cursor }, nodes },
          },
        },
      },
    });
  const node = (id: string) => ({
    id,
    isResolved: false,
    isOutdated: true,
    path: "a.ts",
    line: null,
    originalLine: 4,
    resolvedBy: null,
    comments: {
      nodes: [{ databaseId: 1, body: "b", url: "u", author: { login: "bot", __typename: "Bot" }, replyTo: null }],
    },
  });

  it("follows pages and maps GitHub's fields", async () => {
    const seen: string[][] = [];
    const result = await gatherReviewThreads("o/r", 7, {
      gh: async (args) => {
        seen.push(args);
        return args.some((a) => a.startsWith("endCursor=")) ? page(null, [node("T2")]) : page("c1", [node("T1")]);
      },
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain("endCursor=c1");
    expect(result.labels).toEqual(["ai-review-override"]);
    expect(result.threads.map((t) => t.id)).toEqual(["T1", "T2"]);
    expect(result.threads[0]).toMatchObject({ outdated: true, file: "a.ts", line: 4 });
    expect(result.threads[0]?.comments[0]).toEqual({ id: 1, body: "b", author: "bot", authorType: "Bot", url: "u" });
  });

  it("throws on GraphQL errors instead of returning no threads", async () => {
    const gh = async () => JSON.stringify({ errors: [{ message: "Could not resolve to a Repository" }] });
    await expect(gatherReviewThreads("o/r", 7, { gh })).rejects.toThrow("Could not resolve");
  });
});
