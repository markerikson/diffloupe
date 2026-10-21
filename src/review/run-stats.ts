import type { FindingSeverity, ReviewRun, RunUserState } from "../types/review-run.ts";
import { formatTarget } from "./format-run.ts";
import { targetKey } from "./run-store.ts";
import { cacheShare, emptyUsageTotals, formatUsage, runUsageTotals, type UsageTotals } from "./usage.ts";

export interface StatsInput {
  run: ReviewRun;
  state: Pick<RunUserState, "findingStatus">;
}

export interface RoundStats {
  id: string;
  round: number;
  createdAt: string;
  /** Findings this run raised for the first time. */
  new: number;
  newPreexisting: number;
  /** Open findings carried over from an earlier run. */
  carried: number;
  /** Findings from the previous run this run found fixed. */
  resolved: number;
  costUsd: number;
  scope?: "full" | "incremental";
  promptVersion?: string;
  /** Share of this run's prompt tokens read from the cache, when it recorded tokens. */
  cacheShare?: number;
}

export type SeverityCounts = Record<FindingSeverity, number>;

export interface ChainStats {
  key: string;
  repo: string;
  target: string;
  rounds: RoundStats[];
  /** New findings on the change, by severity, over every round. Pre-existing ones are counted apart. */
  raised: SeverityCounts;
  raisedPreexisting: number;
  fixed: number;
  fixedPreexisting: number;
  dismissed: number;
  /** Findings still listed on the last run and not dismissed. Whether they were fixed is unknown. */
  open: number;
  costUsd: number;
  /** Tokens over the rounds that recorded them. */
  usage: UsageTotals;
  lastAt: string;
}

export interface VersionStats {
  promptVersion: string;
  instructionsHash: string;
  runs: number;
  raised: number;
  raisedPreexisting: number;
  fixed: number;
  fixedPreexisting: number;
  costUsd: number;
}

export interface StatsTotals {
  chains: number;
  meanRounds: number;
  /** Share of chains that went past three rounds. */
  pastThreeRounds: number;
  raised: number;
  fixed: number;
  /** Fixed over raised, for findings on the change only. Null when nothing was raised. */
  resolutionRate: number | null;
  costUsd: number;
  usage: UsageTotals;
}

const UNRECORDED = "unrecorded";

const emptySeverities = (): SeverityCounts => ({ blocker: 0, "should-fix": 0, "nice-to-have": 0, question: 0 });

const total = (counts: SeverityCounts) => Object.values(counts).reduce((n, c) => n + c, 0);

/**
 * Groups complete review runs into re-review chains, each linked by
 * `priorRunId`, and counts what happened to their findings round by round.
 */
