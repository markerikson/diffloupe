# Intent Alignment

Intent alignment is DiffLoupe's core differentiator: comparing what you *say* a change does against what it *actually* does.

## Why It Matters

When reviewing code, you typically have some stated intent:
- A commit message: "Fix null pointer in user service"
- A PR description: "Add rate limiting to API endpoints"
- A task description: "Refactor auth to use JWT tokens"

But does the code actually do that? And *only* that?

Intent alignment catches:

- **Scope creep** - Changes that weren't part of the stated intent (often introduced unintentionally by AI assistants)
- **Incomplete implementations** - Stated goals that aren't fully implemented in the code
- **Mislabeled changes** - Code that does something substantially different than claimed
- **Missing pieces** - Intent mentions something that has no corresponding code change

## How It Works

1. You provide **stated intent** (what you claim the change does)
2. DiffLoupe derives **actual intent** from analyzing the diff
3. The alignment analysis compares them and reports:
   - **Matches** - What aligns between stated and actual
   - **Mismatches** - Where the code diverges from stated intent
   - **Missing** - Stated but not implemented
   - **Unstated** - Implemented but not mentioned

## Providing Stated Intent

DiffLoupe accepts stated intent from multiple sources, in priority order:

### 1. Command Line Flag

```bash
diffloupe analyze --intent "Add rate limiting to /api/users endpoint"
```

Best for: Quick one-off analysis with specific intent.

### 2. Intent File

```bash
diffloupe analyze --intent-file ./PR_DESCRIPTION.md
```

Best for: Longer descriptions, reusable intent files, CI pipelines.

### 3. Commit Message (Automatic)

```bash
diffloupe analyze commit:HEAD
diffloupe analyze commit:abc1234
```

When analyzing a commit, DiffLoupe automatically extracts the commit message as stated intent. This is formatted as "Commit abc1234: Your commit message here".

Best for: Verifying that commits do what their messages claim.

### 4. PR Metadata (Automatic)

```bash
diffloupe pr 123
diffloupe pr owner/repo#456
```

When analyzing a PR, DiffLoupe automatically assembles stated intent from:
- PR title
- PR description/body

Best for: PR review workflows, verifying PRs match their descriptions.

### 5. Piped Input

```bash
echo "Refactor auth module" | diffloupe analyze
cat task-description.txt | diffloupe analyze
```

Best for: Integration with other tools, scripting.

## Reading the Output

### Alignment Levels

| Level | Meaning |
|-------|---------|
| **aligned** | Code does what's stated, no significant extra or missing pieces |
| **partial** | Core intent matches, but there are gaps or additions |
| **misaligned** | Code does something substantially different than stated |

### Output Fields

**Matches** - Specific ways the code fulfills the stated intent:
```
> Added null check in UserService.ts:45 as stated
> Rate limiting middleware added to /api/users route
```

**Mismatches** - Where code diverges from stated intent:
```
> Stated "fix null pointer" but actually rewrote the entire function
> Rate limit applies to all routes, not just /api/users as stated
```

**Missing** - Stated but not implemented:
```
> Stated "add tests" but no test files were added
> PR mentions "update documentation" but no docs changed
```

**Unstated** - Implemented but not mentioned (scope creep):
```
> Refactored error handling in 3 files (not mentioned in intent)
> Added new dependency on lodash (not mentioned)
```

## Example

**Stated intent** (from PR description):
> Add rate limiting to the /api/users endpoint to prevent abuse

**DiffLoupe analysis**:

```
Intent Alignment: PARTIAL
  Core rate limiting implementation matches stated intent.
  > Added RateLimitMiddleware to /api/users route
  > Configured 100 requests per minute limit

  Unstated changes detected:
  > Also added rate limiting to /api/posts (not mentioned)
  > Refactored middleware loading order
  > Added redis dependency for rate limit storage
```

This tells you: the core intent was implemented, but there's scope creep to review.

## Best Practices

### Write Clear Intent

Vague intent leads to low-confidence alignment:
- Bad: "misc fixes"
- Good: "Fix null pointer exception when user.email is undefined"

### Include the "Why"

Help DiffLoupe understand your goals:
- Okay: "Add caching"
- Better: "Add Redis caching to reduce database load on /api/products"

### Review Unstated Changes

Unstated changes aren't necessarily wrong - they might be reasonable cleanup or necessary refactoring. But they deserve attention:
- Should these be in a separate PR?
- Were they intentional or AI-introduced?
- Do they need their own tests/documentation?

## Confidence Levels

Alignment analysis includes a confidence level:

| Level | Meaning |
|-------|---------|
| **high** | Clear stated intent, straightforward comparison |
| **medium** | Some inference required, context may be missing |
| **low** | Vague stated intent or complex diff makes comparison difficult |

Low confidence usually means your stated intent could be clearer.
