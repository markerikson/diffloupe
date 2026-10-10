/**
 * Findings as markdown, for pasting into a PR comment, an issue, or an agent
 * prompt. Shared by the web UI's copy buttons and `runs show --markdown`, so
 * it uses no DOM or Bun APIs.
 */
import { code, fence } from "./core/lib/markdown.ts";
import { formatTarget } from "./format-run.ts";
import type { DiffAnchor, FindingSeverity, ReviewRun, RunFinding } from "../types/review-run.ts";

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

export function findingMarkdown(f: RunFinding): string {
  const out = [`### [${f.severity}] ${f.title}`, code(anchorLocation(f.anchor))];
  const notes = [
    f.carriedFrom && `Open since run ${f.carriedFrom}.`,
    f.repeatOf !== undefined && `Repeats PR comment #${f.repeatOf}.`,
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

export interface RunMarkdownOptions {
  includeOverCap?: boolean;
}

export function runMarkdown(run: ReviewRun, opts: RunMarkdownOptions = {}): string {
  const out = [
    `# Review findings: ${formatTarget(run.target)}`,
    `Base ${code(run.base.slice(0, 12))}, head ${code(run.head.slice(0, 12))}`,
  ];
  if (run.findings.length === 0) out.push("No findings.");
  for (const f of sortFindings(run.findings)) out.push(findingMarkdown(f));
  if (opts.includeOverCap && run.overCapFindings.length) {
    out.push(`## Over the posting cap (${run.overCapFindings.length})`);
    for (const f of sortFindings(run.overCapFindings)) out.push(findingMarkdown(f));
  }
  return `${out.join("\n\n")}\n`;
}
