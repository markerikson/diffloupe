import { describe, expect, test } from "bun:test";
import { needsSavedCredentials, planCredentials, type SavedCredential } from "./credentials.ts";
import type { ReviewModelStage } from "./options.ts";

const saved: SavedCredential[] = [
  { id: "cred_1", integrationID: "anthropic", label: "API key", active: true, value: { type: "key", key: "sk-ant" } },
  { id: "cred_2", integrationID: "openai", label: "ChatGPT", active: true, value: { type: "oauth", access: "x" } },
  { id: "cred_3", integrationID: "groq", label: "API key", active: true, value: { type: "key", key: "gsk" } },
];

function providers(entries: [string, ReviewModelStage[]][]) {
  return new Map(entries);
}

describe("planCredentials", () => {
  test("an environment variable covers the provider", () => {
    const plan = planCredentials({ providers: providers([["anthropic", ["review"]]]), env: { ANTHROPIC_API_KEY: "k" } });
    expect(plan.coverage[0]).toMatchObject({ source: "env", detail: "ANTHROPIC_API_KEY" });
    expect(plan.childEnv).toEqual({});
    expect(plan.imports).toEqual([]);
    expect(plan.errors).toEqual([]);
  });

  test("apiKeys become the provider's env var on the child", () => {
    const plan = planCredentials({
      providers: providers([["openai", ["review"]]]),
      env: {},
      apiKeys: { openai: "sk-o", anthropic: "unused" },
    });
    expect(plan.childEnv).toEqual({ OPENAI_API_KEY: "sk-o" });
    expect(plan.coverage[0]?.source).toBe("config");
  });

  test("Fireworks and NeuralWatt use their OpenCode provider ids", () => {
    const plan = planCredentials({
      providers: providers([
        ["fireworks-ai", ["review"]],
        ["neuralwatt", ["coordinator"]],
      ]),
      env: {},
      apiKeys: { "fireworks-ai": "fw", neuralwatt: "nw" },
    });
    expect(plan.childEnv).toEqual({ FIREWORKS_API_KEY: "fw", NEURALWATT_API_KEY: "nw" });
  });

  test("apiKeys for a provider with no known env var are imported", () => {
    const plan = planCredentials({ providers: providers([["acme", ["review"]]]), env: {}, apiKeys: { acme: "k" } });
    expect(plan.childEnv).toEqual({});
    expect(plan.imports).toEqual([
      { id: "cred_diffloupe_acme", integrationID: "acme", label: "API key", active: true, value: { type: "key", key: "k" } },
    ]);
  });

  test("a providers block env list names the variable", () => {
    const plan = planCredentials({
      providers: providers([["acme", ["review"]]]),
      env: {},
      apiKeys: { acme: "k" },
      userProviders: { acme: { env: ["ACME_KEY"] } },
    });
    expect(plan.childEnv).toEqual({ ACME_KEY: "k" });
  });

  test("saved API keys are imported only for providers in use", () => {
    const plan = planCredentials({ providers: providers([["anthropic", ["review", "coordinator"]]]), env: {}, saved });
    expect(plan.imports.map((c) => c.id)).toEqual(["cred_1"]);
    expect(plan.coverage[0]?.source).toBe("opencode");
  });

  test("OAuth logins are skipped with a warning and fail preflight", () => {
    const plan = planCredentials({ providers: providers([["openai", ["walkthrough"]]]), env: {}, saved });
    expect(plan.imports).toEqual([]);
    expect(plan.warnings.join("\n")).toMatch(/openai login that is not an API key/);
    expect(plan.errors).toEqual([
      "No credential for provider `openai` (used by models.walkthrough). Run `opencode auth login openai`, set OPENAI_API_KEY, or add apiKeys.openai to ~/.config/diffloupe/config.json.",
    ]);
  });

  test("a missing credential for a known provider names it", () => {
    const plan = planCredentials({ providers: providers([["openrouter", ["review", "coordinator"]]]), env: {}, saved: [] });
    expect(plan.errors[0]).toMatch(/provider `openrouter` \(used by models.review, models.coordinator\)/);
  });

  test("ambient providers and unknown providers do not fail", () => {
    const plan = planCredentials({
      providers: providers([
        ["amazon-bedrock", ["review"]],
        ["acme", ["walkthrough"]],
      ]),
      env: {},
    });
    expect(plan.errors).toEqual([]);
    expect(plan.coverage.map((c) => c.source)).toEqual(["ambient", "none"]);
    expect(plan.warnings[0]).toMatch(/acme/);
  });

  test("a providers block carrying its own apiKey covers the provider", () => {
    const plan = planCredentials({
      providers: providers([["openai", ["review"]]]),
      env: {},
      userProviders: { openai: { settings: { apiKey: "{env:WORK_OPENAI}" } } },
    });
    expect(plan.errors).toEqual([]);
    expect(plan.coverage[0]?.source).toBe("providers");
  });
});

describe("needsSavedCredentials", () => {
  test("false when env and apiKeys cover every provider", () => {
    expect(
      needsSavedCredentials({
        providers: providers([
          ["anthropic", ["review"]],
          ["openai", ["walkthrough"]],
          ["amazon-bedrock", ["coordinator"]],
        ]),
        env: { ANTHROPIC_API_KEY: "k" },
        apiKeys: { openai: "k" },
      }),
    ).toBe(false);
  });

  test("true when a provider is uncovered", () => {
    expect(needsSavedCredentials({ providers: providers([["anthropic", ["review"]]]), env: {} })).toBe(true);
  });
});
