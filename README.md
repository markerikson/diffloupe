# DiffLoupe

Understand your diffs before you merge them.

## The Problem

Reading diffs is hard. You're staring at fragments of code without the full picture, trying to reconstruct what the change *actually does* and whether it's correct.

Good code review requires a mental model of the existing system - understanding where features live, how components interact, what a change will impact. But diffs show you disconnected hunks across files, and you're left mentally stitching them together.

This problem gets worse with AI-generated code. When an AI assistant produces 50 files of changes, you can't just skim and approve. You need to understand what was built, verify it matches your intent, and catch the subtle issues that LLMs introduce.

## What It Does

`diffloupe review` runs a multi-agent code review over a local change or a GitHub pull request:

1. **Group** - Changed files are grouped into review units from links in the code itself: a name defined in one file and used in another, a test and its source, an import, a shared directory. Generated and lock files are skipped; docs are listed but not reviewed in depth.
2. **Review** - Each unit gets its own reviewer session, which reads the surrounding code with tilth and reports findings with evidence.
3. **Coordinate** - A coordinator merges and deduplicates the findings, drops the ones it cannot verify, and checks the change against its stated intent (PR description, `--intent`, or the commit messages).
4. **Walk through** - A walkthrough pass orders the change into chapters and stops, with a "start here" list.

Each review is saved as a run you can list and reopen. Re-reviewing the same target picks up the previous run: findings that were fixed are reported as fixed, and ones still open are carried forward instead of being reported again.

## Requirements

- [Bun](https://bun.sh)
- `git`
- [opencode](https://opencode.ai), configured with access to the review models (Claude Opus for reviewers and the coordinator, Claude Sonnet for the walkthrough by default)
- `tilth` on your `PATH`
- [`gh`](https://cli.github.com), authenticated, for pull requests

## Quick Start

```bash
# Review uncommitted changes in the current repo
diffloupe review --headless

# Review a branch against its merge base, with a stated intent
diffloupe review --headless branch:my-feature --intent "Add rate limiting to API endpoints"

# Review a GitHub PR (title and description are the stated intent)
diffloupe review --headless https://github.com/owner/repo/pull/123

# List saved runs, then reopen one
diffloupe runs
diffloupe runs show <id>
```

## Commands

### `diffloupe review [target]`

Server mode (the web UI) is not built yet, so `--headless` is required for now. Progress goes to stderr and a summary of the review goes to stdout: intent alignment, findings by severity with their locations, and where to start reading.

**Targets:**

| Target | Description |
|--------|-------------|
| `worktree` | Staged and unstaged changes against HEAD (default) |
| `staged` | Staged changes against HEAD |
| `HEAD`, `commit:<sha>` | A single commit |
| `range:<a>..<b>` | A commit range |
| `branch:<name>` | A branch against its merge base with the default branch |
| `#<n>`, `pr:<n>`, PR URL | A GitHub pull request |

**Options:**

| Option | Description |
|--------|-------------|
| `-C, --repo <path>` | Repository to review (default: current directory) |
| `--base <ref>` | For `staged`/`worktree`: diff against `merge-base(<ref>, HEAD)` instead of HEAD |
| `-i, --intent <text>` | Describe the intent of the changes |
| `--intent-file <path>` | Read the intent from a file |
| `--model <stage=id>` | Model for a stage: `review`, `coordinator`, `walkthrough` (repeatable) |
| `--effort <level>` | Reasoning effort: `low`, `medium`, `high` |
| `--config <file>` | Per-repo settings JSON (see below) |
| `--headless` | Run in the terminal |
| `--markdown` | Print the full review markdown instead of the summary |

Untracked files are not reviewed; the run lists them as skipped.

**Settings file** (`--config`):

```json
{
  "models": { "review": "...", "coordinator": "...", "walkthrough": "..." },
  "effort": "medium",
  "surfaces": { "deploy": ["^infra/"], "tooling": ["^docs/"] },
  "extraExcludes": ["vendor/openssl/"]
}
```

`surfaces` are regex sources matched against repo-relative paths. `extraExcludes` are path substrings left out of the code map.

### `diffloupe runs`

| Command | Description |
|---------|-------------|
| `diffloupe runs [--json]` | List saved runs, newest first |
| `diffloupe runs show <id> [--json]` | Show a run: groups with their files and findings, walkthrough stops, totals |
| `diffloupe runs rm <id>` | Delete a run and its artifacts |

Runs are stored under `$XDG_DATA_HOME/diffloupe/runs/<id>/` (`~/.local/share/diffloupe/runs/` by default). Each holds `run.json`, the reviewed `diff.patch`, a progress log, and the raw review output.

### `diffloupe serve`

Starts the HTTP server for the web UI. Only a health check exists so far.

## Inspirations

DiffLoupe builds on ideas from several excellent tools:

- [LaReview](https://github.com/puemos/lareview) - Flow-based grouping concept
- [GitHuman](https://github.com/mcollina/githuman) - Pre-commit review philosophy
- [Diffray](https://github.com/diffray/diffray) - Validation patterns, confidence scoring
- [Critique](https://github.com/remorses/critique) - Prompt engineering principles
- [CodeRabbit](https://coderabbit.ai) - Incremental review patterns

## Development

DiffLoupe is built with Bun and TypeScript.

```bash
bun install
bun run dev        # run the CLI from source, in watch mode
bun test src       # unit tests
bun run typecheck
bun run lint
bun run build
```

**Tech stack:** Bun, TypeScript, Commander, ArkType, `@pierre/diffs`, Hono, React, Redux Toolkit

## License

MIT
