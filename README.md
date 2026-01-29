# DiffLoupe

Understand your diffs before you merge them.

## The Problem

Reading diffs is hard. You're staring at fragments of code without the full picture, trying to reconstruct what the change *actually does* and whether it's correct.

Good code review requires a mental model of the existing system - understanding where features live, how components interact, what a change will impact. But diffs show you disconnected hunks across files, and you're left mentally stitching them together.

This problem gets worse with AI-generated code. When an AI assistant produces 50 files of changes, you can't just skim and approve. You need to understand what was built, verify it matches your intent, and catch the subtle issues that LLMs introduce.

## The Solution

DiffLoupe uses AI to analyze diffs and tell you what they *mean*:

- **"What does this change do?"** - Get a clear summary of purpose, scope, and affected areas
- **"What could go wrong?"** - Surface risks with concrete evidence, not vague warnings
- **"Does it match my intent?"** - Compare what you asked for against what was actually built

The key differentiator is **intent alignment**: provide your stated intent (commit message, PR description, or explicit description), and DiffLoupe compares it against what the code actually does. This surfaces scope creep, incomplete implementations, and mislabeled changes before they cause problems.

## Features

- **Intent Derivation** - Analyzes diffs to determine purpose, scope, and affected areas
- **Risk Assessment** - Identifies potential issues with severity levels and concrete evidence
- **Intent Alignment** - Compares stated intent vs derived intent to catch mismatches
- **Smart Context Loading** - Includes sibling files and new file source to reduce false positives
- **Large Diff Handling** - Automatic decomposition strategies (two-pass, flow-based) for big changes
- **GitHub PR Support** - Analyze PRs directly using PR metadata as stated intent

## Installation

```bash
npm install -g @acemarke/diffloupe
```

Requires Node.js 18+.

## Configuration

Set your Anthropic API key as an environment variable:

```bash
export ANTHROPIC_API_KEY=sk-ant-api03-...
```

Add to your shell profile (`~/.bashrc`, `~/.zshrc`) for persistence.

## Quick Start

```bash
# Analyze staged changes
diffloupe analyze

# Analyze with your stated intent
diffloupe analyze --intent "Add rate limiting to API endpoints"

# Analyze a commit (uses commit message as intent)
diffloupe analyze commit:HEAD

# Analyze a GitHub PR (uses title + description as intent)
diffloupe pr 123

# Preview what will be sent to the LLM (no API call)
diffloupe summarize --stats
```

## Commands

### `diffloupe analyze [target]`

Analyze code changes with AI assistance.

**Targets:**

| Target | Description |
|--------|-------------|
| `staged` | Staged changes (default) |
| `unstaged` | Unstaged working tree changes |
| `HEAD` | All uncommitted changes |
| `branch:name` | Compare current HEAD to branch |
| `commit:hash` | Analyze a specific commit |
| `range:a..b` | Analyze a commit range |

**Options:**

| Option | Description |
|--------|-------------|
| `-i, --intent <text>` | Describe the intent of the changes |
| `--intent-file <path>` | Read intent from a file |
| `-v, --verbose` | Show detailed output |
| `--json` | Output results as JSON |
| `-C, --cwd <path>` | Run in a different directory |
| `--strategy <name>` | Force decomposition strategy (direct, two-pass, flow-based) |
| `--demo` | Show example output without API call |

**Intent sources** (in priority order):
1. `--intent` flag
2. `--intent-file` contents
3. Commit message (for `commit:` targets)
4. Piped stdin

### `diffloupe pr <identifier>`

Analyze a GitHub PR. Requires `gh` CLI to be installed and authenticated.

**Identifier formats:**

```bash
diffloupe pr 123                                    # PR in current repo
diffloupe pr owner/repo#123                         # Cross-repo PR
diffloupe pr https://github.com/owner/repo/pull/123 # Full URL
```

**Options:**

| Option | Description |
|--------|-------------|
| `-R, --repo <owner/repo>` | Specify repository |
| `-v, --verbose` | Show detailed output |
| `--json` | Output results as JSON |

The PR's title and description are automatically used as stated intent.

### `diffloupe summarize [target]`

Preview diff formatting without running LLM analysis. Useful for debugging and understanding token usage.

**Options:**

| Option | Description |
|--------|-------------|
| `--stats` | Show only file list and token estimates |
| `--files-only` | Show only file list |
| `--json` | Output as JSON |
| `--no-tokens` | Skip token estimates |

## Output

DiffLoupe provides three types of analysis:

**Derived Intent** - What the change actually does:
- Summary and purpose
- Scope (feature, bugfix, refactor, etc.)
- Affected areas
- Suggested review order

**Risk Assessment** - Potential issues:
- Severity (low, medium, high, critical)
- Category (security, performance, error-handling, etc.)
- Evidence from the actual code
- Suggested mitigations

**Intent Alignment** (when stated intent provided):
- Alignment level (aligned, partial, misaligned)
- What matches between stated and actual
- Mismatches, missing implementations, and unstated changes (scope creep)

## How It Works

1. **Parse** - Load and parse the git diff
2. **Classify** - Tier files by importance (skip lock files, generated code)
3. **Gather Context** - Load sibling files in touched directories
4. **Select Strategy** - Choose decomposition approach based on diff size
5. **Analyze** - Run intent derivation and risk assessment
6. **Align** - Compare stated intent vs derived intent (if provided)

For large diffs, DiffLoupe automatically selects a decomposition strategy:
- **Direct** - Small diffs analyzed in one pass
- **Two-pass** - Medium diffs: quick overview, then deep-dive on flagged files
- **Flow-based** - Large diffs: group files by logical flow, analyze each flow

## Inspirations

DiffLoupe builds on ideas from several excellent tools:

- [LaReview](https://github.com/puemos/lareview) - Flow-based grouping concept
- [GitHuman](https://github.com/mcollina/githuman) - Pre-commit review philosophy
- [Diffray](https://github.com/diffray/diffray) - Validation patterns, confidence scoring
- [Critique](https://github.com/remorses/critique) - Prompt engineering principles
- [CodeRabbit](https://coderabbit.ai) - Incremental review patterns

## Development

DiffLoupe is built with Bun and TypeScript, published as a Node.js-compatible package.

```bash
# Install dependencies
bun install

# Run in dev mode
bun run dev

# Run tests
bun test

# Type check
bun run typecheck

# Build for distribution
bun run build
```

**Tech stack:** Bun, TypeScript, TanStack AI, ArkType, Commander

## License

MIT
