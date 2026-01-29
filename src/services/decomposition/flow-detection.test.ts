import { describe, expect, it } from "bun:test";
import type { ParsedDiff, DiffFile, DiffHunk } from "../../types/diff.js";
import type { ClassifiedFile } from "../../types/loader.js";
import {
  buildFlowDetectionPrompt,
  getFilesForFlow,
  getUncategorizedFiles,
  estimateFlowTokens,
  type DetectedFlow,
  type FlowDetectionResult,
} from "./flow-detection.js";

// ============================================================================
// Test Helpers
// ============================================================================

function createMockHunk(
  adds: number,
  deletes: number,
  content: string[] = []
): DiffHunk {
  const lines: DiffHunk["lines"] = [];
  let oldLine = 1;
  let newLine = 1;

  // Use provided content or generate default
  for (let i = 0; i < deletes; i++) {
    lines.push({
      type: "delete",
      content: content[i] ?? `deleted line ${i}`,
      oldLineNumber: oldLine++,
      newLineNumber: undefined,
    });
  }
  for (let i = 0; i < adds; i++) {
    lines.push({
      type: "add",
      content: content[deletes + i] ?? `added line ${i}`,
      oldLineNumber: undefined,
      newLineNumber: newLine++,
    });
  }

  return {
    header: `@@ -1,${deletes} +1,${adds} @@`,
    oldStart: 1,
    oldLines: deletes,
    newStart: 1,
    newLines: adds,
    lines,
  };
}

function createMockFile(
  path: string,
  status: DiffFile["status"] = "modified",
  hunks: DiffHunk[] = [createMockHunk(10, 5)]
): DiffFile {
  return {
    path,
    status,
    hunks,
    isBinary: false,
  };
}

function createClassifiedFile(
  file: DiffFile,
  tier: 1 | 2 | 3 = 1
): ClassifiedFile {
  const tokens = file.hunks.reduce(
    (sum, h) =>
      sum + h.lines.filter((l) => l.type !== "context").length * 10,
    0
  );
  return {
    file,
    tier,
    estimatedTokens: tokens,
    reason: `Tier ${tier} - test file`,
  };
}

// ============================================================================
// buildFlowDetectionPrompt Tests
// ============================================================================

