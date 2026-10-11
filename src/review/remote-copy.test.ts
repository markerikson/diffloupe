import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run, text } from "./core/lib/proc.ts";
import { executeRun, prepareRun } from "./run-driver.ts";
import { deleteRun, remoteCopyDir } from "./run-store.ts";
import { needsRemoteCopy, validSlug } from "./targets.ts";

describe("validSlug", () => {
  it("accepts owner/repo names and rejects paths", () => {
    expect(validSlug("replayio/backend")).toBe(true);
    expect(validSlug("reduxjs/redux-toolkit.js")).toBe(true);
    expect(validSlug("a/b/c")).toBe(false);
    expect(validSlug("../b")).toBe(false);
    expect(validSlug("a/..")).toBe(false);
    expect(validSlug("a/b c")).toBe(false);
  });
});

describe("remote copies", () => {
  let tmp = "";
  let source = "";
  let base = "";
  let head = "";
  const saved = {
    PATH: process.env.PATH,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  };
  const git = (...args: string[]) => text("git", ["-C", source, ...args]);
  const opts = () => ({ signal: new AbortController().signal, onProgress: () => {}, log: () => {} });

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "diffloupe-remote-"));
    source = path.join(tmp, "source");
    await mkdir(path.join(source, "src"), { recursive: true });
    await git("init", "-q", "-b", "main");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");
    await git("config", "commit.gpgsign", "false");
    await git("config", "uploadpack.allowFilter", "true");
    await git("config", "uploadpack.allowAnySHA1InWant", "true");
    await writeFile(path.join(source, "package.json"), '{ "name": "widget" }\n');
    await writeFile(path.join(source, "src", "math.ts"), "export const one = 1;\n");
    await writeFile(path.join(source, "src", "main.ts"), 'import { one } from "./math";\nconsole.log(one);\n');
    await git("add", ".");
    await git("commit", "-q", "-m", "first");
    base = (await git("rev-parse", "HEAD")).trim();
    await writeFile(path.join(source, "src", "math.ts"), "export const one = 1;\nexport const two = 2;\n");
    await writeFile(path.join(source, "src", "main.ts"), 'import { one, two } from "./math";\nconsole.log(one + two);\n');
    await git("commit", "-q", "-am", "second");
    head = (await git("rev-parse", "HEAD")).trim();

    const pr = {
      number: 7,
      title: "Add two",
      body: "Adds a second constant.",
      author: { login: "someone" },
      url: "https://github.com/acme/widget/pull/7",
      state: "OPEN",
      isDraft: false,
      baseRefName: "main",
      headRefName: "two",
      baseRefOid: base,
      headRefOid: head,
    };
    const bin = path.join(tmp, "bin");
    await mkdir(bin);
    await writeFile(path.join(tmp, "pr.json"), JSON.stringify(pr));
    await writeFile(
      path.join(bin, "gh"),
      [
        "#!/bin/sh",
        'case "$1 $2" in',
        `  "pr view") cat '${path.join(tmp, "pr.json")}' ;;`,
        `  api*) echo '${base}' ;;`,
        "  *) exit 1 ;;",
        "esac",
        "",
      ].join("\n"),
    );
    await chmod(path.join(bin, "gh"), 0o755);

    // The remote copy fetches from https://github.com/acme/widget.git; point
    // that URL at the local source repository.
    const gitconfig = path.join(tmp, "gitconfig");
    await writeFile(gitconfig, `[url "file://${source}"]\n\tinsteadOf = https://github.com/acme/widget.git\n`);
    process.env.GIT_CONFIG_GLOBAL = gitconfig;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    process.env.PATH = `${bin}:${saved.PATH ?? ""}`;
    process.env.XDG_DATA_HOME = path.join(tmp, "data");
    process.env.XDG_CONFIG_HOME = path.join(tmp, "config");
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(tmp, { recursive: true, force: true });
  });

  it("needs a remote copy only for a pull request of another repository", async () => {
    expect(await needsRemoteCopy(tmp, { kind: "pr", pr: 7, repo: "acme/widget" })).toBe(true);
    expect(await needsRemoteCopy(tmp, { kind: "pr", pr: 7 })).toBe(false);
    expect(await needsRemoteCopy(source, { kind: "commit", rev: "HEAD" })).toBe(false);
    await git("remote", "add", "origin", "git@github.com:acme/widget.git");
    expect(await needsRemoteCopy(source, { kind: "pr", pr: 7, repo: "Acme/Widget" })).toBe(false);
    expect(await needsRemoteCopy(source, { kind: "pr", pr: 7, repo: "acme/other" })).toBe(true);
  });

  it("diffs a pull request without a clone, fetching only the two commits", async () => {
    const outside = path.join(tmp, "elsewhere");
    await mkdir(outside);
    const prep = await prepareRun({ kind: "diff", repo: outside, target: "acme/widget#7" }, outside, () => {});
    const copy = remoteCopyDir("acme/widget");
    expect(prep.repo).toBe(copy);
    expect(prep.pending.repo).toEqual({ root: copy, slug: "acme/widget", remote: true });
    expect(prep.patch).toContain("export const two = 2;");

    const commits = (await text("git", ["-C", copy, "rev-list", "--all"])).trim().split("\n").sort();
    expect(commits).toEqual([base, head].sort());

    const { run: done } = await executeRun(prep, opts());
    expect(done.status).toBe("complete");
    expect(done.files.map((f) => f.path).sort()).toEqual(["src/main.ts", "src/math.ts"]);
    const code = done.groups.find((g) => g.files.includes("src/main.ts"));
    expect(code?.files).toContain("src/math.ts");

    await deleteRun(prep.id);
    const refs = await run("git", ["-C", copy, "for-each-ref", "refs/diffloupe/"]);
    expect(refs.stdout.trim()).toBe("");
  });

  it("refuses to review a run that has no clone", async () => {
    const outside = path.join(tmp, "elsewhere");
    await mkdir(outside);
    const prep = await prepareRun({ kind: "diff", repo: outside, target: "acme/widget#7" }, outside, () => {});
    await executeRun(prep, opts());
    await expect(prepareRun({ kind: "review", fromRun: prep.id }, outside, () => {})).rejects.toThrow(
      /needs a local clone/,
    );
  });
});
