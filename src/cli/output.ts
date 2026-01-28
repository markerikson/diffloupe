/**
 * CLI Output Formatting - Formats analysis results for terminal display
 *
 * Two modes:
 * - Summary: Quick overview for fast triage
 * - Verbose: Full details for thorough review
 */

import pc from "picocolors";
import type { DerivedIntent, IntentAlignment, Risk, RiskAssessment, RiskSeverity } from "../types/analysis";

/**
 * Color a risk severity level appropriately
 */
function colorSeverity(severity: RiskSeverity): string {
  switch (severity) {
    case "low":
      return pc.green(severity);
    case "medium":
      return pc.yellow(severity);
    case "high":
      return pc.red(severity);
    case "critical":
      return pc.bold(pc.magenta(severity));
  }
}

/**
 * Color an alignment level appropriately
 */
function colorAlignment(alignment: IntentAlignment["alignment"]): string {
  switch (alignment) {
    case "aligned":
      return pc.green(alignment.toUpperCase());
    case "partial":
      return pc.yellow(alignment.toUpperCase());
    case "misaligned":
      return pc.red(alignment.toUpperCase());
  }
}

/**
 * Format a single risk as a one-liner for summary view
 */
function formatRiskOneLine(risk: Risk): string {
  const severity = colorSeverity(risk.severity);
  const file = risk.file ? pc.dim(` (${risk.file})`) : "";
  return `  ${severity}: ${risk.description}${file}`;
}

/**
 * Format a single risk with full details for verbose view
 */
