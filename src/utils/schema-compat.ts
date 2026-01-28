/**
 * Schema Compatibility Shim for TanStack AI
 *
 * TanStack AI's `isStandardJSONSchema()` check requires `typeof schema === 'object'`,
 * but ArkType schemas are callable functions (`typeof === 'function'`). This causes
 * the Standard Schema detection to fail silently, resulting in empty responses.
 *
 * This shim wraps ArkType schemas in a plain object that satisfies the type check
 * while preserving all `~standard` properties needed for JSON Schema conversion
 * and validation.
 *
 * @see https://github.com/TanStack/ai - isStandardJSONSchema in schema-converter.ts
 */

import type { Type } from "arktype";

/**
 * Wraps an ArkType schema to be compatible with TanStack AI's Standard Schema detection.
 *
 * @example
 * ```ts
 * import { type } from "arktype";
 * import { wrapSchema } from "./utils/schema-compat.js";
 *
 * const MySchema = type({ name: "string" });
 *
 * const result = await chat({
 *   outputSchema: wrapSchema(MySchema),
 *   // ...
 * });
 * ```
 */
export function wrapSchema<T extends Type<unknown>>(arktypeSchema: T): object {
  const standard = (arktypeSchema as Record<string, unknown>)["~standard"];

  if (!standard) {
    throw new Error(
      "Schema does not have ~standard property. Is this an ArkType schema?"
    );
  }

  // Return a plain object (typeof === 'object') with the ~standard property
  // This satisfies TanStack AI's isStandardJSONSchema check
  return {
    "~standard": standard,
  };
}
