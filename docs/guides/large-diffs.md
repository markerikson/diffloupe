# Handling Large Diffs

DiffLoupe automatically selects decomposition strategies for large diffs that would otherwise exceed LLM context limits or produce poor analysis quality.

## The Problem

Large diffs create several challenges:

1. **Token limits** - LLMs have context windows; a 100-file diff may not fit
2. **Attention degradation** - Quality drops when LLMs process very long inputs
3. **Cognitive overload** - Even good analysis becomes hard to read at scale
4. **Mixed concerns** - Large changes often combine unrelated modifications

## Automatic Strategy Selection

DiffLoupe analyzes your diff and automatically selects the best strategy:

| Strategy | When Used | Approach |
|----------|-----------|----------|
| **direct** | Small diffs (~1-15 files) | Analyze everything in one pass |
| **two-pass** | Medium diffs (~16-40 files) | Quick overview, then deep-dive on flagged files |
| **flow-based** | Large diffs (~41-80 files) | Group by logical flow, analyze each group |
| **hierarchical** | Very large diffs (80+ files) | File summaries, then flow grouping, then synthesis |

The actual thresholds depend on token estimates, not just file counts.

## Strategy Details

### Direct Analysis

For small diffs, DiffLoupe runs intent derivation and risk assessment in parallel on the complete diff. This is the simplest and fastest approach.

```
┌─────────┐     ┌──────────────┐     ┌────────┐
│  Diff   │────▶│  Analyze All │────▶│ Output │
└─────────┘     └──────────────┘     └────────┘
```

### Two-Pass Analysis

For medium diffs, a quick first pass identifies which files need deeper attention:

**Pass 1: Overview**
- Quick scan of all files
- Flag files with potential issues or complexity
- Estimate effort per file

**Pass 2: Deep Dive**
- Full analysis on flagged files only
- Detailed risk assessment
- Specific line-level findings

```
┌─────────┐     ┌─────────────┐     ┌─────────────┐     ┌────────┐
│  Diff   │────▶│ Quick Scan  │────▶│ Deep Dive   │────▶│ Output │
└─────────┘     │ (all files) │     │ (flagged)   │     └────────┘
                └─────────────┘     └─────────────┘
```

### Flow-Based Analysis

For large diffs, files are grouped into logical "flows" - cohesive units that serve a common purpose:

**Examples of flows:**
- Authentication changes (login, logout, session handling)
- Data layer (models, migrations, repositories)
- API routes (controllers, middleware, validation)
- UI components (components, styles, tests)

Each flow is analyzed independently, then results are synthesized:

```
┌─────────┐     ┌─────────────┐     ┌─────────────┐     ┌───────────┐     ┌────────┐
│  Diff   │────▶│ Detect      │────▶│ Analyze     │────▶│ Synthesize│────▶│ Output │
└─────────┘     │ Flows       │     │ Each Flow   │     │ Results   │     └────────┘
                └─────────────┘     └─────────────┘     └───────────┘
```

**Flow detection uses:**
- Directory structure (files in same directory often relate)
- Import relationships (files that import each other)
- Naming patterns (auth.ts, auth.test.ts, AuthService.ts)
- Change patterns (files modified together)

### Hierarchical Analysis

For very large diffs, a multi-level approach:

1. **Summarize** - Generate brief summaries for each file
2. **Group** - Cluster summaries into logical flows
3. **Analyze** - Deep analysis per flow
4. **Synthesize** - Combine flow analyses into overall assessment

This approach is the most token-efficient but requires more LLM calls.

## Overriding Strategy Selection

Force a specific strategy with the `--strategy` flag:

```bash
# Force direct analysis (even for large diffs)
diffloupe analyze --strategy direct

# Force two-pass analysis
diffloupe analyze --strategy two-pass

# Force flow-based analysis
diffloupe analyze --strategy flow-based
```

**Use cases for override:**
- Testing/debugging strategy behavior
- When automatic selection isn't optimal for your specific diff
- Forcing simpler analysis when token cost is a concern

## Understanding the Output

When decomposition is used, DiffLoupe reports the strategy in its output:

```
Fetching staged diff...
Parsing diff...
Found 47 file(s), ~45000 tokens
Strategy: flow-based (large diff, grouping by logical flow)
Detecting logical flows...
Analyzing flow: Authentication (8 files)...
Analyzing flow: Data Layer (12 files)...
Analyzing flow: API Routes (15 files)...
Analyzing flow: UI Components (12 files)...
Synthesizing results...
```

The final output combines analysis from all flows into a unified view.

## Tips for Large Changes

### Consider Splitting

If DiffLoupe is using flow-based analysis, your change might benefit from being split into separate PRs:
- Each flow could be its own PR
- Easier to review, test, and revert
- Clearer commit history

### Provide Clear Intent

Intent alignment becomes more valuable with large diffs:
- Helps DiffLoupe understand what's in scope
- Surfaces scope creep more effectively
- Makes "unstated changes" detection more useful

### Use Summarize First

Preview the diff structure before full analysis:

```bash
diffloupe summarize --stats
```

This shows file counts, token estimates, and which files will be analyzed - helpful for understanding what DiffLoupe will process.

## Inspiration

The flow-based grouping concept is inspired by [LaReview](https://github.com/puemos/lareview), which pioneered organizing code review by logical flows rather than file-by-file. DiffLoupe adapts this concept for AI-powered analysis.
