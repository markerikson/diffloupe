import type { DiffFile, DiffHunk, ParsedDiff } from "../types/diff.js";
import type {
  ClassifiedFile,
  FileTier,
  LoadBudgetResult,
} from "../types/loader.js";

// ============================================================================
// Classification patterns
// ============================================================================

/** Source code extensions - Tier 1 */
const SOURCE_CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".scala",
  ".rb",
  ".php",
  ".c",
  ".cpp",
  ".cc",
  ".h",
  ".hpp",
  ".cs",
  ".swift",
  ".m",
  ".mm",
  ".vue",
  ".svelte",
]);

/** Behavior-affecting config files - Tier 1 */
const BEHAVIOR_CONFIG_FILES = new Set([
  "package.json",
  "tsconfig.json",
  "jsconfig.json",
  "vite.config.ts",
  "vite.config.js",
  "vite.config.mjs",
  "webpack.config.ts",
  "webpack.config.js",
  "webpack.config.mjs",
  "rollup.config.ts",
  "rollup.config.js",
  "rollup.config.mjs",
  "esbuild.config.ts",
  "esbuild.config.js",
  "next.config.ts",
  "next.config.js",
  "next.config.mjs",
  "nuxt.config.ts",
  "nuxt.config.js",
  "svelte.config.js",
  "astro.config.mjs",
  "remix.config.js",
  "vitest.config.ts",
  "vitest.config.js",
  "jest.config.ts",
  "jest.config.js",
  "playwright.config.ts",
  "cypress.config.ts",
  "babel.config.js",
  "babel.config.json",
  ".babelrc",
  "tailwind.config.ts",
  "tailwind.config.js",
  "postcss.config.js",
  "eslint.config.js",
  "eslint.config.mjs",
  ".eslintrc.js",
  ".eslintrc.json",
  "prettier.config.js",
  ".prettierrc",
  ".prettierrc.json",
  "biome.json",
  "deno.json",
  "bun.toml",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "setup.py",
  "requirements.txt",
  "Gemfile",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "Makefile",
  "CMakeLists.txt",
]);

/** Lock files - Tier 3 */
const LOCK_FILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "composer.lock",
  "go.sum",
]);

/** Doc extensions - Tier 2 */
const DOC_EXTENSIONS = new Set([".md", ".txt", ".rst", ".adoc"]);

/** Config extensions - Tier 2 */
const CONFIG_EXTENSIONS = new Set([".json", ".yaml", ".yml", ".toml", ".ini"]);

// ============================================================================
// Helper functions
// ============================================================================

/** Get file extension (lowercase, includes dot) */
function getExtension(path: string): string {
  const lastDot = path.lastIndexOf(".");
  if (lastDot === -1 || lastDot === path.length - 1) return "";
  return path.slice(lastDot).toLowerCase();
}

/** Get filename from path */
function getFilename(path: string): string {
  const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return lastSlash === -1 ? path : path.slice(lastSlash + 1);
}

/** Check if file is a test file */
function isTestFile(path: string): boolean {
  const lower = path.toLowerCase();
  const filename = getFilename(lower);
  return (
    lower.includes(".test.") ||
    lower.includes(".spec.") ||
    lower.includes("_test.") ||
    lower.includes("_spec.") ||
    lower.includes("/test/") ||
    lower.includes("/tests/") ||
    lower.includes("/__tests__/") ||
    lower.startsWith("test/") || // root test/ directory
    lower.startsWith("tests/") || // root tests/ directory
    lower.startsWith("__tests__/") || // root __tests__/ directory
    lower.endsWith("_test.go") ||
    lower.endsWith("_test.py") ||
    filename.startsWith("test_") // Python convention: test_foo.py
  );
}

/** Check if file is in a generated/dist directory */
function isGeneratedPath(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.startsWith("dist/") ||
    lower.includes("/dist/") ||
    lower.startsWith("build/") ||
    lower.includes("/build/") ||
    lower.startsWith("out/") ||
    lower.includes("/out/") ||
    lower.startsWith(".next/") ||
    lower.includes("/.next/") ||
    lower.startsWith("node_modules/") ||
    lower.includes("/node_modules/") ||
    lower.startsWith("vendor/") ||
    lower.includes("/vendor/")
  );
}

/** Check if file is a minified/bundled file */
function isMinifiedOrBundled(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.endsWith(".min.js") ||
    lower.endsWith(".min.css") ||
    lower.endsWith(".bundle.js") ||
    lower.endsWith(".chunk.js") ||
    lower.includes(".min.") ||
    // Common bundle output patterns
    lower.match(/\.[a-f0-9]{8,}\.js$/) !== null
  );
}

