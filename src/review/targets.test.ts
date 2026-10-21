import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { text } from "./core/lib/proc.ts";
import { parseModelOverrides } from "./run-driver.ts";
import { MAX_UNTRACKED_BYTES, makeTag, parseTargetSpec, pinPullRequestHead, resolveTarget } from "./targets.ts";

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

  it("parses bare ranges like git", () => {
    expect(parseTargetSpec("9b1e201..b20dfcf")).toEqual({
      kind: "range",
      from: "9b1e201",
      to: "b20dfcf",
      mergeBase: false,
    });
    expect(parseTargetSpec("main...feature/x")).toEqual({
      kind: "range",
      from: "main",
      to: "feature/x",
      mergeBase: true,
    });
    expect(parseTargetSpec("HEAD~3..")).toEqual({ kind: "range", from: "HEAD~3", to: "HEAD", mergeBase: false });
    expect(parseTargetSpec("...topic")).toEqual({ kind: "range", from: "HEAD", to: "topic", mergeBase: true });
    expect(parseTargetSpec("range:v1.0..")).toEqual({ kind: "range", from: "v1.0", to: "HEAD", mergeBase: false });
  });

  it("parses bare revisions as single commits", () => {
    for (const rev of ["9b1e201", "b20dfcf0123456789abcdef0123456789abcdef0", "HEAD^1", "HEAD~3", "main^", "v1.2.3", "123"]) {
      expect(parseTargetSpec(rev)).toEqual({ kind: "commit", rev });
    }
  });

  it("rejects unknown specs", () => {
    expect(() => parseTargetSpec("range:main")).toThrow(/unrecognized target/);
    expect(() => parseTargetSpec("..")).toThrow(/unrecognized target/);
    expect(() => parseTargetSpec("a..b..c")).toThrow(/unrecognized target/);
    expect(() => parseTargetSpec("comit:abc")).toThrow(/unrecognized target/);
    expect(() => parseTargetSpec("--output=x")).toThrow(/unrecognized target/);
    expect(() => parseTargetSpec("two words")).toThrow(/unrecognized target/);
    expect(() => parseTargetSpec("https://github.com/a/b/issues/3")).toThrow(/pull request URL/);
  });
});

describe("makeTag", () => {
  const now = new Date(2026, 9, 8, 7, 5, 3);
  it("names pull requests by number", () => {
    expect(makeTag("diffloupe", { kind: "pr", pr: 42 }, "abcdef1234567890", now)).toBe(
      "diffloupe-pr42-abcdef123456-20261008070503",
    );
  });
  it("names other targets by kind", () => {
    expect(makeTag("diffloupe", { kind: "worktree" }, "abcdef1234567890", now)).toBe(
      "diffloupe-worktree-abcdef123456-20261008070503",
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

  it("resolves bare revisions and ranges", async () => {
    const head = (await git("rev-parse", "HEAD")).trim();
    const parent = (await git("rev-parse", "HEAD^")).trim();
    const range = await resolveTarget(repo, `${parent.slice(0, 7)}..${head.slice(0, 7)}`);
    expect(range.target).toMatchObject({ base: parent, head });
    const open = await resolveTarget(repo, "HEAD~1..");
    expect(open.target).toMatchObject({ base: parent, head });
    const commit = await resolveTarget(repo, "main~0");
    expect(commit.target).toMatchObject({ base: parent, head });
    expect(commit.spec).toEqual({ kind: "commit", rev: "main~0" });
  });

  it("reviews a bare branch name as the whole branch", async () => {
    const main = (await git("rev-parse", "main")).trim();
    await git("checkout", "-q", "-b", "feature");
    await writeFile(path.join(repo, "a.ts"), "export const a = 3;\n");
    await git("commit", "-q", "-am", "third");
    await writeFile(path.join(repo, "a.ts"), "export const a = 4;\n");
    await git("commit", "-q", "-am", "fourth");
    const head = (await git("rev-parse", "HEAD")).trim();

    const bare = await resolveTarget(repo, "feature");
    expect(bare.spec).toEqual({ kind: "branch", branch: "feature" });
    expect(bare.target).toMatchObject({ base: main, head });
    expect(bare.commits).toBe(2);
    expect(bare.tag).toMatch(/-branch-/);

    const tip = await resolveTarget(repo, "commit:feature");
    expect(tip.spec).toEqual({ kind: "commit", rev: "feature" });
    expect(tip.target).toMatchObject({ base: (await git("rev-parse", "HEAD^")).trim(), head });
    expect(tip.commits).toBe(1);

    const defaultBranch = await resolveTarget(repo, "main");
    expect(defaultBranch.spec).toEqual({ kind: "commit", rev: "main" });
    expect(defaultBranch.target.head).toBe(main);
  });

  it("names a revision git cannot resolve", async () => {
    await expect(resolveTarget(repo, "nosuchref")).rejects.toThrow(/unknown revision "nosuchref"/);
    await expect(resolveTarget(repo, "main..nosuchref")).rejects.toThrow(/unknown revision "nosuchref"/);
    await expect(resolveTarget(repo, "4242")).rejects.toThrow(/use #4242/);
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

  it("pins a pull request to an earlier commit of its branch", async () => {
    const head = (await git("rev-parse", "HEAD")).trim();
    const parent = (await git("rev-parse", "HEAD^")).trim();
    expect(await pinPullRequestHead(repo, 7, head, parent)).toBe(parent);
    expect(await pinPullRequestHead(repo, 7, head, head)).toBe(head);
    expect(await pinPullRequestHead(repo, 7, head, parent.toUpperCase())).toBe(parent);
    expect(await pinPullRequestHead(repo, 7, head, head.toUpperCase())).toBe(head);
  });

  // Server requests skip the CLI's check, and the value reaches `git fetch`.
  it("rejects a --head that is not a full SHA before running git", async () => {
    const head = (await git("rev-parse", "HEAD")).trim();
    await expect(pinPullRequestHead(repo, 7, head, "--upload-pack=touch /tmp/x")).rejects.toThrow(/40-character/);
    await expect(pinPullRequestHead(repo, 7, head, head.slice(0, 12))).rejects.toThrow(/40-character/);
  });

  // A force-push can leave the commit CI was started for off the branch. Reviewing
  // it anyway would post comments against lines the pull request no longer has.
  it("rejects a --head that is not in the branch's history", async () => {
    const parent = (await git("rev-parse", "HEAD^")).trim();
    await git("checkout", "-q", "-b", "other", parent);
    await writeFile(path.join(repo, "a.ts"), "export const a = 9;\n");
    await git("commit", "-q", "-am", "elsewhere");
    const stray = (await git("rev-parse", "HEAD")).trim();
    const main = (await git("rev-parse", "main")).trim();
    await expect(pinPullRequestHead(repo, 7, main, stray)).rejects.toThrow(/not in the history of pull request #7/);
  });

  it("diffs a snapshot against merge-base with --base", async () => {
    await writeFile(path.join(repo, "new.ts"), "export const b = 1;\n");
    const r = await resolveTarget(repo, "worktree", { base: "HEAD~1" });
    expect(r.target.base).toBe((await git("rev-parse", "HEAD~1")).trim());
    expect(r.changes.files).toBe(2);
  });
});
