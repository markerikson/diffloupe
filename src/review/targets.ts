/**
 * Turns a DiffLoupe target spec into the base/head pair the review core reads.
 *
 * Every target ends up as two commits in the local clone. Staged and
 * working-tree changes are snapshotted into a synthetic commit on top of HEAD,
 * built through a temporary index so the user's real index is never written.
 */
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
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
  /** Commits in `base..head`; absent for staged and working-tree snapshots. */
  commits?: number;
  /** Untracked files left out of a working-tree snapshot because of their size. */
  skippedUntracked: string[];
  pullRequest?: PullRequestInfo;
}

export interface ResolveOptions {
  /** For staged and worktree targets: diff against merge-base(base, HEAD) instead of HEAD. */
  base?: string;
  /** For pull requests: review this commit instead of the live head. It must be in the head's history. */
  head?: string;
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
    const range = parseRange(rest);
    if (range) return range;
  }

  // Bare git revisions: `a..b`, `a...b`, or anything naming one commit
  // (`9b1e201`, `HEAD~3`, `main^`, a tag). git checks them during resolution.
  if (!prefix && !s.startsWith("-") && !/\s/.test(s)) {
    if (s.includes("..")) {
      const range = parseRange(s);
      if (range) return range;
    } else {
      return { kind: "commit", rev: s };
    }
  }
  throw new TargetError(
    `unrecognized target "${s}". Use worktree, staged, a commit (<sha>, HEAD~2, commit:<rev>), ` +
      `a range (<a>..<b>, <a>...<b>, range:<a>..<b>), branch:<name>, #<pr>, pr:<n>, owner/repo#<n>, ` +
      `or a pull request URL.`,
  );
}

/** `a..b` compares the two commits; `a...b` compares b with merge-base(a, b). An empty side means HEAD. */
function parseRange(s: string): TargetSpec | undefined {
  const mergeBase = s.includes("...");
  const sides = s.split(mergeBase ? "..." : "..");
  if (sides.length !== 2) return undefined;
  const [from = "", to = ""] = sides;
  if (!from && !to) return undefined;
  if (from.includes("..") || to.includes("..")) return undefined;
  return { kind: "range", from: from || "HEAD", to: to || "HEAD", mergeBase };
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
  return `${name}-${what}-${head.slice(0, 12)}-${stamp}`;
}

