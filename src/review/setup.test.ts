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

describe("defaults from configured providers", () => {
  const defaults: RunSetupOptions = {
    env: {},
    userConfig: {},
    openCodeUser: {},
    readSubscription: async () => ({}),
    exportCredentials: async () => [],
    readCatalog: async () => undefined,
    readProviderDefault: async (provider) => `${provider}/available-model`,
  };

  test("an otherwise unconfigured review uses the only ChatGPT subscription for every stage", async () => {
    const lookups: { provider: string; home: string | undefined }[] = [];
    const setup = await resolveRunSetup({
      ...defaults,
      readSubscription: async () => ({ home: "/synthetic/subscription-profile" }),
      readProviderDefault: async (provider, options) => {
        lookups.push({ provider, home: options?.subscriptionHome });
        return "openai/account-model";
      },
    });
    expect(setup.provider).toBe("openai");
    for (const model of Object.values(setup.models)) {
      expect(model).toMatchObject({ model: "openai/account-model", provider: "openai", source: "available" });
      expect(model.variant).toBeUndefined();
    }
    expect(lookups).toEqual([{ provider: "openai", home: "/synthetic/subscription-profile" }]);
    expect(setup.credentials.errors).toEqual([]);
    expect(setup.credentials.coverage).toMatchObject([{ provider: "openai", source: "subscription" }]);
    expect(setup.credentials.imports).toEqual([]);
  });

  test("a sole saved API key supplies the provider and credential", async () => {
    const setup = await resolveRunSetup({ ...defaults, exportCredentials: async () => [savedKey] });
    expect(setup.provider).toBe("openai");
    expect(setup.models.review).toMatchObject({ model: "openai/available-model", source: "available" });
    expect(setup.credentials.imports).toEqual([savedKey]);
    expect(setup.credentials.errors).toEqual([]);
  });

  test.each([
    { label: "environment", options: { env: { OPENAI_API_KEY: "synthetic-key" } }, source: "env" },
    { label: "DiffLoupe config", options: { userConfig: { apiKeys: { openai: "synthetic-key" } } }, source: "config" },
    {
      label: "OpenCode provider settings",
      options: { openCodeUser: { providers: { openai: { settings: { apiKey: "synthetic-key" } } } } },
      source: "providers",
    },
  ])("a sole key in $label supplies the default provider", async ({ options, source }) => {
    const setup = await resolveRunSetup({ ...defaults, ...options });
    expect(setup.models.review).toMatchObject({ model: "openai/available-model", source: "available" });
    expect(setup.credentials.coverage).toMatchObject([{ provider: "openai", source }]);
    expect(setup.credentials.errors).toEqual([]);
  });

  test("an OpenAI API key still takes precedence over a subscription during default selection", async () => {
    let selectedSubscription: string | undefined;
    const setup = await resolveRunSetup({
      ...defaults,
      env: { OPENAI_API_KEY: "synthetic-key" },
      readSubscription: async () => ({ home: "/synthetic/subscription-profile" }),
      readProviderDefault: async (_provider, options) => {
        selectedSubscription = options?.subscriptionHome;
        return "openai/api-model";
      },
    });
    expect(setup.models.review.model).toBe("openai/api-model");
    expect(selectedSubscription).toBeUndefined();
    expect(setup.credentials.subscriptionHome).toBeUndefined();
    expect(setup.credentials.coverage[0]?.source).toBe("env");
  });

  test("Anthropic remains the default when it is configured alongside another provider", async () => {
    const setup = await resolveRunSetup({
      ...defaults,
      env: { ANTHROPIC_API_KEY: "synthetic-anthropic-key" },
      readSubscription: async () => ({ home: "/synthetic/subscription-profile" }),
      readProviderDefault: async () => { throw new Error("must keep the Anthropic defaults"); },
    });
    expect(setup.models.review).toMatchObject({ model: "anthropic/claude-opus-5-5#medium", source: "default" });
    expect(setup.credentials.errors).toEqual([]);
  });

  test("multiple non-Anthropic providers require an explicit choice", async () => {
    const pending = resolveRunSetup({
      ...defaults,
      userConfig: { apiKeys: { openai: "synthetic-openai-key", google: "synthetic-google-key" } },
    });
    await expect(pending).rejects.toThrow(/openai/);
    await expect(pending).rejects.toThrow(/google/);
    await expect(pending).rejects.toThrow(/provider|models\./);
  });

  test("setting a provider selects its available model when several providers are configured", async () => {
    const setup = await resolveRunSetup({
      ...defaults,
      userConfig: { provider: "openai" },
      env: { ANTHROPIC_API_KEY: "synthetic-anthropic-key" },
      readSubscription: async () => ({ home: "/synthetic/subscription-profile" }),
    });
    expect(setup.provider).toBe("openai");
    expect(setup.models.review).toMatchObject({ model: "openai/available-model", source: "available" });
    expect(setup.models.intent.model).toBe("openai/available-model");
    expect(setup.credentials.coverage).toMatchObject([{ provider: "openai", source: "subscription" }]);
    expect(setup.credentials.errors).toEqual([]);
  });

  test.each([
    { label: "environment", options: { env: { REVIEW_PROVIDER: "anthropic" } } },
    { label: "settings", options: { settings: { provider: "anthropic" } } },
    { label: "user config", options: { userConfig: { provider: "anthropic" } } },
  ])("an explicit Anthropic provider from $label is never silently switched", async ({ options }) => {
    const setup = await resolveRunSetup({
      ...defaults,
      ...options,
      readSubscription: async () => ({ home: "/synthetic/subscription-profile" }),
      readProviderDefault: async () => { throw new Error("must honor the explicit provider"); },
    });
    expect(setup.provider).toBe("anthropic");
    expect(setup.models.review.provider).toBe("anthropic");
    expect(setup.credentials.errors.join("\n")).toContain("anthropic");
  });

  test("explicit stage models preserve their precedence without provider discovery", async () => {
    const setup = await resolveRunSetup({
      ...defaults,
      env: { REVIEW_MODEL: "openai/explicit-review" },
      cli: { models: { coordinator: "openai/explicit-coordinator" } },
      settings: { models: { walkthrough: "openai/explicit-walkthrough" } },
      userConfig: { models: { intent: "openai/explicit-intent" } },
      readSubscription: async () => ({ home: "/synthetic/subscription-profile" }),
      readProviderDefault: async () => { throw new Error("every stage already has a model"); },
    });
    expect(setup.models.review).toMatchObject({ model: "openai/explicit-review", source: "env" });
    // REVIEW_MODEL also controls the coordinator, ahead of the CLI setting.
    expect(setup.models.coordinator).toMatchObject({ model: "openai/explicit-review", source: "env" });
    expect(setup.models.walkthrough).toMatchObject({ model: "openai/explicit-walkthrough", source: "settings" });
    expect(setup.models.intent).toMatchObject({ model: "openai/explicit-intent", source: "config" });
    expect(setup.credentials.errors).toEqual([]);
  });

  test("only unset stages inherit an available model", async () => {
    const setup = await resolveRunSetup({
      ...defaults,
      cli: { models: { review: "openai/explicit-review#high" } },
      userConfig: { models: { intent: "openai/explicit-intent" } },
      readSubscription: async () => ({ home: "/synthetic/subscription-profile" }),
    });
    expect(setup.models.review).toMatchObject({ model: "openai/explicit-review#high", source: "cli" });
    expect(setup.models.coordinator).toMatchObject({ model: "openai/available-model", source: "available" });
    expect(setup.models.walkthrough).toMatchObject({ model: "openai/available-model", source: "available" });
    expect(setup.models.intent).toMatchObject({ model: "openai/explicit-intent", source: "config" });
    expect(setup.credentials.errors).toEqual([]);
  });

  test("a global Anthropic model remains explicit, including its intent fallback", async () => {
    const setup = await resolveRunSetup({
      ...defaults,
      openCodeUser: { model: "anthropic/explicit-global-model" },
      readSubscription: async () => { throw new Error("the global model already chooses the provider"); },
      readProviderDefault: async () => { throw new Error("must keep the global default"); },
    });
    expect(setup.models.review).toMatchObject({ model: "anthropic/explicit-global-model", source: "opencode" });
    expect(setup.models.intent.model).toBe("anthropic/claude-haiku-5-5#medium");
    expect(setup.credentials.errors.join("\n")).toContain("anthropic");
  });

  test("opting out of the global default still allows discovery of the sole provider", async () => {
    const setup = await resolveRunSetup({
      ...defaults,
      userConfig: { opencode: { useDefaultModel: false } },
      openCodeUser: { model: "anthropic/ignored-global-model" },
      readSubscription: async () => ({ home: "/synthetic/subscription-profile" }),
    });
    expect(setup.models.review).toMatchObject({ model: "openai/available-model", source: "available" });
    expect(setup.credentials.errors).toEqual([]);
  });

  test("a configured provider without an available model gets an actionable error", async () => {
    const pending = resolveRunSetup({
      ...defaults,
      exportCredentials: async () => [savedKey],
      readProviderDefault: async () => undefined,
    });
    await expect(pending).rejects.toThrow(/openai/);
    await expect(pending).rejects.toThrow(/models\.|--model/);
  });

  test("an unreadable subscription profile cannot fall back to a paid saved key", async () => {
    let error = "";
    try {
      const setup = await resolveRunSetup({
        ...defaults,
        readSubscription: async () => ({ error: "Could not check the ChatGPT subscription profile; run diffloupe auth status." }),
        exportCredentials: async () => [savedKey],
        readProviderDefault: async () => { throw new Error("must not select a paid fallback"); },
      });
      error = setup.credentials.errors.join("\n");
      expect(setup.credentials.imports).toEqual([]);
    } catch (cause) {
      error = String(cause);
    }
    expect(error).toContain("diffloupe auth status");
  });

  test("unused stages do not trigger provider discovery", async () => {
    const setup = await resolveRunSetup({
      ...defaults,
      env: { OPENAI_API_KEY: "synthetic-key" },
      userConfig: { models: { walkthrough: "openai/explicit-walkthrough" } },
      stages: ["walkthrough"],
      readSubscription: async () => { throw new Error("must not inspect an unused profile"); },
      exportCredentials: async () => { throw new Error("must not inspect unused credentials"); },
      readProviderDefault: async () => { throw new Error("must not choose models for unused stages"); },
    });
    expect(setup.models.walkthrough).toMatchObject({ model: "openai/explicit-walkthrough", source: "config" });
    expect(setup.credentials.coverage).toMatchObject([{ provider: "openai", stages: ["walkthrough"], source: "env" }]);
    expect(setup.credentials.errors).toEqual([]);
  });

  test("an ordinary OAuth login that cannot be copied does not count as an available provider", async () => {
    const setup = await resolveRunSetup({
      ...defaults,
      exportCredentials: async () => [savedOAuth],
      readProviderDefault: async () => { throw new Error("an unusable login cannot choose a model"); },
    });
    expect(setup.models.review.provider).toBe("anthropic");
    expect(setup.credentials.errors.join("\n")).toContain("anthropic");
  });
});
