import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SavedCredential } from "./credentials.ts";
import { resolveRunSetup, setupConfig, type RunSetupOptions } from "./setup.ts";
import { subscriptionHome } from "./subscription.ts";

const savedKey: SavedCredential = {
  id: "cred_saved_openai", integrationID: "openai", active: true,
  value: { type: "key", key: "synthetic-saved-api-key" },
};
const savedOAuth: SavedCredential = {
  id: "cred_personal_chatgpt", integrationID: "openai", active: true,
  value: { type: "oauth", access: "synthetic-access-token", refresh: "synthetic-refresh-token" },
};
const base: RunSetupOptions = {
  env: {},
  userConfig: { models: { review: "openai/subscription-model" } },
  openCodeUser: {},
  stages: ["review"],
  readSubscription: async () => ({}),
  exportCredentials: async () => [savedKey, savedOAuth],
  readCatalog: async () => undefined,
};

describe("subscription run setup", () => {
  test("an environment API key skips subscription lookup and saved credentials", async () => {
    const setup = await resolveRunSetup({
      ...base,
      env: { OPENAI_API_KEY: "synthetic-env-key" },
      readSubscription: async () => { throw new Error("must not inspect the profile"); },
      exportCredentials: async () => { throw new Error("must not export credentials"); },
    });
    expect(setup.credentials.coverage[0]?.source).toBe("env");
    expect(setup.credentials.subscriptionHome).toBeUndefined();
    expect(setup.credentials.errors).toEqual([]);
  });

  test("a configured API key skips subscription lookup and saved credentials", async () => {
    const setup = await resolveRunSetup({
      ...base,
      userConfig: { ...base.userConfig, apiKeys: { openai: "synthetic-config-key" } },
      readSubscription: async () => { throw new Error("must not inspect the profile"); },
      exportCredentials: async () => { throw new Error("must not export credentials"); },
    });
    expect(setup.credentials.coverage[0]?.source).toBe("config");
    expect(setupConfig(setup).childEnv).toEqual({ OPENAI_API_KEY: "synthetic-config-key" });
    expect(setupConfig(setup).subscriptionHome).toBe("");
  });

  test("passes the subscription profile to the runner without exporting or importing tokens", async () => {
    let exported = false;
    const setup = await resolveRunSetup({
      ...base,
      readSubscription: async () => ({ home: "/synthetic/subscription-profile" }),
      exportCredentials: async () => {
        exported = true;
        return [savedKey, savedOAuth];
      },
    });
    expect(exported).toBe(false);
    expect(setup.credentials.coverage[0]?.source).toBe("subscription");
    expect(setup.credentials.imports).toEqual([]);
    expect(setup.credentials.errors).toEqual([]);
    const config = setupConfig(setup);
    expect(config.subscriptionHome).toBe("/synthetic/subscription-profile");
    expect(config.authImport).toBe("");
    expect(config.childEnv).toEqual({});
    expect(JSON.stringify(config)).not.toContain("synthetic-access-token");
    expect(JSON.stringify(config)).not.toContain("synthetic-refresh-token");
  });

  test("an unavailable subscription profile fails without falling back to a saved API key", async () => {
    let exported = false;
    const setup = await resolveRunSetup({
      ...base,
      readSubscription: async () => ({ error: "Could not inspect the subscription profile" }),
      exportCredentials: async () => { exported = true; return [savedKey]; },
    });
    expect(exported).toBe(false);
    expect(setup.credentials.errors).toEqual(["Could not inspect the subscription profile"]);
    expect(setup.credentials.coverage[0]?.source).toBe("none");
    expect(setup.credentials.imports).toEqual([]);
  });

  test("subscription credentials cannot be sent through the ordinary OpenAI provider's custom endpoint", async () => {
    const providers = {
      openai: { settings: { baseURL: "https://proxy.example.invalid", apiKey: "synthetic-api-key" }, headers: { authorization: "synthetic" } },
      anthropic: { settings: { baseURL: "https://anthropic.example.invalid" } },
    };
    const setup = await resolveRunSetup({
      ...base, openCodeUser: { providers },
      readSubscription: async () => ({ home: "/synthetic/subscription-profile" }),
    });
    expect(setupConfig(setup).providers).toEqual({ anthropic: providers.anthropic });
    const api = await resolveRunSetup({ ...base, openCodeUser: { providers }, env: { OPENAI_API_KEY: "key" } });
    expect(setupConfig(api).providers).toEqual(providers);
  });

  test("the ordinary OpenAI catalog cannot reject a subscription model", async () => {
    const setup = await resolveRunSetup({
      ...base,
      readSubscription: async () => ({ home: "/synthetic/subscription-profile" }),
      readCatalog: async () => [{ providerID: "openai", id: "api-only-model" }],
    });
    expect(setup.catalog?.errors).toEqual([]);
    expect(setup.catalog?.zeroCost).toEqual(["review"]);
  });

  test("subscription catalog handling still validates other providers in a mixed review", async () => {
    const setup = await resolveRunSetup({
      ...base,
      env: { ANTHROPIC_API_KEY: "synthetic-anthropic-key" },
      userConfig: { models: { review: "openai/subscription-model", walkthrough: "anthropic/unavailable-model" } },
      stages: ["review", "walkthrough"],
      readSubscription: async () => ({ home: "/synthetic/subscription-profile" }),
      readCatalog: async () => [
        { providerID: "openai", id: "api-only-model" },
        { providerID: "anthropic", id: "available-model" },
      ],
    });
    expect(setup.catalog?.errors).toHaveLength(1);
    expect(setup.catalog?.errors[0]).toContain("anthropic/unavailable-model");
    expect(setup.catalog?.zeroCost).toEqual(["review"]);
  });

  test("absence of a subscription preserves the saved API key path", async () => {
    const setup = await resolveRunSetup(base);
    expect(setup.credentials.coverage[0]?.source).toBe("opencode");
    expect(setup.credentials.imports).toEqual([savedKey]);
    expect(setup.credentials.errors).toEqual([]);
    expect(setupConfig(setup).subscriptionHome).toBe("");
    expect(JSON.parse(setupConfig(setup).authImport!)).toEqual([savedKey]);
  });

  test("runs using only another provider do not inspect the subscription profile", async () => {
    const setup = await resolveRunSetup({
      ...base,
      env: { ANTHROPIC_API_KEY: "synthetic-anthropic-key" },
      userConfig: { models: { review: "anthropic/review-model" } },
      readSubscription: async () => { throw new Error("must not inspect the profile"); },
    });
    expect(setup.credentials.errors).toEqual([]);
    expect(setup.credentials.subscriptionHome).toBeUndefined();
  });
});

