import { describe, expect, test } from "bun:test";
import {
  gatherIntent,
  gatherPriorComments,
  latestOwnSummary,
  renderPriorComments,
  type GhText,
  type PriorComment,
} from "./context.ts";
import { marker } from "./lib/marker.ts";

const offline: GhText = async () => {
  throw new Error("gh: could not resolve host");
};

describe("latestOwnSummary", () => {
  test("returns the newest summary the bot wrote, markers included", async () => {
    const summary = (n: number) => `review ${n}\n${marker("summary", { runs: n })}`;
    const comments = [
      { id: 7, body: summary(2), user: { login: "bot", type: "Bot" } },
      { id: 3, body: summary(1), user: { login: "bot", type: "Bot" } },
      { id: 9, body: `quoting\n${marker("summary", { runs: 5 })}`, user: { login: "dev", type: "User" } },
    ];
    const gh: GhText = async () => JSON.stringify(comments);
    expect(await latestOwnSummary("o/r", "5", { gh })).toBe(summary(2));
    expect(await latestOwnSummary("o/r", "5", { gh: async () => "[]" })).toBeNull();
  });
});

describe("gatherPriorComments", () => {
  test("locally, a gh failure means reviewing without prior comments", async () => {
    expect(await gatherPriorComments("o/r", "5", { gh: offline })).toEqual([]);
  });

  // Posting without the earlier comments would repeat every finding already on
  // the pull request, so a CI run fails instead.
  test("strict mode throws when gh fails", async () => {
    await expect(gatherPriorComments("o/r", "5", { gh: offline, strict: true })).rejects.toThrow(
      /review comments: gh: could not resolve host/,
    );
  });

  test("strict mode also covers the issue comments", async () => {
    const gh: GhText = async (args) => {
      if (args.at(-1)?.includes("/pulls/")) return "[]";
      throw new Error("HTTP 502");
    };
    await expect(gatherPriorComments("o/r", "5", { gh, strict: true })).rejects.toThrow(/pull request's comments: HTTP 502/);
  });

  test("reads the bot's own summary", async () => {
    const body = ["# Review", marker("summary", { pr: "5", runs: "2", head: "a".repeat(40) })].join("\n\n");
    const gh: GhText = async (args) =>
      args.at(-1)?.includes("/issues/")
        ? JSON.stringify([{ id: 9, body, user: { login: "bot", type: "Bot" } }])
        : "[]";
    const prior = await gatherPriorComments("o/r", "5", { gh, strict: true });
    expect(prior).toHaveLength(1);
    expect(prior[0]).toMatchObject({ id: 9, mine: true, runs: 2, head: "a".repeat(40) });
  });

  test("keeps another bot's comment when it answers a finding", async () => {
    const comments = [
      { id: 3, body: "Deploy preview ready", user: { login: "vercel", type: "Bot" } },
      {
        id: 4,
        body: "<!-- ai-review-response fp=abcdef12 verdict=disputed -->\nThe value is validated upstream.",
        user: { login: "fixer", type: "Bot" },
      },
    ];
    const gh: GhText = async (args) => (args.at(-1)?.includes("/issues/") ? JSON.stringify(comments) : "[]");
    const prior = await gatherPriorComments("o/r", "5", { gh, strict: true });
    expect(prior.map((c) => c.id)).toEqual([4]);
    expect(prior[0]?.responses).toEqual([
      { fp: "abcdef12", verdict: "disputed", reason: "The value is validated upstream." },
    ]);
  });

  test("reads dispute rulings from the bot's own summary", async () => {
    const body = [
      "# Review",
      `- Withdrawn: \`a.ts:3\` null check ${marker("dispute", { fp: "abcdef12", outcome: "withdrawn" })}`,
      marker("summary", { pr: "5", runs: "2", head: "a".repeat(40) }),
    ].join("\n\n");
    const gh: GhText = async (args) =>
      args.at(-1)?.includes("/issues/")
        ? JSON.stringify([{ id: 9, body, user: { login: "bot", type: "Bot" } }])
        : "[]";
    const prior = await gatherPriorComments("o/r", "5", { gh, strict: true });
    expect(prior[0]?.rulings).toEqual([{ fp: "abcdef12", outcome: "withdrawn", label: "Withdrawn: `a.ts:3` null check" }]);
  });
});

describe("renderPriorComments", () => {
  test("lists withdrawn findings and leaves dispute replies out of the discussion", () => {
    const summary: PriorComment = {
      id: 9,
      author: "bot",
      resolved: false,
      mine: true,
      body: "summary",
      rulings: [{ fp: "abcdef12", outcome: "withdrawn", label: "Withdrawn: `a.ts:3` null check" }],
    };
    const reply: PriorComment = {
      id: 10,
      author: "alice",
      resolved: false,
      mine: false,
      body: "The value is validated upstream.",
      responses: [{ fp: "abcdef12", verdict: "disputed", reason: "The value is validated upstream." }],
    };
    const md = renderPriorComments([summary, reply]);
    expect(md).toContain("You withdrew these");
    expect(md).toContain("- Withdrawn: `a.ts:3` null check");
    expect(md).not.toContain("validated upstream");
  });
});

describe("gatherIntent", () => {
  test("strict mode throws when the description cannot be read", async () => {
    await expect(gatherIntent("o/r", "5", "a", "b", undefined, { gh: offline, strict: true })).rejects.toThrow(
      /pull request description/,
    );
  });
});
