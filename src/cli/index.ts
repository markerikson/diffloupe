import { Command } from "commander";
import { VERSION } from "../version.ts";
import { createDoctorCommand } from "./doctor.ts";
import { createDiffCommand, createOpenCommand, createReviewCommand, createServeCommand } from "./review.ts";
import { createRunsCommand } from "./runs.ts";

/** Options are positional so `runs show --json` reaches `show` instead of `runs`, which also has `--json`. */
export function createProgram(): Command {
  return new Command()
    .name("diffloupe")
    .description("Grouped diffs and multi-agent code review for local changes and pull requests")
    .version(VERSION)
    .enablePositionalOptions()
    .addCommand(createReviewCommand())
    .addCommand(createDiffCommand())
    .addCommand(createOpenCommand())
    .addCommand(createServeCommand())
    .addCommand(createRunsCommand())
    .addCommand(createDoctorCommand());
}

export function run() {
  void createProgram().parseAsync();
}
