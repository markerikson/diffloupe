import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readOpenCodeUserConfig } from "./opencode-user.ts";

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "dl-ocuser-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function write(name: string, text: string, base = path.join(home, ".config")) {
  mkdirSync(path.join(base, "opencode"), { recursive: true });
  writeFileSync(path.join(base, "opencode", name), text);
}

describe("readOpenCodeUserConfig", () => {
  test("parses JSONC with comments and trailing commas", () => {
    write(
      "opencode.json",
      `{
        // default model
        "model": "openrouter/some-model", /* inline */
        "url": "http://example.com/a,}",
        "providers": { "custom": { "env": ["CUSTOM_KEY"], "models": { "m": {}, }, }, },
      }`,
    );
    const cfg = readOpenCodeUserConfig({}, home);
    expect(cfg.model).toBe("openrouter/some-model");
    expect(cfg.providers).toEqual({ custom: { env: ["CUSTOM_KEY"], models: { m: {} } } });
  });

  test("a missing file means none", () => {
    expect(readOpenCodeUserConfig({}, home)).toEqual({});
  });

  test("no model leaves model unset", () => {
    write("opencode.json", `{ "agents": {} }`);
    const cfg = readOpenCodeUserConfig({}, home);
    expect(cfg.model).toBeUndefined();
    expect(cfg.providers).toBeUndefined();
  });

  test("an unparseable file means none", () => {
    write("opencode.json", `{ "model": `);
    expect(readOpenCodeUserConfig({}, home).model).toBeUndefined();
  });

  test("prefers opencode.jsonc and honours XDG_CONFIG_HOME", () => {
    const xdg = path.join(home, "xdg");
    write("opencode.json", `{ "model": "a/json" }`, xdg);
    write("opencode.jsonc", `{ "model": "a/jsonc" }`, xdg);
    write("opencode.json", `{ "model": "a/home" }`);
    expect(readOpenCodeUserConfig({ XDG_CONFIG_HOME: xdg }, home).model).toBe("a/jsonc");
    expect(readOpenCodeUserConfig({}, home).model).toBe("a/home");
  });
});
