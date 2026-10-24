import { Command } from "commander";
import pc from "picocolors";
import { gatherReviewThreads, ghComments } from "../review/core/context.ts";
import { text } from "../review/core/lib/proc.ts";
import { repoSlug } from "../review/core/lib/target.ts";
import { formatGate, runGate } from "../review/gate.ts";
import { parseTargetSpec } from "../review/targets.ts";
import type { FindingSeverity } from "../types/review-run.ts";
import { parseSeverity } from "./review.ts";

interface GateCommandOptions {
  failOn: FindingSeverity;
  json?: boolean;
  status?: string | true;
  overrideLabel?: string;
  countAuthorResolved?: boolean;
}

/** Exit code when an open finding is at or above `--fail-on`, the same as `review --fail-on`. */
export const GATE_FAILED = 3;

function fail(message: string): never {
  console.error(pc.red(`Error: ${message}`));
  process.exit(2);
}

export function createGateCommand(): Command {
  return new Command("gate")
    .description(
      "Fail when a pull request still has open review findings at or above a severity (reads GitHub, runs no model)",
    )
    .argument("<target>", "#<pr>, pr:<n>, owner/repo#<n>, or a PR URL")
    .requiredOption("--fail-on <severity>", "blocker, should-fix, nice-to-have, or question", parseSeverity)
    .option("--json", "Print the result as JSON")
    .option(
      "--status [sha]",
      "Also write the result as the diffloupe/gate commit status on this commit (default: the PR head). Needs statuses: write",
    )
    .option("--override-label <name>", "Pass whatever is open when the pull request has this label")
    .option("--count-author-resolved", "Keep counting threads the pull request's author resolved")
    .action(async (target: string, options: GateCommandOptions) => {
      let spec;
      try {
        spec = parseTargetSpec(target);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
      if (spec.kind !== "pr") fail("gate needs a pull request target (#<n>, pr:<n>, or a PR URL)");
      const statusSha = options.status === true ? undefined : options.status;
      if (statusSha !== undefined && !/^[0-9a-f]{40}$/i.test(statusSha)) {
        fail("--status needs a full 40-character commit SHA, or no value for the PR head");
      }
      const slug = spec.repo ?? (await repoSlug(process.cwd()));
      if (slug.startsWith("local/")) fail("no GitHub repository: pass owner/repo#<n> or set GH_REPO");
      const gh = (args: string[]) => text("gh", args);
      try {
        const result = await runGate(
          slug,
          spec.pr,
          {
            failOn: options.failOn,
            ...(options.overrideLabel ? { overrideLabel: options.overrideLabel } : {}),
            ...(options.countAuthorResolved ? { countAuthorResolved: true } : {}),
            ...(options.status ? { status: statusSha ? { sha: statusSha } : {} } : {}),
          },
          {
            readThreads: (s, n) => gatherReviewThreads(s, n, { gh }),
            readComments: (s, n) => ghComments(`repos/${s}/issues/${n}/comments`, gh),
            gh,
          },
        );
        if (options.json) console.log(JSON.stringify(result, null, 2));
        else console.log(formatGate(result).join("\n"));
        process.exit(result.fails ? GATE_FAILED : 0);
      } catch (err) {
        console.error(pc.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });
}
