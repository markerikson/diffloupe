import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDiffSeededMap } from "../build-map.ts";
import type { RawOutline } from "./code-outline.ts";
import { blobIds, OUTLINE_FORMAT, OutlineCache } from "./outline-cache.ts";
import { text } from "./proc.ts";

const raw: RawOutline = { language: "typescript", lines: 3, symbols: [], importSpecs: ["./b.ts"], parseError: false };
const DAY_MS = 86_400_000;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "outline-cache-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("blobIds", () => {
  test("keeps clean files and drops edited files, submodules and conflict stages", () => {
    const staged = [
      "100644 aaaa 0\tsrc/a.ts",
      "100644 bbbb 0\tsrc/b.ts",
      "160000 cccc 0\tvendor/sub",
      "100644 dddd 2\tsrc/c.ts",
      "100644 eeee 0\tdir with space/d.ts",
    ].join("\n");
    const ids = blobIds(staged, "src/b.ts\n");
    expect([...ids]).toEqual([
      ["src/a.ts", "aaaa"],
      ["dir with space/d.ts", "eeee"],
    ]);
  });
});

describe("OutlineCache", () => {
  test("returns what was stored under the same blob and language", () => {
    const cache = new OutlineCache(dir);
    expect(cache.get("abcdef", "typescript")).toBeNull();
    cache.set("abcdef", "typescript", raw);
    expect(cache.get("abcdef", "typescript")).toEqual(raw);
    expect(cache.get("abcdef", "tsx")).toBeNull();
    expect([cache.hits, cache.misses]).toEqual([1, 2]);
  });

  test("prune drops stale entries and older formats, at most once a day", () => {
    const cache = new OutlineCache(dir);
    cache.set("aa11", "typescript", raw);
    cache.set("bb22", "typescript", raw);
    const old = new Date(Date.now() - 31 * DAY_MS);
    utimesSync(path.join(cache.dir, "aa", "aa11.typescript.json"), old, old);
    mkdirSync(path.join(dir, `v${OUTLINE_FORMAT - 1}`), { recursive: true });

    expect(cache.prune()).toBe(1);
    expect(cache.get("aa11", "typescript")).toBeNull();
    expect(cache.get("bb22", "typescript")).toEqual(raw);
    expect(readdirSync(dir).sort()).toEqual([".last-prune", `v${OUTLINE_FORMAT}`]);

    cache.set("aa11", "typescript", raw);
    utimesSync(path.join(cache.dir, "aa", "aa11.typescript.json"), old, old);
    expect(cache.prune()).toBe(0);
  });
});

describe("buildDiffSeededMap with an outline cache", () => {
  const git = (...args: string[]) => text("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);

  test("a second build reads every outline from the cache and renders the same map", async () => {
    await git("init", "-q");
    writeFileSync(path.join(dir, "a.ts"), "import { b } from './b.ts';\nexport function useB() { return b(); }\n");
    writeFileSync(path.join(dir, "b.ts"), "export function b() { return 1; }\n");
    await git("add", ".");
    await git("commit", "-q", "-m", "one");
    writeFileSync(path.join(dir, "b.ts"), "export function b() { return 2; }\nexport const LIMIT_VALUE = 3;\n");
    await git("commit", "-q", "-am", "two");
    const opts = { repo: dir, base: "HEAD~1", head: "HEAD", cacheDir: path.join(dir, ".cache") };

    const first = await buildDiffSeededMap(opts);
    const second = await buildDiffSeededMap(opts);
    expect(first.meta.outlineCache).toEqual({ hits: 0, misses: 2 });
    expect(second.meta.outlineCache).toEqual({ hits: 2, misses: 0 });
    expect(second.markdown).toBe(first.markdown);
    expect(second.markdown).toContain("b.ts");

    // An unstaged edit no longer matches the blob id, so it is parsed fresh.
    writeFileSync(path.join(dir, "a.ts"), "export function useB() { return 0; }\n");
    const third = await buildDiffSeededMap(opts);
    expect(third.meta.outlineCache).toEqual({ hits: 1, misses: 0 });
  });
});
