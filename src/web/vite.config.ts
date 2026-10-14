import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { bundledLanguagesInfo } from "shiki";
import Icons from "unplugin-icons/vite";
import { defineConfig, type Plugin } from "vite";

// @pierre/diffs registers every Shiki and Pierre theme as a lazy import, and keeps the Oniguruma
// WASM engine behind `preferredHighlighter: "shiki-wasm"`. The UI only renders with the default
// pierre-dark / pierre-light themes and the default JS regex engine, so every other theme and the
// WASM binary resolve to one stub module that throws if it is ever loaded.
const USED_THEMES = new Set(["pierre-dark", "pierre-light"]);
const THEME_IMPORT = /^(?:@shikijs\/themes|@pierre\/theme)\/([\w-]+)$/;
const UNUSED_ID = "\0diffloupe:unused";

// Shiki ids whose grammars ship in the build. Every other language resolves to one grammar with no
// rules, so those files render as plain text instead of adding ~5 MB of grammars to the npm package.
// The last row is grammars that others embed through relative imports (cpp, xml, dockerfile,
// svelte), which ship either way.
const HIGHLIGHTED_LANGUAGES = new Set([
  ...["typescript", "tsx", "javascript", "jsx", "json", "jsonc", "json5"],
  ...["html", "css", "scss", "vue", "svelte", "graphql", "markdown", "xml", "yaml", "toml", "ini"],
  ...["shellscript", "powershell", "dockerfile", "make", "cmake", "diff", "sql"],
  ...["c", "cpp", "objective-cpp", "python", "rust", "go"],
  ...["glsl", "regexp", "java", "docker", "postcss"],
]);
const LANGUAGE_IMPORT = /^@shikijs\/langs\/([\w-]+)$/;
const PLAIN_ID = "\0diffloupe:plain-text";

// @pierre/diffs requires the loaded grammar to declare the requested language as its name or an
// alias, so the shared plain grammar lists every language it stands in for.
function plainTextGrammar(): string {
  const aliases = bundledLanguagesInfo
    .filter((l) => !HIGHLIGHTED_LANGUAGES.has(l.id))
    .flatMap((l) => [l.id].concat(l.aliases ?? []));
  const grammar = { name: "diffloupe-plain-text", scopeName: "text.diffloupe-plain", patterns: [], aliases };
  return `export default [${JSON.stringify(grammar)}];`;
}

function stubUnusedHighlighterAssets(): Plugin {
  return {
    name: "diffloupe:stub-unused-highlighter-assets",
    enforce: "pre",
    resolveId(source) {
      const theme = THEME_IMPORT.exec(source)?.[1];
      if ((theme && !USED_THEMES.has(theme)) || source === "shiki/wasm") return UNUSED_ID;
      const lang = LANGUAGE_IMPORT.exec(source)?.[1];
      if (lang && !HIGHLIGHTED_LANGUAGES.has(lang)) return PLAIN_ID;
    },
    load(id) {
      if (id === UNUSED_ID) {
        return `throw new Error("Not bundled: only the themes in USED_THEMES and the JS regex engine are included (src/web/vite.config.ts).");`;
      }
      if (id === PLAIN_ID) return plainTextGrammar();
    },
  };
}

// Modules that are only reached through dynamic import() and must stay in their own lazy chunks.
const LAZY_MODULE = /@shikijs[\\/]langs[\\/]|@shikijs[\\/]themes[\\/]|@pierre[\\/]theme[\\/]|diffloupe:/;
const vendor = (pattern: RegExp) => (id: string) => id.includes("node_modules") && !LAZY_MODULE.test(id) && pattern.test(id);

function chunkFileNames(chunk: { moduleIds: string[] }): string {
  const ids = chunk.moduleIds;
  if (ids.length > 0 && ids.every((id) => /@shikijs[\\/]langs[\\/]/.test(id))) return "assets/langs/[name]-[hash].js";
  if (ids.length > 0 && ids.every((id) => /@pierre[\\/]theme[\\/]/.test(id))) return "assets/themes/[name]-[hash].js";
  if (ids.length === 1 && ids[0] === UNUSED_ID) return "assets/unused-[hash].js";
  if (ids.length === 1 && ids[0] === PLAIN_ID) return "assets/langs/plain-text-[hash].js";
  return "assets/[name]-[hash].js";
}

export default defineConfig({
  plugins: [stubUnusedHighlighterAssets(), react(), Icons({ compiler: "jsx", jsx: "react" })],
  root: import.meta.dirname,
  worker: {
    format: "es",
    plugins: () => [stubUnusedHighlighterAssets()],
    rolldownOptions: { output: { chunkFileNames } },
  },
  build: {
    outDir: resolve(import.meta.dirname, "../../dist/web"),
    emptyOutDir: true,
    // The cpp grammar (~770 KB) is the only chunk over the default 500 KB, and it loads on demand.
    chunkSizeWarningLimit: 800,
    rolldownOptions: {
      output: {
        chunkFileNames,
        codeSplitting: {
          groups: [
            { name: "react", test: vendor(/[\\/]node_modules[\\/](?:react|react-dom|scheduler)[\\/]/), priority: 4 },
            { name: "router", test: vendor(/[\\/]node_modules[\\/]@tanstack[\\/]/), priority: 3 },
            {
              name: "state",
              test: vendor(/[\\/]node_modules[\\/](?:@reduxjs|immer|redux|react-redux|reselect|use-sync-external-store)[\\/]/),
              priority: 3,
            },
            { name: "arktype", test: vendor(/[\\/]node_modules[\\/](?:arktype|@ark)[\\/]/), priority: 3 },
            {
              name: "shiki",
              test: vendor(/[\\/]node_modules[\\/](?:shiki|@shikijs|oniguruma-to-es|oniguruma-parser|regex|regex-recursion|regex-utilities)[\\/]/),
              priority: 2,
            },
            { name: "diffs", test: vendor(/./), priority: 1 },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4517",
        changeOrigin: true,
      },
    },
  },
});
