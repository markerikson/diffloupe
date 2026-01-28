import { describe, expect, test } from "bun:test";
import { classifyDiff, classifyFile, loadForBudget } from "./diff-loader.js";
import type { DiffFile, DiffHunk, ParsedDiff } from "../types/diff.js";

/** Helper to create a minimal DiffFile for testing */
function makeDiffFile(
  path: string,
  options: { isBinary?: boolean; hunks?: DiffHunk[] } = {}
): DiffFile {
  return {
    path,
    status: "modified",
    hunks: options.hunks ?? [],
    isBinary: options.isBinary ?? false,
  };
}

/** Helper to create a hunk with content for token estimation */
function makeHunk(content: string[]): DiffHunk {
  return {
    oldStart: 1,
    oldLines: content.length,
    newStart: 1,
    newLines: content.length,
    header: "@@ -1,1 +1,1 @@",
    lines: content.map((c, i) => ({
      type: "context" as const,
      content: c,
      oldLineNumber: i + 1,
      newLineNumber: i + 1,
    })),
  };
}

describe("classifyFile", () => {
  describe("Tier 1: Source code", () => {
    test.each([
      ["file.ts", "TypeScript"],
      ["file.tsx", "TSX"],
      ["file.js", "JavaScript"],
      ["file.jsx", "JSX"],
      ["file.mjs", "ES module"],
      ["file.py", "Python"],
      ["file.go", "Go"],
      ["file.rs", "Rust"],
      ["file.java", "Java"],
      ["file.rb", "Ruby"],
      ["file.php", "PHP"],
      ["file.c", "C"],
      ["file.cpp", "C++"],
      ["file.swift", "Swift"],
      ["file.vue", "Vue"],
      ["file.svelte", "Svelte"],
    ])("classifies %s (%s) as tier 1", (path) => {
      const file = makeDiffFile(path);
      const result = classifyFile(file);
      expect(result.tier).toBe(1);
      expect(result.reason).toBe("source code");
    });
  });

  describe("Tier 1: Test files", () => {
    test.each([
      "utils.test.ts",
      "utils.spec.ts",
      "utils_test.go",
      "test_utils.py",
      "src/__tests__/utils.ts",
      "tests/integration.ts",
    ])("classifies %s as tier 1 test file", (path) => {
      const file = makeDiffFile(path);
      const result = classifyFile(file);
      expect(result.tier).toBe(1);
      expect(result.reason).toBe("test file");
    });
  });

  describe("Tier 1: Behavior config", () => {
    test.each([
      "package.json",
      "tsconfig.json",
      "vite.config.ts",
      "webpack.config.js",
      "next.config.mjs",
      "vitest.config.ts",
      "jest.config.js",
      "eslint.config.js",
      "Dockerfile",
      "docker-compose.yml",
      "Cargo.toml",
      "go.mod",
      "pyproject.toml",
    ])("classifies %s as tier 1 behavior config", (path) => {
      const file = makeDiffFile(path);
      const result = classifyFile(file);
      expect(result.tier).toBe(1);
      expect(result.reason).toBe("behavior config");
    });
  });

  describe("Tier 2: Documentation", () => {
    test.each(["README.md", "docs/guide.md", "CHANGELOG.txt", "docs/api.rst"])(
      "classifies %s as tier 2 documentation",
      (path) => {
        const file = makeDiffFile(path);
        const result = classifyFile(file);
        expect(result.tier).toBe(2);
        expect(result.reason).toBe("documentation");
      }
    );
  });

  describe("Tier 2: Type definitions", () => {
    test("classifies .d.ts files as tier 2", () => {
      const file = makeDiffFile("src/types/index.d.ts");
      const result = classifyFile(file);
      expect(result.tier).toBe(2);
      expect(result.reason).toBe("type definition");
    });
  });

  describe("Tier 2: Other config", () => {
    test.each([
      "settings.json",
      "config.yaml",
      "app.yml",
      "settings.toml",
      ".editorconfig",
    ])("classifies %s as tier 2 config", (path) => {
      const file = makeDiffFile(path);
      const result = classifyFile(file);
      expect(result.tier).toBe(2);
      // Could be "config file" or "other" depending on extension
      expect(["config file", "other"]).toContain(result.reason);
    });
  });

  describe("Tier 2: CI/CD", () => {
    test.each([
      ".github/workflows/ci.yml",
      ".github/workflows/release.yaml",
      ".gitlab-ci.yml",
      ".circleci/config.yml",
    ])("classifies %s as tier 2 CI/CD", (path) => {
      const file = makeDiffFile(path);
      const result = classifyFile(file);
      expect(result.tier).toBe(2);
      expect(result.reason).toBe("CI/CD config");
    });
  });

  describe("Tier 3: Lock files", () => {
    test.each([
      "package-lock.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "bun.lock",
      "Cargo.lock",
      "go.sum",
      "poetry.lock",
    ])("classifies %s as tier 3 lock file", (path) => {
      const file = makeDiffFile(path);
      const result = classifyFile(file);
      expect(result.tier).toBe(3);
      expect(result.reason).toBe("lock file");
    });
  });

  describe("Tier 3: Generated/dist files", () => {
    test.each([
      "dist/bundle.js",
      "build/index.js",
      "out/main.js",
      ".next/static/chunks/main.js",
      "node_modules/lodash/index.js",
    ])("classifies %s as tier 3 generated", (path) => {
      const file = makeDiffFile(path);
      const result = classifyFile(file);
      expect(result.tier).toBe(3);
      expect(result.reason).toBe("generated/dist directory");
    });
  });

  describe("Tier 3: Minified/bundled files", () => {
    test.each(["app.min.js", "styles.min.css", "vendor.bundle.js"])(
      "classifies %s as tier 3 minified",
      (path) => {
        const file = makeDiffFile(path);
        const result = classifyFile(file);
        expect(result.tier).toBe(3);
        expect(result.reason).toBe("minified/bundled file");
      }
    );
  });

  describe("Tier 3: Binary files", () => {
    test("classifies binary files as tier 3", () => {
      const file = makeDiffFile("image.png", { isBinary: true });
      const result = classifyFile(file);
      expect(result.tier).toBe(3);
      expect(result.reason).toBe("binary file");
    });
  });
});

