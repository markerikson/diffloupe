// Runs the pipeline's intent draft (src/review/core/intent-draft.ts) on eval targets through
// OpenCode, and reports cost, wall time and whether a complete draft came back. The input is
// built the way pipeline.ts builds it (code files only, deleted files compacted, no branch).
// Drafts are also saved to <eval dir>/data/intents.json as the `shipped` variant, which the
// `intent_shipped` arm in ab.ts reads.
// Usage: bun intent-check.ts [model=anthropic/claude-haiku-5-5] [targetId,...] (default: every target)
// Artifacts go to <eval dir>/intent-check; nothing is cached between invocations.
import fs from "node:fs";
import path from "node:path";
import { DATA, EVAL_DIR, git, loadTargets, repoFor } from "./env.ts";
import { applyConfig, setRunState } from "../../src/review/core/config.ts";
import { classifyFile } from "../../src/review/core/findings.ts";
import { draftIntent } from "../../src/review/core/intent-draft.ts";
import { compactDeletedFiles } from "../../src/review/core/lib/hunks.ts";
import { resetOpenCodeConfig } from "../../src/review/core/runner.ts";
import { resolveRunSetup, setupConfig } from "../../src/review/setup.ts";
import { loadConfig } from "../../src/services/config.ts";

const [model = "anthropic/claude-haiku-5-5", ids] = process.argv.slice(2);
const wanted = ids?.split(",");
const dir = path.join(EVAL_DIR, "intent-check", String(Date.now()));
const intentsFile = path.join(DATA, "intents.json");

const userConfig = await loadConfig();
const setup = await resolveRunSetup({ userConfig, stages: ["walkthrough"] });
applyConfig({ ...setupConfig(setup), modelIntent: model, artifacts: path.join(dir, "artifacts"), out: path.join(dir, "out") });

const results = [];
for (const t of loadTargets().filter((x) => !wanted || wanted.includes(x.id))) {
  const repo = repoFor(t);
  setRunState({ subject: repo, repoName: t.slug });
  resetOpenCodeConfig();
  const range = `${t.base}..${t.head}`;
  const files = git(repo, ["diff", "--name-only", range]).trim().split("\n").filter(Boolean);
  const code = files.filter((f) => classifyFile(f) === "code");
  const docs = files.filter((f) => classifyFile(f) === "docs");
  const diff = compactDeletedFiles(git(repo, ["diff", range, "--", ...code]), t.base);
  const r = await draftIntent({
    tag: t.id,
    cacheKey: t.id,
    intent: { title: t.prTitle, body: t.prBody, commits: git(repo, ["log", "--format=%s%n%b%n---", range]).trim() },
    diffstat: git(repo, ["diff", "--stat", range]),
    diff,
    otherFiles: docs,
  });
  const line = {
    id: t.id, model, rawDiff: diff.length, diffChars: r.diffChars, costUsd: r.costUsd, wallMs: r.wallMs,
    failure: r.failure, title: r.draft?.title, expected: r.draft?.expected_changes.length,
  };
  results.push({ ...line, draft: r.draft });
  console.log(JSON.stringify(line));
  if (r.draft) {
    const saved = fs.existsSync(intentsFile) ? JSON.parse(fs.readFileSync(intentsFile, "utf8")) : {};
    saved[t.id] = { ...saved[t.id], shipped: { ...r.draft, model, costUsd: r.costUsd, wallMs: r.wallMs } };
    fs.writeFileSync(intentsFile, JSON.stringify(saved, null, 2));
  }
}
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "results.json"), JSON.stringify(results, null, 2));
console.log("wrote", path.join(dir, "results.json"));
