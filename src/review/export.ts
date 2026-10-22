/**
 * Findings as markdown, for pasting into a PR comment, an issue, or an agent
 * prompt. Shared by the web UI's copy buttons and `runs show --markdown`, so
 * it uses no DOM or Bun APIs.
 */
import { code, fence } from "./core/lib/markdown.ts";
import { describeRound, formatTarget } from "./format-run.ts";
import type { DiffAnchor, FindingSeverity, ReviewRun, RunFinding, RunUserState } from "../types/review-run.ts";

export const SEVERITY_ORDER: readonly FindingSeverity[] = ["blocker", "should-fix", "nice-to-have", "question"];

const FENCE_LANGUAGE: Record<string, string> = {
  ts: "ts",
  mts: "ts",
  cts: "ts",
  tsx: "tsx",
  js: "js",
  mjs: "js",
  cjs: "js",
  jsx: "jsx",
  json: "json",
  css: "css",
  scss: "scss",
  html: "html",
  md: "md",
  py: "python",
  rs: "rust",
  go: "go",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  sh: "sh",
  bash: "sh",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sql: "sql",
};

export function fenceLanguage(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? (FENCE_LANGUAGE[name.slice(dot + 1).toLowerCase()] ?? "") : "";
}

function range(line: number, end?: number): string {
  return end && end !== line ? `${line}-${end}` : `${line}`;
}

/** `src/a.ts:12-14`; the cited line for a nearby anchor; the bare path for a file anchor. */
export function anchorLocation(a: DiffAnchor): string {
  const side = a.side === "deletions" ? " (old)" : "";
  if (a.kind === "file") return a.cited.line > 0 ? `${a.file}:${range(a.cited.line, a.cited.endLine)}` : a.file;
  if (a.kind === "nearby") return `${a.file}:${range(a.cited.line, a.cited.endLine)}${side}`;
  return `${a.file}:${range(a.line, a.endLine)}${side}`;
}

function statusLabel(f: RunFinding, state: Pick<RunUserState, "findingStatus" | "findingNotes"> | undefined): string {
  const status = state?.findingStatus[f.id];
  if (status === "accepted") return " (accepted)";
  if (status !== "dismissed") return "";
  const reason = state?.findingNotes?.[f.id]?.reason;
  return reason ? ` (dismissed: ${reason})` : " (dismissed)";
}

export function findingMarkdown(
  f: RunFinding,
  state?: Pick<RunUserState, "findingStatus" | "findingNotes">,
  opts: Pick<RunMarkdownOptions, "github"> = {},
): string {
  const out = [
    `### [${f.severity}] ${f.title}${statusLabel(f, state)}`,
    `${code(anchorLocation(f.anchor))} · id ${code(f.id)}`,
  ];
  const dismissNote = state?.findingStatus[f.id] === "dismissed" ? state.findingNotes?.[f.id]?.note?.trim() : undefined;
  if (dismissNote) out.push(`> Dismissed: ${dismissNote}`);
  const notes = [
    // A local run id means nothing to someone reading the pull request.
    !opts.github && f.carriedFrom && `Open since run ${f.carriedFrom}.`,
    f.repeatOf !== undefined && `Repeats PR comment #${f.repeatOf}.`,
    f.preexisting && "Pre-existing: not introduced by this change.",
  ].filter(Boolean);
  if (notes.length) out.push(`_${notes.join(" ")}_`);
  out.push(f.explanation.trim());
  if (f.impact?.trim()) out.push(`**Impact:** ${f.impact.trim()}`);
  if (f.evidence.trim()) out.push(`**Evidence:** ${f.evidence.trim()}`);
  if (f.suggestedCode) {
    if (f.suggestion?.trim()) out.push(`**Suggestion:** ${f.suggestion.trim()}`);
    out.push(fence(f.suggestedCode, fenceLanguage(f.file)));
  } else if (f.suggestion?.trim()) {
    out.push(`**Suggestion:** ${f.suggestion.trim()}`);
  }
  return out.join("\n\n");
}

