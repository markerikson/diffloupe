import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyConfig, resetRunState, setRunState } from "./config.ts";
import { agent, parseAgentJson, resetOpenCodeConfig } from "./runner.ts";

describe("parseAgentJson", () => {
  test("escapes raw tabs and newlines inside string values", () => {
    const text = '{\n  "findings": [{ "suggested_code": "\t\tconst a = 1;\n\t\treturn a;", "title": "x \\"q\\"" }]\n}';
    expect(parseAgentJson(text)).toEqual({
      findings: [{ suggested_code: "\t\tconst a = 1;\n\t\treturn a;", title: 'x "q"' }],
    });
  });

  test("escapes unescaped double quotes inside prose", () => {
    const text = '{\n  "findings": [\n    { "evidence": "so "generated code" is fine", "line": 3 }\n  ]\n}';
    expect(parseAgentJson(text)).toEqual({ findings: [{ evidence: 'so "generated code" is fine', line: 3 }] });
  });

  test("still rejects JSON that is broken in other ways", () => {
    expect(() => parseAgentJson('{"findings": [')).toThrow();
  });
});

let tmp: string;
const savedPath = process.env.PATH;

// Stands in for `opencode`: records the private data directory it was given,
// fails `auth import` when FAKE_IMPORT_FAIL is set, and writes an empty answer.
const FAKE = `#!/bin/sh
if [ "$1" = "auth" ]; then
  cat > /dev/null
  [ -n "$FAKE_IMPORT_FAIL" ] && { echo "import broke" >&2; exit 1; }
  touch "$XDG_DATA_HOME/opencode.db"
  exit 0
fi
cat > /dev/null
mkdir -p "$XDG_DATA_HOME" "$XDG_STATE_HOME"
echo "$XDG_DATA_HOME" > "$FAKE_RECORD"
echo "$XDG_STATE_HOME" >> "$FAKE_RECORD"
echo '{}' > "$REVIEW_GOVERNOR_OUT_FILE"
`;

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "diffloupe-runner-"));
  const bin = path.join(tmp, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "opencode"), FAKE);
  await chmod(path.join(bin, "opencode"), 0o755);
  process.env.PATH = `${bin}:${savedPath}`;
  process.env.FAKE_RECORD = path.join(tmp, "record");
  await mkdir(path.join(tmp, "artifacts", "logs"), { recursive: true });
  await mkdir(path.join(tmp, "artifacts", "raw"), { recursive: true });
  applyConfig({ out: path.join(tmp, "out"), artifacts: path.join(tmp, "artifacts"), authImport: "[]" });
  setRunState({ subject: tmp });
});

afterAll(async () => {
  process.env.PATH = savedPath;
  delete process.env.FAKE_RECORD;
  delete process.env.FAKE_IMPORT_FAIL;
  applyConfig({ authImport: "" });
  resetRunState();
  resetOpenCodeConfig();
  await rm(tmp, { recursive: true, force: true });
});

describe("agent", () => {
  test("removes the call's data and state directories after OpenCode exits", async () => {
    const res = await agent("prompt", { budget: 1, outFile: path.join(tmp, "out-1.json"), tag: "run-1-s00" });
    expect(res.payload).toEqual({});
    const [data, state] = (await readFile(process.env.FAKE_RECORD!, "utf8")).trim().split("\n");
    expect(data).toContain("run-1-s00");
    expect(existsSync(data!)).toBe(false);
    expect(existsSync(state!)).toBe(false);
  });

  test("removes the data directory when the credential import fails", async () => {
    process.env.FAKE_IMPORT_FAIL = "1";
    try {
      await expect(
        agent("prompt", { budget: 1, outFile: path.join(tmp, "out-2.json"), tag: "run-2-s00" }),
      ).rejects.toThrow("opencode auth import failed");
    } finally {
      delete process.env.FAKE_IMPORT_FAIL;
    }
    expect(existsSync(path.join(tmp, "out", "oc", "shared", "data", "run-2-s00"))).toBe(false);
  });
});
