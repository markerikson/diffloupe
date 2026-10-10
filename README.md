# DiffLoupe

Understand your diffs before you merge them.

DiffLoupe runs a multi-agent AI code review over a local change or a GitHub pull request. You read the result in a local web UI: the changed files are grouped by what they do, the findings sit next to the lines they are about, and a walkthrough tells you where to start reading.

![The run page: merge and prod risk, findings by file, intent check, and where to start](docs/images/run-summary.png)

![A finding and a walkthrough stop shown under the lines they refer to](docs/images/run-finding.png)

<sub>Screenshots use a synthetic test fixture, not a real repository.</sub>

## How a review works

1. **Group.** The changed files are grouped into review units from links in the code: a name defined in one file and used in another, a test and its source, an import, a shared directory. Generated and lock files are skipped. Docs are listed but not reviewed in depth.
2. **Review.** Each unit gets its own reviewer agent, which reads the surrounding code with [tilth](https://github.com/jahala/tilth) and reports findings with evidence. Up to six run at once.
3. **Coordinate.** A coordinator merges and deduplicates the findings, drops the ones it cannot verify, and checks the change against its stated intent: the PR description, `--intent`, or the commit messages.
4. **Walk through.** A walkthrough pass orders the change into chapters and stops, with a "start here" list.

Each review is saved as a run that you can list and reopen. Reviewing the same target again links the new run to the previous one: findings that were fixed are listed as fixed, and ones still open are carried forward instead of being reported again.

## The web UI

- **Summary** at the top, laid out like a GitHub review comment: merge risk and production risk, finding counts, findings grouped by file with links to their lines, whether the change matches its stated intent, what to focus on, and where to start.
- **Groups** in the sidebar and down the page. Each group has a short summary and its own file tree. Files can be collapsed one by one or from the collapse menu.
- **Finding cards** under the lines they refer to, coloured by severity, with explanation, evidence and a suggested fix. Focusing a finding highlights its line range.
- **Walkthrough stops** as separate cards, with a Guide mode in the sidebar for stepping through them in order.
- **Copy** on each finding and **Copy all** put the findings on the clipboard as markdown, ready to paste into a coding agent.
- **Keyboard:** `j`/`k` next/previous file, `n`/`p` next/previous finding, `]`/`[` next/previous stop, `x` collapse the current file, `t` back to the summary, `?` for the list. Browser Back and Forward move between the findings you jumped to.
- Split or unified diffs, line wrapping, light and dark themes.
- While a review is running, the page shows its progress and fills in the file groups as soon as grouping finishes.

## Requirements

| Tool | Notes |
|------|-------|
| [Bun](https://bun.sh) 1.3 or later | Runs the CLI and the server. |
| `git` | |
| [OpenCode](https://opencode.ai) 2.x | Runs every agent (`npm i -g opencode-ai`). Tested with 2.0.26. DiffLoupe writes its own OpenCode config for each run, so your OpenCode settings, agents and plugins are not used. |
| [tilth](https://github.com/jahala/tilth) | Code reading tools for the reviewers (`cargo install tilth`). Tested with 0.9.0. |
| [`gh`](https://cli.github.com) | Only for pull requests. Run `gh auth login` first. |
| An Anthropic API key | `ANTHROPIC_API_KEY` in the environment, or `apiKeys.anthropic` in the config file. |

**The API key is required even if you are logged in to OpenCode.** Each review agent runs OpenCode with its own data directory, so OpenCode never sees your stored login. The key has to come from the environment or the DiffLoupe config file.

**Cost.** The defaults are Claude Opus 5.5 for the reviewers and the coordinator, and Claude Sonnet 5.5 for the walkthrough and group naming. Real runs so far: about $0.10 for a one-file commit, about $1 for a small PR, and $4–5 for a large one. Use `--max-cost` or `maxCostUsd` in the config to set a limit. The run page and `diffloupe runs` show what each run cost.

**Platforms.** Developed and tested on Linux and WSL2. On WSL the server binds `127.0.0.1` and the Windows browser reaches it through `localhost`. macOS should work but has not been tried. Native Windows has not been tried.

## Install

DiffLoupe is not published to npm yet; the `@acemarke/diffloupe` 0.1.0 package on npm is the January prototype, with different commands. Build from source:

```bash
git clone https://github.com/markerikson/diffloupe.git
cd diffloupe
bun install
bun run build
```

`dist/` then holds a standalone Bun bundle with the web UI. Run it with `bun /path/to/diffloupe/dist/index.js`, or put a `diffloupe` alias or wrapper script on your `PATH` that runs it.

## Quick start

```bash
# Review uncommitted changes in the current repo and open the result in a browser
diffloupe review --open

# Review a GitHub PR; its title and description are the stated intent
diffloupe review '#123' --open
diffloupe review https://github.com/owner/repo/pull/123 --open

# Review a branch against its merge base, with a stated intent and a cost limit
diffloupe review branch:my-feature --intent "Add rate limiting to API endpoints" --max-cost 3

# Run in the terminal only and print the review as markdown
diffloupe review --headless --markdown

# Reopen saved runs
diffloupe open --last --open
diffloupe runs
```

`review` starts a local server, prints the run URL, and streams progress to the terminal. The page can be opened right away. Ctrl+C stops the server, and cancels the review if it is still running. If a `diffloupe serve` is already running, `review` and `open` use it instead of starting another server.

## Commands

### `diffloupe review [target]`

**Targets:**

| Target | Description |
|--------|-------------|
| `worktree` | Staged, unstaged and untracked changes against HEAD (default) |
| `staged` | Staged changes against HEAD |
| `HEAD`, `commit:<sha>` | A single commit |
| `range:<a>..<b>` | A commit range |
| `branch:<name>` | A branch against its merge base with the default branch |
| `#<n>`, `pr:<n>`, PR URL | A GitHub pull request, reviewed in a temporary worktree at the PR head |

**Options:**

| Option | Description |
|--------|-------------|
| `-C, --repo <path>` | Repository to review (default: current directory) |
| `--base <ref>` | For `staged`/`worktree`: diff against `merge-base(<ref>, HEAD)` instead of HEAD |
| `-i, --intent <text>` | Describe the intent of the changes |
| `--intent-file <path>` | Read the intent from a file |
| `--model <stage=id>` | Model for a stage: `review`, `coordinator`, `walkthrough` (repeatable) |
| `--effort <level>` | Reasoning effort: `low`, `medium`, `high` |
| `--config <file>` | Per-repo review settings (see below) |
| `--max-cost <usd>` | Stop starting new review slices once spending reaches this amount. Slices already running finish, so the total can go over. |
| `--host <host>`, `--port <port>` | Server address (default `127.0.0.1:4517`, or the next free port) |
| `--open` | Open the run in a browser. On WSL this opens the Windows browser. |
| `--headless` | Run without a server and print a summary to stdout |
| `--markdown` | With `--headless`, print the full review markdown instead of the summary |

Untracked files over 1 MB are skipped and listed in the run.

### `diffloupe open [runId]`

Prints the URL of a saved run, starting a server if none is running. `--last` opens the most recent run; with no run id it opens the run list. `--open` opens the browser.

### `diffloupe serve`

Runs the server until you stop it. `-C` sets the repository that runs use by default.

### `diffloupe runs`

| Command | Description |
|---------|-------------|
| `diffloupe runs [--json]` | List saved runs, newest first |
| `diffloupe runs show <id> [--json]` | Show a run: groups with their files and findings, walkthrough stops, totals |
| `diffloupe runs show <id> --markdown [--over-cap]` | Print the findings as markdown, the same text as Copy all in the UI |
| `diffloupe runs rm <id>` | Delete a run and its artifacts |

Runs are stored under `$XDG_DATA_HOME/diffloupe/runs/<id>/` (`~/.local/share/diffloupe/runs/` by default). Each holds `run.json`, the reviewed `diff.patch`, the progress log, and the raw review output.

## Configuration

**User config:** `~/.config/diffloupe/config.json`

```json
{
  "apiKeys": { "anthropic": "sk-ant-..." },
  "models": { "review": "claude-opus-5-5", "coordinator": "claude-opus-5-5", "walkthrough": "claude-sonnet-5-5" },
  "effort": "medium",
  "maxCostUsd": 5,
  "port": 4517,
  "host": "127.0.0.1"
}
```

Every field is optional. Model ids without a provider prefix are Anthropic models.

**Per-repo settings** (`--config <file>`):

```json
{
  "models": { "review": "...", "coordinator": "...", "walkthrough": "..." },
  "effort": "medium",
  "surfaces": { "deploy": ["^infra/"], "tooling": ["^docs/"] },
  "extraExcludes": ["vendor/openssl/"]
}
```

`surfaces` are regex sources matched against repo-relative paths. They decide which findings count toward "prod risk": anything not matched as deploy or tooling counts as product code. `extraExcludes` are path substrings left out of the code map.

Precedence: command-line options, then the per-repo settings file, then the user config.

## Inspirations

- [pulls.review](https://pulls.review) - the page layout: grouped files, sticky group panels, per-group file trees
- [`@pierre/diffs`](https://diffs.com) - the diff renderer
- [Plannotator](https://github.com/backnotprop/plannotator) - local review server, browser opening and request guards
- [LaReview](https://github.com/puemos/lareview) - flow-based grouping
- [GitHuman](https://github.com/mcollina/githuman) - pre-commit review
- [Diffray](https://github.com/diffray/diffray) - validation patterns, confidence scoring
- [Critique](https://github.com/remorses/critique) - prompt engineering principles
- [CodeRabbit](https://coderabbit.ai) - incremental review

## Development

```bash
bun install
bun run dev        # CLI from source, in watch mode
bun run dev:web    # Vite dev server for the web UI on :5173, proxying /api to a server on :4517
bun test src       # unit tests
bun run typecheck
bun run lint
bun run build      # CLI bundle plus the web UI in dist/web
```

The server serves the web UI from `dist/web`, so after changing web code, `bun run build:web` and a page reload are enough.

**Tech stack:** Bun, TypeScript, Commander, ArkType, Hono, React, Redux Toolkit, TanStack Router, `@pierre/diffs`

## License

MIT
