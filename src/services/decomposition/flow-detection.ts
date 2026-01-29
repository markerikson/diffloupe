/**
 * Flow Detection for Large Diffs
 *
 * This module implements flow detection for diffs in the 41-80 file range.
 * It groups files by logical concern (e.g., auth, data layer, UI) to enable
 * focused, per-flow analysis.
 *
 * ## Strategy (from design doc)
 *
 * 1. **Flow Detection Phase (light):**
 *    - Send file list with paths, change stats, and tiers
 *    - Include first 5-10 lines of each file for hints
 *    - LLM identifies 3-8 logical flows/concerns
 *    - Each file belongs to ONE flow (simplifies later analysis)
 *
 * 2. **Per-Flow Analysis Phase:**
 *    - Analyze each flow separately with full diff content
 *    - Produces per-flow intent and risks
 *
 * 3. **Synthesis Phase:**
 *    - Combine flow analyses into unified result
 *    - Cross-flow dependencies noted
 *
 * ## Key Design Decisions
 *
 * - Files can only belong to ONE flow (no overlap) to simplify analysis
 * - Files that don't fit any flow go to "uncategorized" bucket
 * - Flow detection prompt is lightweight (file list + brief content hints)
 * - Priority ordering helps reviewers focus on most important flows first
 */

import { chat } from "@tanstack/ai";
import { anthropicText } from "@tanstack/ai-anthropic";
import { type } from "arktype";

import type { ParsedDiff, DiffFile } from "../../types/diff.js";
import type { ClassifiedFile } from "../../types/loader.js";
import { wrapSchema } from "../../utils/schema-compat.js";

// ============================================================================
// Types
// ============================================================================

/**
 * A detected logical flow/concern in a diff.
 */
export interface DetectedFlow {
  /** Human-readable name, e.g., "Authentication", "Data Layer", "UI Components" */
  name: string;
  /** What this flow accomplishes */
  description: string;
  /** Files in this flow (paths) */
  files: string[];
  /** Suggested analysis order (1 = highest priority) */
  priority: number;
}

/**
 * Result of flow detection.
 */
export interface FlowDetectionResult {
  /** Detected logical flows */
  flows: DetectedFlow[];
  /** Files that don't fit any flow */
  uncategorized: string[];
}

// ============================================================================
// ArkType Schema for Flow Detection Response
// ============================================================================

/**
 * Schema for flow detection LLM response.
 *
 * The LLM returns an array of flows, each with:
 * - name: Short descriptive name for the flow
 * - description: What this flow accomplishes
 * - files: Array of file paths belonging to this flow
 * - priority: 1 = highest priority for review
 */
const FlowDetectionResponseSchema = type({
  flows: type({
    name: "string",
    description: "string",
    files: "string[]",
    priority: "number",
  }).array(),
});

export type FlowDetectionResponse = typeof FlowDetectionResponseSchema.infer;

// ============================================================================
// Constants
// ============================================================================

/** Number of lines to include from each file as hints */
const HINT_LINES_PER_FILE = 8;

// ============================================================================
// Flow Detection System Prompt
// ============================================================================

