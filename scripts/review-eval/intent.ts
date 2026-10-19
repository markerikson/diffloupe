// Generates intent variants per target and grades them blind against the PR description.
// Results go to <eval dir>/data/intents.json; finished variants are skipped on rerun.
import fs from "node:fs";
import path from "node:path";
import { complete, parseJson } from "./llm.ts";
import { DATA, RUNS, git, loadTargets, repoFor } from "./env.ts";

const OUT = path.join(DATA, "intents.json");
const results: Record<string, Record<string, unknown>> = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {};
const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `\n… [${s.length - n} more chars]` : s);

const INTENT_SYSTEM = `You infer the intent of a code change for a code review bot, before any reviewer reads the code. Reviewers will use your output to judge whether the change does what it set out to do, and to find related code outside the diff. Be concrete and specific to this change. Do not praise or critique the code.

Return only JSON:
{
  "title": "one line, imperative, like a good PR title",
  "goal": "2-4 sentences: what the change is for and the main approach",
  "expected_changes": ["each distinct piece of work the change should contain"],
  "out_of_scope": ["things a reviewer might expect but this change deliberately does not do (empty if unknown)"],
  "search_terms": ["8-20 identifiers, module names, string keys, config names or domain words that would locate related code OUTSIDE the changed files: callers, registries, siblings, config, tests"],
  "risk_areas": ["where a bug in this change would most likely hide"]
}`;

function userPrompt(branch: string, inputs: { commits: string; stat: string; outline: string; diff?: string | undefined }) {
  return [
    `Branch: ${branch}`,
    `## Commit messages (oldest last)\n${cap(inputs.commits, 6000)}`,
    `## Diffstat\n${cap(inputs.stat, 6000)}`,
    inputs.diff ? `## Diff\n${cap(inputs.diff, 160000)}` : `## Hunk headers (where each change lands)\n${cap(inputs.outline, 24000)}`,
  ].join("\n\n");
}

const JUDGE = `You grade candidate statements of a code change's intent against the author's PR description, which is the reference. Candidates are labelled with letters and shuffled; some are raw commit text rather than a written summary. Score each candidate 1-5 on:
- goal: does it state the main purpose the PR description gives?
- coverage: fraction of the PR description's distinct pieces of work it mentions (5 = all major pieces, 1 = almost none)
- accuracy: 5 = nothing contradicts the PR description or invents work; 1 = substantially wrong
- reviewer_value: how much would this text help a reviewer who has only one slice of the diff notice that their slice does not match the intended change?
Return only JSON: {"scores": {"A": {"goal":n,"coverage":n,"accuracy":n,"reviewer_value":n,"note":"short reason"}, ...}}`;

function renderIntent(v: Record<string, unknown>): string {
  if (typeof v.text === "string") return v.text;
  const list = (k: string) => ((v[k] as string[] | undefined) ?? []).map((x) => `- ${x}`).join("\n");
  return `Title: ${v.title}\nGoal: ${v.goal}\nExpected changes:\n${list("expected_changes")}\nOut of scope:\n${list("out_of_scope")}\nRisk areas:\n${list("risk_areas")}`;
}

const VARIANTS: Array<[name: string, model: string, fullDiff: boolean]> = [
  ["initial-haiku", "claude-haiku-5-5", false],
  ["initial-sonnet", "claude-sonnet-5-5", false],
  ["full-haiku", "claude-haiku-5-5", true],
  ["full-sonnet", "claude-sonnet-5-5", true],
];

let spent = 0;
for (const t of loadTargets()) {
  const repo = repoFor(t);
  const r = (results[t.id] ??= {});
  const range = `${t.base}..${t.head}`;
  const commits = git(repo, ["log", "--format=%s%n%b%n---", range]).trim();
  const stat = git(repo, ["diff", "--stat=200", range]);
  const outline = git(repo, ["diff", "--unified=0", range]).split("\n").filter((l) => l.startsWith("diff --git ") || l.startsWith("@@")).join("\n");
  const diff = git(repo, ["diff", range]);
  r.inputSizes = { commits: commits.length, stat: stat.length, outline: outline.length, diff: diff.length };

  r.baseline ??= { text: `Title: \n\nCommits:\n${cap(commits, 3000)}` };
  const words = t.branch.replace(/^[^/]+\//, "").replace(/[-_]/g, " ");
  r.branch ??= { text: `Title: ${words} (branch ${t.branch})\n\nCommits:\n${cap(commits, 3000)}` };
  const run = JSON.parse(fs.readFileSync(path.join(RUNS, t.id, "run.json"), "utf8"));
  r.walk ??= { text: run.intent?.inferred ?? "" };

  await Promise.all(VARIANTS.map(async ([name, model, full]) => {
    if (r[name]) return;
    const res = await complete(model, INTENT_SYSTEM, userPrompt(t.branch, { commits, stat, outline, diff: full ? diff : undefined }), 3000);
    spent += res.cost;
    try {
      r[name] = { ...parseJson<Record<string, unknown>>(res.text), cost: res.cost, ms: res.ms };
    } catch {
      r[name] = { text: res.text, parseError: true, cost: res.cost, ms: res.ms };
    }
  }));
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));

  if (t.prBody && !r.judge) {
    const names = ["baseline", "branch", "walk", ...VARIANTS.map((v) => v[0])];
    const shuffled = [...names].sort(() => Math.random() - 0.5);
    const labels = shuffled.map((_, i) => String.fromCharCode(65 + i));
    const body = shuffled.map((n, i) => `### Candidate ${labels[i]}\n${cap(renderIntent(r[n] as Record<string, unknown>), 6000)}`).join("\n\n");
    const res = await complete("claude-opus-5-5", JUDGE, `## Reference PR description\nTitle: ${t.prTitle}\n\n${cap(t.prBody, 12000)}\n\n## Candidates\n\n${body}`, 4000);
    spent += res.cost;
    const parsed = parseJson<{ scores: Record<string, Record<string, unknown>> }>(res.text);
    r.judge = Object.fromEntries(shuffled.map((n, i) => [n, parsed.scores[labels[i]!]]));
  }
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(t.id, `spent so far $${spent.toFixed(3)}`);
}

const judged = Object.values(results).map((r) => r.judge as Record<string, Record<string, number>> | undefined).filter((j) => j !== undefined);
console.log("\nvariant          goal  coverage  accuracy  reviewer_value  (mean of", judged.length, "targets)");
for (const name of ["baseline", "branch", "walk", ...VARIANTS.map((v) => v[0])]) {
  const mean = (k: string) => (judged.reduce((n, j) => n + (j[name]?.[k] ?? 0), 0) / Math.max(1, judged.length)).toFixed(2);
  console.log(name.padEnd(16), mean("goal").padStart(5), mean("coverage").padStart(9), mean("accuracy").padStart(9), mean("reviewer_value").padStart(15));
}
