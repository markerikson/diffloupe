/**
 * HighlighterContext - Provides Shiki syntax highlighting for the diff viewer.
 * Uses lazy initialization and line-level caching for performance.
 */

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { createHighlighter, type Highlighter } from "shiki";

/** Languages we commonly see in diffs */
const COMMON_LANGUAGES = [
  "typescript",
  "javascript",
  "tsx",
  "jsx",
  "json",
  "css",
  "html",
  "markdown",
  "python",
  "rust",
  "go",
  "yaml",
  "bash",
  "sql",
] as const;

/** Map file extensions to language IDs */
const EXTENSION_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  css: "css",
  scss: "css",
  html: "html",
  htm: "html",
  md: "markdown",
  mdx: "markdown",
  py: "python",
  rs: "rust",
  go: "go",
  yml: "yaml",
  yaml: "yaml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
};

interface HighlighterContextValue {
  /** Whether the highlighter is ready */
  isReady: boolean;
  /** Get highlighted HTML for a line of code */
  getHighlightedLine: (filePath: string, lineContent: string) => string;
  /** Get the detected language for a file */
  getLanguage: (filePath: string) => string | null;
}

const HighlighterContext = createContext<HighlighterContextValue | null>(null);

/** Cache key for a highlighted line */
function getCacheKey(lang: string, content: string): string {
  return `${lang}:${content}`;
}

/** Extract file extension from a path */
function getExtension(filePath: string): string {
  const parts = filePath.split(".");
  const ext = parts.length > 1 ? parts[parts.length - 1] : "";
  return ext?.toLowerCase() ?? "";
}

export function HighlighterProvider({ children }: { children: ReactNode }) {
  const [highlighter, setHighlighter] = useState<Highlighter | null>(null);
  const [isReady, setIsReady] = useState(false);

  // Line cache: Map<cacheKey, highlightedHtml>
  const [lineCache] = useState(() => new Map<string, string>());

  // Initialize Shiki highlighter
  useEffect(() => {
    let mounted = true;

    async function init() {
      try {
        const hl = await createHighlighter({
          themes: ["github-dark"],
          langs: [...COMMON_LANGUAGES],
        });

        if (mounted) {
          setHighlighter(hl);
          setIsReady(true);
        }
      } catch (err) {
        console.error("Failed to initialize Shiki highlighter:", err);
        // Still mark as ready so we can fall back to plain text
        if (mounted) {
          setIsReady(true);
        }
      }
    }

    init();

    return () => {
      mounted = false;
    };
  }, []);

  const getLanguage = useCallback((filePath: string): string | null => {
    const ext = getExtension(filePath);
    return EXTENSION_TO_LANG[ext] || null;
  }, []);

  const getHighlightedLine = useCallback(
    (filePath: string, lineContent: string): string => {
      // If no highlighter, return escaped HTML
      if (!highlighter) {
        return escapeHtml(lineContent);
      }

      const lang = getLanguage(filePath);

      // If we can't determine the language, return escaped HTML
      if (!lang) {
        return escapeHtml(lineContent);
      }

      // Check cache first
      const cacheKey = getCacheKey(lang, lineContent);
      const cached = lineCache.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }

      try {
        // Highlight the single line
        const html = highlighter.codeToHtml(lineContent, {
          lang,
          theme: "github-dark",
        });

        // Extract just the inner content (remove <pre><code> wrapper)
        // Shiki output: <pre class="..." style="..."><code><span>...</span></code></pre>
        const innerMatch = html.match(/<code[^>]*>([\s\S]*?)<\/code>/);
        const inner = innerMatch?.[1] ?? escapeHtml(lineContent);

        // Cache and return
        lineCache.set(cacheKey, inner);
        return inner;
      } catch {
        // Fallback on error
        const escaped = escapeHtml(lineContent);
        lineCache.set(cacheKey, escaped);
        return escaped;
      }
    },
    [highlighter, getLanguage, lineCache]
  );

  return (
    <HighlighterContext.Provider
      value={{ isReady, getHighlightedLine, getLanguage }}
    >
      {children}
    </HighlighterContext.Provider>
  );
}

export function useHighlighter(): HighlighterContextValue {
  const ctx = useContext(HighlighterContext);
  if (!ctx) {
    throw new Error("useHighlighter must be used within a HighlighterProvider");
  }
  return ctx;
}

/** Escape HTML special characters */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
