import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyConfig, DEFAULT_SURFACES } from "./core/config.ts";
import { loadReviewSettings, parseReviewSettings, settingsInstructions, settingsToConfig } from "./settings.ts";

describe("parseReviewSettings", () => {
  test("accepts a full settings object", () => {
    const settings = parseReviewSettings(
      {
        models: { review: "a", coordinator: "b", walkthrough: "c" },
        effort: "high",
        surfaces: { deploy: ["^infra/"], tooling: ["^docs/"] },
        extraExcludes: ["vendor/"],
      },
      "test",
    );
    expect(settings.models?.walkthrough).toBe("c");
    expect(settings.extraExcludes).toEqual(["vendor/"]);
  });

  test("rejects unknown keys", () => {
    expect(() => parseReviewSettings({ surface: {} }, "test")).toThrow(/invalid settings in test/);
    expect(() => parseReviewSettings({ models: { reviewer: "x" } }, "test")).toThrow(/invalid settings/);
  });

  test("rejects wrong types and bad regexes", () => {
    expect(() => parseReviewSettings({ extraExcludes: "vendor/" }, "test")).toThrow(/invalid settings/);
    expect(() => parseReviewSettings({ surfaces: { deploy: ["("] } }, "test")).toThrow(/invalid surface pattern/);
  });
});

describe("settingsInstructions", () => {
  test("joins an array of lines", () => {
    expect(settingsInstructions(parseReviewSettings({ instructions: ["a", "b"] }, "test"))).toBe("a\nb");
  });

  test("accepts a string and treats blank as none", () => {
    expect(settingsInstructions(parseReviewSettings({ instructions: " x " }, "test"))).toBe("x");
    expect(settingsInstructions({ instructions: "  " })).toBeUndefined();
    expect(settingsInstructions({})).toBeUndefined();
  });

  test("rejects other types", () => {
    expect(() => parseReviewSettings({ instructions: 3 }, "test")).toThrow(/invalid settings/);
  });
});

describe("settingsToConfig", () => {
  test("keeps the default for a surface list that is not given", () => {
    const config = settingsToConfig({ surfaces: { deploy: ["^infra/"] }, extraExcludes: ["x/"] });
    expect(config.surfaces).toEqual({ deploy: ["^infra/"], tooling: DEFAULT_SURFACES.tooling });
    expect(config.extraExcludes).toEqual(["x/"]);
  });

  test("leaves models and effort out", () => {
    const config = settingsToConfig({ models: { review: "a" }, effort: "low" });
    expect(config).not.toHaveProperty("model");
    expect(config).not.toHaveProperty("effort");
  });

  test("resets every setting to its default when none are given", () => {
    applyConfig({ surfaces: { deploy: ["^other-repo/"], tooling: [] } });
    try {
      expect(settingsToConfig({})).toEqual({
        surfaces: { deploy: [...DEFAULT_SURFACES.deploy], tooling: [...DEFAULT_SURFACES.tooling] },
        extraExcludes: [],
        postMinSeverity: null,
        dropQuestions: false,
      });
    } finally {
      applyConfig({ surfaces: { ...DEFAULT_SURFACES } });
    }
  });

  test("reads the posting rules", () => {
    const settings = parseReviewSettings({ post: { minSeverity: "should-fix", questions: "drop" } }, "test");
    expect(settingsToConfig(settings)).toMatchObject({ postMinSeverity: "should-fix", dropQuestions: true });
  });

  test("rejects an unknown severity", () => {
    expect(() => parseReviewSettings({ post: { minSeverity: "major" } }, "test")).toThrow(/invalid settings/);
  });
});

describe("loadReviewSettings", () => {
  test("reads a file and reports bad JSON", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "diffloupe-settings-"));
    const good = path.join(dir, "good.json");
    const bad = path.join(dir, "bad.json");
    await writeFile(good, JSON.stringify({ effort: "low" }));
    await writeFile(bad, "{ nope");
    expect(await loadReviewSettings(good)).toEqual({ effort: "low" });
    await expect(loadReviewSettings(bad)).rejects.toThrow(/not valid JSON/);
    await expect(loadReviewSettings(path.join(dir, "missing.json"))).rejects.toThrow(/cannot read/);
  });
});
