/**
 * Models and credentials for a review, resolved before anything is written.
 * Shared by `prepareRun` and `diffloupe doctor`.
 */
import type { DiffLoupeConfig } from "../services/config.ts";
import type { ReviewRun } from "../types/review-run.ts";
import type { ReviewConfig } from "./core/config.ts";
import {
  exportSavedCredentials,
  needsSavedCredentials,
  planCredentials,
  type CredentialPlan,
  type SavedCredential,
} from "./credentials.ts";
import { checkModels, readModelCatalog, type CatalogCheck, type CatalogModel } from "./model-catalog.ts";
import { MODEL_STAGES, providersInUse, resolveModels, resolveProvider, type ResolvedModels } from "./models.ts";
import { readOpenCodeUserConfig, type OpenCodeUserConfig } from "./opencode-user.ts";
import type { ReviewModelStage } from "./options.ts";
import type { ReviewSettings } from "./settings.ts";

export interface RunSetup {
  provider: string;
  models: ResolvedModels;
  openCodeUser: OpenCodeUserConfig;
  credentials: CredentialPlan;
  /** Undefined when the catalog could not be read. */
  catalog?: CatalogCheck;
}

export interface RunSetupOptions {
  cli?: { models?: Partial<Record<ReviewModelStage, string>>; effort?: string };
  settings?: ReviewSettings;
  userConfig: DiffLoupeConfig;
  env?: NodeJS.ProcessEnv;
  /** Replaces reading the user's global OpenCode config. */
  openCodeUser?: OpenCodeUserConfig;
  /** Replaces `opencode auth export`. */
  exportCredentials?: () => Promise<SavedCredential[] | undefined>;
  /** Replaces asking OpenCode for its model catalog; return undefined to skip the check. */
  readCatalog?: () => Promise<CatalogModel[] | undefined>;
  /** The stages that will run; credentials and the catalog are checked only for these. Default: all. */
  stages?: readonly ReviewModelStage[];
}

export async function resolveRunSetup(opts: RunSetupOptions): Promise<RunSetup> {
  const env = opts.env ?? process.env;
  const openCodeUser = opts.openCodeUser ?? readOpenCodeUserConfig(env);
  const settings = opts.settings ?? {};
  const inputs = {
    env,
    ...(opts.cli ? { cli: opts.cli } : {}),
    settings,
    config: opts.userConfig,
    ...(openCodeUser.model ? { openCodeModel: openCodeUser.model } : {}),
  };
  const models = resolveModels(inputs);
  const credentialInputs = {
    providers: providersInUse(models, opts.stages),
    env,
    ...(opts.userConfig.apiKeys ? { apiKeys: opts.userConfig.apiKeys } : {}),
    ...(openCodeUser.providers ? { userProviders: openCodeUser.providers } : {}),
  };
  const saved = needsSavedCredentials(credentialInputs)
    ? await (opts.exportCredentials ?? (() => exportSavedCredentials(env)))()
    : undefined;
  const credentials = planCredentials({ ...credentialInputs, ...(saved ? { saved } : {}) });
  const catalogModels = await (opts.readCatalog ?? (() => readModelCatalog()))();
  return {
    provider: resolveProvider(inputs),
    models,
    openCodeUser,
    credentials,
    ...(catalogModels ? { catalog: checkModels(models, catalogModels, opts.stages) } : {}),
  };
}

/** Review-core config for a resolved setup. Effort is already in each model's `#variant`. */
export function setupConfig(setup: RunSetup): Partial<ReviewConfig> {
  return {
    provider: setup.provider,
    model: setup.models.review.model,
    modelMerge: setup.models.coordinator.model,
    modelWalk: setup.models.walkthrough.model,
    effort: "",
    effortAux: "",
    providers: setup.openCodeUser.providers ?? {},
    childEnv: setup.credentials.childEnv,
    authImport: setup.credentials.imports.length ? JSON.stringify(setup.credentials.imports) : "",
  };
}

export function runModels(
  setup: RunSetup,
  stages: readonly ReviewModelStage[] = MODEL_STAGES,
): NonNullable<ReviewRun["meta"]["models"]> {
  const out: NonNullable<ReviewRun["meta"]["models"]> = {};
  for (const stage of stages) {
    out[stage] = { model: setup.models[stage].model, source: setup.models[stage].source };
  }
  return out;
}
