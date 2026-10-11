import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gatherChangeFacts } from "./change-facts.ts";
import { projectFilesAtCommit, readFilesAt, treeFiles } from "./git-objects.ts";
import { projectFilesFromGit } from "./module-resolver.ts";
import { text } from "./proc.ts";

let repo: string;
const git = (...args: string[]) => text("git", ["-C", repo, ...args]);

async function put(rel: string, body: string) {
  await mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
  await writeFile(path.join(repo, rel), body);
}

beforeEach(async () => {
  repo = await mkdtemp(path.join(os.tmpdir(), "dl-gitobj-"));
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "t@example.com");
  await git("config", "user.name", "t");
  await git("config", "commit.gpgsign", "false");
  await put("package.json", JSON.stringify({ name: "fixture" }));
  await put("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }));
  await put("src/util.ts", "export function helper() { return 1; }\n");
  await put("src/app.ts", "import { helper } from './util';\nexport const x = helper();\n");
  await put("README.md", "# fixture\n");
  await git("add", ".");
  await git("commit", "-q", "-m", "base");
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("git object reads", () => {
  it("lists blobs and reads contents with multibyte text intact", async () => {
    await put("src/ünï.ts", "export const s = 'héllo ✓';\n");
    await git("add", ".");
    await git("commit", "-q", "-m", "more");
    const head = (await git("rev-parse", "HEAD")).trim();
    const paths = await treeFiles(repo, head);
    expect(paths.sort()).toEqual(["README.md", "package.json", "src/app.ts", "src/util.ts", "src/ünï.ts", "tsconfig.json"]);
    const files = await readFilesAt(repo, head, ["src/ünï.ts", "missing.ts", "src/util.ts"]);
    expect(files.get("src/ünï.ts")).toBe("export const s = 'héllo ✓';\n");
    expect(files.get("src/util.ts")).toBe("export function helper() { return 1; }\n");
    expect(files.has("missing.ts")).toBe(false);
  });

  it("preloads requested and config files only", async () => {
    const head = (await git("rev-parse", "HEAD")).trim();
    const files = await projectFilesAtCommit(repo, head, ["src/app.ts"]);
    expect(files.paths.has("src/util.ts")).toBe(true);
    expect(files.read("src/app.ts")).toContain("helper");
    expect(files.read("tsconfig.json")).toContain("baseUrl");
    expect(files.read("package.json")).toContain("fixture");
    expect(files.read("src/util.ts")).toBeUndefined();
  });

  it("gives the same change facts as reading the checkout", async () => {
    const base = (await git("rev-parse", "HEAD")).trim();
    await put("src/feature.ts", "import { helper } from '@/util';\nexport function feature() { return helper(); }\n");
    await put("src/app.ts", "import { helper } from './util';\nimport { feature } from './feature';\nexport const x = helper() + feature();\n");
    await git("add", ".");
    await git("commit", "-q", "-m", "change");
    const head = (await git("rev-parse", "HEAD")).trim();
    const files = ["src/app.ts", "src/feature.ts"];
    const diffU0 = await git("diff", "--unified=0", `${base}..${head}`, "--", ...files);
    const fileTokens = new Map(files.map((f) => [f, 10]));

    const fromDisk = await gatherChangeFacts({ source: projectFilesFromGit(repo), diffU0, files, fileTokens });
    // Change the checkout so a disk read would differ from the commit.
    await put("src/feature.ts", "export const nothing = 0;\n");
    const fromGit = await gatherChangeFacts({
      source: await projectFilesAtCommit(repo, head, files),
      diffU0,
      files,
      fileTokens,
    });
    expect(fromGit).toEqual(fromDisk);
    const app = fromGit.find((f) => f.file === "src/app.ts");
    expect(app?.imports).toEqual(["src/feature.ts", "src/util.ts"]);
    expect(fromGit.find((f) => f.file === "src/feature.ts")?.imports).toEqual(["src/util.ts"]);
  });
});