describe("classifyDiff", () => {
  test("sorts files by tier then by path", () => {
    const diff: ParsedDiff = {
      files: [
        makeDiffFile("package-lock.json"), // tier 3
        makeDiffFile("README.md"), // tier 2
        makeDiffFile("src/index.ts"), // tier 1
        makeDiffFile("src/utils.ts"), // tier 1
        makeDiffFile("docs/guide.md"), // tier 2
        makeDiffFile("yarn.lock"), // tier 3
      ],
    };

    const result = classifyDiff(diff);

    // Should be sorted: tier 1 first, then tier 2, then tier 3
    // Within tiers, sorted alphabetically by path (localeCompare)
    expect(result.map((c) => c.file.path)).toEqual([
      "src/index.ts",
      "src/utils.ts",
      "docs/guide.md", // 'd' < 'R' in localeCompare
      "README.md",
      "package-lock.json",
      "yarn.lock",
    ]);

    expect(result.map((c) => c.tier)).toEqual([1, 1, 2, 2, 3, 3]);
  });

  test("includes estimated token count", () => {
    const diff: ParsedDiff = {
      files: [
        makeDiffFile("src/index.ts", {
          hunks: [makeHunk(["const x = 1;", "const y = 2;"])],
        }),
      ],
    };

    const result = classifyDiff(diff);
    expect(result[0]!.estimatedTokens).toBeGreaterThan(0);
  });
});

describe("loadForBudget", () => {
  test("includes files up to budget", () => {
    // Create files with known token estimates
    const diff: ParsedDiff = {
      files: [
        makeDiffFile("a.ts", { hunks: [makeHunk(["// 100 chars".padEnd(100)])] }),
        makeDiffFile("b.ts", { hunks: [makeHunk(["// 100 chars".padEnd(100)])] }),
        makeDiffFile("c.ts", { hunks: [makeHunk(["// 100 chars".padEnd(100)])] }),
      ],
    };

    const classified = classifyDiff(diff);

    // Budget for ~2 files (estimate ~30 tokens each with header overhead)
    const result = loadForBudget(classified, 60);

    expect(result.included.length).toBe(2);
    expect(result.excluded.length).toBe(1);
    expect(result.totalTokens).toBeLessThanOrEqual(60);
  });

  test("respects tier priority for budget", () => {
    const diff: ParsedDiff = {
      files: [
        makeDiffFile("package-lock.json", {
          hunks: [makeHunk(["small"])],
        }), // tier 3
        makeDiffFile("src/index.ts", {
          hunks: [makeHunk(["const x = 1;"])],
        }), // tier 1
        makeDiffFile("README.md", {
          hunks: [makeHunk(["# Title"])],
        }), // tier 2
      ],
    };

    const classified = classifyDiff(diff);
    // Even with tight budget, tier 1 should come first
    const result = loadForBudget(classified, 1000);

    expect(result.included[0]!.tier).toBe(1);
    expect(result.included[0]!.file.path).toBe("src/index.ts");
  });

  test("returns empty included when budget is 0", () => {
    const diff: ParsedDiff = {
      files: [makeDiffFile("a.ts", { hunks: [makeHunk(["code"])] })],
    };

    const classified = classifyDiff(diff);
    const result = loadForBudget(classified, 0);

    expect(result.included).toHaveLength(0);
    expect(result.excluded).toHaveLength(1);
    expect(result.totalTokens).toBe(0);
  });

  test("includes all files when budget is large", () => {
    const diff: ParsedDiff = {
      files: [
        makeDiffFile("a.ts", { hunks: [makeHunk(["code"])] }),
        makeDiffFile("b.ts", { hunks: [makeHunk(["more code"])] }),
        makeDiffFile("c.ts", { hunks: [makeHunk(["even more code"])] }),
      ],
    };

    const classified = classifyDiff(diff);
    const result = loadForBudget(classified, 100000);

    expect(result.included).toHaveLength(3);
    expect(result.excluded).toHaveLength(0);
  });
});

describe("token estimation", () => {
  test("estimates ~4 chars per token", () => {
    // Create a file with known content length
    const content = "x".repeat(400); // 400 chars → ~100 tokens
    const diff: ParsedDiff = {
      files: [makeDiffFile("file.ts", { hunks: [makeHunk([content])] })],
    };

    const classified = classifyDiff(diff);
    const tokens = classified[0]!.estimatedTokens;

    // Should be roughly 100 tokens, give or take header overhead
    expect(tokens).toBeGreaterThan(90);
    expect(tokens).toBeLessThan(120);
  });
});