const FLOW_DETECTION_SYSTEM_PROMPT = `You are an expert code reviewer analyzing a large diff to identify logical "flows" or concerns.

Your task is to GROUP the changed files into logical flows. A flow is a cohesive unit of related changes that serve a common purpose.

## Guidelines

1. **Identify 3-8 flows** - Too few loses granularity, too many fragments the review
2. **Each file belongs to ONE flow** - No overlap. Assign to the PRIMARY concern.
3. **Name flows clearly** - Use names like "Authentication", "Data Layer", "API Routes", "UI Components", "Configuration", "Testing"
4. **Set priority based on risk/importance**:
   - Priority 1: Security, auth, data mutations
   - Priority 2: Core business logic, API changes
   - Priority 3: Supporting code, utilities
   - Priority 4: Tests, config, docs

## Common Flow Patterns

- **Authentication/Security**: Login, auth middleware, tokens, permissions
- **Data Layer**: Database, models, migrations, queries
- **API Layer**: Routes, controllers, handlers, middleware
- **UI Components**: React components, Vue components, templates
- **State Management**: Redux, MobX, stores, actions
- **Configuration**: Build config, env, CI/CD
- **Testing**: Test files, fixtures, mocks
- **Utilities**: Helpers, shared functions, types

## Edge Cases

- **Cross-cutting files** (e.g., types used everywhere): Assign to the flow they MOST support
- **Mixed-purpose files**: Assign to the HIGHER priority flow
- **Very small groups** (1-2 files): Consider merging with related flow or marking as uncategorized

## Output Quality

- Order flows by priority (1 first)
- Descriptions should be 1-2 sentences
- Don't create a flow for just 1 file unless it's critical`;

// ============================================================================
// Prompt Building
// ============================================================================

/**
 * Get first N lines of changes from a file for hints.
 */
function getFileHints(file: DiffFile, maxLines: number): string[] {
  const hints: string[] = [];
  let lineCount = 0;

  for (const hunk of file.hunks) {
    if (lineCount >= maxLines) break;

    for (const line of hunk.lines) {
      if (lineCount >= maxLines) break;
      if (line.type === "add" || line.type === "delete") {
        const prefix = line.type === "add" ? "+" : "-";
        hints.push(`${prefix}${line.content}`);
        lineCount++;
      }
    }
  }

  return hints;
}

/**
 * Build the prompt for flow detection.
 *
 * The prompt is designed to be lightweight:
 * - File list with paths, status, and change stats
 * - First 5-10 lines of each file for context hints
 * - File tier (priority classification)
 */
export function buildFlowDetectionPrompt(
  _diff: ParsedDiff,
  classified: ClassifiedFile[]
): string {
  // Only include tier 1-2 files (exclude lock files, generated, etc.)
  const relevantFiles = classified.filter((cf) => cf.tier <= 2);

  const sections: string[] = [];

  // Overview section
  sections.push("## Diff Overview");
  sections.push(`Total files to group: ${relevantFiles.length}`);
  const tier1Count = relevantFiles.filter((cf) => cf.tier === 1).length;
  const tier2Count = relevantFiles.filter((cf) => cf.tier === 2).length;
  sections.push(
    `- Tier 1 (high priority): ${tier1Count} files (source code, tests, critical config)`
  );
  sections.push(
    `- Tier 2 (lower priority): ${tier2Count} files (docs, other config, types)`
  );
  sections.push("");

  // File list with stats and hints
  sections.push("## Files to Group");
  sections.push("");

  for (const cf of relevantFiles) {
    const file = cf.file;

    // Calculate change stats
    const addedLines = file.hunks.reduce(
      (sum, h) => sum + h.lines.filter((l) => l.type === "add").length,
      0
    );
    const deletedLines = file.hunks.reduce(
      (sum, h) => sum + h.lines.filter((l) => l.type === "delete").length,
      0
    );

    // File header with path, status, stats, tier
    const statusLabel = file.status.toUpperCase();
    sections.push(
      `### ${file.path} (${statusLabel}) [+${addedLines}/-${deletedLines}] [Tier ${cf.tier}]`
    );

    // Binary files - just note it
    if (file.isBinary) {
      sections.push("[binary file]");
      sections.push("");
      continue;
    }

    // Add hint lines
    const hints = getFileHints(file, HINT_LINES_PER_FILE);
    if (hints.length > 0) {
      sections.push("```");
      sections.push(...hints);
      if (addedLines + deletedLines > hints.length) {
        sections.push(`... (${addedLines + deletedLines - hints.length} more lines)`);
      }
      sections.push("```");
    }
    sections.push("");
  }

  // Task instruction
  sections.push("---");
  sections.push(`Group these ${relevantFiles.length} files into logical flows.

REQUIREMENTS:
1. Create 3-8 flows (no more, no fewer unless diff is very small)
2. Every file must be assigned to exactly ONE flow
3. Set priority: 1 = most important to review, higher = less critical
4. If a file doesn't fit any flow well, you can leave it out (it will be uncategorized)

OUTPUT FORMAT:
{
  "flows": [
    {
      "name": "Flow Name",
      "description": "What this flow accomplishes",
      "files": ["path/to/file1.ts", "path/to/file2.ts"],
      "priority": 1
    }
  ]
}`);

  return sections.join("\n");
}