function formatRiskVerbose(risk: Risk, index: number): string {
  const lines: string[] = [];

  lines.push(`${pc.bold(`Risk #${index + 1}`)}`);
  lines.push(`  Severity: ${colorSeverity(risk.severity)}`);
  lines.push(`  Category: ${pc.cyan(risk.category)}`);
  if (risk.file) {
    lines.push(`  File:     ${pc.blue(risk.file)}`);
  }
  lines.push(`  ${risk.description}`);
  lines.push("");
  lines.push(`  ${pc.dim("Evidence:")} ${risk.evidence}`);

  if (risk.mitigation) {
    lines.push(`  ${pc.dim("Mitigation:")} ${risk.mitigation}`);
  }

  return lines.join("\n");
}

/**
 * Get the scope badge with appropriate styling
 */
function formatScope(scope: string): string {
  return pc.dim(`[${scope}]`);
}

/**
 * Format for default (summary) output
 *
 * Shows:
 * - Stated intent (if provided)
 * - Intent summary (1-2 lines)
 * - Intent alignment (if stated intent provided)
 * - Overall risk level with color
 * - Top 3 risks (one line each)
 * - File count affected
 */
export function formatSummary(
  intent: DerivedIntent,
  risks: RiskAssessment,
  statedIntent?: string,
  alignment?: IntentAlignment
): string {
  const lines: string[] = [];

  // Stated intent section (if provided)
  if (statedIntent) {
    lines.push(pc.bold("Stated Intent"));
    lines.push(pc.cyan(statedIntent));
    lines.push("");
  }

  // Derived intent section
  lines.push(pc.bold("Derived Intent"));
  lines.push(`${formatScope(intent.scope)} ${intent.summary}`);
  lines.push("");

  // Intent alignment section (if we have stated intent and alignment)
  if (alignment) {
    lines.push(`${pc.bold("Intent Alignment")}: ${colorAlignment(alignment.alignment)}`);
    lines.push(`  ${alignment.summary}`);

    // Show key mismatches/missing/unstated in summary
    const keyIssues = [
      ...alignment.mismatches.slice(0, 2),
      ...alignment.missing.slice(0, 1),
      ...alignment.unstated.slice(0, 1),
    ];
    if (keyIssues.length > 0) {
      for (const issue of keyIssues) {
        lines.push(pc.dim(`  > ${issue}`));
      }
    }
    lines.push("");
  }

  // Risk section
  const overallColor = colorSeverity(risks.overallRisk);
  lines.push(`${pc.bold("Risk")}: ${overallColor}`);

  if (risks.risks.length === 0) {
    lines.push(pc.dim("  No risks identified"));
  } else {
    // Show top 3 risks
    const topRisks = risks.risks.slice(0, 3);
    for (const risk of topRisks) {
      lines.push(formatRiskOneLine(risk));
    }

    if (risks.risks.length > 3) {
      lines.push(pc.dim(`  ... and ${risks.risks.length - 3} more`));
    }
  }
  lines.push("");

  // Affected areas count
  const areaCount = intent.affectedAreas.length;
  lines.push(pc.dim(`${areaCount} area${areaCount !== 1 ? "s" : ""} affected: ${intent.affectedAreas.join(", ")}`));

  return lines.join("\n");
}

/**
 * Format a list of items with a prefix indicator
 */
function formatItemList(items: string[], emptyMessage = "(none)"): string[] {
  if (items.length === 0) {
    return [pc.dim(`  ${emptyMessage}`)];
  }
  return items.map((item) => `  ${pc.blue(">")} ${item}`);
}

/**
 * Format for verbose output (full detail)
 *
 * Shows:
 * - Stated intent (if provided)
 * - Full intent with purpose and scope
 * - Intent alignment (if stated intent provided)
 * - Suggested review order
 * - All risks with severity, category, description, evidence, mitigation
 */
export function formatVerbose(
  intent: DerivedIntent,
  risks: RiskAssessment,
  statedIntent?: string,
  alignment?: IntentAlignment
): string {
  const lines: string[] = [];
  const divider = pc.dim("─".repeat(60));

  // Stated intent section (if provided)
  if (statedIntent) {
    lines.push(divider);
    lines.push(pc.bold(pc.cyan("STATED INTENT")));
    lines.push(divider);
    lines.push("");
    lines.push(pc.cyan(statedIntent));
    lines.push("");
  }

  // Header
  lines.push(divider);
  lines.push(pc.bold(pc.cyan("DERIVED INTENT")));
  lines.push(divider);
  lines.push("");

  // Summary and purpose
  lines.push(`${pc.bold("Summary:")} ${intent.summary}`);
  lines.push(`${pc.bold("Purpose:")} ${intent.purpose}`);
  lines.push(`${pc.bold("Scope:")}   ${formatScope(intent.scope)}`);
  lines.push("");

  // Affected areas
  lines.push(pc.bold("Affected Areas:"));
  for (const area of intent.affectedAreas) {
    lines.push(`  ${pc.blue(">")} ${area}`);
  }
  lines.push("");

  // Suggested review order
  if (intent.suggestedReviewOrder && intent.suggestedReviewOrder.length > 0) {
    lines.push(pc.bold("Suggested Review Order:"));
    intent.suggestedReviewOrder.forEach((file, i) => {
      lines.push(`  ${pc.dim(`${i + 1}.`)} ${pc.blue(file)}`);
    });
    lines.push("");
  }

  // Intent alignment section (if we have stated intent and alignment)
  if (alignment) {
    lines.push(divider);
    lines.push(pc.bold(pc.cyan(`INTENT ALIGNMENT: ${colorAlignment(alignment.alignment)}`)));
    lines.push(divider);
    lines.push("");

    lines.push(`${pc.bold("Confidence:")} ${alignment.confidence}`);
    lines.push(`${pc.bold("Summary:")} ${alignment.summary}`);
    lines.push("");

    lines.push(pc.bold("Matches:"));
    lines.push(...formatItemList(alignment.matches));
    lines.push("");

    lines.push(pc.bold("Mismatches:"));
    lines.push(...formatItemList(alignment.mismatches));
    lines.push("");

    lines.push(pc.bold("Missing (stated but not implemented):"));
    lines.push(...formatItemList(alignment.missing));
    lines.push("");

    lines.push(pc.bold("Unstated Changes (scope creep):"));
    lines.push(...formatItemList(alignment.unstated));
    lines.push("");
  }

  // Risk assessment
  lines.push(divider);
  lines.push(pc.bold(pc.cyan("RISK ASSESSMENT")));
  lines.push(divider);
  lines.push("");

  // Overall risk and confidence
  const overallColor = colorSeverity(risks.overallRisk);
  lines.push(`${pc.bold("Overall Risk:")} ${overallColor}`);
  lines.push(`${pc.bold("Confidence:")}   ${risks.confidence}`);
  lines.push(`${pc.bold("Summary:")}      ${risks.summary}`);
  lines.push("");

  // All risks
  if (risks.risks.length === 0) {
    lines.push(pc.green("No risks identified."));
  } else {
    lines.push(pc.bold(`Identified Risks (${risks.risks.length}):`));
    lines.push("");

    risks.risks.forEach((risk, i) => {
      lines.push(formatRiskVerbose(risk, i));
      if (i < risks.risks.length - 1) {
        lines.push("");
      }
    });
  }

  lines.push("");
  lines.push(divider);

  return lines.join("\n");
}
