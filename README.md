# DiffLoupe

Understand your diffs before you merge them.

DiffLoupe runs a multi-agent AI code review over a local change or a GitHub pull request. You read the result in a local web UI: the changed files are grouped by what they do, the findings sit next to the lines they are about, and a walkthrough tells you where to start reading.

It is also a plain diff viewer. `diffloupe diff` shows the same grouped diff in about a second, with no agents and no credentials, and can add a walkthrough from a single model call.

![The run page: merge and prod risk, findings by file, intent check, and where to start](docs/images/run-summary.png)

![A finding and a walkthrough stop shown under the lines they refer to, and listed under their files in the group's file tree](docs/images/run-finding.png)

<sub>Screenshots use a synthetic test fixture, not a real repository.</sub>

## How a review works

1. **Group.** The changed files are grouped into review units from links in the code: a name defined in one file and used in another, a test and its source, an import, a shared directory. Generated and lock files are skipped. Docs are listed but not reviewed in depth.
2. **Review.** A small model first reads the whole diff and drafts what the change is for, so each reviewer knows what the parts it cannot see are doing. Each unit then gets its own reviewer agent, which reads the surrounding code with [tilth](https://github.com/jahala/tilth) and reports findings with evidence. Up to six run at once.
3. **Coordinate.** A coordinator merges and deduplicates the findings, drops the ones it cannot verify, and checks the change against its stated intent: the PR description, `--intent`, or the commit messages.
4. **Walk through.** A walkthrough pass orders the change into chapters and stops, with a "start here" list.

Each review is saved as a run that you can list and reopen. Reviewing the same target again links the new run to the previous one: findings that were fixed are listed as fixed, and ones still open are carried forward instead of being reported again.

A re-review (round 2 and later) only sends the files that changed since the previous run's head to the reviewers. Each of them sees the full diff plus what changed since the last review, and is told to focus on the new lines. The cap on new findings drops from 10 to 5. Grouping and the walkthrough still cover the whole change. If more than half the files changed, or the previous head is no longer available, the round falls back to a full review. `--full` forces one. From round 4 on, the CLI warns that later rounds mostly find smaller problems.

Findings about code the change did not add or modify are tagged **pre-existing**. They have their own cap of 3, so they never push findings on the new code out of the review. They are listed after the other findings, do not count toward merge risk, and are shown muted in the web UI.

## The web UI

- **Summary** at the top, laid out like a GitHub review comment: merge risk and production risk, finding counts, findings grouped by file with links to their lines, whether the change matches its stated intent, what to focus on, and where to start.
- **Groups** in the sidebar and down the page. Each group has a short summary and its own file tree. Files can be collapsed one by one or from the collapse menu.
- **File tree notes:** under each file in a group's tree, one row per finding (severity dot, title, line) and per walkthrough stop (signpost icon, title, stop number, line). Clicking a row scrolls to its line. Groups with a blocker or should-fix finding, or a critical walkthrough stop, get an orange mark; its tooltip says which.
- **Finding cards** under the lines they refer to, coloured by severity, with explanation, evidence and a suggested fix. Focusing a finding highlights its line range.
- **Walkthrough stops** as separate cards, with a Guide mode in the sidebar for stepping through them in order.
- **Copy** on each finding and **Copy all** put the findings on the clipboard as markdown, ready to paste into a coding agent.
- **Keyboard:** `j`/`k` next/previous file, `n`/`p` next/previous finding, `]`/`[` next/previous stop, `x` collapse the current file, `t` back to the summary, `?` for the list. Browser Back and Forward move between the findings you jumped to.
- Split or unified diffs, line wrapping, light and dark themes.
- While a review is running, the page shows its progress and fills in the file groups as soon as grouping finishes.
- The run list at `/` shows every saved run, with a filter for reviews or diffs.

## Requirements

| Tool | Notes |
|------|-------|
| [Bun](https://bun.sh) 1.3 or later | Runs the CLI and the server. |
| `git` | |
| [OpenCode](https://opencode.ai) 2.x | Runs every agent (`npm i -g @opencode/cli`; the older `opencode-ai` package is 1.x). Tested with 2.0.26. DiffLoupe writes its own OpenCode config for each run, so your agents, plugins and MCP servers are not used. Your default model and your `providers` block are. |
| [tilth](https://github.com/jahala/tilth) | Code reading tools for the reviewers (`cargo install tilth`). Tested with 0.9.0. |
| [`gh`](https://cli.github.com) | Only for pull requests. Run `gh auth login` first. |
| A model provider credential | See [Credentials](#credentials). |

`diffloupe diff` needs only Bun, `git`, and `gh` for pull requests. With `--walkthrough` it also needs OpenCode and a credential for the walkthrough model, but not tilth.

Run `diffloupe doctor` to check all of this, along with which models a review will use and where each credential comes from.

**Cost.** With the built-in defaults (Claude Opus 5.5 for the reviewers and the coordinator, Claude Sonnet 5.5 for the walkthrough and group naming, Claude Haiku 5.5 for the intent draft at about $0.01), real runs so far cost about $0.10 for a one-file commit, about $1 for a small PR, and $4–5 for a large one. If your OpenCode config sets a default model, DiffLoupe uses it for every stage instead, which changes the cost. Use `--max-cost` or `maxCostUsd` to set a limit. The run page and `diffloupe runs` show what each run cost. Models whose provider reports no price show "cost not reported", and `--max-cost` cannot be enforced for them.

**Platforms.** Developed and tested on Linux and WSL2. On WSL the server binds `127.0.0.1` and the Windows browser reaches it through `localhost`. macOS should work but has not been tried. Native Windows is not supported; use WSL.

## Install

```bash
bun add -g @acemarke/diffloupe
```

`npm i -g @acemarke/diffloupe` works too, but the `diffloupe` command runs under Bun either way, so Bun must be on your `PATH`. The package is a self-contained bundle with no runtime dependencies.

To run from source instead:

```bash
git clone https://github.com/markerikson/diffloupe.git
cd diffloupe
bun install
bun run build
```

Then run `bun /path/to/diffloupe/dist/index.js`, or put a `diffloupe` alias or wrapper script on your `PATH` that runs it.

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

# View uncommitted changes grouped by code links, with no model calls
diffloupe diff --open

# View a PR with a walkthrough guide (one model call)
diffloupe diff '#123' --walkthrough --open

# View a PR from any directory, without a clone
diffloupe diff owner/repo#123 --open

# Reopen saved runs
diffloupe open --last --open
diffloupe runs
```

`review` and `diff` start a local server, print the run URL, and stream progress to the terminal. The page can be opened right away. Ctrl+C stops the server, and cancels the run if it is still going. If a `diffloupe serve` is already running, `review`, `diff` and `open` use it instead of starting another server.

## Commands

### `diffloupe review [target]`

**Targets:**

| Target | Description |
|--------|-------------|
| `worktree` | Staged, unstaged and untracked changes against HEAD (default) |
| `staged` | Staged changes against HEAD |
| `<sha>`, `HEAD`, `HEAD~2`, `main^`, a tag, `commit:<rev>` | A single commit against its parent. Use `commit:<branch>` for just the tip commit of a branch |
| `<a>..<b>`, `range:<a>..<b>` | The diff between two commits. An empty side means `HEAD`, as in `HEAD~3..` |
| `<a>...<b>`, `range:<a>...<b>` | `<b>` against `merge-base(<a>, <b>)` |
| `<branch>`, `branch:<name>` | A branch against its merge base with the default branch. A bare name of the default branch means its tip commit |
| `#<n>`, `pr:<n>`, PR URL | A GitHub pull request, reviewed in a temporary worktree at the PR head |

**Options:**

| Option | Description |
|--------|-------------|
| `-C, --repo <path>` | Repository to review (default: current directory) |
| `--base <ref>` | For `staged`/`worktree`: diff against `merge-base(<ref>, HEAD)` instead of HEAD |
| `-i, --intent <text>` | What the change should do. Every reviewer sees it labelled as yours, next to the PR description |
| `--intent-file <path>` | Read the intent from a file |
| `--model <stage=id>` | Model for a stage: `review`, `coordinator`, `walkthrough`, `intent` (repeatable) |
| `--effort <level>` | Reasoning effort: `low`, `medium`, `high` |
| `--config <file>` | Per-repo review settings (see below) |
| `--max-cost <usd>` | Stop starting new review slices once spending reaches this amount. Slices already running finish, so the total can go over: by up to six slices at $3 each, plus the coordinator and walkthrough. |
| `--max-rounds <n>` | Skip the review when it would be past round n. With `--github`, rounds are counted from the pull request's summary comment, and the payloads only add a notice to it saying why the push was not reviewed. With `--headless`, a skipped run exits 4. |
| `--host <host>`, `--port <port>` | Server address (default `127.0.0.1:4517`, or the next free port) |
| `--open` | Open the run in a browser. On WSL this opens the Windows browser. |
| `--full` | On a re-review, review every changed file instead of only the files changed since the last run |
| `--headless` | Run without a server and print a summary to stdout |
| `--markdown` | With `--headless`, print the full review markdown instead of the summary |
| `--github` | PR targets only. Review for posting to GitHub: see [Running in CI](#running-in-ci) |
| `--head <sha>` | PR targets only. Review this commit instead of the PR's current head. It must be a full 40-character SHA in the PR's history |
| `--out <dir>` | With `--headless`, copy the review output and `result.json` into this directory |
| `--json` | With `--headless`, print only the `result.json` object to stdout |
| `--fail-on <severity>` | With `--headless`, exit 3 if a finding posted in this round is at this severity or above: `blocker`, `should-fix`, `nice-to-have`, `question` |

Untracked files over 1 MB are skipped and listed in the run.

### `diffloupe diff [target]`

Shows a target's diff in the web UI, grouped the same way as a review, with no review agents. It takes the same targets as `review`. Grouping reads files from git objects, so no worktree is created and your checkout is not touched. Group titles come from the files' directories and names instead of a model call. Docs and generated files go in the trailing "Other changes" section.

| Option | Description |
|--------|-------------|
| `-C, --repo <path>` | Repository (default: current directory) |
| `--base <ref>` | For `staged`/`worktree`: diff against `merge-base(<ref>, HEAD)` instead of HEAD |
| `--walkthrough` | Add the walkthrough guide: one call to the walkthrough model, which works from the diff alone and gets no tools for reading the repo |
| `-i, --intent <text>`, `--intent-file <path>` | Stated intent, used by the walkthrough |
| `--model walkthrough=<id>`, `--effort <level>` | Walkthrough model and effort |
| `--config <file>` | Per-repo settings, for the walkthrough model |
| `--host`, `--port`, `--open` | As for `review` |
| `--headless` | Print the groups and their files to stdout, no server |

`owner/repo#<n>` and PR URLs also work outside a clone of that repository. DiffLoupe then keeps its own copy of the repository under `~/.local/share/diffloupe/repos/` with no history and no file contents: each run fetches only the PR head and its merge base, and file contents are fetched as the diff and grouping need them. git authenticates through `gh`, so private repositories work too. Such runs cannot be turned into reviews, since a review needs a clone.

A diff run page has a **Review these changes** button. It starts a full review of the same base and head commits. For `worktree` and `staged` targets that is the snapshot you were looking at, not what is on disk now.

### `diffloupe open [runId]`

Prints the URL of a saved run, starting a server if none is running. `--last` opens the most recent run; with no run id it opens the run list. `--open` opens the browser. `--port` is where it looks for a running server (default 4517), and `--host` is the address a new server listens on.

### `diffloupe serve`

Runs the server until you stop it. `-C` sets the repository that runs use by default. `--host`, `--port` and `--open` work as for `review`.

### `diffloupe runs`

| Command | Description |
|---------|-------------|
| `diffloupe runs [--kind review\|diff] [--json]` | List saved runs, newest first |
| `diffloupe runs show <id> [--json]` | Show a run: groups with their files and findings, walkthrough stops, totals |
| `diffloupe runs show <id> --markdown [--over-cap]` | Print the findings as markdown, the same text as Copy all in the UI |
| `diffloupe runs stats [--repo <path\|owner/name>] [--since 30d] [--by-version] [--json]` | For each chain of re-reviews of the same target: findings raised, carried and fixed per round, findings dismissed and still open, cost per fixed finding, and totals (resolution rate for findings on the change, mean rounds, share of chains past three rounds). `--by-version` splits the counts by the hash of the review prompts and of the repo's instructions, which each run records |
| `diffloupe runs rm <id>` | Delete a run, its artifacts, its scratch files and the git refs that pin its commits |
| `diffloupe runs prune [--older-than 30d] [--keep 20] [--kind review\|diff] [--yes]` | Delete runs older than the cutoff, except the newest `--keep`, plus scratch files no run owns. Lists what it would delete unless `--yes` is given |

Runs are stored under `$XDG_DATA_HOME/diffloupe/runs/<id>/` (`~/.local/share/diffloupe/runs/` by default). Each holds `run.json`, the reviewed `diff.patch`, the progress log, and the raw review output. Deleting a run removes the refs that pin its commits; the repository copies under `repos/` are not deleted, and their objects stay until you remove the directory.

### `diffloupe doctor`

Checks Bun, git, OpenCode, tilth and `gh`; prints the model for each stage and where it came from, and the source of each provider credential; and shows how much disk the data directory uses. Exits non-zero if a review could not run. `--config <file>` includes a per-repo settings file in the model lookup. `--strict` also exits non-zero on warnings, such as `gh` not being logged in or a model with no known cost. `--json` prints the checks as a JSON array of `{ name, status, detail }`.

### `diffloupe gate`

`diffloupe gate '#<n>' --fail-on <severity>` reads a pull request's comments on GitHub and lists the bot's findings that are still open. It exits 3 when one of them is at or above `--fail-on`, and 0 otherwise. It runs no model and needs only `gh`. `#<n>` takes the repository from the current checkout or `GH_REPO`; outside a checkout, pass `owner/repo#<n>`. See [Failing the check on findings](#failing-the-check-on-findings) for what counts as open.

| Option | Meaning |
|--------|---------|
| `--fail-on <severity>` | Required. `blocker`, `should-fix`, `nice-to-have` or `question` |
| `--json` | Print the result as JSON |
| `--status [sha]` | Also set the `diffloupe/gate` commit status on that commit, or on the PR head when no sha is given |
| `--override-label <name>` | Pass the gate when the PR has this label |
| `--count-author-resolved` | Treat a thread the PR author resolved as closed. By default the author's own resolutions do not close findings |
| `--review-missing` | Say that this push's review never reached the PR (the review or post job failed). The gate then fails when the bot has never reviewed the PR |

## Running in CI

`diffloupe review '#<n>' --headless --github --head <sha> --out <dir>` reviews a pull request for a bot that posts the result. DiffLoupe itself does not post anything: it writes the GitHub API payloads, and a later step sends them.

`--github` changes how a re-review finds the earlier rounds:

- Earlier rounds come only from the PR's comments on GitHub, through `gh`. Runs saved on the CI machine are not used for carried-over findings, so a cached data directory cannot make the bot reply to comments that are not on the PR.
- Every round reviews the whole PR. The summary comment is rewritten on each push and holds the findings, so a round that only looked at the changed files would drop the open findings on the other files from it.
- A `gh` failure while reading the PR description or its comments fails the run instead of reviewing without them.
- The run writes `payloads.json` with the summary comment, the inline review and the replies.
- The summary comment gets a "Copy all findings as Markdown" fold. If it would push the comment over GitHub's size limit, the comment links to the `findings.md` file in the run's artifact instead.

`--head` pins the review to the commit the workflow was triggered for, so a push during the run does not change what gets reviewed.

Review agents may not reach the network. DiffLoupe gathers the PR description and comments itself before any agent starts, the web tools are turned off, and shell commands such as `curl`, `wget`, `gh pr`, `gh api` and `git fetch` are refused, as is inline `node -e`/`bun -e`/`python -c` code that makes a request. That check reads command lines and can be got around, so on CI also limit outbound traffic from the review job to the model provider and GitHub, and keep tokens that can write to the repository out of the review step.

### Answering a finding

The PR author, or an agent fixing the PR for them, can answer a finding with a marker and a reason, either as a reply in the finding's thread or as a PR comment:

```markdown
<!-- ai-review-response fp=3f9c2a1b verdict=disputed -->
The value is validated in `parseInput` before it gets here.
```

`fp` is the finding's fingerprint, from the `fp=` field of the marker on the bot's comment or summary bullet. `verdict` is `disputed` (the finding is wrong) or `fixed` (the code now handles it); `action` works in place of `verdict`. One comment can answer several findings with one marker per paragraph. Answers are read from any account, bots included.

On the next review the coordinator rules once on each disputed finding:

- **Withdrawn**: the bot replies in the thread and marks it settled, and the finding is never reported again on that PR.
- **Upheld**: the bot replies that the finding still stands and leaves the thread open for a human reviewer. It does not argue the point again.

Rulings are listed in a "Disputed findings" fold at the end of the summary comment, which is how later reviews remember them. A `fixed` answer is not a ruling: the coordinator checks the code and closes the finding out as usual if the fix is there. `run.json` lists each disputed finding under `disputes` with its outcome (`withdrawn`, `upheld`, or `unjudged` when the coordinator did not rule), and `diffloupe runs stats` counts them.

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | The review finished, or was skipped because the change has no code files |
| 1 | The run failed, including a `gh` failure under `--github` |
| 2 | The run could not start: a bad flag, target, model or credential |
| 3 | `--fail-on` was given and a finding posted in this round is at or above that severity. For `diffloupe gate`: an open finding is at or above `--fail-on` |
| 4 | `--max-rounds` was given and this review would have been past that round, so it was skipped |
| 130 | The run was cancelled |

### `result.json`

Written to `--out` for every finished, failed, cancelled or skipped run, and printed by `--json`:

```json
{
  "id": "backend-pr42-0123abcdef45-20261021183000",
  "status": "complete",
  "reviewed": true,
  "skipReason": null,
  "pr": 42,
  "base": "<sha>",
  "head": "<sha>",
  "runDir": "/home/runner/.local/share/diffloupe/runs/backend-pr42-0123abcdef45-20261021183000",
  "outDir": "review-out",
  "payloads": "review-out/payloads.json",
  "artifactName": "ai-code-review-42-0123abcde",
  "costUsd": 1.62,
  "wallMs": 412000,
  "budgetStopped": false,
  "skippedSlices": 0,
  "findings": {
    "total": 7,
    "posted": 6,
    "minor": 0,
    "bySeverity": { "blocker": 0, "should-fix": 2, "nice-to-have": 3, "question": 1 }
  },
  "progress": {
    "open": 1,
    "fixed": 3,
    "withdrawn": 1,
    "upheld": 0,
    "fixedThisRound": 2,
    "withdrawnThisRound": 1,
    "new": 6
  },
  "round": 2,
  "incremental": false,
  "version": "0.4.0"
}
```

`status` is `complete`, `failed`, `cancelled` or `skipped`. `skipReason` is `no-code-files` or `round-limit` (from `--max-rounds`) for a skipped run. `payloads` is `null` when there is nothing to post. `findings.posted` counts the findings in the comments; `minor` counts the ones folded into the summary's "Minor findings" section by the `post.minSeverity` setting; `total` adds the ones over the comment cap, and `bySeverity` counts posted and minor findings. `artifactName` is the name the summary comment links to, so upload `--out` under that name.

`progress` says where the bot's findings from earlier rounds stand after this review, counted by their inline comments: `open` are still unresolved (upheld disputes included), `fixed` were closed out as fixed, `withdrawn` were withdrawn after a dispute, and `upheld` were disputed but still stand and wait for a human reviewer. The `ThisRound` counts are the part of `fixed` and `withdrawn` this review decided, and `new` is the number of findings this review raised. When `new` stays above zero round after round and `fixedThisRound` stays at zero, the rounds are not converging. `progress` is `null` when nothing was reviewed. `run.json` keeps the same counts under `roundProgress`.

`--out` also holds `review.md`, `payloads.json`, `findings.md`, `record.json`, `units.json`, `byClass.json`, `run.json` and the detail report `<run id>.detail.md`. Files a run did not produce are left out.

### Failing the check on findings

`--fail-on` on the review counts only the findings posted in this round. On a re-review, a finding already posted in an earlier round is not posted again, so a later push can pass while an earlier blocker is still unfixed. It suits a single job or a local script: it exits 3 after writing `--out`, and ignores findings over the comment cap.

To block merges until the findings are dealt with, run `diffloupe gate` in a job after the comments are posted, and make that job the required check. It reads the PR on GitHub, so it sees every round's findings:

```yaml
gate:
  needs: [review, post]
  if: >-
    !cancelled() && needs.post.result != 'cancelled' &&
    (needs.review.result == 'success' || needs.review.result == 'failure')
  runs-on: ubuntu-latest
  permissions:
    pull-requests: read
    statuses: write
  steps:
    - uses: oven-sh/setup-bun@v2
    - run: npm install -g @acemarke/diffloupe
    - env:
        GH_TOKEN: ${{ github.token }}
        PR: ${{ github.event.pull_request.number }}
        HEAD_SHA: ${{ github.event.pull_request.head.sha }}
        REVIEW_MISSING: >-
          ${{ (needs.review.result == 'failure' ||
          (needs.review.outputs.reviewed == 'true' && needs.post.result == 'failure')) && 'yes' || '' }}
      run: >-
        diffloupe gate "$GITHUB_REPOSITORY#$PR"
        --fail-on blocker
        --override-label ai-review-max-rounds
        --status "$HEAD_SHA"
        ${REVIEW_MISSING:+--review-missing}
```

[`examples/github-actions/review.yml`](examples/github-actions/review.yml) is a complete workflow with the review, post and gate jobs and the round limit described below.

A finding is open when:

- it has an inline thread from the bot that is not resolved and that the bot has not settled. The bot settles a thread when it closes the finding out as fixed or withdraws it after a dispute. An outdated thread still counts, since moving the code does not fix it.
- or it is listed in the bot's latest summary comment and was not withdrawn. With inline comments off, every finding is only in the summary. Earlier summary findings that a review does not post again are carried forward under "Still open from earlier reviews", so they keep counting. That covers files the review did not read (an incremental review of a later push, or a file past a budget or size cap) and findings it found again but cut at the posting cap.

A thread the PR author resolved still counts unless `--count-author-resolved` is given, so the author cannot clear a blocker by closing the thread. An upheld dispute stays open until someone other than the PR author resolves the thread. If an agent resolves threads with a different account than the one that opened the PR, those resolutions count as someone else's. Severity comes from the comment's marker; a finding whose severity cannot be read is listed as `unknown` and never fails the gate. Neither does a pre-existing finding, in code the change did not touch: the gate lists it but does not count it, since the author was not asked to fix it. `--override-label` passes the gate when the PR has that label, for a human to accept the open findings.

With `--status`, the gate also sets a `diffloupe/gate` commit status on the PR head. Make that status the required check if you rerun the gate outside the PR's workflow, for example on `pull_request_review` events or after a dispute is ruled on, since a status on the head commit is replaced by the latest run.

Gate on `blocker` only: findings vary between runs, and a lower threshold blocks merges on false positives. The `if:` above runs the gate even when the review or post job fails, since it reads the PR and sees whatever earlier rounds and this one did get posted. A failed review of a later push therefore does not clear open blockers from earlier rounds. If reviews keep failing, the PR stays blocked on those findings until they are resolved or a human adds the override label. The example workflow also passes `--review-missing` when this push's review or post job failed, so a PR whose first review broke fails the gate instead of merging unreviewed; a PR with an earlier review is judged on what that review left open. The gate is skipped only when the review job is skipped, and GitHub counts a skipped required job as passing. "Require conversation resolution before merging" in the branch protection rules is a simpler option. It blocks on any unresolved inline comment, from the bot or a person, at any severity, but misses findings that are only in the summary.

To stop an automated fix loop from running forever, pass `--max-rounds`. A review past that round is skipped before any model runs, exits 4 under `--headless`, and writes a `result.json` with `skipReason: "round-limit"`. Its `payloads.json` only updates the summary comment: a notice at the top says the push was not reviewed and why, and the rest of the comment, with its findings and rulings, stays as the last review left it. The example workflow posts that notice, labels the PR `ai-review-max-rounds`, and passes the gate with `--override-label`, so the PR can merge after a bounded number of fix attempts and the label marks the PRs that merged with findings still open. Treat exit 4 as success in the review job, and run the post job when `skipReason` is `round-limit` as well as when `reviewed` is true.

Run `diffloupe doctor --strict` before the review to fail fast on a missing tool or credential.

## Configuration

**User config:** `~/.config/diffloupe/config.json`

```json
{
  "provider": "anthropic",
  "models": { "review": "claude-opus-5-5", "coordinator": "claude-opus-5-5", "walkthrough": "claude-sonnet-5-5" },
  "effort": "medium",
  "apiKeys": { "anthropic": "sk-ant-..." },
  "opencode": { "useDefaultModel": true },
  "maxCostUsd": 5,
  "port": 4517,
  "host": "127.0.0.1"
}
```

**Per-repo settings** (`--config <file>`):

```json
{
  "provider": "anthropic",
  "models": { "review": "...", "coordinator": "...", "walkthrough": "..." },
  "effort": "medium",
  "surfaces": { "deploy": ["^infra/"], "tooling": ["^docs/"] },
  "extraExcludes": ["vendor/openssl/"],
  "post": { "minSeverity": "should-fix", "questions": "drop" },
  "instructions": [
    "## What failure looks like here",
    "A change that breaks runs already saved on disk.",
    "## Don't report",
    "Styling in src/web/."
  ]
}
```

Every field is optional.

| Setting | User config | Per-repo settings | CLI | Environment | Default |
|---------|-------------|-------------------|-----|-------------|---------|
| Reviewer model | `models.review` | `models.review` | `--model review=<id>` | `REVIEW_MODEL` | OpenCode default model, else `anthropic/claude-opus-5-5` |
| Coordinator model | `models.coordinator` | `models.coordinator` | `--model coordinator=<id>` | `REVIEW_MODEL_MERGE` | OpenCode default model, else `anthropic/claude-opus-5-5` |
| Walkthrough model | `models.walkthrough` | `models.walkthrough` | `--model walkthrough=<id>` | `REVIEW_MODEL_WALK` | OpenCode default model, else `anthropic/claude-sonnet-5-5` |
| Intent draft model | `models.intent` | `models.intent` | `--model intent=<id>` | `REVIEW_MODEL_INTENT` | `anthropic/claude-haiku-5-5` when the walkthrough model is Anthropic, else the walkthrough model |
| Provider for bare model ids | `provider` | `provider` | | `REVIEW_PROVIDER` | `anthropic` |
| Effort | `effort` | `effort` | `--effort` | `REVIEW_EFFORT`, `REVIEW_EFFORT_AUX` | `medium` for built-in default models only |
| Use the OpenCode default model | `opencode.useDefaultModel` | | | | `true` |
| API keys by provider id | `apiKeys.<provider>` | | | | |
| Cost limit (USD) | `maxCostUsd` | | `--max-cost` | | none |
| Server address | `host`, `port` | | `--host`, `--port` | | `127.0.0.1:4517` |

**Model lookup.** Each stage is looked up on its own. `REVIEW_*` environment variables win, then command-line options, then the per-repo settings file, then the user config, then the `model` in your global OpenCode config (`~/.config/opencode/opencode.json(c)`), then the built-in defaults. A model id without a `/` gets the provider prefix, so `claude-opus-5-5` means `anthropic/claude-opus-5-5`.

**Effort** is passed to OpenCode as the model variant (`provider/model#high`), so it must be a variant the model offers. It is only added when you set it, or when the model is a built-in default. A model from your OpenCode config runs without a variant unless you set an effort. A `#variant` written in the model id always wins.

`surfaces` are regex sources matched against repo-relative paths. They decide which findings count toward "prod risk": anything not matched as deploy or tooling counts as product code. `extraExcludes` are path substrings left out of the code map.

`post` decides what the posted review shows. Findings below `minSeverity` (order: `blocker`, `should-fix`, `nice-to-have`, `question`) get no inline comment and are listed in a collapsed "Minor findings" section of the summary. They don't count toward `findings.posted` in `result.json`; `findings.minor` counts them. `"questions": "drop"` leaves questions out of the review entirely, so they don't take slots under the findings cap. By default every finding is posted.

`instructions` is free text given to every reviewer and the coordinator, either one string or an array of lines. Keep it short and about what the code can't tell a reviewer: what counts as breaking in this repo, invariants that are easy to break and invisible in a diff, and what not to report. Where it conflicts with the built-in review guidance, it wins.

### Credentials

DiffLoupe supports API keys and ChatGPT subscriptions through OpenCode 2.x. For each provider the chosen models use, the first available credential source is used:

1. The provider's environment variable, such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. A `providers.<id>.env` list in your OpenCode config is honored.
2. `apiKeys.<provider>` in `~/.config/diffloupe/config.json`. It is passed to the OpenCode processes only, not to DiffLoupe's own environment.
3. For OpenAI, a ChatGPT subscription saved with `diffloupe auth login`.
4. An API key you saved with `opencode auth login`. DiffLoupe reads it with `opencode auth export` and imports it into each agent's data directory, which is deleted when the agent exits.

To use your ChatGPT subscription, sign in and select a ChatGPT subscription method from OpenCode's prompts:

```bash
diffloupe auth login
```

This saves a separate login for DiffLoupe. Existing OAuth logins from your ordinary OpenCode profile are not copied; sign in again through DiffLoupe even if you already use ChatGPT in OpenCode. OpenCode manages sign-in and token refresh. Subscription reviews use OpenCode's native OpenAI provider settings; `providers.openai` overrides from your ordinary OpenCode config are not copied into subscription reviews.

Choose OpenAI models for your review stages in `~/.config/diffloupe/config.json`, replacing `<model-id>` with a model available to your subscription in OpenCode:

```json
{
  "provider": "openai",
  "models": {
    "review": "openai/<model-id>",
    "coordinator": "openai/<model-id>",
    "walkthrough": "openai/<model-id>",
    "intent": "openai/<model-id>"
  }
}
```

You can also inherit an OpenAI default model from your global OpenCode config. Setting `provider` alone only changes how bare model IDs are resolved; it does not replace the built-in Claude models. Environment variables and explicit stage model settings still take precedence over the OpenCode default.

```bash
diffloupe auth status  # List the accounts in DiffLoupe's subscription profile
diffloupe doctor      # Check which credential and model each stage will use
diffloupe auth logout # Remove a DiffLoupe subscription login
```

Explicit API keys take precedence over a subscription. Unset `OPENAI_API_KEY` and remove any `apiKeys.openai` if you want subscription access instead. A DiffLoupe subscription login takes precedence over API keys saved in your ordinary OpenCode profile. Subscription agents share one persistent profile and run one at a time, including across simultaneous DiffLoupe processes, so OpenCode can safely refresh the login. API-key agents keep their separate data directories and run in parallel. Subscription usage has no dollar cost reported to DiffLoupe, so `--max-cost` cannot enforce a dollar limit for it; your subscription's usage limits still apply.

Subscriptions for other providers, including Claude, are not supported. Providers that authenticate from the machine, such as Amazon Bedrock, Google Vertex, Ollama and LM Studio, are not checked. If a provider has no credential, the review stops before it starts and names the provider, the stage, and the ways to add one.

The `diffloupe` command does not load `.env` files, so a `.env` in the repo you review cannot supply or override a key. `diffloupe doctor` shows which source each provider's credential comes from.

## Inspirations

- [pulls.review](https://pulls.review) - the page layout: grouped files, sticky group panels, per-group file trees
- [Codiff](https://github.com/nkzw-tech/codiff): a diff viewer with walkthroughs
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