export async function resolveTarget(
  repo: string,
  specText: string | undefined,
  opts: ResolveOptions = {},
): Promise<ResolvedTarget> {
  let spec = parseTargetSpec(specText);
  const git = (args: string[], o: RunOptions = {}) => text("git", ["-C", repo, ...args], o);
  const rev = async (r: string) => {
    const res = await run("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `${r}^{commit}`], {
      allowFail: true,
    });
    if (res.code !== 0) {
      const hint = /^\d+$/.test(r) ? ` (for pull request ${r}, use #${r})` : "";
      throw new TargetError(`unknown revision "${r}": not a commit in ${repo}${hint}`);
    }
    return res.stdout.trim();
  };
  const mergeBase = async (a: string, b: string) => (await git(["merge-base", a, b])).trim();

  const top = await run("git", ["-C", repo, "rev-parse", "--show-toplevel"], { allowFail: true });
  if (top.code !== 0) {
    throw new TargetError(
      `${repo} is not inside a git repository` +
        (spec.kind === "pr" && spec.repo ? ". diffloupe diff can show this pull request without a clone." : ""),
    );
  }

  const slug = await repoSlug(repo);
  let base: string;
  let head: string;
  let pullRequest: PullRequestInfo | undefined;
  let skippedUntracked: string[] = [];
  let synthetic = false;
  let defaultBase: string | undefined;

  // A bare branch name means the whole branch. `commit:<branch>` keeps the tip
  // commit, and so does the default branch, which has nothing of its own.
  if (spec.kind === "commit" && isBareRev(specText) && (await isBranch(repo, spec.rev))) {
    defaultBase = await defaultBranch(repo).catch(() => undefined);
    if (defaultBase) {
      const tip = await rev(spec.rev);
      if ((await mergeBase(defaultBase, tip)) !== tip) spec = { kind: "branch", branch: spec.rev };
    }
  }

  switch (spec.kind) {
    case "pr": {
      if (spec.repo && !slug.startsWith("local/") && spec.repo.toLowerCase() !== slug.toLowerCase()) {
        throw new TargetError(
          `pull request is in ${spec.repo} but ${repo} is a clone of ${slug}. Run from a clone of ${spec.repo} or pass -C. ` +
            `diffloupe diff can show it without a clone.`,
        );
      }
      pullRequest = await fetchPullRequest(repo, spec.pr, spec.repo ?? (slug.startsWith("local/") ? undefined : slug));
      head = pullRequest.headRefOid;
      await ensureCommit(repo, head, [`refs/pull/${spec.pr}/head`]);
      if (opts.head) head = await pinPullRequestHead(repo, spec.pr, head, opts.head);
      await ensureCommit(repo, pullRequest.baseRefOid, [pullRequest.baseRefName]);
      base = await mergeBase(pullRequest.baseRefOid, head);
      break;
    }
    case "branch": {
      head = await rev(spec.branch);
      base = await mergeBase(defaultBase ?? (await defaultBranch(repo)), head);
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
  const commits = synthetic ? undefined : Number((await git(["rev-list", "--count", `${base}..${head}`])).trim());
  const target: Target = { base, head, slug, ...(spec.kind === "pr" ? { pr: String(spec.pr) } : {}) };
  return {
    spec,
    target,
    tag,
    changes,
    ...(commits !== undefined ? { commits } : {}),
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

const SLUG_PART = /^(?!\.{1,2}$)[\w.-]+$/;

/** `owner/repo` when both parts are plain names, so they can name a directory. */
export function validSlug(slug: string): boolean {
  const parts = slug.split("/");
  return parts.length === 2 && parts.every((p) => SLUG_PART.test(p));
}

/**
 * True when a pull request names a repository that `repo` is not a clone of.
 * Such a pull request can be diffed through a remote copy instead.
 */
export async function needsRemoteCopy(repo: string, spec: TargetSpec): Promise<boolean> {
  if (spec.kind !== "pr" || !spec.repo) return false;
  const top = await run("git", ["-C", repo, "rev-parse", "--show-toplevel"], { allowFail: true });
  if (top.code !== 0) return true;
  const slug = await repoSlug(repo);
  return !slug.startsWith("local/") && slug.toLowerCase() !== spec.repo.toLowerCase();
}

/**
 * Creates the bare repository at `dir` that holds DiffLoupe's copy of a GitHub
 * repository, if it is not there yet. It is a partial clone with no history:
 * each run fetches only its two commits, their trees, and blobs on demand.
 * git authenticates through gh, so private repositories work the same.
 */
export async function openRemoteCopy(dir: string, slug: string, url = `https://github.com/${slug}.git`): Promise<void> {
  if (!validSlug(slug)) throw new TargetError(`not a GitHub repository: ${slug}`);
  const git = (...args: string[]) => text("git", ["-C", dir, ...args]);
  const exists = await stat(path.join(dir, "HEAD")).catch(() => null);
  if (exists) return;
  await mkdir(dir, { recursive: true });
  await git("init", "-q", "--bare");
  await git("remote", "add", "origin", url);
  await git("config", "core.repositoryformatversion", "1");
  await git("config", "extensions.partialClone", "origin");
  await git("config", "remote.origin.promisor", "true");
  await git("config", "remote.origin.partialclonefilter", "blob:none");
  await git("config", "gc.auto", "0");
  // An empty helper first clears any configured helpers for this repository.
  await git("config", "credential.helper", "");
  await git("config", "--add", "credential.helper", "!gh auth git-credential");
}

/**
 * Resolves a pull request in the remote copy at `dir`: reads it with gh, finds
 * the merge base through the compare API, and fetches both commits without
 * history or blobs. Both are pinned under `refs/diffloupe/` until the run is
 * deleted.
 */
export async function resolveRemotePullRequest(
  dir: string,
  spec: Extract<TargetSpec, { kind: "pr" }> & { repo: string },
  opts: Pick<ResolveOptions, "now" | "isTaken"> = {},
): Promise<ResolvedTarget> {
  const pullRequest = await fetchPullRequest(dir, spec.pr, spec.repo);
  const head = pullRequest.headRefOid;
  const compare = await run(
    "gh",
    ["api", `repos/${spec.repo}/compare/${pullRequest.baseRefOid}...${head}`, "--jq", ".merge_base_commit.sha"],
    { cwd: dir, allowFail: true },
  );
  const base = compare.code === 0 && compare.stdout.trim() ? compare.stdout.trim() : pullRequest.baseRefOid;
  await fetchShallow(dir, [base, head], [`refs/pull/${spec.pr}/head`]);
  const repoName = spec.repo.split("/").pop() ?? spec.repo;
  const tag = freeTag(makeTag(repoName, spec, head, opts.now), opts.isTaken);
  await text("git", ["-C", dir, "update-ref", `refs/diffloupe/${tag}`, head]);
  await text("git", ["-C", dir, "update-ref", `refs/diffloupe/${tag}-base`, base]);
  return {
    spec,
    target: { base, head, slug: spec.repo, pr: String(spec.pr) },
    tag,
    changes: await countChanges(dir, base, head),
    skippedUntracked: [],
    pullRequest,
  };
}

async function fetchShallow(dir: string, shas: string[], fallbackRefs: string[]): Promise<void> {
  const missing = async () => {
    const present = await Promise.all(shas.map((sha) => hasCommit(dir, sha)));
    return shas.filter((_, i) => !present[i]);
  };
  const fetch = (wants: string[]) =>
    run("git", ["-C", dir, "fetch", "-q", "--depth=1", "--filter=blob:none", "--no-tags", "origin", ...wants], {
      allowFail: true,
    });
  let wanted = await missing();
  if (wanted.length === 0) return;
  const first = await fetch(wanted);
  wanted = await missing();
  for (const ref of fallbackRefs) {
    if (wanted.length === 0) return;
    await fetch([ref]);
    wanted = await missing();
  }
  if (wanted.length) {
    throw new TargetError(
      `could not fetch ${wanted.map((s) => s.slice(0, 12)).join(", ")} from GitHub: ${first.stderr.trim() || "not found"}`,
    );
  }
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
  // In a partial clone a missing commit would otherwise be fetched with its
  // whole history just to answer the question.
  const r = await run("git", ["-C", repo, "cat-file", "-e", `${sha}^{commit}`], {
    allowFail: true,
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
  });
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

/**
 * `--head`: review the pull request as of the commit a CI job was started for,
 * not whatever was pushed since. The commit must be in the branch's history.
 */
export async function pinPullRequestHead(repo: string, pr: number, liveHead: string, pinned: string): Promise<string> {
  if (pinned === liveHead) return liveHead;
  await ensureCommit(repo, pinned, [`refs/pull/${pr}/head`, pinned]);
  const onBranch = await run("git", ["-C", repo, "merge-base", "--is-ancestor", pinned, liveHead], { allowFail: true });
  if (onBranch.code !== 0) {
    throw new TargetError(`--head ${pinned} is not in the history of pull request #${pr} (head ${liveHead.slice(0, 12)})`);
  }
  return pinned;
}

function isBareRev(specText: string | undefined): boolean {
  return !(specText ?? "").trim().startsWith("commit:");
}

async function isBranch(repo: string, name: string): Promise<boolean> {
  const found = await Promise.all(
    [`refs/heads/${name}`, `refs/remotes/${name}`].map((ref) =>
      run("git", ["-C", repo, "show-ref", "--verify", "--quiet", ref], { allowFail: true }),
    ),
  );
  return found.some((r) => r.code === 0);
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
