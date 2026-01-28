/**
 * Tests for deleted file summarization
 */

import { describe, it, expect } from "bun:test";
import {
  shouldSummarizeDeletedFile,
  extractSignatures,
  summarizeDeletedFile,
  formatDeletedFileSummary,
} from "./deleted-file-summary.js";
import type { DiffFile } from "../types/diff.js";

/**
 * Helper to create a deleted file with N lines
 */
function createDeletedFile(path: string, lineCount: number): DiffFile {
  const lines = Array.from({ length: lineCount }, (_, i) => ({
    type: "delete" as const,
    content: `line ${i + 1}`,
    oldLineNumber: i + 1,
    newLineNumber: undefined,
  }));

  return {
    path,
    status: "deleted",
    isBinary: false,
    hunks: [
      {
        oldStart: 1,
        oldLines: lineCount,
        newStart: 0,
        newLines: 0,
        header: `@@ -1,${lineCount} +0,0 @@`,
        lines,
      },
    ],
  };
}

/**
 * Helper to create a deleted file with specific content
 */
function createDeletedFileWithContent(
  path: string,
  content: string[]
): DiffFile {
  const lines = content.map((line, i) => ({
    type: "delete" as const,
    content: line,
    oldLineNumber: i + 1,
    newLineNumber: undefined,
  }));

  return {
    path,
    status: "deleted",
    isBinary: false,
    hunks: [
      {
        oldStart: 1,
        oldLines: content.length,
        newStart: 0,
        newLines: 0,
        header: `@@ -1,${content.length} +0,0 @@`,
        lines,
      },
    ],
  };
}

describe("shouldSummarizeDeletedFile", () => {
  it("returns false for non-deleted files", () => {
    const modifiedFile: DiffFile = {
      path: "src/test.ts",
      status: "modified",
      isBinary: false,
      hunks: [],
    };
    expect(shouldSummarizeDeletedFile(modifiedFile)).toBe(false);

    const addedFile: DiffFile = {
      path: "src/new.ts",
      status: "added",
      isBinary: false,
      hunks: [],
    };
    expect(shouldSummarizeDeletedFile(addedFile)).toBe(false);
  });

  it("returns false for small deleted files (<=100 lines)", () => {
    const smallFile = createDeletedFile("src/small.ts", 50);
    expect(shouldSummarizeDeletedFile(smallFile)).toBe(false);

    const boundaryFile = createDeletedFile("src/boundary.ts", 100);
    expect(shouldSummarizeDeletedFile(boundaryFile)).toBe(false);
  });

  it("returns true for large deleted files (>100 lines)", () => {
    const largeFile = createDeletedFile("src/large.ts", 101);
    expect(shouldSummarizeDeletedFile(largeFile)).toBe(true);

    const veryLargeFile = createDeletedFile("src/huge.ts", 500);
    expect(shouldSummarizeDeletedFile(veryLargeFile)).toBe(true);
  });
});

describe("extractSignatures", () => {
  describe("TypeScript/JavaScript", () => {
    it("extracts class declarations", () => {
      const content = `
class Foo {
  bar() {}
}

export class Bar {}

export default class Baz {}

abstract class AbstractThing {}
`;
      const signatures = extractSignatures(content, ".ts");

      expect(signatures).toContain("class Foo");
      expect(signatures).toContain("class Bar");
      expect(signatures).toContain("class Baz");
      expect(signatures).toContain("class AbstractThing");
    });

    it("extracts function declarations", () => {
      const content = `
function foo() {}

export function bar() {}

async function asyncFn() {}

export async function exportedAsync() {}

export default function defaultFn() {}
`;
      const signatures = extractSignatures(content, ".ts");

      expect(signatures).toContain("function foo()");
      expect(signatures).toContain("function bar()");
      expect(signatures).toContain("function asyncFn()");
      expect(signatures).toContain("function exportedAsync()");
      expect(signatures).toContain("function defaultFn()");
    });

    it("extracts arrow function exports", () => {
      const content = `
export const handler = () => {};

export const asyncHandler = async () => {};

const privateConst = 'not exported';
`;
      const signatures = extractSignatures(content, ".ts");

      expect(signatures).toContain("const handler");
      expect(signatures).toContain("const asyncHandler");
      expect(signatures).not.toContain("privateConst");
    });

    it("extracts interfaces", () => {
      const content = `
interface User {
  name: string;
}

export interface AuthState {
  isLoggedIn: boolean;
}
`;
      const signatures = extractSignatures(content, ".ts");

      expect(signatures).toContain("interface User");
      expect(signatures).toContain("interface AuthState");
    });

    it("extracts type aliases", () => {
      const content = `
type ID = string;

export type UserRole = 'admin' | 'user';
`;
      const signatures = extractSignatures(content, ".ts");

      expect(signatures).toContain("type ID");
      expect(signatures).toContain("type UserRole");
    });

    it("extracts named exports", () => {
      const content = `
export { foo, bar, baz };

export { original as renamed };

export { a, b, c as d };
`;
      const signatures = extractSignatures(content, ".ts");

      expect(signatures).toContain("export { foo, bar, baz }");
      expect(signatures).toContain("export { original }");
      expect(signatures).toContain("export { a, b, c }");
    });

    it("works with .tsx files", () => {
      const content = `
export function Component() {
  return <div />;
}

interface Props {
  name: string;
}
`;
      const signatures = extractSignatures(content, ".tsx");

      expect(signatures).toContain("function Component()");
      expect(signatures).toContain("interface Props");
    });

    it("works with .js, .jsx, .mjs, .cjs files", () => {
      const content = `
export function handler() {}
class Service {}
`;
      expect(extractSignatures(content, ".js")).toContain("function handler()");
      expect(extractSignatures(content, ".jsx")).toContain("class Service");
      expect(extractSignatures(content, ".mjs")).toContain("function handler()");
      expect(extractSignatures(content, ".cjs")).toContain("class Service");
    });
  });

  describe("Python", () => {
    it("extracts class declarations", () => {
      const content = `
class Foo:
    pass

class Bar(Base):
    def __init__(self):
        pass
`;
      const signatures = extractSignatures(content, ".py");

      expect(signatures).toContain("class Foo");
      expect(signatures).toContain("class Bar");
    });

    it("extracts function definitions", () => {
      const content = `
def foo():
    pass

async def async_handler():
    pass

def bar(a, b):
    return a + b
`;
      const signatures = extractSignatures(content, ".py");

      expect(signatures).toContain("def foo()");
      expect(signatures).toContain("def async_handler()");
      expect(signatures).toContain("def bar()");
    });
  });

  it("returns empty array for unknown extensions", () => {
    const content = "some content";
    expect(extractSignatures(content, ".xyz")).toEqual([]);
    expect(extractSignatures(content, "")).toEqual([]);
  });
});

