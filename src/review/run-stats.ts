import type { DismissReason, FindingSeverity, ReviewRun, RunFinding, RunUserState } from "../types/review-run.ts";
import { formatTarget } from "./format-run.ts";
import { fingerprintOf } from "./prior-run.ts";
import { targetKey } from "./run-store.ts";
import { cacheShare, emptyUsageTotals, formatUsage, runUsageTotals, type UsageTotals } from "./usage.ts";

export interface StatsInput {
  run: ReviewRun;
  state: Pick<RunUserState, "findingStatus" | "findingNotes">;
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

/** Prior findings whose lines a later run could check, and how many had their code edited. */
export interface ActedCounts {
  measured: number;
  acted: number;
  /** How many of the control spans, 35 lines away, were edited. */
  control: number;
}

export interface ActedStats {
  change: ActedCounts;
  preexisting: ActedCounts;
  /** Acted-on findings the next run still listed: edits that did not settle them. */
  stillListed: number;
}

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
  dismissedBy: DismissalCounts;
  /** Findings still listed on the last run and not dismissed. Whether they were fixed is unknown. */
  open: number;
  costUsd: number;
  /** Tokens over the rounds that recorded them. */
  usage: UsageTotals;
  /** Over the rounds that recorded which prior findings had their code edited. */
  acted: ActedStats;
  /** Where the author's disputes stood at the last run. */
  disputes: DisputeCounts;
  lastAt: string;
}

export interface DisputeCounts {
  withdrawn: number;
  upheld: number;
  unjudged: number;
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
  acted: ActedStats;
}

/** Dismissals by reason; `unrecorded` for dismissals saved without one. */
export type DismissalKey = DismissReason | "unrecorded";
export type DismissalCounts = Partial<Record<DismissalKey, number>>;

export interface StatsTotals {
  chains: number;
  meanRounds: number;
  /** Share of chains that went past three rounds. */
  pastThreeRounds: number;
  raised: number;
  fixed: number;
  dismissed: number;
  dismissedBy: DismissalCounts;
  /** Fixed over raised, for findings on the change only. Null when nothing was raised. */
  resolutionRate: number | null;
  costUsd: number;
  usage: UsageTotals;
  acted: ActedStats;
  disputes: DisputeCounts;
}

const UNRECORDED = "unrecorded";

const emptyActed = (): ActedStats => ({
  change: { measured: 0, acted: 0, control: 0 },
  preexisting: { measured: 0, acted: 0, control: 0 },
  stillListed: 0,
});

interface ActedEntry {
  acted: boolean;
  control: boolean;
  finding: RunFinding;
  stillListed: boolean;
}

/** `run.priorActedOn` joined to the previous run's findings. */
function actedEntries(run: ReviewRun, previous: ReviewRun | undefined): ActedEntry[] {
  if (!previous || !run.priorActedOn) return [];
  const listed = new Set(run.findings.map((f) => fingerprintOf(f.id)));
  return run.priorActedOn.flatMap((e) => {
    const finding = previous.findings.find((f) => f.id === e.id);
    if (!finding) return [];
    return [{ acted: e.acted, control: e.control, finding, stillListed: e.acted && listed.has(fingerprintOf(e.id)) }];
  });
}

function addActed(into: ActedStats, e: ActedEntry): void {
  const counts = e.finding.preexisting ? into.preexisting : into.change;
  counts.measured++;
  if (e.acted) counts.acted++;
  if (e.control) counts.control++;
  if (e.stillListed) into.stillListed++;
}

function sumActed(all: ActedStats[]): ActedStats {
  const sum = emptyActed();
  for (const a of all) {
    for (const key of ["change", "preexisting"] as const) {
      sum[key].measured += a[key].measured;
      sum[key].acted += a[key].acted;
      sum[key].control += a[key].control;
    }
    sum.stillListed += a.stillListed;
  }
  return sum;
}

function countDismissals(reasons: Iterable<DismissalKey>): DismissalCounts {
  const counts: DismissalCounts = {};
  for (const r of reasons) counts[r] = (counts[r] ?? 0) + 1;
  return counts;
}

