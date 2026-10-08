
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { run, text } from "./proc.ts";
import { openSubject } from "./subject.ts";

/** A throwaway repository with two commits, so there is a wrong commit to be at. */
async function makeRepo(): Promise<{ dir: string; first: string; second: string }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "subject-test-"));
  await text("git", ["-C", dir, "init", "-q", "-b", "main"]);
  await text("git", ["-C", dir, "config", "user.email", "t@example.com"]);
  await text("git", ["-C", dir, "config", "user.name", "Test"]);
  writeFileSync(path.join(dir, "a.txt"), "one\n");
  await text("git", ["-C", dir, "add", "."]);
  await text("git", ["-C", dir, "commit", "-qm", "one"]);
  const first = (await text("git", ["-C", dir, "rev-parse", "HEAD"])).trim();
  writeFileSync(path.join(dir, "a.txt"), "two\n");
  await text("git", ["-C", dir, "commit", "-qam", "two"]);
  const second = (await text("git", ["-C", dir, "rev-parse", "HEAD"])).trim();
  return { dir, first, second };
}

describe("openSubject", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env.CODE_REVIEW_SUBJECT_DIR = saved.CODE_REVIEW_SUBJECT_DIR;
    process.env.CODE_REVIEW_NO_CHECKOUT = saved.CODE_REVIEW_NO_CHECKOUT;
  });

  it("uses the checkout as it stands when told the workflow already moved it", async () => {
    const repo = await makeRepo();
    process.env.CODE_REVIEW_NO_CHECKOUT = "1";
    delete process.env.CODE_REVIEW_SUBJECT_DIR;
    const subject = await openSubject(repo.dir, undefined, repo.first);
    expect(subject.dir).toBe(repo.dir);
    await subject.release();
  });

  // Detaching the clone the review runs out of discards the developer's branch
  // position and swaps the reviewer's own scripts for the pull request's copy
  // of them mid-run. This guard has been wrong twice: `rev-parse` answers for
  // the enclosing repository, and the launching clone is the root of its own
  // working tree, so neither check on its own rules this out.
  it("refuses to move the checkout it is running from", async () => {
    const repo = await makeRepo();
    delete process.env.CODE_REVIEW_NO_CHECKOUT;
    process.env.CODE_REVIEW_SUBJECT_DIR = repo.dir;
    await expect(openSubject(repo.dir, undefined, repo.first)).rejects.toThrow(
      /is the checkout this review is running from/,
    );
    const at = (await text("git", ["-C", repo.dir, "rev-parse", "HEAD"])).trim();
    expect(at).toBe(repo.second);
  });

  it("refuses a directory that only sits inside a working tree", async () => {
    const repo = await makeRepo();
    const inside = path.join(repo.dir, "scratch");
    await run("mkdir", [inside]);
    writeFileSync(path.join(inside, "mine.txt"), "keep me\n");
    delete process.env.CODE_REVIEW_NO_CHECKOUT;
    process.env.CODE_REVIEW_SUBJECT_DIR = inside;
    await expect(openSubject(repo.dir, undefined, repo.first)).rejects.toThrow(
      /is not the root of its own git working tree/,
    );
    const at = (await text("git", ["-C", repo.dir, "rev-parse", "HEAD"])).trim();
    expect(at).toBe(repo.second);
  });

  // `checkout --detach` only aborts when a dirty file would be overwritten by
  // the checkout. An edit to a tracked file the two commits agree on is carried
  // into the new tree untouched, and the review then reads source that is not
  // the head commit — so the refusal has to be ours, not git's.
  it("refuses to move a reused directory with edits to tracked files", async () => {
    const repo = await makeRepo();
    const own = path.join(mkdtempSync(path.join(os.tmpdir(), "subject-dirty-")), "tree");
    delete process.env.CODE_REVIEW_NO_CHECKOUT;
    process.env.CODE_REVIEW_SUBJECT_DIR = own;

    const first = await openSubject(repo.dir, undefined, repo.second);
    await first.release();
    // b.txt exists in neither commit, so this edit survives any checkout; a.txt
    // differs between them, so git itself would catch that one. Add a tracked
    // file at the target commit's content to hit the silent case.
    writeFileSync(path.join(own, "b.txt"), "tracked and edited\n");
    await text("git", ["-C", own, "add", "b.txt"]);

    await expect(openSubject(repo.dir, undefined, repo.first)).rejects.toThrow(
      /uncommitted changes to tracked files/,
    );
  });

  it("gives each run on the same commit its own checkout", async () => {
    const repo = await makeRepo();
    delete process.env.CODE_REVIEW_NO_CHECKOUT;
    delete process.env.CODE_REVIEW_SUBJECT_DIR;

    const a = await openSubject(repo.dir, undefined, repo.first);
    const b = await openSubject(repo.dir, undefined, repo.first);
    expect(a.dir).not.toBe(b.dir);
    await a.release();
    expect((await text("git", ["-C", b.dir, "rev-parse", "HEAD"])).trim()).toBe(repo.first);
    await b.release();
    expect(existsSync(a.dir)).toBe(false);
    expect(existsSync(b.dir)).toBe(false);
  });

  it("moves a directory the caller owns rather than destroying it", async () => {
    const repo = await makeRepo();
    const own = path.join(mkdtempSync(path.join(os.tmpdir(), "subject-own-")), "tree");
    delete process.env.CODE_REVIEW_NO_CHECKOUT;
    process.env.CODE_REVIEW_SUBJECT_DIR = own;

    const first = await openSubject(repo.dir, undefined, repo.second);
    expect(first.dir).toBe(own);
    writeFileSync(path.join(own, "untracked.txt"), "caller's\n");

    const again = await openSubject(repo.dir, undefined, repo.first);
    expect((await text("git", ["-C", own, "rev-parse", "HEAD"])).trim()).toBe(repo.first);
    // A directory the caller named is never removed, so anything they left in
    // it survives.
    expect((await text("cat", [path.join(own, "untracked.txt")])).trim()).toBe("caller's");
    await again.release();
    expect((await text("git", ["-C", own, "rev-parse", "HEAD"])).trim()).toBe(repo.first);
  });
});
