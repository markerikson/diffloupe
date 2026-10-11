/**
 * Turns a DiffLoupe target spec into the base/head pair the review core reads.
 *
 * Every target ends up as two commits in the local clone. Staged and
 * working-tree changes are snapshotted into a synthetic commit on top of HEAD,
 * built through a temporary index so the user's real index is never written.
 */
import { copyFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { run, text, type RunOptions } from "./core/lib/proc.ts";
import { repoSlug, type Target } from "./core/lib/target.ts";

export type TargetKind = "pr" | "branch" | "range" | "commit" | "staged" | "worktree";

export type TargetSpec =
  | { kind: "pr"; pr: number; repo?: string }
  | { kind: "branch"; branch: string }
  | { kind: "range"; from: string; to: string; mergeBase: boolean }
  | { kind: "commit"; rev: string }
  | { kind: "staged" }
  | { kind: "worktree" };

export interface PullRequestInfo {
  number: number;
  title: string;
  body: string;
  author: { login: string };
  url: string;
  state: string;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  baseRefOid: string;
  headRefOid: string;
}

export interface ChangeCounts {
  files: number;
  insertions: number;
  deletions: number;
}

export interface ResolvedTarget {
  spec: TargetSpec;
  target: Target;
  /** Run tag: names the artifacts and the pinned ref of a synthetic commit. */
  tag: string;
  changes: ChangeCounts;
  /** Untracked files left out of a working-tree snapshot because of their size. */
  skippedUntracked: string[];
  pullRequest?: PullRequestInfo;
}

export interface ResolveOptions {
  /** For staged and worktree targets: diff against merge-base(base, HEAD) instead of HEAD. */
  base?: string;
  now?: Date;
  /** True when a tag already names a run; the tag then gets a `-2`, `-3`… suffix. */
  isTaken?: (tag: string) => boolean;
}

function freeTag(tag: string, isTaken: ResolveOptions["isTaken"]): string {
  if (!isTaken) return tag;
  let candidate = tag;
  for (let n = 2; isTaken(candidate); n++) candidate = `${tag}-${n}`;
  return candidate;
}

/** Untracked files above this size are not snapshotted into a working-tree review. */
export const MAX_UNTRACKED_BYTES = 1024 * 1024;

export class TargetError extends Error {
  override name = "TargetError";
}

export function parseTargetSpec(spec: string | undefined): TargetSpec {
  const s = (spec ?? "worktree").trim();
  if (s === "" || s === "worktree") return { kind: "worktree" };
  if (s === "staged") return { kind: "staged" };
  if (s === "HEAD") return { kind: "commit", rev: "HEAD" };

  const pr = s.match(/^(?:#|pr:)(\d+)$/);
  if (pr?.[1]) return { kind: "pr", pr: Number(pr[1]) };
  const cross = s.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (cross?.[1] && cross[2]) return { kind: "pr", pr: Number(cross[2]), repo: cross[1] };
  if (/github\.com\//.test(s)) {
    const url = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/);
    if (!url?.[1] || !url[2] || !url[3]) throw new TargetError(`not a GitHub pull request URL: ${s}`);
    return { kind: "pr", pr: Number(url[3]), repo: `${url[1]}/${url[2]}` };
  }

  const colon = s.indexOf(":");
  const prefix = colon > 0 ? s.slice(0, colon) : "";
  const rest = colon > 0 ? s.slice(colon + 1) : "";
  if (prefix === "branch" && rest) return { kind: "branch", branch: rest };
  if (prefix === "commit" && rest) return { kind: "commit", rev: rest };
  if (prefix === "range") {
    const three = rest.split("...");
    if (three.length === 2 && three[0] && three[1]) {
      return { kind: "range", from: three[0], to: three[1], mergeBase: true };
    }
    const two = rest.split("..");
    if (two.length === 2 && two[0] && two[1]) {
      return { kind: "range", from: two[0], to: two[1], mergeBase: false };
    }
  }
  throw new TargetError(
    `unrecognized target "${s}". Use worktree, staged, HEAD, commit:<sha>, range:<a>..<b>, ` +
      `branch:<name>, #<pr>, pr:<n>, owner/repo#<n>, or a pull request URL.`,
  );
}

export function makeTag(
  repoName: string,
  spec: TargetSpec,
  head: string,
  now: Date = new Date(),
): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const what = spec.kind === "pr" ? `pr${spec.pr}` : spec.kind;
  const name = repoName.replace(/[^\w.-]+/g, "_");
  return `${name}-${what}-${head.slice(0, 7)}-${stamp}`;
}

export async function resolveTarget(
  repo: string,
  specText: string | undefined,
  opts: ResolveOptions = {},
): Promise<ResolvedTarget> {
  const spec = parseTargetSpec(specText);
  const git = (args: string[], o: RunOptions = {}) => text("git", ["-C", repo, ...args], o);
  const rev = async (r: string) => {
    const res = await run("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `${r}^{commit}`], {
      allowFail: true,
    });
    if (res.code !== 0) throw new TargetError(`unknown revision: ${r}`);
    return res.stdout.trim();
  };
  const mergeBase = async (a: string, b: string) => (await git(["merge-base", a, b])).trim();

  const top = await run("git", ["-C", repo, "rev-parse", "--show-toplevel"], { allowFail: true });
  if (top.code !== 0) throw new TargetError(`${repo} is not inside a git repository`);

  const slug = await repoSlug(repo);
  let base: string;
  let head: string;
  let pullRequest: PullRequestInfo | undefined;
  let skippedUntracked: string[] = [];
  let synthetic = false;

  switch (spec.kind) {
    case "pr": {
      if (spec.repo && !slug.startsWith("local/") && spec.repo.toLowerCase() !== slug.toLowerCase()) {
        throw new TargetError(
          `pull request is in ${spec.repo} but ${repo} is a clone of ${slug}. Run from a clone of ${spec.repo} or pass -C.`,
        );
      }
      pullRequest = await fetchPullRequest(repo, spec.pr, spec.repo ?? (slug.startsWith("local/") ? undefined : slug));
      head = pullRequest.headRefOid;
      await ensureCommit(repo, head, [`refs/pull/${spec.pr}/head`]);
      await ensureCommit(repo, pullRequest.baseRefOid, [pullRequest.baseRefName]);
      base = await mergeBase(pullRequest.baseRefOid, head);
      break;
    }
    case "branch": {
      head = await rev(spec.branch);
      base = await mergeBase(await defaultBranch(repo), head);
      break;
    }
    case "range": {
      const from = await rev(spec.from);
      head = await rev(spec.to);
      base = spec.mergeBase ? await mergeBase(from, head) : from;
      break;
    }
    case "commit": {
      head = await rev(spec.rev);
      const parent = await run("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `${head}^`], {
        allowFail: true,
      });
      if (parent.code !== 0) throw new TargetError(`${spec.rev} is a root commit; use range: instead`);
      base = parent.stdout.trim();
      break;
    }
    case "staged":
    case "worktree": {
      const parent = await rev("HEAD");
      const snap =
        spec.kind === "staged" ? await snapshotStaged(repo, parent) : await snapshotWorktree(repo, parent);
      head = snap.commit;
      skippedUntracked = snap.skipped;
      base = opts.base ? await mergeBase(await rev(opts.base), parent) : parent;
      synthetic = true;
      break;
    }
  }

  const repoName = slug.split("/").pop() ?? path.basename(repo);
  const tag = freeTag(makeTag(repoName, spec, head, opts.now), opts.isTaken);
  if (synthetic) {
    // A snapshot commit is reachable from nothing, so pin it until the user
    // clears refs/diffloupe/ — the review reads it through a worktree.
    await git(["update-ref", `refs/diffloupe/${tag}`, head]);
  }

  const changes = await countChanges(repo, base, head);
  const target: Target = { base, head, slug, ...(spec.kind === "pr" ? { pr: String(spec.pr) } : {}) };
  return {
    spec,
    target,
    tag,
    changes,
    skippedUntracked,
    ...(pullRequest ? { pullRequest } : {}),
  };
}

