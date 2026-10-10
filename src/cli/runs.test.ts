import { describe, expect, test } from "bun:test";
import { parseAge } from "./runs.ts";

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