// ============================================================================
// Flow Detection Execution
// ============================================================================

/**
 * Run LLM to detect flows in a diff.
 *
 * @param diff - The parsed diff
 * @param classified - Classified files with tier and token estimates
 * @returns Detected flows and uncategorized files
 */
export async function detectFlows(
  diff: ParsedDiff,
  classified: ClassifiedFile[]
): Promise<FlowDetectionResult> {
  const relevantFiles = classified.filter((cf) => cf.tier <= 2);
  const allFilePaths = new Set(relevantFiles.map((cf) => cf.file.path));

  const userPrompt = buildFlowDetectionPrompt(diff, classified);

  const response = await chat({
    adapter: anthropicText("claude-sonnet-4-5"),
    systemPrompts: [FLOW_DETECTION_SYSTEM_PROMPT],
    messages: [{ role: "user", content: userPrompt }],
    outputSchema: wrapSchema(FlowDetectionResponseSchema),
    temperature: 0.3, // Low temp for consistent categorization
    stream: false,
    maxTokens: 4096,
  });

  // Track which files were assigned
  const assignedFiles = new Set<string>();
  const validatedFlows: DetectedFlow[] = [];

  // Process and validate each flow
  for (const flow of response.flows) {
    // Filter to only files that actually exist in the diff
    const validFiles = flow.files.filter((f: string) => {
      if (!allFilePaths.has(f)) return false;
      if (assignedFiles.has(f)) return false; // Already assigned to another flow
      return true;
    });

    // Mark these files as assigned
    for (const f of validFiles) {
      assignedFiles.add(f);
    }

    // Only include flow if it has files
    if (validFiles.length > 0) {
      validatedFlows.push({
        name: flow.name,
        description: flow.description,
        files: validFiles,
        priority: Math.max(1, Math.min(10, Math.round(flow.priority))), // Clamp to 1-10
      });
    }
  }

  // Sort flows by priority
  validatedFlows.sort((a, b) => a.priority - b.priority);

  // Find uncategorized files
  const uncategorized = relevantFiles
    .filter((cf) => !assignedFiles.has(cf.file.path))
    .map((cf) => cf.file.path);

  return {
    flows: validatedFlows,
    uncategorized,
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get the ClassifiedFile objects for a specific flow.
 *
 * Useful for later per-flow analysis.
 */
export function getFilesForFlow(
  flow: DetectedFlow,
  classified: ClassifiedFile[]
): ClassifiedFile[] {
  const flowPaths = new Set(flow.files);
  return classified.filter((cf) => flowPaths.has(cf.file.path));
}

/**
 * Get the ClassifiedFile objects for uncategorized files.
 */
export function getUncategorizedFiles(
  uncategorized: string[],
  classified: ClassifiedFile[]
): ClassifiedFile[] {
  const uncatPaths = new Set(uncategorized);
  return classified.filter((cf) => uncatPaths.has(cf.file.path));
}

/**
 * Calculate total estimated tokens for a flow.
 */
export function estimateFlowTokens(
  flow: DetectedFlow,
  classified: ClassifiedFile[]
): number {
  const files = getFilesForFlow(flow, classified);
  return files.reduce((sum, cf) => sum + cf.estimatedTokens, 0);
}
