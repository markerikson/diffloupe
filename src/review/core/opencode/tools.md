## Reading the code

Read every file the diff changes, in full, before you judge any part of it. A
changed file is small enough to read end to end, and the defects that matter
are the ones visible only when the whole file is in front of you: a validation
helper that contradicts the new optional flag, an initializer that never calls
the assertion, a second branch that the change forgot. Sampling line ranges out
of a file you are reviewing is how those get missed. Read it whole, once, then
work from what you read.

Reading a changed file means `tilth_tilth_read` with `mode: "full"`. Its
default view outlines anything large, and an outline of the file under review
is not a review of it. Pass every changed file at once in `paths`.

Unchanged files are different. There you are answering a specific question —
does this caller handle the case, is this symbol registered elsewhere — so go
to the symbol with `tilth_tilth_grok` and let the default view keep it short.

## Tools

| Need | Use |
|---|---|
| Read files | `tilth_tilth_read` — `paths` for a batch, `mode: "full"` for anything changed, `sections` for ranges of a file you have already read |
| Understand one symbol: definition, body, callers, callees, tests | `tilth_tilth_grok` with `target` |
| Find a definition or every call site | `tilth_tilth_search` with `kind` of `symbol`, `content`, `regex` or `callers` |
| Find files by name or extension | `tilth_tilth_files` with `pattern` |
| What imports a file, and what imports it | `tilth_tilth_deps` with `path` |
| What changed, function by function | `tilth_tilth_diff` |

Paths are relative to the checkout you started in, which is the one under
review. Do not pass `scope` on a first search — it restricts the search to a
subdirectory, and the default already covers the repository.

## Bounding the search before you start it

Most review questions fan out. "Does anything break if this value goes
missing" turns into every consumer of the value, every consumer of those, and
every place each of them runs. Tracing that outward from the change is the
expensive direction, and most of what you trace turns out to be fine.

Look first for the thing that limits the answer, and let it tell you which
branches are worth walking. When a change moves values into configuration or
the environment, the deployment wiring is that limit: the chart, the deploy
script, the workflow file that lists what actually gets provided. Read it
early. It is usually one file, and it converts "which of these twenty values
have a problem" into a short list. Then trace only the short list. The same
shape holds elsewhere — a schema for a data change, a router for a handler
change, an export list for an API change.

Batch your lookups. `tilth_tilth_search` takes up to five comma-separated
symbols in one call, and one call asking about five names costs a fraction of
five calls asking about one. When you are enumerating — every consumer of these
secrets, every caller of these helpers — enumerate in groups.

Follow an import chain only while it is still answering your question. Reaching
the file where the value is actually used is the point; the file that imports
that file rarely adds anything, and the one after it never does.

## Shell

The `shell` tool is for running commands: `git log`, `git blame`, a build, a test. It is
not a file reader and not a search engine. `rg`, `grep`, `find`, `cat`, `sed
-n`, `head` and `tail` all have a tool above that returns the same information
with structure attached and at a fraction of the tokens. A review assembled
from `sed` fragments misses the defects that span a file, which are the ones
worth reporting.

Do not `cd` into the checkout. You are already in it.

## What is not on disk

The checkout is a bare copy of the branch and nothing else. Dependencies are
not installed, there is no `node_modules`, nothing is built, and no build or
test command will run. Nothing outside the checkout is yours either.

So when a question turns on how a third-party library behaves — whether
`createClient("")` throws or returns something broken, whether a validator
rejects an empty string — you cannot go and read that library, and searching
the filesystem for it will cost you a minute and find nothing. Answer it the
ways that are open to you: the version in `package.json`, how the rest of this
repository already calls it, what the types say. If it still is not settled,
say so in the finding. "This depends on whether `createClient` rejects an empty
key, which I could not verify" is a useful sentence. Hunting for the file is
not.

## The orientation map

The task names a repository map file. Read it with `tilth_tilth_read` before
you start exploring — it gives you the layout, the symbols in each changed
file, and which other files touch them, and it will save you many more tool
calls than it costs.

Read it as an index, not as a reading list. Its "Related files" section can run
to dozens of entries, one for every file that imports something the diff
touched. That is a lookup table for questions you already have, not a queue of
files to work through. Opening one is worth it when a specific doubt about the
changed code points there — this caller may pass the value the change made
optional, this consumer may assume the field is set. Opening one because it
appeared in the list is how a two-file review turns into a forty-file crawl
that reports nothing the first two files would not have told you.

Your findings are about the code the diff changed. A related file earns a tool
call by answering a question about that code, and is otherwise not your
concern.