/** Check if file is in CI/CD directory */
function isCiCdFile(path: string): boolean {
  return (
    path.startsWith(".github/workflows/") ||
    path.startsWith(".gitlab-ci") ||
    path.startsWith(".circleci/") ||
    path.startsWith("azure-pipelines") ||
    path.startsWith("Jenkinsfile")
  );
}

/** Estimate token count from hunks (rough: ~4 chars per token) */
function estimateTokens(hunks: DiffHunk[]): number {
  let totalChars = 0;
  for (const hunk of hunks) {
    // Include the header
    totalChars += hunk.header.length;
    for (const line of hunk.lines) {
      // +1 for the prefix character (+/-/ ) and newline
      totalChars += line.content.length + 2;
    }
  }
  return Math.ceil(totalChars / 4);
}

// ============================================================================
// Main classification logic
// ============================================================================

/** Classification result without token estimation */
interface ClassificationResult {
  tier: FileTier;
  reason: string;
}

/**
 * Classify a single file into a priority tier.
 * Tier 1: Source code, tests, behavior-affecting config
 * Tier 2: Docs, other config, type definitions, CI/CD
 * Tier 3: Lock files, generated files, binaries
 */
export function classifyFile(file: DiffFile): ClassificationResult {
  const { path, isBinary } = file;
  const filename = getFilename(path);
  const ext = getExtension(path);

  // Tier 3: Binary files (check first - no content to analyze)
  if (isBinary) {
    return { tier: 3, reason: "binary file" };
  }

  // Tier 3: Lock files (check early - these are high-priority exclusions)
  if (LOCK_FILES.has(filename)) {
    return { tier: 3, reason: "lock file" };
  }

  // Tier 3: Generated/dist paths
  if (isGeneratedPath(path)) {
    return { tier: 3, reason: "generated/dist directory" };
  }

  // Tier 3: Minified/bundled files
  if (isMinifiedOrBundled(path)) {
    return { tier: 3, reason: "minified/bundled file" };
  }

  // Tier 2: Type definitions (check BEFORE source code - .d.ts ends with .ts)
  if (path.endsWith(".d.ts")) {
    return { tier: 2, reason: "type definition" };
  }

  // Tier 1: Behavior-affecting config (check BEFORE source code - some are .ts/.js)
  if (BEHAVIOR_CONFIG_FILES.has(filename)) {
    return { tier: 1, reason: "behavior config" };
  }

  // Tier 1: Test files (check before general source code for specific reason)
  if (isTestFile(path) && SOURCE_CODE_EXTENSIONS.has(ext)) {
    return { tier: 1, reason: "test file" };
  }

  // Tier 1: Source code
  if (SOURCE_CODE_EXTENSIONS.has(ext)) {
    return { tier: 1, reason: "source code" };
  }

  // Tier 2: CI/CD files
  if (isCiCdFile(path)) {
    return { tier: 2, reason: "CI/CD config" };
  }

  // Tier 2: Documentation
  if (DOC_EXTENSIONS.has(ext)) {
    return { tier: 2, reason: "documentation" };
  }

  // Tier 2: Other config files (not in behavior config set)
  if (CONFIG_EXTENSIONS.has(ext)) {
    return { tier: 2, reason: "config file" };
  }

  // Default: Tier 2 for unknown file types
  return { tier: 2, reason: "other" };
}

/**
 * Classify and sort all files in a diff by priority.
 * Returns files sorted by tier (1 first), then by path within each tier.
 */
export function classifyDiff(diff: ParsedDiff): ClassifiedFile[] {
  const classified: ClassifiedFile[] = diff.files.map((file) => {
    const { tier, reason } = classifyFile(file);
    return {
      file,
      tier,
      reason,
      estimatedTokens: estimateTokens(file.hunks),
    };
  });

  // Sort by tier (ascending), then by path for stable ordering
  classified.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    return a.file.path.localeCompare(b.file.path);
  });

  return classified;
}

/**
 * Select files up to a token budget.
 * Includes files in tier order until budget is exhausted.
 */
export function loadForBudget(
  classified: ClassifiedFile[],
  maxTokens: number
): LoadBudgetResult {
  const included: ClassifiedFile[] = [];
  const excluded: ClassifiedFile[] = [];
  let totalTokens = 0;

  for (const cf of classified) {
    if (totalTokens + cf.estimatedTokens <= maxTokens) {
      included.push(cf);
      totalTokens += cf.estimatedTokens;
    } else {
      excluded.push(cf);
    }
  }

  return { included, excluded, totalTokens };
}