describe("subscription metadata inspection", () => {
  let tmp: string;
  let home: string;
  let record: string;
  let options: RunSetupOptions;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "diffloupe-setup-"));
    const bin = path.join(tmp, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "opencode"), `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_CALL_RECORD"
printf '%s\\n' "$XDG_DATA_HOME" "$OPENCODE_DB" "$OPENCODE_CONFIG" "$OPENAI_API_KEY" >> "$FAKE_CALL_RECORD"
printf '%s' "$FAKE_METADATA"
`);
    await chmod(path.join(bin, "opencode"), 0o755);
    record = path.join(tmp, "calls");
    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      XDG_DATA_HOME: path.join(tmp, "data"),
      OPENCODE_DB: "unrelated-database",
      OPENCODE_CONFIG: "unrelated-config",
      FAKE_CALL_RECORD: record,
      FAKE_METADATA: JSON.stringify([
        { id: "openai", connections: [{ type: "credential", method: "oauth", id: "subscription-login" }] },
      ]),
    };
    home = subscriptionHome(env);
    options = {
      env,
      userConfig: base.userConfig,
      openCodeUser: {},
      stages: ["review"],
      exportCredentials: async () => [savedKey],
      readCatalog: async () => undefined,
    };
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("uses only auth list metadata from an existing isolated subscription profile", async () => {
    await mkdir(home, { recursive: true });
    const setup = await resolveRunSetup(options);
    expect(setup.credentials.subscriptionHome).toBe(home);
    expect(setup.credentials.imports).toEqual([]);
    expect((await readFile(record, "utf8")).split("\n")).toEqual([
      "auth", "list", "--standalone", "--format", "json", path.join(home, "data"), "", "", "", "",
    ]);
  });

  test("does not create or inspect a subscription profile until one exists", async () => {
    const setup = await resolveRunSetup(options);
    expect(setup.credentials.imports).toEqual([savedKey]);
    expect(existsSync(record)).toBe(false);
    expect(existsSync(home)).toBe(false);
  });

  test("does not select an inactive OAuth connection behind an active API key", async () => {
    await mkdir(home, { recursive: true });
    const setup = await resolveRunSetup({
      ...options,
      env: {
        ...options.env,
        FAKE_METADATA: JSON.stringify([{ id: "openai", connections: [
          { type: "credential", method: "key", id: "active-api-key" },
          { type: "credential", method: "oauth", id: "inactive-subscription" },
        ] }]),
      },
    });
    expect(setup.credentials.subscriptionHome).toBeUndefined();
    expect(setup.credentials.imports).toEqual([savedKey]);
  });

  test("unreadable metadata fails closed instead of choosing a saved API key", async () => {
    await mkdir(home, { recursive: true });
    let exported = false;
    const setup = await resolveRunSetup({
      ...options,
      env: { ...options.env, FAKE_METADATA: "invalid metadata synthetic-secret" },
      exportCredentials: async () => { exported = true; return [savedKey]; },
    });
    expect(exported).toBe(false);
    expect(setup.credentials.imports).toEqual([]);
    expect(setup.credentials.errors).toHaveLength(1);
    expect(setup.credentials.errors[0]).toContain("diffloupe auth status");
    expect(setup.credentials.errors[0]).not.toContain("synthetic-secret");
  });
});