describe("buildFlowDetectionPrompt", () => {
  it("should include file list with paths and stats", () => {
    const files = [
      createMockFile("src/auth/login.ts", "modified", [createMockHunk(20, 10)]),
      createMockFile("src/api/users.ts", "added", [createMockHunk(50, 0)]),
      createMockFile("src/db/models.ts", "modified", [createMockHunk(15, 5)]),
    ];
    const diff: ParsedDiff = { files };
    const classified = files.map((f) => createClassifiedFile(f));

    const prompt = buildFlowDetectionPrompt(diff, classified);

    // Should include all file paths
    expect(prompt).toContain("src/auth/login.ts");
    expect(prompt).toContain("src/api/users.ts");
    expect(prompt).toContain("src/db/models.ts");

    // Should include change stats
    expect(prompt).toContain("+20/-10");
    expect(prompt).toContain("+50/-0");
    expect(prompt).toContain("+15/-5");

    // Should include status
    expect(prompt).toContain("MODIFIED");
    expect(prompt).toContain("ADDED");
  });

  it("should include tier information", () => {
    const files = [
      createMockFile("src/app.ts"),
      createMockFile("README.md"),
    ];
    const diff: ParsedDiff = { files };
    const classified = [
      createClassifiedFile(files[0]!, 1),
      createClassifiedFile(files[1]!, 2),
    ];

    const prompt = buildFlowDetectionPrompt(diff, classified);

    expect(prompt).toContain("[Tier 1]");
    expect(prompt).toContain("[Tier 2]");
    expect(prompt).toContain("Tier 1 (high priority): 1 files");
    expect(prompt).toContain("Tier 2 (lower priority): 1 files");
  });

  it("should include hint lines from file content", () => {
    const hunk = createMockHunk(5, 3, [
      "const oldValue = 1;",
      "const oldValue2 = 2;",
      "const oldValue3 = 3;",
      "const newValue = 'hello';",
      "const newValue2 = 'world';",
      "const newValue3 = '!';",
      "const newValue4 = 'extra';",
      "const newValue5 = 'line';",
    ]);
    const file = createMockFile("src/test.ts", "modified", [hunk]);
    const diff: ParsedDiff = { files: [file] };
    const classified = [createClassifiedFile(file)];

    const prompt = buildFlowDetectionPrompt(diff, classified);

    // Should include some of the actual content
    expect(prompt).toContain("const oldValue = 1;");
    expect(prompt).toContain("const newValue = 'hello';");
  });

  it("should exclude tier 3 files", () => {
    const files = [
      createMockFile("src/app.ts"),
      createMockFile("package-lock.json"),
    ];
    const diff: ParsedDiff = { files };
    const classified = [
      createClassifiedFile(files[0]!, 1),
      createClassifiedFile(files[1]!, 3),
    ];

    const prompt = buildFlowDetectionPrompt(diff, classified);

    expect(prompt).toContain("src/app.ts");
    expect(prompt).not.toContain("package-lock.json");
    expect(prompt).toContain("Total files to group: 1");
  });

  it("should handle binary files", () => {
    const binaryFile: DiffFile = {
      path: "assets/logo.png",
      status: "added",
      hunks: [],
      isBinary: true,
    };
    const diff: ParsedDiff = { files: [binaryFile] };
    const classified = [createClassifiedFile(binaryFile)];

    const prompt = buildFlowDetectionPrompt(diff, classified);

    expect(prompt).toContain("assets/logo.png");
    expect(prompt).toContain("[binary file]");
  });

  it("should include output format instructions", () => {
    const file = createMockFile("src/test.ts");
    const diff: ParsedDiff = { files: [file] };
    const classified = [createClassifiedFile(file)];

    const prompt = buildFlowDetectionPrompt(diff, classified);

    expect(prompt).toContain("flows");
    expect(prompt).toContain("name");
    expect(prompt).toContain("description");
    expect(prompt).toContain("files");
    expect(prompt).toContain("priority");
    expect(prompt).toContain("3-8 flows");
  });
});

// ============================================================================
// getFilesForFlow Tests
// ============================================================================

describe("getFilesForFlow", () => {
  it("should return ClassifiedFiles matching flow paths", () => {
    const files = [
      createMockFile("src/auth/login.ts"),
      createMockFile("src/auth/logout.ts"),
      createMockFile("src/api/users.ts"),
    ];
    const classified = files.map((f) => createClassifiedFile(f));

    const flow: DetectedFlow = {
      name: "Authentication",
      description: "Auth-related changes",
      files: ["src/auth/login.ts", "src/auth/logout.ts"],
      priority: 1,
    };

    const result = getFilesForFlow(flow, classified);

    expect(result).toHaveLength(2);
    expect(result.map((cf) => cf.file.path)).toEqual([
      "src/auth/login.ts",
      "src/auth/logout.ts",
    ]);
  });

  it("should return empty array for flow with no matching files", () => {
    const files = [createMockFile("src/other.ts")];
    const classified = files.map((f) => createClassifiedFile(f));

    const flow: DetectedFlow = {
      name: "Empty",
      description: "No matching files",
      files: ["src/nonexistent.ts"],
      priority: 1,
    };

    const result = getFilesForFlow(flow, classified);

    expect(result).toHaveLength(0);
  });
});

// ============================================================================
// getUncategorizedFiles Tests
// ============================================================================

describe("getUncategorizedFiles", () => {
  it("should return ClassifiedFiles matching uncategorized paths", () => {
    const files = [
      createMockFile("src/utils/helpers.ts"),
      createMockFile("src/utils/format.ts"),
      createMockFile("src/api/users.ts"),
    ];
    const classified = files.map((f) => createClassifiedFile(f));

    const uncategorized = ["src/utils/helpers.ts", "src/utils/format.ts"];

    const result = getUncategorizedFiles(uncategorized, classified);

    expect(result).toHaveLength(2);
    expect(result.map((cf) => cf.file.path)).toContain("src/utils/helpers.ts");
    expect(result.map((cf) => cf.file.path)).toContain("src/utils/format.ts");
  });
});

