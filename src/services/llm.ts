/**
 * LLM Service - TanStack AI integration for Claude
 *
 * This module provides a simple interface for generating text and structured
 * JSON responses using Anthropic's Claude models via TanStack AI.
 *
 * ## How TanStack AI Works
 *
 * TanStack AI uses an "adapter" pattern to support different LLM providers:
 * - **Adapters**: Provider-specific implementations (Anthropic, OpenAI, etc.)
 * - **chat()**: The main function that sends messages to the LLM
 * - **Messages**: Conversation history in a standard format
 *
 * The flow is:
 * 1. Create an adapter for your provider (e.g., `anthropicText()`)
 * 2. Call `chat()` with the adapter, model, and messages
 * 3. Iterate over the streaming response or await the full text
 *
 * ## Key Concepts
 *
 * - **Tokens**: LLMs count input/output in "tokens" (roughly 4 chars each)
 * - **Temperature**: Controls randomness (0 = consistent, 1 = creative)
 * - **System prompts**: Instructions that guide the model's behavior
 * - **Messages**: The conversation history (user messages + assistant responses)
 */

import { chat } from "@tanstack/ai";
import { anthropicText } from "@tanstack/ai-anthropic";
import {
  LLMAPIKeyError,
  LLMGenerationError,
  LLMJSONParseError,
  type LLMConfig,
  type LLMModel,
  type LLMTextResult,
  type LLMJSONResult,
} from "../types/llm.js";

// Re-export types for convenience
export type { LLMConfig, LLMModel, LLMTextResult, LLMJSONResult };
export { LLMAPIKeyError, LLMGenerationError, LLMJSONParseError };

/**
 * Default model to use for generation.
 * Claude Sonnet 4.5 is highly capable with good speed.
 */
const DEFAULT_MODEL: LLMModel = "claude-sonnet-4-5";

/**
 * Default maximum tokens for responses.
 * 4096 is enough for most use cases while keeping costs reasonable.
 */
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Default temperature for responses.
 * 0.5 balances consistency with some variety.
 */
const DEFAULT_TEMPERATURE = 0.5;

/**
 * Checks if the Anthropic API key is available in the environment.
 *
 * @returns true if ANTHROPIC_API_KEY is set
 */
export function hasAPIKey(): boolean {
  return !!process.env["ANTHROPIC_API_KEY"];
}

/**
 * Validates that the API key is present, throwing a clear error if not.
 *
 * @throws {LLMAPIKeyError} if ANTHROPIC_API_KEY is not set
 */
function validateAPIKey(): void {
  if (!hasAPIKey()) {
    throw new LLMAPIKeyError();
  }
}

/**
 * Generate text from a prompt using Claude.
 *
 * This is the simplest way to get a response from the LLM.
 * The function handles:
 * - Creating the adapter (connection to Anthropic)
 * - Sending the message
 * - Collecting the streaming response into a single string
 *
 * @param prompt - The user's message/question
 * @param config - Optional configuration (model, maxTokens, temperature)
 * @returns The generated text
 *
 * @throws {LLMAPIKeyError} if ANTHROPIC_API_KEY is not set
 * @throws {LLMGenerationError} if generation fails
 *
 * @example
 * ```ts
 * const result = await generateText("What is 2 + 2?");
 * console.log(result.text); // "2 + 2 equals 4."
 * ```
 */
