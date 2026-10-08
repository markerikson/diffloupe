import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { text } from "./core/lib/proc.ts";
import { parseModelOverrides } from "./headless.ts";
import { MAX_UNTRACKED_BYTES, makeTag, parseTargetSpec, resolveTarget } from "./targets.ts";

describe("parseTargetSpec", () => {
  it("defaults to the working tree", () => {
    expect(parseTargetSpec(undefined)).toEqual({ kind: "worktree" });
    expect(parseTargetSpec("worktree")).toEqual({ kind: "worktree" });
  });

  it("parses pull request forms", () => {
    expect(parseTargetSpec("#12")).toEqual({ kind: "pr", pr: 12 });
    expect(parseTargetSpec("pr:12")).toEqual({ kind: "pr", pr: 12 });
    expect(parseTargetSpec("reduxjs/redux-toolkit#4567")).toEqual({
      kind: "pr",
      pr: 4567,
      repo: "reduxjs/redux-toolkit",
    });
    expect(parseTargetSpec("https://github.com/reduxjs/reselect/pull/9/files")).toEqual({
      kind: "pr",
      pr: 9,
      repo: "reduxjs/reselect",
    });
  });

  it("parses git forms", () => {
    expect(parseTargetSpec("staged")).toEqual({ kind: "staged" });
    expect(parseTargetSpec("HEAD")).toEqual({ kind: "commit", rev: "HEAD" });
    expect(parseTargetSpec("commit:abc123")).toEqual({ kind: "commit", rev: "abc123" });
    expect(parseTargetSpec("branch:feature/x")).toEqual({ kind: "branch", branch: "feature/x" });
    expect(parseTargetSpec("range:main..topic")).toEqual({
      kind: "range",
      from: "main",
      to: "topic",
      mergeBase: false,
    });
    expect(parseTargetSpec("range:main...topic")).toEqual({
      kind: "range",
      from: "main",
      to: "topic",
      mergeBase: true,
    });
  });

  it("rejects unknown specs", () => {
    expect(() => parseTargetSpec("123")).toThrow(/unrecognized target/);
    expect(() => parseTargetSpec("range:main")).toThrow(/unrecognized target/);
    expect(() => parseTargetSpec("https://github.com/a/b/issues/3")).toThrow(/pull request URL/);
  });
});

describe("makeTag", () => {
  const now = new Date(2026, 9, 8, 7, 5, 3);
  it("names pull requests by number", () => {
    expect(makeTag("diffloupe", { kind: "pr", pr: 42 }, "abcdef1234", now)).toBe(
      "diffloupe-pr42-abcdef1-20261008070503",
    );
  });
  it("names other targets by kind", () => {
    expect(makeTag("diffloupe", { kind: "worktree" }, "abcdef1234", now)).toBe(
      "diffloupe-worktree-abcdef1-20261008070503",
    );
  });
});

describe("parseModelOverrides", () => {
  it("maps stages to config keys", () => {
    expect(parseModelOverrides(["review=a", "coordinator=b", "walkthrough=c"])).toEqual({
      model: "a",
      modelMerge: "b",
      modelWalk: "c",
    });
  });
  it("rejects unknown stages and missing ids", () => {
    expect(() => parseModelOverrides(["merge=a"])).toThrow(/--model/);
    expect(() => parseModelOverrides(["review="])).toThrow(/--model/);
    expect(() => parseModelOverrides(["review"])).toThrow(/--model/);
  });
});

describe("resolveTarget", () => {
  let repo = "";
  const git = (...args: string[]) => text("git", ["-C", repo, ...args]);

  beforeEach(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), "diffloupe-targets-"));
    await git("init", "-q", "-b", "main");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");
    await git("config", "commit.gpgsign", "false");
    await writeFile(path.join(repo, "a.ts"), "export const a = 1;\n");
    await git("add", "a.ts");
    await git("commit", "-q", "-m", "first");
    await writeFile(path.join(repo, "a.ts"), "export const a = 2;\n");
    await git("commit", "-q", "-am", "second");
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("resolves a commit against its parent", async () => {
    const r = await resolveTarget(repo, "HEAD");
    expect(r.target.head).toBe((await git("rev-parse", "HEAD")).trim());
    expect(r.target.base).toBe((await git("rev-parse", "HEAD^")).trim());
    expect(r.target.slug).toMatch(/^local\//);
    expect(r.target.pr).toBeUndefined();
    expect(r.changes).toEqual({ files: 1, insertions: 1, deletions: 1 });
  });

  it("resolves a range", async () => {
    const r = await resolveTarget(repo, "range:HEAD~1..HEAD");
    expect(r.target.base).toBe((await git("rev-parse", "HEAD~1")).trim());
  });

  it("snapshots the working tree without touching the real index", async () => {
    await writeFile(path.join(repo, "a.ts"), "export const a = 3;\n");
    await writeFile(path.join(repo, "new.ts"), "export const b = 1;\n");
    await writeFile(path.join(repo, "big.bin"), Buffer.alloc(MAX_UNTRACKED_BYTES + 1));
    const indexBefore = await readFile(path.join(repo, ".git", "index"));

    const r = await resolveTarget(repo, undefined);

    expect(await readFile(path.join(repo, ".git", "index"))).toEqual(indexBefore);
    expect(r.target.base).toBe((await git("rev-parse", "HEAD")).trim());
    expect(r.skippedUntracked).toEqual(["big.bin"]);
    const files = (await git("diff", "--name-only", r.target.base, r.target.head)).trim().split("\n");
    expect(files.sort()).toEqual(["a.ts", "new.ts"]);
    expect((await git("rev-parse", `refs/diffloupe/${r.tag}`)).trim()).toBe(r.target.head);
  });

  it("snapshots only staged changes", async () => {
    await writeFile(path.join(repo, "a.ts"), "export const a = 3;\n");
    await git("add", "a.ts");
    await writeFile(path.join(repo, "new.ts"), "export const b = 1;\n");

    const r = await resolveTarget(repo, "staged");
    const files = (await git("diff", "--name-only", r.target.base, r.target.head)).trim();
    expect(files).toBe("a.ts");
  });

  it("refuses an empty snapshot", async () => {
    await expect(resolveTarget(repo, "staged")).rejects.toThrow(/no changes/);
  });

  it("diffs a snapshot against merge-base with --base", async () => {
    await writeFile(path.join(repo, "new.ts"), "export const b = 1;\n");
    const r = await resolveTarget(repo, "worktree", { base: "HEAD~1" });
    expect(r.target.base).toBe((await git("rev-parse", "HEAD~1")).trim());
    expect(r.changes.files).toBe(2);
  });
});