/**
 * Targets a base/head pair an earlier run already resolved. A snapshot head is
 * pinned again under the new tag, so it outlives the earlier run's ref.
 */
export async function pinnedTarget(
  repo: string,
  spec: TargetSpec,
  base: string,
  head: string,
  opts: Pick<ResolveOptions, "now" | "isTaken"> = {},
): Promise<ResolvedTarget> {
  const present = await Promise.all([base, head].map((sha) => hasCommit(repo, sha)));
  const missing = [base, head].filter((_, i) => !present[i]);
  if (missing.length) throw new TargetError(`commit ${missing[0]} is no longer in ${repo}`);
  const slug = await repoSlug(repo);
  const repoName = slug.split("/").pop() ?? path.basename(repo);
  const tag = freeTag(makeTag(repoName, spec, head, opts.now), opts.isTaken);
  if (spec.kind === "staged" || spec.kind === "worktree") {
    await text("git", ["-C", repo, "update-ref", `refs/diffloupe/${tag}`, head]);
  }
  const target: Target = { base, head, slug, ...(spec.kind === "pr" ? { pr: String(spec.pr) } : {}) };
  return { spec, target, tag, changes: await countChanges(repo, base, head), skippedUntracked: [] };
}

async function fetchPullRequest(repo: string, pr: number, ghRepo: string | undefined): Promise<PullRequestInfo> {
  const fields =
    "number,title,body,author,url,state,isDraft,baseRefName,headRefName,baseRefOid,headRefOid";
  const args = ["pr", "view", String(pr), "--json", fields, ...(ghRepo ? ["--repo", ghRepo] : [])];
  const res = await run("gh", args, { cwd: repo, allowFail: true });
  if (res.code !== 0) {
    throw new TargetError(`gh pr view ${pr} failed: ${res.stderr.trim() || `exit ${res.code}`}`);
  }
  return JSON.parse(res.stdout) as PullRequestInfo;
}

