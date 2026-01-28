/**
 * CLI Output Formatting - Formats analysis results for terminal display
 *
 * Two modes:
 * - Summary: Quick overview for fast triage
 * - Verbose: Full details for thorough review
 */

import pc from "picocolors";
import type { DerivedIntent, Risk, RiskAssessment, RiskSeverity } from "../types/analysis";

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
 * - Intent summary (1-2 lines)
 * - Overall risk level with color
 * - Top 3 risks (one line each)
 * - File count affected
 */
export function formatSummary(intent: DerivedIntent, risks: RiskAssessment): string {
  const lines: string[] = [];

  // Intent section
  lines.push(pc.bold("Intent"));
  lines.push(`${formatScope(intent.scope)} ${intent.summary}`);
  lines.push("");

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
 * Format for verbose output (full detail)
 *
 * Shows:
 * - Full intent with purpose and scope
 * - Suggested review order
 * - All risks with severity, category, description, evidence, mitigation
 */
export function formatVerbose(intent: DerivedIntent, risks: RiskAssessment): string {
  const lines: string[] = [];
  const divider = pc.dim("─".repeat(60));

  // Header
  lines.push(divider);
  lines.push(pc.bold(pc.cyan("INTENT")));
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
