/**
 * A best-effort check of the resolved models against OpenCode's catalog.
 *
 * `opencode models --standalone` returns before the catalog loads, so this
 * asks the user's background service instead. That service only lists models
 * for providers it has credentials for, so a provider missing from the list is
 * not an error here: the credential check covers it. Any failure to read the
 * catalog skips the check.
 */
import { run } from "./core/lib/proc.ts";
import { MODEL_STAGES, STAGE_SETTING, type ResolvedModels } from "./models.ts";
import type { ReviewModelStage } from "./options.ts";

export interface CatalogModel {
  id: string;
  modelID?: string;
  providerID: string;
  variants?: { id: string }[];
  cost?: { input?: number; output?: number }[];
}

export interface CatalogCheck {
  errors: string[];
  /** Stages whose model the catalog prices at zero. */
  zeroCost: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function readModelCatalog(timeoutMs = 10_000): Promise<CatalogModel[] | undefined> {
  try {
    const res = await run("opencode", ["api", "GET", "/api/model"], { allowFail: true, timeoutMs });
    if (res.code !== 0) return undefined;
    const parsed: unknown = JSON.parse(res.stdout);
    const data = isRecord(parsed) && Array.isArray(parsed.data) ? parsed.data : undefined;
    if (!data) return undefined;
    return data.filter(
      (m): m is CatalogModel => isRecord(m) && typeof m.id === "string" && typeof m.providerID === "string",
    );
  } catch {
    return undefined;
  }
}

export function checkModels(
  models: ResolvedModels,
  catalog: CatalogModel[],
  stages: readonly ReviewModelStage[] = MODEL_STAGES,
): CatalogCheck {
  const out: CatalogCheck = { errors: [], zeroCost: [] };
  for (const stage of stages) {
    const m = models[stage];
    const fromProvider = catalog.filter((c) => c.providerID === m.provider);
    if (!fromProvider.length) continue;
    const entry = fromProvider.find((c) => c.id === m.id || c.modelID === m.id);
    const fail = (reason: string) =>
      out.errors.push(
        `Model \`${m.model}\` is not available in OpenCode: ${reason}. ` +
          `Set \`${STAGE_SETTING[stage]}\` in ~/.config/diffloupe/config.json or pass --model ${stage}=<provider/model>.`,
      );
    if (!entry) {
      fail(`provider \`${m.provider}\` has no model \`${m.id}\``);
      continue;
    }
    const variants = entry.variants?.map((v) => v.id) ?? [];
    if (m.variant && !variants.includes(m.variant)) {
      fail(
        variants.length
          ? `it has no variant \`${m.variant}\` (variants: ${variants.join(", ")})`
          : `it has no variants, so \`#${m.variant}\` and effort cannot apply`,
      );
      continue;
    }
    const costs = entry.cost ?? [];
    if (costs.length && costs.every((c) => !c.input && !c.output)) out.zeroCost.push(stage);
  }
  return out;
}
