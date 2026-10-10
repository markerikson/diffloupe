// No config or Node imports: the web app renders the same verdicts as the
// GitHub comment and imports this module directly.

export type Surface = "product" | "deploy" | "tooling";

export const SURFACE_RANK = { product: 0, deploy: 1, tooling: 2 } as const;

export const SURFACE_ORDER = ["product", "deploy", "tooling"] as const;

/** Heading for the findings list at or above the change's primary surface. */
export const TIER_TITLE: Record<Surface, string> = {
  product: "Prod risk",
  deploy: "Deploy risk",
  tooling: "Main findings — tooling",
};

export type RiskLevel = "high" | "moderate" | "low";

export interface Verdict {
  level: RiskLevel;
  label: string;
  detail: string;
}

interface Judged {
  severity: string;
}

const severe = (f: Judged) => f.severity === "blocker" || f.severity === "should-fix";

export function mergeRisk(findings: readonly Judged[]): Verdict {
  const blockers = findings.filter((f) => f.severity === "blocker").length;
  const shoulds = findings.filter((f) => f.severity === "should-fix").length;
  if (blockers) {
    return { level: "high", label: "Merge risk: high", detail: `${blockers} ${blockers === 1 ? "blocker" : "blockers"} open.` };
  }
  if (shoulds) {
    return {
      level: "moderate",
      label: "Merge risk: moderate",
      detail: `${shoulds} should-fix ${shoulds === 1 ? "finding" : "findings"} open.`,
    };
  }
  return { level: "low", label: "Merge risk: low", detail: "nothing found that should block this." };
}

/**
 * Whether anything found can break production. Severity is not folded in: a
 * blocker in a test helper is still not a production risk.
 */
export function prodRisk(findings: readonly (Judged & { surface: Surface })[]): Verdict {
  const product = findings.filter((f) => f.surface === "product");
  const count = product.filter(severe).length;
  if (product.length === 0) {
    return { level: "low", label: "Prod risk: none", detail: "everything found is in tooling, deploy or test code." };
  }
  if (count) {
    return {
      level: "high",
      label: `Prod risk: ${count}`,
      detail: `${count === 1 ? "finding" : "findings"} in production code worth acting on.`,
    };
  }
  return {
    level: "moderate",
    label: "Prod risk: low",
    detail: `${product.length} in production code, none above a question.`,
  };
}

/**
 * The most production-proximate surface present. Presence, not proportion: ten
 * new scripts must not outvote the two source files the change exists for.
 */
export function primaryOf(surfaces: Iterable<Surface>): Surface {
  const present = new Set(surfaces);
  return SURFACE_ORDER.find((s) => present.has(s)) ?? "product";
}

/** Findings at or above the primary surface stay in view; the rest collapse. */
export function inTier(surface: Surface, tier: Surface): boolean {
  return SURFACE_RANK[surface] <= SURFACE_RANK[tier];
}
