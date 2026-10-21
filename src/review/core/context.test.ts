import { describe, expect, test } from "bun:test";
import { gatherIntent, gatherPriorComments, type GhText } from "./context.ts";
import { marker } from "./lib/marker.ts";

const offline: GhText = async () => {
  throw new Error("gh: could not resolve host");
};

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
    expect(prior[0]).toMatchObject({ id: 9, mine: true, runs: 2 });
  });
});

describe("gatherIntent", () => {
  test("strict mode throws when the description cannot be read", async () => {
    await expect(gatherIntent("o/r", "5", "a", "b", undefined, { gh: offline, strict: true })).rejects.toThrow(
      /pull request description/,
    );
  });
});
