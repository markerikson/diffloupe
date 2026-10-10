import path from "node:path";
import { describe, expect, test } from "bun:test";
import { loadFixture } from "../review/__fixtures__/load.ts";
import { runMarkdown } from "../review/export.ts";
import { createRunDir, writeRun } from "../review/run-store.ts";
import { useTempDataDir } from "../server/test-helpers.ts";

useTempDataDir();

const entry = path.join(import.meta.dir, "..", "index.ts");

async function cli(...args: string[]): Promise<string> {
  const proc = Bun.spawn(["bun", entry, ...args], { env: process.env, stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(code).toBe(0);
  return out;
}

describe("runs show --markdown", () => {
  test("prints the same markdown as Copy all", async () => {
    const run = loadFixture("large-pr").build();
    await createRunDir(run.id);
    await writeRun(run);
    expect(await cli("runs", "show", run.id, "--markdown")).toBe(runMarkdown(run));
    expect(await cli("runs", "show", run.id, "--markdown", "--over-cap")).toBe(
      runMarkdown(run, { includeOverCap: true }),
    );
  });
});
