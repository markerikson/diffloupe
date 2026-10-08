// These tests are written for vitest with globals.
// bun test provides the same globals and maps `vitest` imports to `bun:test`.
/// <reference types="bun-types/test-globals" />

declare module "vitest" {
  export * from "bun:test";
}
