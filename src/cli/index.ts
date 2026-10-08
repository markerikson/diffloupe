import { Command } from "commander";
import pc from "picocolors";
import { createReviewCommand } from "./review.js";

const program = new Command();

program
  .name("diffloupe")
  .description("Multi-agent code review for local changes and pull requests")
  .version("0.1.0");

program.addCommand(createReviewCommand());

program
  .command("serve")
  .description("Start the HTTP API server for the web UI")
  .option("-p, --port <port>", "Port to listen on", "3000")
  .action(async (options: { port: string }) => {
    const port = parseInt(options.port, 10);

    if (isNaN(port) || port < 1 || port > 65535) {
      console.error(pc.red(`Error: Invalid port number: ${options.port}`));
      process.exit(1);
    }

    try {
      const { startServer } = await import("../server/index.js");
      const result = startServer(port);

      console.log(pc.green(`DiffLoupe server running on http://localhost:${result.port}`));
      console.log(pc.dim("Endpoints:"));
      console.log(pc.dim("  GET  /api/health        - Health check"));
      console.log("");
      console.log(pc.dim("Press Ctrl+C to stop"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(pc.red(`Error starting server: ${message}`));
      process.exit(1);
    }
  });

export function run() {
  program.parse();
}