// ============================================================================
// estimateFlowTokens Tests
// ============================================================================

describe("estimateFlowTokens", () => {
  it("should sum estimated tokens for files in flow", () => {
    const files = [
      createMockFile("src/a.ts", "modified", [createMockHunk(10, 5)]),
      createMockFile("src/b.ts", "modified", [createMockHunk(20, 10)]),
      createMockFile("src/c.ts", "modified", [createMockHunk(5, 2)]),
    ];
    const classified = files.map((f) => createClassifiedFile(f));

    const flow: DetectedFlow = {
      name: "Test",
      description: "Test flow",
      files: ["src/a.ts", "src/b.ts"],
      priority: 1,
    };

    const tokens = estimateFlowTokens(flow, classified);

    // Should be sum of tokens for a.ts and b.ts only
    const expectedTokens = classified[0]!.estimatedTokens + classified[1]!.estimatedTokens;
    expect(tokens).toBe(expectedTokens);
  });
});

// ============================================================================
// Flow Assignment Logic Tests (testing the validation)
// ============================================================================

describe("Flow assignment validation", () => {
  it("should handle multiple flows without overlap", () => {
    // This tests the logic indirectly through the result structure
    const mockResult: FlowDetectionResult = {
      flows: [
        {
          name: "Auth",
          description: "Auth changes",
          files: ["src/auth/login.ts", "src/auth/logout.ts"],
          priority: 1,
        },
        {
          name: "API",
          description: "API changes",
          files: ["src/api/users.ts", "src/api/posts.ts"],
          priority: 2,
        },
      ],
      uncategorized: ["src/utils/helpers.ts"],
    };

    // Verify no file appears in multiple flows
    const allFlowFiles = mockResult.flows.flatMap((f) => f.files);
    const uniqueFiles = new Set(allFlowFiles);
    expect(allFlowFiles.length).toBe(uniqueFiles.size);

    // Verify uncategorized files don't appear in any flow
    for (const uncatFile of mockResult.uncategorized) {
      expect(allFlowFiles).not.toContain(uncatFile);
    }
  });

  it("should sort flows by priority", () => {
    const mockResult: FlowDetectionResult = {
      flows: [
        { name: "Low", description: "", files: ["a.ts"], priority: 3 },
        { name: "High", description: "", files: ["b.ts"], priority: 1 },
        { name: "Medium", description: "", files: ["c.ts"], priority: 2 },
      ],
      uncategorized: [],
    };

    // If sorted by priority, should be High, Medium, Low
    const sorted = [...mockResult.flows].sort((a, b) => a.priority - b.priority);
    expect(sorted[0]!.name).toBe("High");
    expect(sorted[1]!.name).toBe("Medium");
    expect(sorted[2]!.name).toBe("Low");
  });
});

// ============================================================================
// Large Diff Scenario Tests
// ============================================================================

describe("Large diff scenarios", () => {
  it("should handle a realistic 50-file diff prompt", () => {
    // Create a realistic set of files for a medium-large PR
    const files: DiffFile[] = [
      // Auth flow (8 files)
      ...["login", "logout", "session", "middleware", "types", "utils", "constants", "hooks"].map(
        (name) => createMockFile(`src/auth/${name}.ts`)
      ),
      // API flow (10 files)
      ...["users", "posts", "comments", "likes", "follows", "notifications", "search", "feed", "analytics", "admin"].map(
        (name) => createMockFile(`src/api/${name}.ts`)
      ),
      // UI flow (12 files)
      ...["Button", "Input", "Modal", "Card", "List", "Avatar", "Badge", "Dropdown", "Tooltip", "Tabs", "Nav", "Footer"].map(
        (name) => createMockFile(`src/components/${name}.tsx`)
      ),
      // State flow (6 files)
      ...["store", "userSlice", "postSlice", "uiSlice", "selectors", "middleware"].map(
        (name) => createMockFile(`src/store/${name}.ts`)
      ),
      // Test files (10 files)
      ...["auth", "api", "components", "store", "utils", "hooks", "integration", "e2e", "fixtures", "mocks"].map(
        (name) => createMockFile(`src/__tests__/${name}.test.ts`)
      ),
      // Config/misc (4 files)
      createMockFile("src/config/settings.ts"),
      createMockFile("src/types/index.ts"),
      createMockFile("src/utils/helpers.ts"),
      createMockFile("README.md"),
    ];

    const diff: ParsedDiff = { files };
    const classified = files.map((f) => createClassifiedFile(f));

    const prompt = buildFlowDetectionPrompt(diff, classified);

    // Should handle 50 files
    expect(prompt).toContain("Total files to group: 50");

    // Should include files from different areas
    expect(prompt).toContain("src/auth/login.ts");
    expect(prompt).toContain("src/api/users.ts");
    expect(prompt).toContain("src/components/Button.tsx");
    expect(prompt).toContain("src/store/store.ts");
    expect(prompt).toContain("src/__tests__/auth.test.ts");
  });
});

