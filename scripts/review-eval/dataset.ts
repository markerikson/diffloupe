// Builds <eval dir>/data/targets.json: one entry per selected run, with ground truth
// (unchanged files cited by findings, unchanged files read by slice agents) per run and
// per slice, plus the PR description as the reference intent.
import fs from "node:fs";
import path from "node:path";
import { ARTIFACTS, DATA, RUNS, SELECTED, type Target } from "./env.ts";

fs.mkdirSync(DATA, { recursive: true });

function rel(p: string): string {
  return p
    .replace(/^\/tmp\/code-review-subject-[^/]+\//, "")
    .replace(/^.*\/projects\/worktrees\/[^/]+\//, "")
    .replace(/^.*\/projects\/[^/]+\//, "");
}

function readPaths(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of ["path", "filePath", "file", "target"]) if (typeof input[k] === "string") out.push(input[k] as string);
  if (Array.isArray(input.paths)) for (const v of input.paths) if (typeof v === "string") out.push(v);
  return out.map(rel).map((p) => p.replace(/:\d+(-\d+)?$/, ""));
}

const targets: Target[] = [];
for (const { id, pr } of SELECTED) {
  const r = JSON.parse(fs.readFileSync(path.join(RUNS, id, "run.json"), "utf8"));
  const root: string = r.repo?.root ?? r.repo;
  const slug: string = r.repo?.slug ?? "";
  const tracked = new Set(
    Bun.spawnSync(["git", "-C", root, "ls-tree", "-r", "--name-only", r.head]).stdout.toString().split("\n").filter(Boolean),
  );
  const changed: string[] = (r.files ?? []).map((f: { path: string }) => f.path);
  const changedSet = new Set(changed);
  const units: Array<{ id: string; title: string; files: string[] }> = JSON.parse(
    fs.readFileSync(path.join(RUNS, id, "raw", "units.json"), "utf8"),
  );

  const citedBy = new Map<string, Set<string>>();
  const cited = new Set<string>();
  for (const fd of r.findings ?? []) {
    const unit = units.find((u) => u.files.includes(fd.file))?.id ?? "?";
    const refs = [fd.file, ...(fd.crossFileRefs ?? []).map((c: { file: string }) => c.file)];
    for (const f of refs) {
      if (!f || changedSet.has(f) || !tracked.has(f)) continue;
      cited.add(f);
      if (!citedBy.has(f)) citedBy.set(f, new Set());
      citedBy.get(f)!.add(unit);
    }
  }

  const rawDir = path.join(ARTIFACTS, "raw");
  const agents = fs.readdirSync(rawDir).filter((f) => f.startsWith(`${id}-s`) && f.endsWith(".stdout.ndjson")).sort();
  const slices: Target["slices"] = [];
  const readAll = new Set<string>();
  for (const a of agents) {
    const tag = a.slice(id.length + 1).replace(".stdout.ndjson", "");
    const read = new Set<string>();
    let calls = 0;
    for (const line of fs.readFileSync(path.join(rawDir, a), "utf8").split("\n")) {
      if (!line) continue;
      const j = JSON.parse(line);
      if (j.part?.type !== "tool") continue;
      calls++;
      for (const p of readPaths(j.part.state?.input ?? {})) if (tracked.has(p) && !changedSet.has(p)) read.add(p);
    }
    for (const p of read) readAll.add(p);
    // units.json order matches slice order only before packing, so take the slice's files from its prompt.
    const promptFile = path.join(ARTIFACTS, "prompts", `${id}-${tag}.txt`);
    const prompt = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, "utf8") : "";
    const sliceFiles = changed.filter((f) => prompt.includes(`diff --git a/${f} `) || prompt.includes(`+++ b/${f}\n`));
    const unitIds = new Set(units.filter((u) => u.files.some((f) => sliceFiles.includes(f))).map((u) => u.id));
    const sliceCited = [...cited].filter((f) => [...(citedBy.get(f) ?? [])].some((u) => unitIds.has(u)));
    slices.push({ tag, idx: Number(tag.slice(1)), calls, files: sliceFiles, read: [...read], cited: sliceCited });
  }

  let prTitle = "";
  let prBody = "";
  if (pr) {
    const j = JSON.parse(Bun.spawnSync(["gh", "pr", "view", String(pr), "-R", slug, "--json", "title,body"]).stdout.toString());
    prTitle = j.title;
    prBody = j.body;
  }
  targets.push({
    id, repo: root, slug, branch: r.target?.spec, pr, base: r.base, head: r.head,
    changed, cited: [...cited], read: [...readAll], slices, prTitle, prBody,
  });
  console.log(
    id,
    `changed=${changed.length} cited=${cited.size} read=${readAll.size} slices=${slices.length}`,
    slices.map((s) => `${s.tag}:${s.files.length}f/${s.read.length}r/${s.cited.length}c`).join(" "),
  );
}
fs.writeFileSync(path.join(DATA, "targets.json"), JSON.stringify(targets, null, 2));
