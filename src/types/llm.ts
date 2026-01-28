/**
 * LLM Types - Type definitions for the LLM service
 *
 * These types define the configuration and interfaces for interacting with
 * Large Language Models (LLMs) via TanStack AI.
 */

/**
 * Supported Claude models.
 * - "claude-opus-4-5" - Most capable, best for complex analysis
 * - "claude-sonnet-4-5" - Highly capable, good speed (default)
 * - "claude-haiku-4-5" - Fastest, good for simple tasks
 */
export type LLMModel = "claude-opus-4-5" | "claude-sonnet-4-5" | "claude-haiku-4-5";

/**
 * Configuration options for LLM requests.
 *
 * These options control how the LLM generates responses:
 * - `model`: Which Claude model to use
 * - `maxTokens`: Maximum length of the response (in tokens, roughly ~4 chars per token)
 * - `temperature`: Controls randomness (0 = deterministic, 1 = creative)
 */
export interface LLMConfig {
  /**
   * The model to use for generation.
   * Defaults to "claude-sonnet-4-5".
   */
  model?: LLMModel;

  /**
   * Maximum number of tokens (words/subwords) in the response.
   * A token is roughly 4 characters. Defaults to 4096.
   */
  maxTokens?: number;

  /**
   * Controls randomness in the response.
   * - 0.0 = Very deterministic, consistent responses
   * - 0.5 = Balanced (default)
   * - 1.0 = More creative/random
   */
  temperature?: number;
}

/**
 * Result from a text generation request.
 * Contains the generated text and optional metadata.
 */
export interface LLMTextResult {
  /** The generated text content */
  text: string;
}

/**
 * Result from a JSON generation request.
 * The data is already parsed into the expected type.
 */
export interface LLMJSONResult<T> {
  /** The parsed JSON data */
  data: T;
  /** The raw text that was parsed (useful for debugging) */
  rawText: string;
}

/**
 * Error thrown when the LLM API key is missing.
 */
export class LLMAPIKeyError extends Error {
  constructor() {
    super(
      "ANTHROPIC_API_KEY environment variable is not set. " +
        "Please set it to your Anthropic API key."
    );
    this.name = "LLMAPIKeyError";
  }
}

/**
 * Error thrown when LLM generation fails.
 */
export class LLMGenerationError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = "LLMGenerationError";
  }
}

/**
 * Error thrown when JSON parsing fails.
 */
export class LLMJSONParseError extends Error {
  constructor(message: string, public readonly rawText: string) {
    super(message);
    this.name = "LLMJSONParseError";
  }
}
