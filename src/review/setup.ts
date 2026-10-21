/**
 * Models and credentials for a review, resolved before anything is written.
 * Shared by `prepareRun` and `diffloupe doctor`.
 */
import { existsSync } from "node:fs";
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
import { hasSubscriptionLogin, subscriptionCommand, subscriptionEnv, subscriptionHome } from "./subscription.ts";
import { run } from "./core/lib/proc.ts";

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
  /** Replaces inspecting DiffLoupe's dedicated subscription profile. */
  readSubscription?: () => Promise<{ home?: string; error?: string }>;
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
  // Explicit API keys still win. Do not start a profile server for API-only runs.
  const openaiInputs = { ...credentialInputs, providers: new Map([["openai", [] as ReviewModelStage[]]]) };
  const subscription = credentialInputs.providers.has("openai") && needsSavedCredentials(openaiInputs)
    ? await (opts.readSubscription ?? (() => readSubscriptionProfile(env)))()
    : {};
  const withSubscription = {
    ...credentialInputs,
    ...(subscription.home ? { subscriptionHome: subscription.home } : {}),
    ...(subscription.error ? { subscriptionError: subscription.error } : {}),
  };
  const saved = needsSavedCredentials(withSubscription)
    ? await (opts.exportCredentials ?? (() => exportSavedCredentials(env)))()
    : undefined;
  const credentials = planCredentials({ ...withSubscription, ...(saved ? { saved } : {}) });
  const catalogModels = await (opts.readCatalog ?? (() => readModelCatalog()))();
  // The ordinary OpenCode server may use an API key or a different ChatGPT
  // account. Its OpenAI catalog cannot validate this profile's entitlements.
  const catalog = catalogModels
    ? checkModels(
      models,
      credentials.subscriptionHome ? catalogModels.filter((m) => m.providerID !== "openai") : catalogModels,
      opts.stages,
    )
    : undefined;
  if (catalog && credentials.subscriptionHome) {
    catalog.zeroCost.push(...(opts.stages ?? MODEL_STAGES).filter((stage) => models[stage].provider === "openai"));
  }
  return {
    provider: resolveProvider(inputs),
    models,
    openCodeUser,
    credentials,
    ...(catalog ? { catalog } : {}),
  };
}

/** Inspect only the dedicated profile; never fork a user's renewable login. */
async function readSubscriptionProfile(env: NodeJS.ProcessEnv): Promise<{ home?: string; error?: string }> {
  const home = subscriptionHome(env);
  if (!existsSync(home)) return {};
  try {
    // Unlike auth export, auth list contains only connection metadata. The
    // worker owns the profile lock until OpenCode exits, even if we crash.
    const command = subscriptionCommand(home, ["auth", "list", "--standalone", "--format", "json"], "probe");
    const result = await run(command.command, command.args, {
      env: subscriptionEnv(home, env), cwd: home, allowFail: true,
    });
    if (result.code !== 0) throw new Error("profile unavailable");
    return hasSubscriptionLogin(result.stdout) ? { home } : {};
  } catch {
    return { error: "Could not check the ChatGPT subscription profile. Run `diffloupe auth status` or sign in again with `diffloupe auth login`." };
  }
}

/** Review-core config for a resolved setup. Effort is already in each model's `#variant`. */
export function setupConfig(setup: RunSetup): Partial<ReviewConfig> {
  // Native ChatGPT authentication owns its endpoint and headers. Applying an
  // ordinary OpenAI proxy/package override here could redirect OAuth tokens.
  const providers = Object.fromEntries(Object.entries(setup.openCodeUser.providers ?? {})
    .filter(([id]) => !(setup.credentials.subscriptionHome && id === "openai")));
  return {
    provider: setup.provider,
    model: setup.models.review.model,
    modelMerge: setup.models.coordinator.model,
    modelWalk: setup.models.walkthrough.model,
    modelIntent: setup.models.intent.model,
    effort: "",
    effortAux: "",
    providers,
    childEnv: setup.credentials.childEnv,
    authImport: setup.credentials.imports.length ? JSON.stringify(setup.credentials.imports) : "",
    subscriptionHome: setup.credentials.subscriptionHome ?? "",
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
