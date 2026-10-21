import { describe, expect, test } from "bun:test";
import { createProgram } from "./index.ts";
import { parseAge, parseReason } from "./runs.ts";

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

describe("runs dismiss", () => {
  test("takes several finding ids, a reason, and a note", async () => {
    const program = createProgram();
    const runs = program.commands.find((c) => c.name() === "runs")!;
    const dismiss = runs.commands.find((c) => c.name() === "dismiss")!;
    let seen: unknown[] = [];
    dismiss.action((...args: unknown[]) => {
      seen = args.slice(0, 3);
    });
    await program.parseAsync(["runs", "dismiss", "run-1", "a1", "b2", "--reason", "duplicate", "--note", "same as a1"], {
      from: "user",
    });
    expect(seen).toEqual(["run-1", ["a1", "b2"], { reason: "duplicate", note: "same as a1" }]);
  });

  test("parseReason rejects unknown reasons", () => {
    expect(parseReason("wrong")).toBe("wrong");
    expect(() => parseReason("meh")).toThrow(/must be one of wrong, not-worth-fixing/);
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
