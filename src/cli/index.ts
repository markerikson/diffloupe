import { Command } from "commander";
import { VERSION } from "../version.ts";
import { createDoctorCommand } from "./doctor.ts";
import { createDiffCommand, createOpenCommand, createReviewCommand, createServeCommand } from "./review.ts";
import { createRunsCommand } from "./runs.ts";

const program = new Command();

program
  .name("diffloupe")
  .description("Grouped diffs and multi-agent code review for local changes and pull requests")
  .version(VERSION);

program.addCommand(createReviewCommand());
program.addCommand(createDiffCommand());
program.addCommand(createOpenCommand());
program.addCommand(createServeCommand());
program.addCommand(createRunsCommand());
program.addCommand(createDoctorCommand());

export function run() {
  void program.parseAsync();
}
