import { describe, expect, test } from "bun:test";
import { parseModelName, providersInUse, resolveModels } from "./models.ts";

describe("resolveModels lookup order", () => {
  test("built-in defaults with #medium when nothing is set", () => {
    const m = resolveModels({});
    expect(m.review).toMatchObject({ model: "anthropic/claude-opus-5-5#medium", source: "default" });
    expect(m.coordinator).toMatchObject({ model: "anthropic/claude-opus-5-5#medium", source: "default" });
    expect(m.walkthrough).toMatchObject({ model: "anthropic/claude-sonnet-5-5#medium", source: "default" });
  });

  test("each source wins over the next", () => {
    const all = {
      env: { REVIEW_MODEL: "p/env" },
      cli: { models: { review: "p/cli" } },
      settings: { models: { review: "p/settings" } },
      config: { models: { review: "p/config" } },
      openCodeModel: "p/opencode",
    };
    expect(resolveModels(all).review).toMatchObject({ model: "p/env", source: "env" });
    expect(resolveModels({ ...all, env: {} }).review).toMatchObject({ model: "p/cli", source: "cli" });
    expect(resolveModels({ ...all, env: {}, cli: {} }).review).toMatchObject({ model: "p/settings", source: "settings" });
    expect(resolveModels({ ...all, env: {}, cli: {}, settings: {} }).review).toMatchObject({
      model: "p/config",
      source: "config",
    });
    expect(resolveModels({ openCodeModel: "p/opencode" }).review).toMatchObject({ model: "p/opencode", source: "opencode" });
  });

  test("the OpenCode default fills only stages DiffLoupe has no model for", () => {
    const m = resolveModels({ config: { models: { walkthrough: "openai/gpt-x" } }, openCodeModel: "openrouter/some" });
    expect(m.review.source).toBe("opencode");
    expect(m.coordinator.source).toBe("opencode");
    expect(m.walkthrough).toMatchObject({ model: "openai/gpt-x", source: "config" });
  });

  test("useDefaultModel: false skips the OpenCode default", () => {
    const m = resolveModels({ config: { opencode: { useDefaultModel: false } }, openCodeModel: "openrouter/some" });
    expect(m.review.source).toBe("default");
  });

  test("REVIEW_MODEL also moves the coordinator unless REVIEW_MODEL_MERGE is set", () => {
    expect(resolveModels({ env: { REVIEW_MODEL: "a/b" } }).coordinator.model).toBe("a/b");
    expect(resolveModels({ env: { REVIEW_MODEL: "a/b", REVIEW_MODEL_MERGE: "a/c" } }).coordinator.model).toBe("a/c");
  });

  test("bare names take the provider from env, settings, config, then anthropic", () => {
    expect(resolveModels({ cli: { models: { review: "gpt-x" } } }).review.model).toBe("anthropic/gpt-x");
    expect(resolveModels({ config: { provider: "openai", models: { review: "gpt-x" } } }).review.model).toBe("openai/gpt-x");
    expect(
      resolveModels({ settings: { provider: "openrouter" }, config: { provider: "openai", models: { review: "x" } } })
        .review.model,
    ).toBe("openrouter/x");
    expect(resolveModels({ env: { REVIEW_PROVIDER: "groq" }, cli: { models: { review: "x" } } }).review.model).toBe("groq/x");
  });

  test("built-in defaults keep their anthropic prefix under another provider", () => {
    expect(resolveModels({ config: { provider: "openai" } }).review.model).toBe("anthropic/claude-opus-5-5#medium");
  });
});