export async function generateText(
  prompt: string,
  config?: LLMConfig
): Promise<LLMTextResult> {
  // Ensure we have an API key before making the request
  validateAPIKey();

  const model = config?.model ?? DEFAULT_MODEL;
  const maxTokens = config?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const temperature = config?.temperature ?? DEFAULT_TEMPERATURE;

  try {
    // Create the Anthropic text adapter
    // This reads ANTHROPIC_API_KEY from the environment automatically
    const adapter = anthropicText(model);

    // Use chat() with stream: false to get a simple string response
    // When stream: false, chat() returns a Promise<string> instead of AsyncIterable
    const text = await chat({
      adapter,
      stream: false, // Don't stream - just wait for the complete response
      maxTokens,
      temperature,
      // Messages are the conversation history
      // For a simple prompt, we just have one user message
      messages: [
        {
          role: "user", // "user" = the human, "assistant" = the AI
          content: prompt, // The actual text of the message
        },
      ],
    });

    return { text };
  } catch (error) {
    // Wrap any errors in our custom error type for consistent handling
    if (error instanceof LLMAPIKeyError) {
      throw error;
    }
    throw new LLMGenerationError(
      `Failed to generate text: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Generate structured JSON output from a prompt.
 *
 * This function asks the LLM to respond with JSON and parses the result.
 * It adds instructions to the prompt to ensure JSON output.
 *
 * NOTE: TanStack AI supports structured output with schemas (outputSchema),
 * but for simplicity we're using a prompt-based approach here.
 * The schema-based approach would be better for production use cases.
 *
 * @param prompt - The user's message (should describe what JSON to generate)
 * @param config - Optional configuration (model, maxTokens, temperature)
 * @returns The parsed JSON data and raw text
 *
 * @throws {LLMAPIKeyError} if ANTHROPIC_API_KEY is not set
 * @throws {LLMGenerationError} if generation fails
 * @throws {LLMJSONParseError} if the response isn't valid JSON
 *
 * @example
 * ```ts
 * interface Person { name: string; age: number; }
 *
 * const result = await generateJSON<Person>(
 *   "Generate a person with name and age"
 * );
 * console.log(result.data.name); // "John"
 * ```
 */
export async function generateJSON<T>(
  prompt: string,
  config?: LLMConfig
): Promise<LLMJSONResult<T>> {
  // Add instructions to ensure JSON output
  // This is a simple approach - for production, use outputSchema
  const jsonPrompt = `${prompt}

IMPORTANT: Respond with ONLY valid JSON. No markdown code blocks, no explanations, just the raw JSON object.`;

  // Generate the text
  const result = await generateText(jsonPrompt, config);
  const rawText = result.text.trim();

  // Try to parse the JSON
  // Sometimes models wrap JSON in markdown code blocks, so we handle that
  let jsonText = rawText;

  // Remove markdown code blocks if present
  if (jsonText.startsWith("```json")) {
    jsonText = jsonText.slice(7);
  } else if (jsonText.startsWith("```")) {
    jsonText = jsonText.slice(3);
  }
  if (jsonText.endsWith("```")) {
    jsonText = jsonText.slice(0, -3);
  }
  jsonText = jsonText.trim();

  try {
    const data = JSON.parse(jsonText) as T;
    return { data, rawText };
  } catch (parseError) {
    throw new LLMJSONParseError(
      `Failed to parse LLM response as JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
      rawText
    );
  }
}

/**
 * Generate text with a system prompt.
 *
 * System prompts provide context and instructions that guide the model's behavior.
 * They're useful for setting up a specific persona or task.
 *
 * @param systemPrompt - Instructions for the model (e.g., "You are a helpful code reviewer")
 * @param userPrompt - The user's message/question
 * @param config - Optional configuration
 * @returns The generated text
 *
 * @example
 * ```ts
 * const result = await generateTextWithSystem(
 *   "You are a code reviewer. Be concise and focus on bugs.",
 *   "Review this code: function add(a, b) { return a - b; }"
 * );
 * ```
 */
export async function generateTextWithSystem(
  systemPrompt: string,
  userPrompt: string,
  config?: LLMConfig
): Promise<LLMTextResult> {
  validateAPIKey();

  const model = config?.model ?? DEFAULT_MODEL;
  const maxTokens = config?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const temperature = config?.temperature ?? DEFAULT_TEMPERATURE;

  try {
    const adapter = anthropicText(model);

    const text = await chat({
      adapter,
      stream: false,
      maxTokens,
      temperature,
      // System prompts are passed separately and are applied before messages
      systemPrompts: [systemPrompt],
      messages: [
        {
          role: "user",
          content: userPrompt,
        },
      ],
    });

    return { text };
  } catch (error) {
    if (error instanceof LLMAPIKeyError) {
      throw error;
    }
    throw new LLMGenerationError(
      `Failed to generate text: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Generate JSON with a system prompt.
 *
 * Combines system prompts with JSON output for structured responses.
 *
 * @param systemPrompt - Instructions for the model
 * @param userPrompt - The user's message
 * @param config - Optional configuration
 * @returns The parsed JSON data and raw text
 */
export async function generateJSONWithSystem<T>(
  systemPrompt: string,
  userPrompt: string,
  config?: LLMConfig
): Promise<LLMJSONResult<T>> {
  // Enhance the system prompt to ensure JSON output
  const jsonSystemPrompt = `${systemPrompt}

IMPORTANT: Always respond with ONLY valid JSON. No markdown code blocks, no explanations, just the raw JSON object.`;

  const result = await generateTextWithSystem(
    jsonSystemPrompt,
    userPrompt,
    config
  );
  const rawText = result.text.trim();

  // Parse JSON (same logic as generateJSON)
  let jsonText = rawText;
  if (jsonText.startsWith("```json")) {
    jsonText = jsonText.slice(7);
  } else if (jsonText.startsWith("```")) {
    jsonText = jsonText.slice(3);
  }
  if (jsonText.endsWith("```")) {
    jsonText = jsonText.slice(0, -3);
  }
  jsonText = jsonText.trim();

  try {
    const data = JSON.parse(jsonText) as T;
    return { data, rawText };
  } catch (parseError) {
    throw new LLMJSONParseError(
      `Failed to parse LLM response as JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
      rawText
    );
  }
}
