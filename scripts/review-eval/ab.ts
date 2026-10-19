// Paid A/B reruns of saved slice prompts under several context arms, N samples each.
//   base           saved prompt (pointer to the on-disk map)
//   inline         per-slice 6K map inlined in place of the pointer
//   intent         Haiku full-diff intent draft (with risk list) + inline 6K map
//   intent_nomap   intent draft (with risk list) + pointer
//   intent_norisk  intent draft without the risk list + pointer
//   intent_names   intent_norisk + ranked file names (~600 tokens)
//   intent_mini    intent_norisk + 12 files with symbols for the top 5 (~700 tokens)
// The draft comes from intent.ts (`full-haiku` variant).
// Usage: bun ab.ts render | bun ab.ts run <sliceTag> [samples=2] [arms=csv]
import fs from "node:fs";
import path from "node:path";
import { prepare, rank, fit, type Prepared, type Ranked } from "./rank.ts";
import { AB, ARTIFACTS, DATA, SLICES, loadTargets, repoFor, type Target } from "./env.ts";
import { applyConfig, setRunState } from "../../src/review/core/config.ts";
import { agent, resetOpenCodeConfig } from "../../src/review/core/runner.ts";
import { resolveRunSetup, setupConfig } from "../../src/review/setup.ts";
import { loadConfig } from "../../src/services/config.ts";
import { dataDir } from "../../src/review/run-store.ts";

export { SLICES };
export const ARMS = ["base", "inline", "intent", "intent_nomap", "intent_norisk", "intent_names", "intent_mini"] as const;
export type Arm = (typeof ARMS)[number];
const MAP_BUDGET = 6000;
const RANKING = { damp: true, hop2: true, strings: true, stringWeight: 3 } as const;

const targets = loadTargets();

function find(tag: string): { t: Target; s: Target["slices"][number] } {
  for (const t of targets) for (const s of t.slices) if (`${t.id}-${s.tag}` === tag) return { t, s };
  throw new Error(`no slice ${tag}`);
}

const usefulSymbols = (o: NonNullable<ReturnType<Prepared["outlines"]["get"]>>) =>
  (o.symbols ?? []).filter((s) => s.exported || o.language === "cpp" || s.kind !== "variable");

function renderMap(P: Prepared, files: string[], why: Map<string, string[]>): string {
  const out = [
    "## Related code outside this slice",
    "",
    "Unchanged files ranked by their links to this slice's changes: imports in both directions, shared identifiers, and shared string keys. Each entry lists the file's symbols with line numbers. The list is incomplete: the file that confirms or disproves a finding may not be here, so search for what it does not contain. Read bodies with your file-read tool.",
    "",
  ];
  for (const p of files) {
    const o = P.outlines.get(p);
    const tag = ` — ${(why.get(p) ?? []).slice(0, 3).join("; ")}`;
    if (!o) {
      out.push(`### ${p}${tag}`, "");
      continue;
    }
    const syms = usefulSymbols(o);
    out.push(`### ${p} (${o.lines} lines)${tag}`);
    for (const s of syms.slice(0, 40)) out.push(`  ${s.line} ${s.kind} ${s.signature || s.name}`);
    if (syms.length > 40) out.push(`  … ${syms.length - 40} more`);
    out.push("");
  }
  return out.join("\n");
}

/** Ranked file paths with reasons, optionally with a few symbols for the first `outlineTop` files. */
function renderSmall(P: Prepared, ranked: Ranked[], budgetTokens: number, outlineTop: number): string {
  const out = [
    "## Related code outside this slice",
    "",
    "Unchanged files ranked by their links to this slice's changes (imports in both directions, shared identifiers, shared string keys). The list is incomplete: search for what it does not contain.",
    "",
  ];
  let chars = out.join("\n").length;
  for (const [k, r] of ranked.slice(0, outlineTop ? 12 : 20).entries()) {
    const lines = [`- ${r.path} — ${r.why.slice(0, 2).join("; ")}`];
    const o = P.outlines.get(r.path);
    if (k < outlineTop && o) {
      const syms = usefulSymbols(o);
      for (const s of syms.slice(0, 8)) lines.push(`    ${s.line} ${s.kind} ${s.name}`);
      if (syms.length > 8) lines.push(`    … ${syms.length - 8} more`);
    }
    const add = lines.join("\n").length + 1;
    if ((chars + add) / 3.6 > budgetTokens) break;
    out.push(...lines);
    chars += add;
  }
  return out.join("\n");
}

type Draft = { title: string; goal: string; expected_changes?: string[]; risk_areas?: string[] };
let intents: Record<string, Record<string, Draft & { parseError?: boolean; text?: string }>> | undefined;