export function chainStats(inputs: StatsInput[]): ChainStats[] {
  const runs = inputs.filter(({ run }) => run.status === "complete" && run.meta.kind !== "diff");
  const byId = new Map(runs.map((i) => [i.run.id, i]));
  const rootOf = (input: StatsInput): string => {
    const seen = new Set<string>();
    let current = input;
    while (current.run.priorRunId && byId.has(current.run.priorRunId) && !seen.has(current.run.id)) {
      seen.add(current.run.id);
      current = byId.get(current.run.priorRunId) ?? current;
    }
    return current.run.id;
  };
  const chains = new Map<string, StatsInput[]>();
  for (const input of runs) {
    const root = rootOf(input);
    chains.set(root, [...(chains.get(root) ?? []), input]);
  }
  return [...chains.values()]
    .map((members) => summarizeChain(members.sort((a, b) => a.run.createdAt.localeCompare(b.run.createdAt)), byId))
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

function summarizeChain(members: StatsInput[], byId: Map<string, StatsInput>): ChainStats {
  const first = members[0]?.run;
  const last = members.at(-1);
  if (!first || !last) throw new Error("empty chain");
  const raised = emptySeverities();
  let raisedPreexisting = 0;
  let fixed = 0;
  let fixedPreexisting = 0;
  const dismissed = new Set<string>();
  const usage = emptyUsageTotals();
  const rounds = members.map(({ run, state }, index): RoundStats => {
    const own = runUsageTotals(run);
    runUsageTotals(run, usage);
    const share = own.calls ? cacheShare(own) : null;
    const fresh = run.findings.filter((f) => !f.carriedFrom);
    for (const f of fresh) {
      if (f.preexisting) raisedPreexisting++;
      else raised[f.severity]++;
    }
    const previous = run.priorRunId ? byId.get(run.priorRunId)?.run : undefined;
    const resolved = previous ? run.resolved : [];
    for (const r of resolved) {
      fixed++;
      if (previous?.findings.find((f) => f.id === r.id)?.preexisting) fixedPreexisting++;
    }
    for (const [id, status] of Object.entries(state.findingStatus)) if (status === "dismissed") dismissed.add(id);
    return {
      id: run.id,
      round: run.round ?? index + 1,
      createdAt: run.createdAt,
      new: fresh.length,
      newPreexisting: fresh.filter((f) => f.preexisting).length,
      carried: run.findings.length - fresh.length,
      resolved: resolved.length,
      costUsd: run.meta.costUsd,
      ...(run.meta.reviewScope ? { scope: run.meta.reviewScope } : {}),
      ...(run.meta.promptVersion ? { promptVersion: run.meta.promptVersion } : {}),
      ...(share !== null ? { cacheShare: share } : {}),
    };
  });
  const lastDismissed = new Set(
    Object.entries(last.state.findingStatus).flatMap(([id, s]) => (s === "dismissed" ? [id] : [])),
  );
  return {
    key: targetKey(first.repo, first.target),
    repo: first.repo.slug ?? first.repo.root,
    target: formatTarget(first.target),
    rounds,
    raised,
    raisedPreexisting,
    fixed,
    fixedPreexisting,
    dismissed: dismissed.size,
    open: last.run.findings.filter((f) => !lastDismissed.has(f.id)).length,
    costUsd: rounds.reduce((n, r) => n + r.costUsd, 0),
    usage,
    lastAt: last.run.createdAt,
  };
}

export function statsTotals(chains: ChainStats[]): StatsTotals {
  const raised = chains.reduce((n, c) => n + total(c.raised), 0);
  const fixedOnChange = chains.reduce((n, c) => n + c.fixed - c.fixedPreexisting, 0);
  const rounds = chains.reduce((n, c) => n + c.rounds.length, 0);
  return {
    chains: chains.length,
    meanRounds: chains.length ? rounds / chains.length : 0,
    pastThreeRounds: chains.length ? chains.filter((c) => c.rounds.length > 3).length / chains.length : 0,
    raised,
    fixed: chains.reduce((n, c) => n + c.fixed, 0),
    resolutionRate: raised ? fixedOnChange / raised : null,
    costUsd: chains.reduce((n, c) => n + c.costUsd, 0),
    usage: chains.reduce((sum, c) => {
      sum.input += c.usage.input;
      sum.output += c.usage.output;
      sum.reasoning += c.usage.reasoning;
      sum.cacheRead += c.usage.cacheRead;
      sum.cacheWrite += c.usage.cacheWrite;
      sum.calls += c.usage.calls;
      sum.firstStepShares.push(...c.usage.firstStepShares);
      return sum;
    }, emptyUsageTotals()),
  };
}

/**
 * Splits the counts by the prompts and repo instructions in use. A raised
 * finding counts toward the run that raised it, and a fix counts toward the
 * run that raised the fixed finding, so each version is judged on its own
 * findings.
 */
export function statsByVersion(inputs: StatsInput[]): VersionStats[] {
  const runs = inputs.filter(({ run }) => run.status === "complete" && run.meta.kind !== "diff");
  const byId = new Map(runs.map((i) => [i.run.id, i.run]));
  const groups = new Map<string, VersionStats>();
  const groupFor = (run: ReviewRun): VersionStats => {
    const promptVersion = run.meta.promptVersion ?? UNRECORDED;
    const instructionsHash = run.meta.instructionsHash ?? "none";
    const key = `${promptVersion}/${instructionsHash}`;
    let group = groups.get(key);
    if (!group) {
      group = { promptVersion, instructionsHash, runs: 0, raised: 0, raisedPreexisting: 0, fixed: 0, fixedPreexisting: 0, costUsd: 0 };
      groups.set(key, group);
    }
    return group;
  };
  for (const { run } of runs) {
    const group = groupFor(run);
    group.runs++;
    group.costUsd += run.meta.costUsd;
    for (const f of run.findings) {
      if (f.carriedFrom) continue;
      if (f.preexisting) group.raisedPreexisting++;
      else group.raised++;
    }
    const previous = run.priorRunId ? byId.get(run.priorRunId) : undefined;
    if (!previous) continue;
    for (const r of run.resolved) {
      const finding = previous.findings.find((f) => f.id === r.id);
      const origin = byId.get(finding?.carriedFrom ?? previous.id) ?? previous;
      const originGroup = groupFor(origin);
      if (finding?.preexisting) originGroup.fixedPreexisting++;
      else originGroup.fixed++;
    }
  }
  return [...groups.values()].sort((a, b) => b.runs - a.runs);
}

const percent = (n: number | null) => (n === null ? "n/a" : `${Math.round(n * 100)}%`);
const usd = (n: number) => `$${n.toFixed(2)}`;

function severityLine(counts: SeverityCounts): string {
  const parts = (Object.entries(counts) as [FindingSeverity, number][]).filter(([, n]) => n > 0).map(([s, n]) => `${n} ${s}`);
  return parts.length ? parts.join(", ") : "none";
}

export function formatStats(chains: ChainStats[], versions?: VersionStats[]): string {
  if (chains.length === 0) return "No complete review runs match.";
  const lines: string[] = [];
  for (const c of chains) {
    const rounds = c.rounds.length;
    lines.push(`${c.target}  ${c.repo}  (${rounds} round${rounds === 1 ? "" : "s"}, ${usd(c.costUsd)})`);
    for (const r of c.rounds) {
      const pre = r.newPreexisting ? ` (${r.newPreexisting} pre-existing)` : "";
      const scope = r.scope === "incremental" ? ", changes only" : "";
      const cache = r.cacheShare === undefined ? "" : `, ${percent(r.cacheShare)} cached`;
      lines.push(
        `  round ${r.round}  ${r.id}  ${r.new} new${pre}, ${r.carried} carried, ${r.resolved} fixed${scope}, ${usd(r.costUsd)}${cache}`,
      );
    }
    const usage = formatUsage(c.usage);
    if (usage) lines.push(`  tokens: ${usage}`);
    const perFixed = c.fixed ? `, ${usd(c.costUsd / c.fixed)} per fixed finding` : "";
    lines.push(`  raised: ${severityLine(c.raised)}${c.raisedPreexisting ? `; ${c.raisedPreexisting} pre-existing` : ""}`);
    lines.push(`  fixed ${c.fixed}, dismissed ${c.dismissed}, still open at last run ${c.open}${perFixed}`);
    lines.push("");
  }
  const t = statsTotals(chains);
  lines.push(
    `${t.chains} chain${t.chains === 1 ? "" : "s"}, ${t.meanRounds.toFixed(1)} rounds on average, ${percent(t.pastThreeRounds)} past three rounds`,
    `${t.raised} raised on the change, ${t.fixed} fixed, resolution rate ${percent(t.resolutionRate)}, ${usd(t.costUsd)} total`,
  );
  const usage = formatUsage(t.usage);
  if (usage) lines.push(`tokens over ${t.usage.calls} agent calls: ${usage}`);
  if (versions) {
    lines.push("", "By prompt version / instructions:");
    for (const v of versions) {
      const rate = v.raised ? percent(v.fixed / v.raised) : "n/a";
      lines.push(
        `  ${v.promptVersion} / ${v.instructionsHash}  ${v.runs} run${v.runs === 1 ? "" : "s"}, ${v.raised} raised (${v.raisedPreexisting} pre-existing), ${v.fixed} fixed, resolution rate ${rate}, ${usd(v.costUsd)}`,
      );
    }
  }
  return lines.join("\n");
}
