import { describe, expect, test } from "bun:test";
import { loadFixture } from "../../review/__fixtures__/load.ts";
import { parsePatch } from "./patch.ts";

describe("parsePatch", () => {
  for (const name of ["large-pr", "renames", "worktree", "small-commit", "docs-only"]) {
    test(`${name}: every RunFile.path maps to a parsed file`, () => {
      const fx = loadFixture(name);
      const run = fx.build();
      const files = parsePatch(fx.patch);
      for (const f of run.files) {
        const parsed = files.get(f.path);
        expect(parsed, f.path).toBeDefined();
        if (f.previousPath) expect(parsed?.prevName).toBe(f.previousPath);
      }
    });
  }

  test("renames, deletions and binary files are keyed like RunFile.path", () => {
    const patch = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 100%",
      "rename from old.ts",
      "rename to new.ts",
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "index 1111111..0000000",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-x",
      "diff --git a/img.png b/img.png",
      "new file mode 100644",
      "index 0000000..2222222",
      "Binary files /dev/null and b/img.png differ",
      "",
    ].join("\n");
    const files = parsePatch(patch);
    expect([...files.keys()].sort()).toEqual(["gone.ts", "img.png", "new.ts"]);
    expect(files.get("new.ts")?.prevName).toBe("old.ts");
    expect(files.get("gone.ts")?.type).toBe("deleted");
  });
});