async function hasCommit(repo: string, sha: string): Promise<boolean> {
  const r = await run("git", ["-C", repo, "cat-file", "-e", `${sha}^{commit}`], { allowFail: true });
  return r.code === 0;
}

async function ensureCommit(repo: string, sha: string, refs: string[]): Promise<void> {
  if (await hasCommit(repo, sha)) return;
  for (const ref of refs) {
    await run("git", ["-C", repo, "fetch", "-q", "origin", ref], { allowFail: true });
    if (await hasCommit(repo, sha)) return;
  }
  throw new TargetError(`commit ${sha} is not in this clone and could not be fetched from origin`);
}

async function defaultBranch(repo: string): Promise<string> {
  const gh = await run("gh", ["repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"], {
    cwd: repo,
    allowFail: true,
  }).catch(() => null);
  const candidates: string[] = [];
  const ghName = gh?.code === 0 ? gh.stdout.trim() : "";
  if (ghName) candidates.push(`origin/${ghName}`, ghName);
  const originHead = await run("git", ["-C", repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
    allowFail: true,
  });
  if (originHead.code === 0 && originHead.stdout.trim()) candidates.push(originHead.stdout.trim());
  candidates.push("origin/main", "main", "origin/master", "master");
  for (const c of candidates) {
    const r = await run("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `${c}^{commit}`], {
      allowFail: true,
    });
    if (r.code === 0) return c;
  }
  throw new TargetError("could not determine the default branch; use range:<base>..<branch> instead");
}

async function commitTree(repo: string, tree: string, parent: string, message: string, env?: NodeJS.ProcessEnv) {
  const parentTree = (await text("git", ["-C", repo, "rev-parse", `${parent}^{tree}`])).trim();
  if (tree === parentTree) throw new TargetError("no changes to review");
  return (
    await text("git", ["-C", repo, "commit-tree", tree, "-p", parent, "-m", message], env ? { env } : {})
  ).trim();
}

async function snapshotStaged(repo: string, parent: string): Promise<{ commit: string; skipped: string[] }> {
  const tree = (await text("git", ["-C", repo, "write-tree"])).trim();
  return { commit: await commitTree(repo, tree, parent, "diffloupe: staged changes"), skipped: [] };
}

async function snapshotWorktree(repo: string, parent: string): Promise<{ commit: string; skipped: string[] }> {
  const top = (await text("git", ["-C", repo, "rev-parse", "--show-toplevel"])).trim();
  const realIndex = path.resolve(top, (await text("git", ["-C", top, "rev-parse", "--git-path", "index"])).trim());
  const tmpIndex = path.join(os.tmpdir(), `diffloupe-index-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    // Starting from a copy of the real index keeps files marked
    // assume-unchanged or skip-worktree as the user staged them.
    await copyFile(realIndex, tmpIndex).catch(async () => {
      await text("git", ["-C", top, "read-tree", parent], { env: { ...process.env, GIT_INDEX_FILE: tmpIndex } });
    });
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };

    const untracked = (await text("git", ["-C", top, "ls-files", "--others", "--exclude-standard", "-z"]))
      .split("\0")
      .filter(Boolean);
    const skipped: string[] = [];
    for (const f of untracked) {
      const st = await stat(path.join(top, f)).catch(() => null);
      if (st && st.isFile() && st.size > MAX_UNTRACKED_BYTES) skipped.push(f);
    }
    const excludes = skipped.map((f) => `:(exclude,literal)${f}`);
    await text("git", ["-C", top, "add", "-A", "--", ".", ...excludes], { env });
    const tree = (await text("git", ["-C", top, "write-tree"], { env })).trim();
    return { commit: await commitTree(top, tree, parent, "diffloupe: working tree", env), skipped };
  } finally {
    await rm(tmpIndex, { force: true });
  }
}

async function countChanges(repo: string, base: string, head: string): Promise<ChangeCounts> {
  const out = await text("git", ["-C", repo, "diff", "--numstat", "--no-renames", base, head]);
  const counts: ChangeCounts = { files: 0, insertions: 0, deletions: 0 };
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [ins, del] = line.split("\t");
    counts.files++;
    // Binary files report "-" for both columns.
    counts.insertions += Number(ins) || 0;
    counts.deletions += Number(del) || 0;
  }
  return counts;
}
