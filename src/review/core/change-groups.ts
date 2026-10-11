/**
 * The deterministic half of grouping, shared by reviews and diff runs: the
 * diffs of the code files, their token sizes, the per-file facts, the links
 * between files, and the computed groups. No model call happens here.
 */
import { GENERIC_IDENTS } from "./build-map.ts";
import { CHARS_PER_TOKEN, MAX_SLICES, MAX_SLICE_TOKENS } from "./config.ts";
import { gitText } from "./context.ts";
import { gatherChangeFacts } from "./lib/change-facts.ts";
import { groupFiles, linkFiles, type CodeGrouping, type FileFacts, type Link } from "./lib/grouping.ts";
import { compactDeletedFiles, diffSizes } from "./lib/hunks.ts";
import type { ProjectFiles } from "./lib/module-resolver.ts";

export interface ChangeGroups {
  /** `git diff` of the code files, deleted files compacted. */
  wholeDiff: string;
  diffstat: string;
  /** `git diff --unified=0` of the code files. */
  diffU0: string;
  fileTokens: Map<string, number>;
  facts: FileFacts[];
  links: Link[];
  grouping: CodeGrouping;
}

export async function groupChanges(o: {
  base: string;
  head: string;
  /** The code files to group. Must not be empty: an empty pathspec means every file. */
  files: string[];
  /** The head version of the repo, given the files that will be read. */
  source: (preload: string[]) => ProjectFiles | Promise<ProjectFiles>;
}): Promise<ChangeGroups> {
  const range = `${o.base}..${o.head}`;
  const wholeDiff = compactDeletedFiles(await gitText(["diff", range, "--", ...o.files]), o.base);
  const diffstat = await gitText(["diff", "--stat", range]);
  // One parse of the diff already in hand, rather than a `git diff` per file:
  // it is exact, it is one subprocess instead of one per changed file, and
  // tokens are the currency everything downstream is budgeted in.
  const fileTokens = new Map([...diffSizes(wholeDiff)].map(([f, b]) => [f, Math.ceil(b / CHARS_PER_TOKEN)]));
  const diffU0 = await gitText(["diff", "--unified=0", range, "--", ...o.files]);
  const facts = await gatherChangeFacts({ source: await o.source(o.files), diffU0, files: o.files, fileTokens });
  const links = linkFiles(facts, GENERIC_IDENTS);
  const grouping = groupFiles(facts, links, { budget: MAX_SLICE_TOKENS, maxGroups: MAX_SLICES });
  return { wholeDiff, diffstat, diffU0, fileTokens, facts, links, grouping };
}
