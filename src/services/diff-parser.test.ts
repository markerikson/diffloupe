import { describe, expect, test } from "bun:test";
import { parseDiff } from "./diff-parser.js";

describe("parseDiff", () => {
  describe("edge cases", () => {
    test("empty string returns empty files array", () => {
      const result = parseDiff("");
      expect(result.files).toEqual([]);
    });

    test("whitespace-only string returns empty files array", () => {
      const result = parseDiff("   \n\n  ");
      expect(result.files).toEqual([]);
    });
  });

  describe("new files", () => {
    test("parses new file with added status", () => {
      const diff = `diff --git a/newfile.ts b/newfile.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/newfile.ts
@@ -0,0 +1,3 @@
+const x = 1;
+const y = 2;
+export { x, y };
`;

      const result = parseDiff(diff);
      expect(result.files).toHaveLength(1);

      const file = result.files[0]!;
      expect(file.status).toBe("added");
      expect(file.path).toBe("newfile.ts");
      expect(file.oldPath).toBeUndefined();
      expect(file.isBinary).toBe(false);
      expect(file.hunks).toHaveLength(1);

      const hunk = file.hunks[0]!;
      expect(hunk.oldStart).toBe(0);
      expect(hunk.oldLines).toBe(0);
      expect(hunk.newStart).toBe(1);
      expect(hunk.newLines).toBe(3);
      expect(hunk.lines).toHaveLength(3);

      // All lines should be additions
      for (const line of hunk.lines) {
        expect(line.type).toBe("add");
        expect(line.oldLineNumber).toBeUndefined();
        expect(line.newLineNumber).toBeDefined();
      }
    });
  });

  describe("deleted files", () => {
    test("parses deleted file with deleted status", () => {
      const diff = `diff --git a/oldfile.ts b/oldfile.ts
deleted file mode 100644
index abc1234..0000000
--- a/oldfile.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-const old = true;
-export { old };
`;

      const result = parseDiff(diff);
      expect(result.files).toHaveLength(1);

      const file = result.files[0]!;
      expect(file.status).toBe("deleted");
      expect(file.path).toBe("oldfile.ts");

      const hunk = file.hunks[0]!;
      expect(hunk.lines).toHaveLength(2);

      // All lines should be deletions
      for (const line of hunk.lines) {
        expect(line.type).toBe("delete");
        expect(line.oldLineNumber).toBeDefined();
        expect(line.newLineNumber).toBeUndefined();
      }
    });
  });

  describe("renamed files", () => {
    test("parses renamed file with oldPath", () => {
      const diff = `diff --git a/old-name.ts b/new-name.ts
similarity index 95%
rename from old-name.ts
rename to new-name.ts
index abc1234..def5678 100644
--- a/old-name.ts
+++ b/new-name.ts
@@ -1,3 +1,3 @@
 const x = 1;
-const y = 2;
+const y = 3;
 export { x, y };
`;

      const result = parseDiff(diff);
      expect(result.files).toHaveLength(1);

      const file = result.files[0]!;
      expect(file.status).toBe("renamed");
      expect(file.path).toBe("new-name.ts");
      expect(file.oldPath).toBe("old-name.ts");
    });
  });

  describe("binary files", () => {
    test("detects binary file from Binary files marker", () => {
      const diff = `diff --git a/image.png b/image.png
new file mode 100644
index 0000000..abc1234
Binary files /dev/null and b/image.png differ
`;

      const result = parseDiff(diff);
      expect(result.files).toHaveLength(1);

      const file = result.files[0]!;
      expect(file.isBinary).toBe(true);
      expect(file.hunks).toHaveLength(0);
    });

    test("detects binary file from GIT binary patch marker", () => {
      const diff = `diff --git a/data.bin b/data.bin
index abc1234..def5678 100644
GIT binary patch
literal 1234
somebinarydata
`;

      const result = parseDiff(diff);
      expect(result.files).toHaveLength(1);
      expect(result.files[0]!.isBinary).toBe(true);
    });
  });

  describe("modified files", () => {
    test("parses modification with context lines", () => {
      const diff = `diff --git a/src/utils.ts b/src/utils.ts
index abc1234..def5678 100644
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -10,7 +10,8 @@ import { foo } from "./foo";
 
 export function helper(x: number): number {
   // Some comment
-  const result = x * 2;
+  const multiplier = 2;
+  const result = x * multiplier;
   return result;
 }
`;

      const result = parseDiff(diff);
      expect(result.files).toHaveLength(1);

      const file = result.files[0]!;
      expect(file.status).toBe("modified");
      expect(file.path).toBe("src/utils.ts");

      const hunk = file.hunks[0]!;
      expect(hunk.oldStart).toBe(10);
      expect(hunk.oldLines).toBe(7);
      expect(hunk.newStart).toBe(10);
      expect(hunk.newLines).toBe(8);

      // Check line types
      const types = hunk.lines.map((l) => l.type);
      expect(types).toEqual([
        "context", // empty line
        "context", // export function
        "context", // comment
        "delete", // old const result
        "add", // new const multiplier
        "add", // new const result
        "context", // return
        "context", // }
      ]);
    });

    test("tracks line numbers correctly", () => {
      const diff = `diff --git a/file.ts b/file.ts
index abc..def 100644
--- a/file.ts
+++ b/file.ts
@@ -1,4 +1,5 @@
 line1
-line2
+line2a
+line2b
 line3
 line4
`;

      const result = parseDiff(diff);
      const lines = result.files[0]!.hunks[0]!.lines;

      // Context line: both numbers
      expect(lines[0]).toMatchObject({
        type: "context",
        content: "line1",
        oldLineNumber: 1,
        newLineNumber: 1,
      });

      // Deleted line: only old number
      expect(lines[1]).toMatchObject({
        type: "delete",
        content: "line2",
        oldLineNumber: 2,
        newLineNumber: undefined,
      });

      // Added lines: only new numbers
      expect(lines[2]).toMatchObject({
        type: "add",
        content: "line2a",
        oldLineNumber: undefined,
        newLineNumber: 2,
      });
      expect(lines[3]).toMatchObject({
        type: "add",
        content: "line2b",
        oldLineNumber: undefined,
        newLineNumber: 3,
      });

      // Context after changes: numbers adjusted
      expect(lines[4]).toMatchObject({
        type: "context",
        content: "line3",
        oldLineNumber: 3,
        newLineNumber: 4,
      });
    });
  });

  describe("multiple files", () => {
    test("parses multiple files in single diff", () => {
      const diff = `diff --git a/file1.ts b/file1.ts
index abc..def 100644
--- a/file1.ts
+++ b/file1.ts
@@ -1 +1 @@
-old
+new
diff --git a/file2.ts b/file2.ts
index 123..456 100644
--- a/file2.ts
+++ b/file2.ts
@@ -1 +1 @@
-foo
+bar
`;

      const result = parseDiff(diff);
      expect(result.files).toHaveLength(2);
      expect(result.files[0]!.path).toBe("file1.ts");
      expect(result.files[1]!.path).toBe("file2.ts");
    });
  });

  describe("multiple hunks", () => {
    test("parses file with multiple hunks", () => {
      const diff = `diff --git a/file.ts b/file.ts
index abc..def 100644
--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,3 @@
 start
-old1
+new1
 middle
@@ -10,3 +10,3 @@ function foo() {
 more
-old2
+new2
 end
`;

      const result = parseDiff(diff);
      expect(result.files).toHaveLength(1);
      expect(result.files[0]!.hunks).toHaveLength(2);

      const [hunk1, hunk2] = result.files[0]!.hunks;
      expect(hunk1!.oldStart).toBe(1);
      expect(hunk2!.oldStart).toBe(10);
    });
  });

  describe("hunk header parsing", () => {
    test("parses hunk header without line counts (single line)", () => {
      const diff = `diff --git a/file.ts b/file.ts
index abc..def 100644
--- a/file.ts
+++ b/file.ts
@@ -5 +5 @@ context
-old
+new
`;

      const result = parseDiff(diff);
      const hunk = result.files[0]!.hunks[0]!;
      expect(hunk.oldStart).toBe(5);
      expect(hunk.oldLines).toBe(1);
      expect(hunk.newStart).toBe(5);
      expect(hunk.newLines).toBe(1);
    });

    test("preserves full header line including context", () => {
      const diff = `diff --git a/file.ts b/file.ts
index abc..def 100644
--- a/file.ts
+++ b/file.ts
@@ -10,5 +10,6 @@ export function myFunc() {
 code
`;

      const result = parseDiff(diff);
      const hunk = result.files[0]!.hunks[0]!;
      expect(hunk.header).toBe("@@ -10,5 +10,6 @@ export function myFunc() {");
    });
  });

  describe("no newline at end of file", () => {
    test("handles no newline marker", () => {
      const diff = `diff --git a/file.ts b/file.ts
index abc..def 100644
--- a/file.ts
+++ b/file.ts
@@ -1,2 +1,2 @@
 line1
-line2
\\ No newline at end of file
+line2modified
\\ No newline at end of file
`;

      const result = parseDiff(diff);
      const lines = result.files[0]!.hunks[0]!.lines;

      // Should have 3 actual lines, not including the "no newline" markers
      expect(lines).toHaveLength(3);
      expect(lines.map((l) => l.type)).toEqual(["context", "delete", "add"]);
    });
  });
});
