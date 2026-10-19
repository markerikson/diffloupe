import { describe, expect, test } from "bun:test";
import { checkModels, type CatalogModel } from "./model-catalog.ts";
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
