import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkModels, readProviderDefault, type CatalogModel } from "./model-catalog.ts";
import { resolveModels } from "./models.ts";

const catalog: CatalogModel[] = [
  {
    id: "claude-opus-5-5",
    providerID: "anthropic",
    variants: [{ id: "low" }, { id: "medium" }],
    cost: [{ input: 5, output: 25 }],
  },
  { id: "claude-sonnet-5-5", providerID: "anthropic", variants: [{ id: "medium" }], cost: [{ input: 1, output: 5 }] },
  { id: "claude-haiku-5-5", providerID: "anthropic", variants: [{ id: "medium" }], cost: [{ input: 0.1, output: 0.5 }] },
  { id: "free", providerID: "opencode", variants: [], cost: [{ input: 0, output: 0 }] },
];

describe("checkModels", () => {
  test("built-in defaults pass", () => {
    expect(checkModels(resolveModels({}), catalog)).toEqual({ errors: [], zeroCost: [] });
  });

  test("an unknown model from a listed provider fails", () => {
    const res = checkModels(resolveModels({ cli: { models: { review: "anthropic/claude-nope" } } }), catalog);
    expect(res.errors).toEqual([
      "Model `anthropic/claude-nope` is not available in OpenCode: provider `anthropic` has no model `claude-nope`. Set `models.review` in ~/.config/diffloupe/config.json or pass --model review=<provider/model>.",
    ]);
  });

  test("an unknown variant fails and lists the variants", () => {
    const res = checkModels(resolveModels({ cli: { effort: "max" } }), catalog);
    expect(res.errors[0]).toMatch(/no variant `max` \(variants: low, medium\)/);
  });

  test("a provider missing from the catalog is not checked", () => {
    expect(checkModels(resolveModels({ openCodeModel: "openai/gpt-x" }), catalog).errors).toEqual([]);
  });

  test("zero-priced models are reported", () => {
    expect(checkModels(resolveModels({ openCodeModel: "opencode/free" }), catalog).zeroCost).toEqual([
      "review",
      "coordinator",
      "walkthrough",
      "intent",
    ]);
  });
});

describe("provider defaults from native OpenCode", () => {
  let tmp: string;
  let record: string;
  let env: NodeJS.ProcessEnv;
  const capabilities = { tools: true, input: ["text"], output: ["text"] };

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "diffloupe-provider-model-"));
    record = path.join(tmp, "calls");
    const executable = path.join(tmp, "opencode");
    await writeFile(executable, `#!/bin/sh
printf '%s\\n' "$@" "$XDG_DATA_HOME" "$OPENCODE_DB" "$OPENAI_API_KEY" "$OPENCODE_DISABLE_PROJECT_CONFIG" "$OPENCODE_CONFIG" "$OPENCODE_CONFIG_DIR" "$OPENCODE_CONFIG_CONTENT" "$OPENCODE_CLI_CONFIG_CONTENT" > "$FAKE_CALL_RECORD"
printf '%s' "$FAKE_CATALOG"
exit "\${FAKE_EXIT_CODE:-0}"
`);
    await chmod(executable, 0o755);
    env = { PATH: `${tmp}:${process.env.PATH}`, FAKE_CALL_RECORD: record };
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("selects a review-capable subscription model from its isolated profile", async () => {
    const home = path.join(tmp, "subscription");
    const model = { providerID: "openai", id: "first-eligible", capabilities };
    env = {
      ...env,
      OPENAI_API_KEY: "synthetic-unrelated-api-key",
      OPENCODE_DB: "unrelated-database",
      FAKE_CATALOG: JSON.stringify({ data: [
        { ...model, providerID: "opencode", id: "free-global-default" },
        { ...model, id: "disabled", enabled: false },
        { ...model, id: "deprecated", status: "deprecated" },
        { ...model, id: "no-tools", capabilities: { ...capabilities, tools: false } },
        { ...model, id: "image-input", capabilities: { ...capabilities, input: ["image"] } },
        { ...model, id: "audio-output", capabilities: { ...capabilities, output: ["audio"] } },
        { providerID: "openai", id: "unknown-capabilities" },
        model,
        { ...model, id: "later-eligible" },
      ] }),
    };

    expect(await readProviderDefault("openai", { subscriptionHome: home, env })).toBe("openai/first-eligible");
    expect((await readFile(record, "utf8")).split("\n")).toEqual([
      "api", "model.list", "--standalone", path.join(home, "data"), "", "", "1", "", path.join(home, "config"), "", "", "",
    ]);
  });

  test("ordinary provider lookup keeps selected API credentials and ignores config overrides", async () => {
    env = {
      ...env,
      OPENAI_API_KEY: "synthetic-selected-api-key",
      OPENCODE_DB: "selected-credential-database",
      OPENCODE_DISABLE_PROJECT_CONFIG: "0",
      OPENCODE_CONFIG: "unrelated-config-file",
      OPENCODE_CONFIG_DIR: "unrelated-config-directory",
      OPENCODE_CONFIG_CONTENT: "unrelated-config-content",
      OPENCODE_CLI_CONFIG_CONTENT: "unrelated-cli-config-content",
      FAKE_CATALOG: JSON.stringify({ data: [{ providerID: "openai", id: "api-model", capabilities }] }),
    };
    expect(await readProviderDefault("openai", { env })).toBe("openai/api-model");
    expect((await readFile(record, "utf8")).split("\n")).toEqual([
      "api", "model.list", "--standalone", "", "selected-credential-database", "synthetic-selected-api-key", "1", "", "", "", "", "",
    ]);
  });

  test("an unrelated provider does not become the selected provider's default", async () => {
    env.FAKE_CATALOG = JSON.stringify({ data: [{ providerID: "opencode", id: "free-default", capabilities }] });
    expect(await readProviderDefault("openai", { env })).toBeUndefined();
  });

  test("malformed catalog metadata leaves model selection unresolved", async () => {
    env.FAKE_CATALOG = "synthetic-private-provider-data";
    expect(await readProviderDefault("openai", { env })).toBeUndefined();
  });

  test("native command failure does not accept partial catalog output", async () => {
    env.FAKE_CATALOG = JSON.stringify({ data: [{ providerID: "openai", id: "partial-model", capabilities }] });
    env.FAKE_EXIT_CODE = "1";
    expect(await readProviderDefault("openai", { env })).toBeUndefined();
  });
});