function sumDismissals(all: DismissalCounts[]): DismissalCounts {
  const sum: DismissalCounts = {};
  for (const counts of all) {
    for (const [r, n] of Object.entries(counts) as [DismissalKey, number][]) sum[r] = (sum[r] ?? 0) + n;
  }
  return sum;
}

/** "2 wrong, 1 duplicate", most common first. Empty when nothing was dismissed. */
export function formatDismissals(counts: DismissalCounts): string {
  return (Object.entries(counts) as [DismissalKey, number][])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `${n} ${r}`)
    .join(", ");
}

const emptySeverities = (): SeverityCounts => ({ blocker: 0, "should-fix": 0, "nice-to-have": 0, question: 0 });

const total = (counts: SeverityCounts) => Object.values(counts).reduce((n, c) => n + c, 0);

/**
 * Complete review runs that reviewed something. A run `--max-rounds` stopped is
 * saved as complete but carries the previous round's findings and nothing new.
 */
const reviewed = ({ run }: StatsInput) =>
  run.status === "complete" && run.meta.kind !== "diff" && !run.meta.roundLimit;

/**
 * Groups complete review runs into re-review chains, each linked by
 * `priorRunId`, and counts what happened to their findings round by round.
 */
export function chainStats(inputs: StatsInput[]): ChainStats[] {
  const runs = inputs.filter(reviewed);
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
  const dismissed = new Map<string, DismissalKey>();
  const usage = emptyUsageTotals();
  const acted = emptyActed();
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
    for (const e of actedEntries(run, previous)) addActed(acted, e);
    for (const [id, status] of Object.entries(state.findingStatus)) {
      if (status === "dismissed") dismissed.set(id, state.findingNotes?.[id]?.reason ?? "unrecorded");
    }
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
    dismissedBy: countDismissals(dismissed.values()),
    open: last.run.findings.filter((f) => !lastDismissed.has(f.id)).length,
    costUsd: rounds.reduce((n, r) => n + r.costUsd, 0),
    usage,
    acted,
    disputes: countDisputes(last.run),
    lastAt: last.run.createdAt,
  };
}

/** Each run carries every dispute on the pull request so far, so the last run's list is the whole history. */
function countDisputes(run: ReviewRun): DisputeCounts {
  const counts: DisputeCounts = { withdrawn: 0, upheld: 0, unjudged: 0 };
  for (const d of run.disputes ?? []) counts[d.outcome]++;
  return counts;
}

function formatDisputes(d: DisputeCounts): string | null {
  if (!d.withdrawn && !d.upheld && !d.unjudged) return null;
  return `${d.withdrawn} withdrawn, ${d.upheld} upheld for a human, ${d.unjudged} awaiting a ruling`;
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
    dismissed: chains.reduce((n, c) => n + c.dismissed, 0),
    dismissedBy: sumDismissals(chains.map((c) => c.dismissedBy)),
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
    acted: sumActed(chains.map((c) => c.acted)),
    disputes: chains.reduce(
      (sum, c) => ({
        withdrawn: sum.withdrawn + c.disputes.withdrawn,
        upheld: sum.upheld + c.disputes.upheld,
        unjudged: sum.unjudged + c.disputes.unjudged,
      }),
      { withdrawn: 0, upheld: 0, unjudged: 0 },
    ),
  };
}

/**
 * Splits the counts by the prompts and repo instructions in use. A raised
 * finding counts toward the run that raised it, and a fix counts toward the
 * run that raised the fixed finding, so each version is judged on its own
 * findings.
 */
