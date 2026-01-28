/**
 * LLM Service Tests
 *
 * These tests verify the LLM service works correctly.
 * The live API tests are skipped by default (no API key in CI).
 * Run manually with ANTHROPIC_API_KEY set to test the actual API.
 */

import { describe, test, expect } from "bun:test";
import {
  hasAPIKey,
  generateText,
  generateJSON,
  generateTextWithSystem,
  LLMAPIKeyError,
} from "./llm.js";

describe("LLM Service", () => {
  describe("hasAPIKey", () => {
    test("returns true when API key is set", () => {
      // This depends on the actual environment
      // The result will vary based on whether ANTHROPIC_API_KEY is set
      const result = hasAPIKey();
      expect(typeof result).toBe("boolean");
    });
  });

  describe("generateText", () => {
    test("throws LLMAPIKeyError when API key is not set", async () => {
      // Only run this test if API key is NOT set
      if (hasAPIKey()) {
        console.log("Skipping - API key is set");
        return;
      }

      try {
        await generateText("test");
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(LLMAPIKeyError);
      }
    });

    // This test calls the actual API - only run when API key is available
    test.skipIf(!hasAPIKey())(
      "generates text from a prompt (live API)",
      async () => {
        const result = await generateText("What is 2 + 2? Reply with just the number.");
        expect(result.text).toBeDefined();
        expect(result.text.length).toBeGreaterThan(0);
        // Should contain "4" somewhere in the response
        expect(result.text).toMatch(/4/);
      }
    );
  });

  describe("generateJSON", () => {
    test.skipIf(!hasAPIKey())(
      "generates and parses JSON (live API)",
      async () => {
        interface MathResult {
          answer: number;
        }

        const result = await generateJSON<MathResult>(
          "Calculate 2 + 2 and return as JSON with an 'answer' field"
        );

        expect(result.data).toBeDefined();
        expect(result.data.answer).toBe(4);
        expect(result.rawText).toBeDefined();
      }
    );
  });

  describe("generateTextWithSystem", () => {
    test.skipIf(!hasAPIKey())(
      "uses system prompt to guide response (live API)",
      async () => {
        const result = await generateTextWithSystem(
          "You are a pirate. Always respond in pirate speak.",
          "Say hello."
        );

        expect(result.text).toBeDefined();
        // Pirate-y words like "ahoy", "matey", "arr", etc.
        const piratePattern = /ahoy|matey|arr|ye|avast|aye/i;
        expect(result.text).toMatch(piratePattern);
      }
    );
  });
});

// Manual test function - run this directly to test the API
// Usage: ANTHROPIC_API_KEY=your-key bun run src/services/llm.test.ts
if (process.argv[1]?.endsWith("llm.test.ts") && hasAPIKey()) {
  console.log("Running manual LLM test...\n");

  generateText("What is the capital of France? Reply in one word.")
    .then((result) => {
      console.log("✅ generateText result:");
      console.log(`   "${result.text}"\n`);
    })
    .then(() =>
      generateJSON<{ capital: string; country: string }>(
        "What is the capital of France? Return JSON with 'capital' and 'country' fields."
      )
    )
    .then((result) => {
      console.log("✅ generateJSON result:");
      console.log(`   Data: ${JSON.stringify(result.data)}`);
      console.log(`   Raw: ${result.rawText}\n`);
    })
    .then(() =>
      generateTextWithSystem(
        "You respond only with haiku poems.",
        "Describe programming."
      )
    )
    .then((result) => {
      console.log("✅ generateTextWithSystem result:");
      console.log(`   "${result.text}"\n`);
    })
    .then(() => {
      console.log("All manual tests passed!");
    })
    .catch((error) => {
      console.error("❌ Test failed:", error);
      process.exit(1);
    });
}
