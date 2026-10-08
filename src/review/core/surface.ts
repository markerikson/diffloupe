import { type Finding } from "./findings.ts";
import { SURFACES } from "./config.ts";

// ---------------------------------------------------------------- render

export type Surface = "product" | "deploy" | "tooling";

/**
 * Where a file runs. A bug in shipped product code costs users; the same bug in
 * a dev script costs one engineer an afternoon. Both are worth reporting, but
 * they do not belong side by side in the same ordering, and this also decides
 * which findings are worth a comment of their own — see `primarySurface`.
 *
 * Product is identified by exclusion rather than by a list of source roots, so
 * a directory nobody thought to enumerate is treated as shipping code. `src`,
 * `lib` (shipped binaries such as 7z and the platform dylibs), `db` and
 * `database` (migrations that run against production), `packages`, `proto`,
 * `resources` and `third-party` all reach production and none of them are named
 * here.
 */
export function classifySurface(file: string): Surface {
  // Before the directory rules, so a test file under any root stays tooling.
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) return "tooling";
  // Before the root-file rule below, which would otherwise claim a root
  // Dockerfile — the thing that builds the production image.
  // Repo-specific deployment directories, from SURFACES in config.ts.
  if (SURFACES.deploy.some((p) => new RegExp(p).test(file))) return "deploy";
  if (/(^|\/)(Earthfile|[^/]*Dockerfile[^/]*)$/.test(file)) return "deploy";
  if (/(^|\/)(scripts|test|tests|__tests__|e2e)\//.test(file)) return "tooling";
  // Build and workflow description. `.github` and other CI directories are
  // graded with tooling rather than deploy because they describe CI, not the
  // production deployment: breaking one stops the build, which deployment
  // config does to the running service. Repo-specific tooling directories come
  // from SURFACES in config.ts.
  if (SURFACES.tooling.some((p) => new RegExp(p).test(file))) return "tooling";
  if (/^\./.test(file)) return "tooling";
  // A new top-level source directory is plausible and defaults to product
  // above. A new top-level source *file* is not — anything sitting loose in the
  // repo root is a manifest or a config, so `package.json` and `tsconfig.json`
  // stop counting as shipping code.
  if (!file.includes("/")) return "tooling";
  return "product";
}

export const SURFACE_RANK = { product: 0, deploy: 1, tooling: 2 } as const;

export const SURFACE_ORDER = ["product", "deploy", "tooling"] as const;

/**
 * The most production-proximate surface this change actually touches.
 *
 * Routing is relative to the pull request rather than absolute. On a change
 * that touches shipping code, a finding in a helper script is a distraction
 * from the finding in `src` and belongs in the collapsed list. On a change that
 * is *entirely* tooling there is nothing more important to make room for, and
 * demoting every finding would bury the whole point of the review.
 *
 * Presence, not proportion. A threshold would let ten new script files outvote
 * the two files that are the reason the pull request exists, which is the
 * common "fix a bug and add some scripts to analyze it" shape.
 *
 * Falls back to the findings' own files when the diff could not be read, which
 * is worse — it cannot see a surface that produced no findings — but is the
 * only signal left at that point.
 */
export function primarySurface(changedFiles: string[], findings: Finding[]): Surface {
  const pool = changedFiles.length ? changedFiles : findings.map((f) => f.file);
  const present = new Set(pool.map(classifySurface));
  return SURFACE_ORDER.find((s) => present.has(s)) ?? "product";
}

export const SURFACE_TAG: Record<string, string> = {
  product: "",
  deploy: "🚢 deploy",
  tooling: "🔧 tooling",
};

export const CONF = ["high", "medium", "low"] as const;

export const SEV = {
  blocker: { badge: "🔴 **Blocker**", rank: 0 },
  "should-fix": { badge: "🟠 **Should fix**", rank: 1 },
  question: { badge: "🔵 **Question**", rank: 2 },
  "nice-to-have": { badge: "⚪ **Nice to have**", rank: 3 },
} as const;

export const EFFORT_TAG: Record<string, string> = {
  quick: "⚡ Quick fix",
  moderate: "🔨 Some work",
  involved: "🏗️ Involved",
};

/**
 * Whether the comment's own lines are exactly the lines `suggested_code` replaces.
 *
 * The anchor decides where the comment lands, and GitHub rewrites whatever the
 * comment covers. With no anchor the payload uses the model's own lines, so the
 * two agree by construction; an off-hunk snap or a span collapsed to one end of
 * two hunks makes them disagree, and then a committable suggestion would edit
 * code the model never looked at.
 */
export function anchorCovers(f: Finding): boolean {
  const first = Math.min(f.line, f.end_line ?? f.line);
  const last = Math.max(f.line, f.end_line ?? f.line);
  if (!f._anchor) return true;
  if (f._anchor.kind !== "anchorable") return false;
  return (f._anchor.start_line ?? f._anchor.line) === first && f._anchor.line === last;
}

export const CAT: Record<string, string> = {
  bug: "🎯 Correctness",
  race: "🩺 Concurrency",
  "edge-case": "🎯 Correctness",
  "resource-leak": "🩺 Stability",
  invariant: "🗄️ Data integrity",
  architecture: "📐 Architecture",
  duplication: "📐 Architecture",
  performance: "🚀 Performance",
  security: "🔒 Security",
  other: "⚪ Other",
};

/**
 * Stands in for `impact` on findings written before that field existed. Takes as
 * many whole sentences as fit.
 *
 * `max` is a soft limit, honored at sentence granularity. The first sentence is
 * always returned even when it is longer than `max` on its own: a result that
 * stops mid-clause reads as the bot breaking rather than as a length limit, and
 * the summary as a whole is already bounded by `fitComment`.
 */
export function leadSentences(s: string, max = 280): string {
  const text = (s ?? "").trim();
  if (text.length <= max) return text;
  // Split only where punctuation is followed by whitespace, so "call-mcp.ts"
  // stays intact. A split keeps every character; a global match would drop any
  // prefix it failed to match.
  const parts = text.split(/(?<=[.!?])\s+/);
  let out = "";
  for (const p of parts) {
    if (out && `${out} ${p}`.length > max) break;
    out = out ? `${out} ${p}` : p;
  }
  return out.trim();
}
