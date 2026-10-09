// Copies the runtime files the bundled CLI reads from disk into dist/:
// review-core prompts and OpenCode plugin files, plus tree-sitter WASM.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");

const copies: Array<[string, string]> = [
  ["src/review/core/system.md", "review-core/system.md"],
  ["src/review/core/opencode/governor.ts", "review-core/opencode/governor.ts"],
  ["src/review/core/opencode/tools.md", "review-core/opencode/tools.md"],
  ["node_modules/web-tree-sitter/web-tree-sitter.wasm", "wasm/web-tree-sitter.wasm"],
  ["node_modules/tree-sitter-typescript/tree-sitter-typescript.wasm", "wasm/tree-sitter-typescript.wasm"],
  ["node_modules/tree-sitter-typescript/tree-sitter-tsx.wasm", "wasm/tree-sitter-tsx.wasm"],
  ["node_modules/tree-sitter-cpp/tree-sitter-cpp.wasm", "wasm/tree-sitter-cpp.wasm"],
];

for (const [from, to] of copies) {
  const src = join(root, from);
  if (!existsSync(src)) throw new Error(`missing build asset: ${from}`);
  const dest = join(dist, to);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}
console.log(`copied ${copies.length} assets to dist/`);