describe("summarizeDeletedFile", () => {
  it("extracts header lines (first 15)", () => {
    const content = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    const file = createDeletedFileWithContent("src/test.ts", content);

    const summary = summarizeDeletedFile(file);

    expect(summary.headerLines).toHaveLength(15);
    expect(summary.headerLines[0]).toBe("line 1");
    expect(summary.headerLines[14]).toBe("line 15");
  });

  it("extracts signatures from content", () => {
    const content = [
      'import { foo } from "bar";',
      "",
      "export class AuthService {",
      "  login() {}",
      "}",
      "",
      "export function validateToken() {}",
      "",
      "export interface User {",
      "  name: string;",
      "}",
    ];
    const file = createDeletedFileWithContent("src/auth.ts", content);

    const summary = summarizeDeletedFile(file);

    expect(summary.signatures).toContain("class AuthService");
    expect(summary.signatures).toContain("function validateToken()");
    expect(summary.signatures).toContain("interface User");
  });

  it("reports total line count", () => {
    const file = createDeletedFile("src/test.ts", 287);

    const summary = summarizeDeletedFile(file);

    expect(summary.totalLines).toBe(287);
  });

  it("handles files with fewer than 15 lines", () => {
    const content = ["line 1", "line 2", "line 3"];
    const file = createDeletedFileWithContent("src/small.ts", content);

    const summary = summarizeDeletedFile(file);

    expect(summary.headerLines).toHaveLength(3);
    expect(summary.totalLines).toBe(3);
  });
});

describe("formatDeletedFileSummary", () => {
  it("formats with path and line count", () => {
    const file = createDeletedFile("src/old/legacy.ts", 287);
    const summary = summarizeDeletedFile(file);

    const formatted = formatDeletedFileSummary(file, summary);

    expect(formatted).toContain("DELETED FILE: src/old/legacy.ts (287 lines)");
  });

  it("includes language hint in code block", () => {
    const content = ['import { foo } from "bar";', "", "export class Test {}"];
    const file = createDeletedFileWithContent("src/test.ts", content);
    const summary = summarizeDeletedFile(file);

    const formatted = formatDeletedFileSummary(file, summary);

    expect(formatted).toContain("```typescript");
    expect(formatted).toContain('import { foo } from "bar";');
    expect(formatted).toContain("```");
  });

  it("includes extracted signatures", () => {
    const content = [
      'import { foo } from "bar";',
      "",
      "export class AuthService {}",
      "",
      "export function validate() {}",
    ];
    const file = createDeletedFileWithContent("src/auth.ts", content);
    const summary = summarizeDeletedFile(file);

    const formatted = formatDeletedFileSummary(file, summary);

    expect(formatted).toContain("Extracted signatures:");
    expect(formatted).toContain("- class AuthService");
    expect(formatted).toContain("- function validate()");
  });

  it("omits signatures section when none found", () => {
    const content = ["# Just a comment", "# No code here"];
    const file = createDeletedFileWithContent("src/readme.ts", content);
    const summary = summarizeDeletedFile(file);

    const formatted = formatDeletedFileSummary(file, summary);

    expect(formatted).not.toContain("Extracted signatures:");
  });

  it("uses correct language hints for different extensions", () => {
    const jsFile = createDeletedFileWithContent("app.js", ["const x = 1;"]);
    const pyFile = createDeletedFileWithContent("main.py", ["def foo():"]);

    const jsFormatted = formatDeletedFileSummary(
      jsFile,
      summarizeDeletedFile(jsFile)
    );
    const pyFormatted = formatDeletedFileSummary(
      pyFile,
      summarizeDeletedFile(pyFile)
    );

    expect(jsFormatted).toContain("```javascript");
    expect(pyFormatted).toContain("```python");
  });
});