function renderIntent(runId: string, risks = true): string {
  intents ??= JSON.parse(fs.readFileSync(path.join(DATA, "intents.json"), "utf8"));
  const v = intents![runId]?.["full-haiku"];
  if (!v) throw new Error(`${runId}: no full-haiku intent; run intent.ts first`);
  let j: Draft = v;
  if (v.parseError && v.text) {
    // Output hit the token cap mid-array: drop the unfinished item and close the brackets.
    const cut = v.text.slice(v.text.indexOf("{"), v.text.lastIndexOf('",') + 1);
    j = JSON.parse(`${cut}]}`);
  }
  const out = [
    "## Inferred intent (drafted by a smaller model from the whole diff; it may be wrong, so check it against the code)",
    `Title: ${j.title}`,
    "",
    j.goal,
    "",
    "Expected changes:",
    ...(j.expected_changes ?? []).map((x) => `- ${x}`),
  ];
  if (risks && j.risk_areas?.length) out.push("", "Areas worth checking:", ...j.risk_areas.map((x) => `- ${x}`));
  return out.join("\n");
}

const MAP_NOTE = /A repository orientation map for this change is at `[^`]+`\.[^\n]*/;

export function prompts(tag: string) {
  const { t, s } = find(tag);
  const saved = fs.readFileSync(path.join(ARTIFACTS, "prompts", `${tag}.txt`), "utf8");
  if (!MAP_NOTE.test(saved)) throw new Error(`${tag}: map note not found`);
  const P = prepare(t);
  const ranked = rank(P, { ...RANKING, seeds: s.files });
  const files = fit(P, ranked, MAP_BUDGET);
  const map = renderMap(P, files, new Map(ranked.map((r) => [r.path, r.why])));
  const intent = renderIntent(t.id);
  const lite = renderIntent(t.id, false);
  const names = renderSmall(P, ranked, 1000, 0);
  const mini = renderSmall(P, ranked, 2000, 5);
  const text: Record<Arm, string> = {
    base: saved,
    inline: saved.replace(MAP_NOTE, () => map),
    intent: saved.replace(MAP_NOTE, () => `${intent}\n\n${map}`),
    intent_nomap: saved.replace(MAP_NOTE, (note) => `${intent}\n\n${note}`),
    intent_norisk: saved.replace(MAP_NOTE, (note) => `${lite}\n\n${note}`),
    intent_names: saved.replace(MAP_NOTE, (note) => `${lite}\n\n${names}\n\n${note}`),
    intent_mini: saved.replace(MAP_NOTE, (note) => `${lite}\n\n${mini}\n\n${note}`),
  };
  return { t, s, files, text };
}

/** Detached worktree of the target's head, shared by the reruns and the judge. Remove with `git worktree remove` when done. */
export function worktree(t: Target): string {
  const dir = path.join(AB, "subjects", t.head.slice(0, 12));
  if (fs.existsSync(dir)) return dir;
  const r = Bun.spawnSync(["git", "-C", repoFor(t), "worktree", "add", "--detach", "-q", dir, t.head]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return dir;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SCRATCH_OUT = new RegExp(`${escapeRegExp(path.join(dataDir(), "scratch"))}/[^\\s\`"]+\\.json`);

if (import.meta.main) {
  const [cmd = "render", tag, samplesArg = "2", armsArg = ARMS.join(",")] = process.argv.slice(2);
  fs.mkdirSync(path.join(AB, "prompts"), { recursive: true });
  fs.mkdirSync(path.join(AB, "out"), { recursive: true });
  if (cmd === "render") {
    for (const sliceTag of SLICES) {
      const p = prompts(sliceTag);
      for (const arm of ARMS) fs.writeFileSync(path.join(AB, "prompts", `${sliceTag}-${arm}.txt`), p.text[arm]);
      console.log(sliceTag, "map files", p.files.length, "map chars", p.text.inline.length - p.text.base.length);
    }
  } else if (cmd === "run" && tag) {
    const userConfig = await loadConfig();
    const setup = await resolveRunSetup({ userConfig, stages: ["review"] });
    applyConfig({ ...setupConfig(setup), artifacts: path.join(AB, "artifacts"), out: path.join(AB, "out") });
    const p = prompts(tag);
    setRunState({ subject: worktree(p.t), repoName: p.t.slug });
    await resetOpenCodeConfig();
    const arms = armsArg.split(",") as Arm[];
    const resultsFile = path.join(AB, "results.jsonl");
    const done = fs.existsSync(resultsFile)
      ? new Set(fs.readFileSync(resultsFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).id))
      : new Set<string>();
    for (let n = 1; n <= Number(samplesArg); n++) {
      await Promise.all(arms.map(async (arm) => {
        const id = `${tag}-${arm}-${n}`;
        if (done.has(id)) return;
        const outFile = path.join(AB, "out", `${id}.json`);
        const origOut = p.text[arm].match(SCRATCH_OUT)?.[0];
        if (!origOut) throw new Error(`${tag}: out path not found`);
        const r = await agent(p.text[arm].replaceAll(origOut, outFile), { budget: 3, outFile, tag: id });
        const findings = (r.payload as { findings?: unknown[] } | undefined)?.findings;
        const line = {
          id, tag, arm, n, costUsd: r.costUsd, numTurns: r.numTurns, wallMs: r.wallMs, exitCode: r.exitCode, failure: r.failure,
          findings: Array.isArray(findings) ? findings.length : null,
        };
        fs.appendFileSync(resultsFile, JSON.stringify(line) + "\n");
        console.log(JSON.stringify(line));
      }));
    }
  } else {
    console.error("usage: bun ab.ts render | bun ab.ts run <sliceTag> [samples=2] [arms=csv]");
    process.exit(1);
  }
}
