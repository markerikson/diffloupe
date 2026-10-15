import { describe, expect, test } from "bun:test";
import { createProgram } from "./index.ts";
import { parseAge } from "./runs.ts";

describe("runs show", () => {
  test("--json after show goes to show, not to runs", async () => {
    const program = createProgram();
    const runs = program.commands.find((c) => c.name() === "runs")!;
    const show = runs.commands.find((c) => c.name() === "show")!;
    let seen: { json: boolean } | undefined;
    show.action((_id: string, opts: { json: boolean }) => {
      seen = opts;
    });
    await program.parseAsync(["runs", "show", "some-id", "--json"], { from: "user" });
    expect(seen?.json).toBe(true);
    expect(runs.opts().json).toBe(false);
  });
});

describe("parseAge", () => {
  test("hours, days and weeks", () => {
    expect(parseAge("12h")).toBe(12 * 3_600_000);
    expect(parseAge("30d")).toBe(30 * 86_400_000);
    expect(parseAge("2w")).toBe(14 * 86_400_000);
    expect(parseAge("0d")).toBe(0);
  });

  test("rejects anything else", () => {
    expect(parseAge("30")).toBeNull();
    expect(parseAge("1.5d")).toBeNull();
    expect(parseAge("3m")).toBeNull();
  });
});