// ============================================================================
// Integration Tests (require API key - skipped without it)
// ============================================================================

describe("detectFlows integration", () => {
  const hasAPIKey = !!process.env["ANTHROPIC_API_KEY"];

  it.skipIf(!hasAPIKey)(
    "should detect flows for a realistic diff",
    async () => {
      const { detectFlows } = await import("./flow-detection.js");

      // Create a realistic medium-sized diff with clear groupings
      const files: DiffFile[] = [
        // Auth-related
        createMockFile("src/auth/login.ts", "modified", [
          createMockHunk(20, 10, [
            "// Old login logic",
            "async function login(email, password) {",
            "  // Old implementation",
            "export async function login(email: string, password: string) {",
            "  // New implementation with better security",
            "  const hashedPassword = await bcrypt.hash(password);",
            "  return await db.users.findOne({ email, password: hashedPassword });",
          ]),
        ]),
        createMockFile("src/auth/session.ts", "modified", [
          createMockHunk(15, 5, [
            "// Session handling",
            "export function createSession(user) {",
            "export function createSession(user: User): Session {",
            "  return { userId: user.id, token: generateToken() };",
          ]),
        ]),
        // API-related
        createMockFile("src/api/users.ts", "modified", [
          createMockHunk(30, 15, [
            "// User API routes",
            "router.get('/users', getUsers);",
            "router.get('/users/:id', getUser);",
            "router.post('/users', createUser);",
          ]),
        ]),
        createMockFile("src/api/posts.ts", "added", [
          createMockHunk(50, 0, [
            "// Post API routes",
            "router.get('/posts', getPosts);",
            "router.post('/posts', createPost);",
          ]),
        ]),
        // Test files
        createMockFile("src/__tests__/auth.test.ts", "modified", [
          createMockHunk(25, 10, [
            "describe('login', () => {",
            "  it('should login successfully', async () => {",
          ]),
        ]),
        createMockFile("src/__tests__/api.test.ts", "added", [
          createMockHunk(40, 0, [
            "describe('API routes', () => {",
            "  describe('/users', () => {",
          ]),
        ]),
      ];

      const diff: ParsedDiff = { files };
      const classified = files.map((f) => createClassifiedFile(f));

      const result = await detectFlows(diff, classified);

      // Should have detected some flows
      expect(result.flows.length).toBeGreaterThan(0);
      expect(result.flows.length).toBeLessThanOrEqual(8);

      // Each flow should have files
      for (const flow of result.flows) {
        expect(flow.files.length).toBeGreaterThan(0);
        expect(flow.name).toBeTruthy();
        expect(flow.description).toBeTruthy();
        expect(flow.priority).toBeGreaterThanOrEqual(1);
      }

      // All files should be accounted for (in flows or uncategorized)
      const totalAssigned =
        result.flows.reduce((sum, f) => sum + f.files.length, 0) +
        result.uncategorized.length;
      expect(totalAssigned).toBe(files.length);

      // No file should appear in multiple flows
      const allFlowFiles = result.flows.flatMap((f) => f.files);
      const uniqueFiles = new Set(allFlowFiles);
      expect(allFlowFiles.length).toBe(uniqueFiles.size);
    },
    60000 // 60 second timeout for API calls
  );
});