export function statsByVersion(inputs: StatsInput[]): VersionStats[] {
  const runs = inputs.filter(reviewed);
  const byId = new Map(runs.map((i) => [i.run.id, i.run]));
  const groups = new Map<string, VersionStats>();
  const groupFor = (run: ReviewRun): VersionStats => {
    const promptVersion = run.meta.promptVersion ?? UNRECORDED;
    const instructionsHash = run.meta.instructionsHash ?? "none";
    const key = `${promptVersion}/${instructionsHash}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        promptVersion,
        instructionsHash,
        runs: 0,
        raised: 0,
        raisedPreexisting: 0,
        fixed: 0,
        fixedPreexisting: 0,
        costUsd: 0,
        acted: emptyActed(),
      };
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
    const originOf = (finding: RunFinding | undefined) => byId.get(finding?.carriedFrom ?? previous.id) ?? previous;
    for (const r of run.resolved) {
      const finding = previous.findings.find((f) => f.id === r.id);
      const originGroup = groupFor(originOf(finding));
      if (finding?.preexisting) originGroup.fixedPreexisting++;
      else originGroup.fixed++;
    }
    for (const e of actedEntries(run, previous)) addActed(groupFor(originOf(e.finding)).acted, e);
  }
  return [...groups.values()].sort((a, b) => b.runs - a.runs);
}

const percent = (n: number | null) => (n === null ? "n/a" : `${Math.round(n * 100)}%`);
const usd = (n: number) => `$${n.toFixed(2)}`;

function severityLine(counts: SeverityCounts): string {
  const parts = (Object.entries(counts) as [FindingSeverity, number][]).filter(([, n]) => n > 0).map(([s, n]) => `${n} ${s}`);
  return parts.length ? parts.join(", ") : "none";
}

function ratesText(c: ActedCounts): string {
  const acted = c.measured ? c.acted / c.measured : 0;
  const control = c.measured ? c.control / c.measured : 0;
  const points = Math.round((acted - control) * 100);
  return `${c.acted} of ${c.measured} edited (${percent(acted)}), control ${percent(control)}, ${points >= 0 ? "+" : ""}${points} points`;
}

/** How often prior findings had their code edited, against the control spans. Null when nothing was measured. */
export function formatActed(a: ActedStats): string | null {
  if (!a.change.measured && !a.preexisting.measured) return null;
  const parts = [a.change.measured ? ratesText(a.change) : "none on the change"];
  if (a.preexisting.measured) parts.push(`pre-existing ${ratesText(a.preexisting)}`);
  if (a.stillListed) parts.push(`${a.stillListed} edited but still listed`);
  return parts.join("; ");
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
    const reasons = formatDismissals(c.dismissedBy);
    lines.push(
      `  fixed ${c.fixed}, dismissed ${c.dismissed}${reasons ? ` (${reasons})` : ""}, still open at last run ${c.open}${perFixed}`,
    );
    const acted = formatActed(c.acted);
    if (acted) lines.push(`  acted on: ${acted}`);
    const disputes = formatDisputes(c.disputes);
    if (disputes) lines.push(`  disputes: ${disputes}`);
    lines.push("");
  }
  const t = statsTotals(chains);
  lines.push(
    `${t.chains} chain${t.chains === 1 ? "" : "s"}, ${t.meanRounds.toFixed(1)} rounds on average, ${percent(t.pastThreeRounds)} past three rounds`,
    `${t.raised} raised on the change, ${t.fixed} fixed, resolution rate ${percent(t.resolutionRate)}, ${usd(t.costUsd)} total`,
  );
  if (t.dismissed) lines.push(`${t.dismissed} dismissed: ${formatDismissals(t.dismissedBy)}`);
  const usage = formatUsage(t.usage);
  if (usage) lines.push(`tokens over ${t.usage.calls} agent calls: ${usage}`);
  const acted = formatActed(t.acted);
  if (acted) lines.push(`prior findings acted on: ${acted}`);
  const disputes = formatDisputes(t.disputes);
  if (disputes) lines.push(`disputes: ${disputes}`);
  if (versions) {
    lines.push("", "By prompt version / instructions:");
    for (const v of versions) {
      const rate = v.raised ? percent(v.fixed / v.raised) : "n/a";
      lines.push(
        `  ${v.promptVersion} / ${v.instructionsHash}  ${v.runs} run${v.runs === 1 ? "" : "s"}, ${v.raised} raised (${v.raisedPreexisting} pre-existing), ${v.fixed} fixed, resolution rate ${rate}, ${usd(v.costUsd)}`,
      );
      const vActed = formatActed(v.acted);
      if (vActed) lines.push(`    acted on: ${vActed}`);
    }
  }
  return lines.join("\n");
}
