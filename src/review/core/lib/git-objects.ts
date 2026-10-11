/**
 * Read files at a commit straight from the object store, so grouping can run
 * against any commit without checking it out.
 */
import { spawn } from "node:child_process";
import { posix } from "node:path";
import type { ProjectFiles } from "./module-resolver.ts";

function gitBuffer(repo: string, args: string[], input?: string, env?: NodeJS.ProcessEnv): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", repo, ...args], {
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (c: Buffer) => out.push(c));
    child.stderr?.on("data", (c: Buffer) => err.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`git ${args.join(" ")} exited ${code}\n${Buffer.concat(err).toString("utf8").slice(0, 2000)}`));
    });
    if (input !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    }
  });
}

/** Path → blob id for every blob in the tree at `sha`, repo-relative with forward slashes. */
async function treeBlobs(repo: string, sha: string): Promise<Map<string, string>> {
  const out = (await gitBuffer(repo, ["ls-tree", "-r", "-z", sha])).toString("utf8");
  const blobs = new Map<string, string>();
  for (const entry of out.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const [, type, oid] = entry.slice(0, tab).split(" ");
    if (type === "blob" && oid) blobs.set(entry.slice(tab + 1), oid);
  }
  return blobs;
}

/** Every blob path in the tree at `sha`, repo-relative with forward slashes. */
export async function treeFiles(repo: string, sha: string): Promise<string[]> {
  return [...(await treeBlobs(repo, sha)).keys()];
}

/**
 * In a partial clone, fetches the blobs in `oids` that are not local yet with
 * one request. Without this, `cat-file --batch` fetches each missing blob in
 * its own round trip. A repo that is not a partial clone is left alone.
 */
export async function prefetchBlobs(repo: string, oids: string[]): Promise<void> {
  if (oids.length === 0) return;
  const remote = (
    await gitBuffer(repo, ["config", "--get", "extensions.partialClone"]).catch(() => Buffer.alloc(0))
  )
    .toString("utf8")
    .trim();
  if (!remote) return;
  const check = await gitBuffer(repo, ["cat-file", "--batch-check"], `${oids.join("\n")}\n`, {
    GIT_NO_LAZY_FETCH: "1",
  });
  const missing = check
    .toString("utf8")
    .split("\n")
    .flatMap((l) => (l.endsWith(" missing") ? [l.slice(0, l.indexOf(" "))] : []));
  if (missing.length === 0) return;
  await gitBuffer(
    repo,
    [
      "-c",
      "fetch.negotiationAlgorithm=noop",
      "fetch",
      "-q",
      "--no-tags",
      "--no-write-fetch-head",
      "--recurse-submodules=no",
      "--filter=blob:none",
      "--stdin",
      remote,
    ],
    `${missing.join("\n")}\n`,
  );
}

/**
 * Contents of `paths` at `sha`, read with one `git cat-file --batch`. Paths that
 * are missing or contain a newline are left out of the result.
 */
export async function readFilesAt(repo: string, sha: string, paths: string[]): Promise<Map<string, string>> {
  const wanted = paths.filter((p) => !p.includes("\n"));
  const files = new Map<string, string>();
  if (wanted.length === 0) return files;
  const out = await gitBuffer(repo, ["cat-file", "--batch"], wanted.map((p) => `${sha}:${p}\n`).join(""));
  let pos = 0;
  for (const p of wanted) {
    const eol = out.indexOf(0x0a, pos);
    if (eol < 0) break;
    const header = out.subarray(pos, eol).toString("utf8");
    pos = eol + 1;
    if (header.endsWith(" missing") || header.endsWith(" ambiguous")) continue;
    const size = Number(header.split(" ")[2]);
    if (!Number.isFinite(size)) break;
    const type = header.split(" ")[1];
    if (type === "blob") files.set(p, out.subarray(pos, pos + size).toString("utf8"));
    pos += size + 1;
  }
  return files;
}

const CONFIG_FILE = /^(?:(?:tsconfig|jsconfig).*\.json|package\.json)$/;

/**
 * Every file at `sha`, with contents preloaded for `preload` plus every
 * tsconfig, jsconfig and package.json in the tree, the files import
 * resolution reads. `read` of anything else returns undefined.
 */
export async function projectFilesAtCommit(repo: string, sha: string, preload: string[]): Promise<ProjectFiles> {
  const blobs = await treeBlobs(repo, sha);
  const set = new Set(blobs.keys());
  const configs = [...set].filter((p) => CONFIG_FILE.test(posix.basename(p)));
  const toRead = [...new Set([...preload.filter((p) => set.has(p)), ...configs])];
  await prefetchBlobs(
    repo,
    toRead.map((p) => blobs.get(p) ?? "").filter(Boolean),
  );
  const contents = await readFilesAt(repo, sha, toRead);
  return { paths: set, read: (p) => contents.get(p) };
}