/** Severity first, then file, then line. */
export function sortFindings(findings: readonly RunFinding[]): RunFinding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      a.file.localeCompare(b.file) ||
      a.anchor.line - b.anchor.line,
  );
}

/**
 * "3 findings: 1 blocker, 2 should-fix. 2 pre-existing." or "No issues found."
 * — the first thing a reader or agent needs. The severity tally covers only
 * findings on the change itself.
 */
function countLine(introduced: readonly RunFinding[], preexisting: readonly RunFinding[], overCap: number): string {
  const tail =
    (preexisting.length ? ` ${preexisting.length} pre-existing.` : "") +
    (overCap ? ` ${overCap} more over the posting cap.` : "");
  if (introduced.length === 0) return `${preexisting.length ? "No issues found in this change." : "No issues found."}${tail}`;
  const bySeverity = SEVERITY_ORDER.map((s) => [s, introduced.filter((f) => f.severity === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`);
  const n = introduced.length;
  return `${n} finding${n === 1 ? "" : "s"}: ${bySeverity.join(", ")}.${tail}`;
}

export interface RunMarkdownOptions {
  includeOverCap?: boolean;
  /** Reviewer state: accepted findings are marked, dismissed ones left out unless `includeDismissed`. */
  state?: Pick<RunUserState, "findingStatus" | "findingNotes"> | undefined;
  includeDismissed?: boolean;
  /** For a pull request comment: leaves out notes that only make sense on this machine. */
  github?: boolean;
  /**
   * Cuts the last `count` findings, in document order, to a heading and a
   * location, and puts `note` under the count line.
   */
  shorten?: { count: number; note: string };
}

function briefMarkdown(f: RunFinding, state: RunMarkdownOptions["state"]): string {
  return [`### [${f.severity}] ${f.title}${statusLabel(f, state)}`, `${code(anchorLocation(f.anchor))} · id ${code(f.id)}`].join(
    "\n\n",
  );
}

export function runMarkdown(run: ReviewRun, opts: RunMarkdownOptions = {}): string {
  const round = describeRound(run);
  const out = [
    `# Review findings: ${formatTarget(run.target)}`,
    `Base ${code(run.base.slice(0, 12))}, head ${code(run.head.slice(0, 12))}${round ? `. ${round}.` : ""}`,
  ];
  const { state } = opts;
  const shown = (f: RunFinding) => opts.includeDismissed || state?.findingStatus[f.id] !== "dismissed";
  const findings = run.findings.filter(shown);
  const overCapShown = run.overCapFindings.filter(shown);
  const overCap = opts.includeOverCap ? overCapShown : [];
  const introduced = findings.filter((f) => !f.preexisting);
  const preexisting = findings.filter((f) => f.preexisting);
  const hidden = run.findings.length - findings.length + run.overCapFindings.length - overCapShown.length;
  out.push(
    countLine(introduced, preexisting, overCapShown.length) + (hidden ? ` ${hidden} dismissed finding${hidden === 1 ? "" : "s"} left out.` : ""),
  );
  const sections = [sortFindings(introduced), sortFindings(preexisting), sortFindings(overCap)];
  const shortenCount = Math.min(opts.shorten?.count ?? 0, sections.flat().length);
  const shortened = new Set(shortenCount > 0 ? sections.flat().slice(-shortenCount) : []);
  if (shortenCount > 0 && opts.shorten) out.push(opts.shorten.note);
  const render = (f: RunFinding) => (shortened.has(f) ? briefMarkdown(f, state) : findingMarkdown(f, state, opts));
  const [introducedSorted = [], preexistingSorted = [], overCapSorted = []] = sections;
  for (const f of introducedSorted) out.push(render(f));
  if (preexistingSorted.length) {
    out.push(`## Pre-existing (not introduced by this change)`);
    for (const f of preexistingSorted) out.push(render(f));
  }
  if (overCapSorted.length) {
    out.push(`## Over the posting cap (${overCapSorted.length})`);
    for (const f of overCapSorted) out.push(render(f));
  }
  return `${out.join("\n\n")}\n`;
}
