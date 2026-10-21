/**
 * A best-effort check of the resolved models against OpenCode's catalog.
 *
 * Older OpenCode versions return from `models --standalone` before the catalog
 * loads, so validation asks the user's background service. That service lists models
 * for providers it has credentials for, so a provider missing from the list is
 * not an error here: the credential check covers it. Any failure to read the
 * catalog skips the check.
 */
import { run } from "./core/lib/proc.ts";
import { MODEL_STAGES, STAGE_SETTING, type ResolvedModels } from "./models.ts";
import type { ReviewModelStage } from "./options.ts";
import { subscriptionCommand, subscriptionEnv } from "./subscription.ts";

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

/**
 * Choose the first review-capable model in OpenCode's native catalog order.
 * Its global default may belong to an unrelated free provider, so filter the
 * available list to the provider whose credentials DiffLoupe selected.
 */
export async function readProviderDefault(
  provider: string,
  options: { subscriptionHome?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string | undefined> {
  try {
    const args = ["api", "model.list", "--standalone"];
    const home = options.subscriptionHome;
    const command = home ? subscriptionCommand(home, args, "probe") : { command: "opencode", args };
    const env = home ? subscriptionEnv(home, options.env) : {
      ...(options.env ?? process.env),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
    };
    if (!home) {
      // Reviews borrow only the global model/providers config. Repository and
      // ambient overrides must not choose models that the runner cannot use.
      for (const name of ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CLI_CONFIG_CONTENT"]) {
        delete env[name];
      }
    }
    const result = await run(command.command, command.args, {
      allowFail: true,
      env,
      ...(home ? {} : { timeoutMs: 10_000 }),
    });
    if (result.code !== 0) return undefined;
    const parsed: unknown = JSON.parse(result.stdout);
    if (!isRecord(parsed) || !Array.isArray(parsed.data)) return undefined;
    const model = parsed.data.find((entry: unknown): entry is CatalogModel => {
      if (!isRecord(entry) || entry.providerID !== provider || typeof entry.id !== "string" || !entry.id ||
        entry.enabled === false || entry.status === "deprecated" || !isRecord(entry.capabilities)) return false;
      const { tools, input, output } = entry.capabilities;
      const supportsText = (values: unknown) => Array.isArray(values) &&
        values.some((value: unknown) => typeof value === "string" && value.startsWith("text"));
      return tools === true && supportsText(input) && supportsText(output);
    });
    return model ? `${model.providerID}/${model.id}` : undefined;
  } catch {
    // Catalog responses and native failures can contain provider settings.
    // Let setup explain the missing default without exposing those details.
    return undefined;
  }
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
