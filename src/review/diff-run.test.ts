import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { text } from "./core/lib/proc.ts";
import { executeRun, prepareRun } from "./run-driver.ts";
import { deleteRun, listRuns } from "./run-store.ts";

describe("diff runs", () => {
  let tmp = "";
  let repo = "";
  const saved = { PATH: process.env.PATH, XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  const git = (...args: string[]) => text("git", ["-C", repo, ...args]);

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "diffloupe-diff-run-"));
    repo = path.join(tmp, "repo");
    await mkdir(path.join(repo, "src", "lib"), { recursive: true });
    await git("init", "-q", "-b", "main");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");
    await git("config", "commit.gpgsign", "false");
    await writeFile(path.join(repo, "src", "lib", "math.ts"), "export function add(a: number, b: number) {\n  return a + b;\n}\n");
    await writeFile(path.join(repo, "src", "main.ts"), 'import { add } from "./lib/math";\nconsole.log(add(1, 2));\n');
    await writeFile(path.join(repo, "README.md"), "# demo\n");
    await git("add", ".");
    await git("commit", "-q", "-m", "first");
    await writeFile(
      path.join(repo, "src", "lib", "math.ts"),
      "export function add(a: number, b: number) {\n  return a + b;\n}\nexport function twice(a: number) {\n  return add(a, a);\n}\n",
    );
    await writeFile(path.join(repo, "src", "main.ts"), 'import { twice } from "./lib/math";\nconsole.log(twice(2));\n');
    await writeFile(path.join(repo, "README.md"), "# demo\n\nNow doubles.\n");
    await git("commit", "-q", "-am", "second");

    // Only git on PATH: a diff run must not need opencode, tilth or gh.
    const bin = path.join(tmp, "bin");
    await mkdir(bin);
    await symlink(Bun.which("git")!, path.join(bin, "git"));
    process.env.PATH = bin;
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

  it("groups a commit with only git on PATH, no credentials and no worktree", async () => {
    const worktreesBefore = await git("worktree", "list");
    const lines: string[] = [];
    const prep = await prepareRun({ kind: "diff", repo, target: "HEAD" }, repo, (m) => lines.push(m));
    expect(prep.kind).toBe("diff");
    expect(prep.pending.meta.kind).toBe("diff");
    expect(lines[0]).toMatch(/^Diff of /);

    const events: string[] = [];
    const { run, reviewed } = await executeRun(prep, {
      signal: new AbortController().signal,
      onProgress: (e) => events.push(e.type),
      log: (m) => lines.push(m),
    });
    expect(reviewed).toBe(true);
    expect(events).toContain("groups");
    expect(run.status).toBe("complete");
    expect(run.meta.kind).toBe("diff");
    expect(run.meta.costUsd).toBe(0);
    expect(run.meta.models).toBeUndefined();
    expect(run.findings).toEqual([]);
    expect(run.stops).toEqual([]);

    const code = run.groups.find((g) => g.files.includes("src/main.ts"));
    expect(code?.files.sort()).toEqual(["src/lib/math.ts", "src/main.ts"]);
    expect(code?.title).toBe("src: lib/math, main");
    expect(run.groups.find((g) => g.id === "docs")?.files).toEqual(["README.md"]);
    expect(run.groups.find((g) => g.id === "other")?.title).toBe("Other changes");

    expect(await git("worktree", "list")).toBe(worktreesBefore);
    const headers = await listRuns();
    expect(headers.map((h) => h.kind)).toEqual(["diff"]);
  });

  it("a run started from an earlier one keeps its snapshot after the earlier run is deleted", async () => {
    await writeFile(path.join(repo, "src", "main.ts"), 'import { twice } from "./lib/math";\nconsole.log(twice(3));\n');
    const first = await prepareRun({ kind: "diff", repo, target: "worktree" }, repo, () => {});
    const second = await prepareRun({ kind: "diff", fromRun: first.id }, "/nonexistent", () => {});
    expect(second.id).not.toBe(first.id);
    expect(second.repo).toBe(repo);
    expect(second.target.base).toBe(first.target.base);
    expect(second.target.head).toBe(first.target.head);
    expect(second.reviewTarget.kind).toBe("worktree");

    await deleteRun(first.id);
    expect((await git("rev-parse", `refs/diffloupe/${second.id}`)).trim()).toBe(first.target.head);
  });

  it("asks for opencode only when the walkthrough is requested", async () => {
    await expect(prepareRun({ kind: "diff", repo, target: "HEAD", walkthrough: true }, repo, () => {})).rejects.toThrow(
      /opencode/,
    );
  });
});
