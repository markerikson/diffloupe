/**
 * Resolves which repository and which commit range to review.
 *
 * In CI the base and head come from the pull_request event payload, which the
 * workflow passes through as BASE and HEAD. Locally they can come from a
 * fixture file (TARGETS) or, failing both, from the GitHub API.
 */
import path from "node:path";
import { run } from "./proc.ts";

export interface Target {
  /**
   * Absent when reviewing a bare commit range. Everything that talks to GitHub
   * — the description, the prior comments, the API payloads — is keyed on this,
   * so without it the review is local-only.
   */
  pr?: string | undefined;
  base: string;
  head: string;
  /** owner/name, for the GitHub API. */
  slug: string;
}

/**
 * Names the cached repo map for a target.
 *
 * Both the pipeline and the standalone map builder derive this, and a map
 * written under one name and read under another is silently useless — the
 * pipeline just rebuilds it every run. Two copies of the same rule is how that
 * happened, so there is one.
 *
 * The head commit is part of the key in both forms. The pipeline treats the
 * presence of the map file as proof it is current and never checks what it was
 * built from, so a key naming only the pull request would serve a map of the
 * previous push's code to a review of this one. CI never sees this because its
 * artifacts directory is new each run; the local loop this cache exists for is
 * exactly the one that keeps `.code-review/` across pushes.
 */
export function targetKey(t: Pick<Target, "pr" | "base" | "head">): string {
  return t.pr
    ? `pr-${t.pr}-${t.head.slice(0, 7)}`
    : `range-${t.base.slice(0, 7)}-${t.head.slice(0, 7)}`;
}

/**
 * owner/name from the origin remote, so nothing hardcodes a fork. A repo with
 * no origin, or a non-GitHub origin, gets `local/<dirname>`. Only PR targets
 * talk to GitHub.
 */
export async function repoSlug(repo: string): Promise<string> {
  if (process.env.GH_REPO) return process.env.GH_REPO;
  const r = await run("git", ["-C", repo, "remote", "get-url", "origin"], { allowFail: true });
  const url = r.code === 0 ? r.stdout.trim() : "";
  const m = url.match(/github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?$/);
  if (!m) return `local/${path.basename(path.resolve(repo))}`;
  return `${m[1]}/${m[2]}`;
}