describe("effort rule", () => {
  test("OpenCode-default and user models get no variant", () => {
    expect(resolveModels({ openCodeModel: "anthropic/claude-sonnet-5-5" }).review.model).toBe("anthropic/claude-sonnet-5-5");
    expect(resolveModels({ cli: { models: { review: "openai/gpt-x" } } }).review.model).toBe("openai/gpt-x");
  });

  test("user effort applies to every stage, whatever the model's source", () => {
    const m = resolveModels({ config: { effort: "high" }, openCodeModel: "openai/gpt-x" });
    expect(m.review.model).toBe("openai/gpt-x#high");
    expect(m.walkthrough.model).toBe("openai/gpt-x#high");
    expect(resolveModels({ cli: { effort: "low" } }).review.model).toBe("anthropic/claude-opus-5-5#low");
  });

  test("effort precedence: env, cli, settings, config", () => {
    const m = resolveModels({ cli: { effort: "low" }, settings: { effort: "high" }, config: { effort: "max" } });
    expect(m.review.variant).toBe("low");
    expect(resolveModels({ settings: { effort: "high" }, config: { effort: "max" } }).review.variant).toBe("high");
    expect(resolveModels({ env: { REVIEW_EFFORT: "xhigh" }, cli: { effort: "low" } }).review.variant).toBe("xhigh");
  });

  test("REVIEW_EFFORT_AUX applies to the coordinator and walkthrough only", () => {
    const m = resolveModels({ env: { REVIEW_EFFORT: "high", REVIEW_EFFORT_AUX: "low" } });
    expect(m.review.variant).toBe("high");
    expect(m.coordinator.variant).toBe("low");
    expect(m.walkthrough.variant).toBe("low");
  });

  test("an explicit #variant wins over effort", () => {
    const m = resolveModels({ cli: { models: { review: "openai/gpt-x#max" }, effort: "low" } });
    expect(m.review).toMatchObject({ model: "openai/gpt-x#max", variant: "max", id: "gpt-x", provider: "openai" });
  });
});

describe("parseModelName", () => {
  test("splits provider, id and variant", () => {
    expect(parseModelName("openrouter/meta/llama#high", "anthropic")).toEqual({
      provider: "openrouter",
      id: "meta/llama",
      variant: "high",
    });
    expect(parseModelName("claude", "anthropic")).toEqual({ provider: "anthropic", id: "claude" });
  });
});

test("providersInUse groups stages by provider", () => {
  const m = resolveModels({ cli: { models: { walkthrough: "openai/gpt-x" } } });
  expect([...providersInUse(m)]).toEqual([
    ["anthropic", ["review", "coordinator"]],
    ["openai", ["walkthrough", "intent"]],
  ]);
});

describe("intent stage", () => {
  test("defaults to Haiku and skips the OpenCode default model", () => {
    expect(resolveModels({}).intent).toMatchObject({ model: "anthropic/claude-haiku-5-5#medium", source: "default" });
    expect(resolveModels({ openCodeModel: "anthropic/claude-sonnet-5-5" }).intent).toMatchObject({
      model: "anthropic/claude-haiku-5-5#medium",
      source: "default",
    });
  });

  test("follows the walkthrough model when the walkthrough is not on Anthropic", () => {
    expect(resolveModels({ openCodeModel: "openai/gpt-x" }).intent).toMatchObject({
      model: "openai/gpt-x",
      source: "opencode",
    });
    expect(resolveModels({ cli: { models: { walkthrough: "openai/gpt-x" } } }).intent.model).toBe("openai/gpt-x");
  });

  test("an explicit intent model wins, from env, cli, settings or config", () => {
    expect(resolveModels({ env: { REVIEW_MODEL_INTENT: "openai/mini" } }).intent).toMatchObject({
      model: "openai/mini",
      source: "env",
    });
    expect(
      resolveModels({ cli: { models: { walkthrough: "openai/gpt-x", intent: "openai/mini" } } }).intent.model,
    ).toBe("openai/mini");
    expect(resolveModels({ config: { models: { intent: "claude-haiku-4-5" } } }).intent.model).toBe(
      "anthropic/claude-haiku-4-5",
    );
  });

  test("effort follows REVIEW_EFFORT_AUX", () => {
    expect(resolveModels({ env: { REVIEW_EFFORT: "high", REVIEW_EFFORT_AUX: "low" } }).intent.variant).toBe("low");
  });
});
