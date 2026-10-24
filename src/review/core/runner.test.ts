import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyConfig, resetRunState, setRunState } from "./config.ts";
import { agent, answerFromText, lastReplyText, parseAgentJson, resetOpenCodeConfig } from "./runner.ts";

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

  test("reports the original parse error when a repair does not help", () => {
    const text = '{"a": "x\ty", "b": }';
    let original = "";
    try {
      JSON.parse(text);
    } catch (error) {
      original = (error as Error).message;
    }
    expect(() => parseAgentJson(text)).toThrow(original);
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
if [ -n "$FAKE_REPLY" ]; then
  printf '%s\\n' "$FAKE_REPLY"
  exit 0
fi
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

  test("reads the answer from the final reply when no output file is written", async () => {
    const text = 'Here is the draft:\n```json\n{"title": "T", "goal": "G"}\n```';
    process.env.FAKE_REPLY = JSON.stringify({ type: "text", part: { type: "text", text } });
    const outFile = path.join(tmp, "out-3.json");
    try {
      const res = await agent("prompt", { budget: 1, outFile, tag: "run-3-intent", answerKeys: ["title", "goal"] });
      expect(res.payload).toEqual({ title: "T", goal: "G" });
      expect(res.failure).toBeUndefined();
      expect(res.deliveredAs).toBe("text");
      expect(JSON.parse(await readFile(outFile, "utf8"))).toEqual({ title: "T", goal: "G" });
    } finally {
      delete process.env.FAKE_REPLY;
    }
  });

  test("still reports no output when the reply holds no answer", async () => {
    process.env.FAKE_REPLY = JSON.stringify({ type: "text", part: { type: "text", text: "I ran out of steps." } });
    try {
      const res = await agent("prompt", { budget: 1, outFile: path.join(tmp, "out-4.json"), tag: "run-4-s00", answerKeys: ["findings"] });
      expect(res.payload).toBeNull();
      expect(res.failure?.kind).toBe("no-output");
      expect(res.deliveredAs).toBeUndefined();
    } finally {
      delete process.env.FAKE_REPLY;
    }
  });
});

describe("answerFromText", () => {
  test("takes the last fenced block that has an answer key", () => {
    const text = 'First try:\n```json\n{"findings": [1]}\n```\nCorrected:\n```json\n{"findings": [2]}\n```';
    expect(answerFromText(text, ["findings"])).toEqual({ findings: [2] });
  });

  test("falls back to the outermost braces when there is no fence", () => {
    expect(answerFromText('Result: {"keep": [], "resolved": []} done', ["keep"])).toEqual({ keep: [], resolved: [] });
  });

  test("ignores JSON without any answer key", () => {
    expect(answerFromText('See `package.json`:\n```json\n{"type": "module"}\n```', ["findings"])).toBeUndefined();
  });

  test("repairs raw newlines the way the output file parse does", () => {
    expect(answerFromText('```\n{"title": "a\nb", "goal": "g"}\n```', ["title"])).toEqual({ title: "a\nb", goal: "g" });
  });
});

describe("lastReplyText", () => {
  test("returns the last non-empty text part", () => {
    const stream = [
      JSON.stringify({ type: "step_start", part: { type: "step-start" } }),
      JSON.stringify({ type: "text", part: { type: "text", text: "first" } }),
      JSON.stringify({ type: "text", part: { type: "text", text: "  " } }),
      JSON.stringify({ type: "text", part: { type: "text", text: "second" } }),
    ].join("\n");
    expect(lastReplyText(stream)).toBe("second");
  });
});
