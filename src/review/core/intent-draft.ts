/**
 * A short statement of what the change is for, drafted by a small model from
 * the whole diff before any slice reviewer starts.
 *
 * Each slice reviewer sees one part of the change, plus the author's
 * description, which is often empty or a single line. The draft tells it what
 * the other parts do, so it can notice a part that does not fit. It is labelled
 * as inferred wherever it appears, and nothing depends on it: a failed or
 * truncated draft leaves the review running without the section.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { ARTIFACTS, EFFORT_AUX, INTENT_BUDGET, MODEL_INTENT, OUT } from "./config.ts";
import { compactForIntent } from "./lib/hunks.ts";
import { exists, readJson, writeJson } from "./lib/io.ts";
import { INTENT_DRAFT_SYSTEM, intentDraftPrompt, type IntentDraft, type StatedIntent } from "./prompts.ts";
import { agent, type AgentUsage } from "./runner.ts";

/** About 65K tokens: room for every file of a large change at under a cent on the smallest tier. */
export const INTENT_DIFF_CHARS = 160_000;

/** What a run records about its draft. */
export interface IntentDraftRecord {
  draft?: IntentDraft;
  model: string;
  costUsd: number;
  wallMs: number;
  usage?: AgentUsage;
  /** True when the draft came from an earlier run on the same head. */
  cached: boolean;
  /** Why there is no draft. */
  failure?: string;
  /** Characters of diff the model was shown, after compaction. */
  diffChars: number;
}

interface CachedDraft {
  draft: IntentDraft;
  model: string;
  inputHash: string;
}

function nonEmptyText(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** The draft in a model's output, or undefined when the title or goal is missing. */
export function parseIntentDraft(payload: unknown): IntentDraft | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const p = payload as Record<string, unknown>;
  const title = nonEmptyText(p.title);
  const goal = nonEmptyText(p.goal);
  if (!title || !goal) return undefined;
  const expected = Array.isArray(p.expected_changes)
    ? p.expected_changes.map(nonEmptyText).filter((c) => c !== undefined)
    : [];
  return { title, goal, expected_changes: expected };
}

export async function draftIntent(o: {
  tag: string;
  /** Names the cache file; the same key on a later run reuses the draft when the input is unchanged. */
  cacheKey: string;
  branch?: string | undefined;
  intent: StatedIntent;
  diffstat: string;
  /** `git diff` of the code files. */
  diff: string;
  otherFiles: string[];
}): Promise<IntentDraftRecord> {
  const model = MODEL_INTENT;
  const diff = compactForIntent(o.diff, INTENT_DIFF_CHARS);
  const outFile = path.join(OUT, `${o.tag}-intent.json`);
  const input = { branch: o.branch, intent: o.intent, diffstat: o.diffstat, diff, otherFiles: o.otherFiles };
  const inputHash = createHash("sha256")
    .update(INTENT_DRAFT_SYSTEM)
    .update(intentDraftPrompt({ ...input, outFile: "" }))
    .digest("hex")
    .slice(0, 16);
  const cacheFile = path.join(ARTIFACTS, "intents", `${o.cacheKey}.json`);
  const base = { model, diffChars: diff.length };

  if (await exists(cacheFile)) {
    try {
      const cached = await readJson<CachedDraft>(cacheFile);
      const draft = parseIntentDraft(cached.draft);
      if (draft && cached.model === model && cached.inputHash === inputHash) {
        return { ...base, draft, costUsd: 0, wallMs: 0, cached: true };
      }
    } catch {
      // An unreadable cache entry is drafted again and overwritten.
    }
  }

  const res = await agent(intentDraftPrompt({ ...input, outFile }), {
    budget: INTENT_BUDGET,
    outFile,
    tag: `${o.tag}-intent`,
    model,
    effort: EFFORT_AUX,
    tools: "none",
    system: { name: "intent", text: INTENT_DRAFT_SYSTEM },
  });
  const spent = { costUsd: res.costUsd, wallMs: res.wallMs, cached: false, ...(res.usage ? { usage: res.usage } : {}) };
  const draft = parseIntentDraft(res.payload);
  if (!draft) {
    const failure = res.failure?.message ?? "the draft has no title or goal";
    return { ...base, ...spent, failure };
  }
  await writeJson(cacheFile, { draft, model, inputHash } satisfies CachedDraft);
  return { ...base, ...spent, draft };
}
