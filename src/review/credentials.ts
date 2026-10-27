/**
 * Credentials for the providers a review's models use.
 *
 * OpenCode runs with relocated data directories, so it never sees the user's
 * own login. Per provider, first match wins:
 * 1. an environment variable OpenCode reads for that provider, inherited by the child
 * 2. `apiKeys.<provider>` in ~/.config/diffloupe/config.json, set as that
 *    provider's environment variable on the child only
 * 3. the dedicated ChatGPT profile created by `diffloupe auth login`
 * 4. an API key saved with `opencode auth login`, read with `opencode auth export`
 *    and imported into the review's temporary OpenCode profile
 *
 * OAuth logins are never copied: OpenCode refreshes them in the persistent
 * subscription profile. Providers that authenticate from the machine
 * (Bedrock, Vertex, local servers) are not checked.
 */
import { run } from "./core/lib/proc.ts";
import type { ReviewModelStage } from "./options.ts";
import { STAGE_SETTING } from "./models.ts";

/** Environment variables OpenCode reads a key from, for the common providers. */
export const PROVIDER_ENV: Record<string, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  google: ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
  groq: ["GROQ_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  xai: ["XAI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  togetherai: ["TOGETHER_AI_API_KEY"],
  "fireworks-ai": ["FIREWORKS_API_KEY"],
  neuralwatt: ["NEURALWATT_API_KEY"],
  opencode: ["OPENCODE_API_KEY"],
};

/** Providers whose credentials come from the machine rather than a key. */
export const AMBIENT_PROVIDERS = new Set([
  "amazon-bedrock",
  "google-vertex",
  "google-vertex-anthropic",
  "ollama",
  "lmstudio",
  "vllm",
]);

/** One entry of `opencode auth export`. */
export interface SavedCredential {
  id: string;
  integrationID: string;
  label?: string;
  active?: boolean;
  value: { type: string; key?: string; [field: string]: unknown };
}

export type CredentialSource = "env" | "config" | "subscription" | "opencode" | "providers" | "ambient" | "none";

export interface ProviderCoverage {
  provider: string;
  stages: ReviewModelStage[];
  source: CredentialSource;
  /** The variable, file or entry that covers it. Never the key itself. */
  detail: string;
}

export interface CredentialPlan {
  /** Added to the environment of every OpenCode child. */
  childEnv: Record<string, string>;
  /** Imported into the temporary API-key profile before the review server starts. */
  imports: SavedCredential[];
  /** Persistent OpenCode profile; no subscription tokens are passed to workers. */
  subscriptionHome?: string;
  coverage: ProviderCoverage[];
  warnings: string[];
  /** One per provider with no credential; preflight fails on any. */
  errors: string[];
}

export interface CredentialInputs {
  providers: Map<string, ReviewModelStage[]>;
  env: NodeJS.ProcessEnv;
  apiKeys?: Record<string, string>;
  /** The `providers` block of the user's OpenCode config. */
  userProviders?: Record<string, unknown>;
  /** `opencode auth export`; undefined when it was not read or failed. */
  saved?: SavedCredential[];
  /** The dedicated profile has an active OpenAI OAuth login. */
  subscriptionHome?: string;
  /** Fail closed if an existing profile could not be checked. */
  subscriptionError?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Environment variable names for a provider: the user's `providers.<id>.env`, then the built-in table. */
export function envNamesFor(provider: string, userProviders?: Record<string, unknown>): string[] {
  const entry = userProviders?.[provider];
  const own = isRecord(entry) && Array.isArray(entry.env) ? entry.env.filter((e) => typeof e === "string") : [];
  return [...new Set([...own, ...(PROVIDER_ENV[provider] ?? [])])];
}

/** True when the user's `providers` block carries a key for the provider itself. */
function providerBlockHasKey(provider: string, userProviders?: Record<string, unknown>): boolean {
  const entry = userProviders?.[provider];
  if (!isRecord(entry)) return false;
  for (const holder of [entry.settings, entry.options]) {
    if (isRecord(holder) && typeof holder.apiKey === "string" && holder.apiKey) return true;
  }
  return false;
}

/** Whether any provider needs `opencode auth export` to be read at all. */
export function needsSavedCredentials(inputs: Omit<CredentialInputs, "saved">): boolean {
  for (const provider of inputs.providers.keys()) {
    if (AMBIENT_PROVIDERS.has(provider)) continue;
    if (envNamesFor(provider, inputs.userProviders).some((n) => inputs.env[n])) continue;
    if (inputs.apiKeys?.[provider]) continue;
    if (provider === "openai" && (inputs.subscriptionHome || inputs.subscriptionError)) continue;
    return true;
  }
  return false;
}

/** Providers with usable credentials, not every provider OpenCode can list. */
export function configuredProviders(inputs: Omit<CredentialInputs, "providers">): string[] {
  const candidates = new Set([
    ...Object.keys(PROVIDER_ENV),
    ...Object.keys(inputs.apiKeys ?? {}),
    ...Object.keys(inputs.userProviders ?? {}),
    ...(inputs.saved ?? []).map((credential) => credential.integrationID),
  ]);
  const plan = planCredentials({
    ...inputs,
    providers: new Map([...candidates].map((provider) => [provider, []])),
  });
  return plan.coverage.filter((entry) => entry.source !== "none").map((entry) => entry.provider);
}

function missingMessage(provider: string, stages: ReviewModelStage[], envNames: string[]): string {
  const used = stages.map((s) => STAGE_SETTING[s]).join(", ");
  const envHint = envNames[0] ? `set ${envNames[0]}, ` : "";
  return (
    `No credential for provider \`${provider}\` (used by ${used}). ` +
    (provider === "openai" ? "Run `diffloupe auth login` for ChatGPT, " : `Run \`opencode auth login ${provider}\`, `) +
    `${envHint}or add apiKeys.${provider} to ~/.config/diffloupe/config.json.`
  );
}

export function planCredentials(inputs: CredentialInputs): CredentialPlan {
  const plan: CredentialPlan = { childEnv: {}, imports: [], coverage: [], warnings: [], errors: [] };
  for (const [provider, stages] of inputs.providers) {
    const cover = (source: CredentialSource, detail: string) =>
      plan.coverage.push({ provider, stages, source, detail });
    const envNames = envNamesFor(provider, inputs.userProviders);

    const fromEnv = envNames.find((n) => inputs.env[n]);
    if (fromEnv) {
      cover("env", fromEnv);
      continue;
    }

    const key = inputs.apiKeys?.[provider];
    if (key) {
      const name = envNames[0];
      if (name) {
        plan.childEnv[name] = key;
      } else {
        plan.imports.push({
          id: `cred_diffloupe_${provider.replace(/[^\w-]/g, "_")}`,
          integrationID: provider,
          label: "API key",
          active: true,
          value: { type: "key", key },
        });
      }
      cover("config", `apiKeys.${provider}`);
      continue;
    }

    if (provider === "openai" && inputs.subscriptionError) {
      cover("none", "");
      plan.errors.push(inputs.subscriptionError);
      continue;
    }
    if (provider === "openai" && inputs.subscriptionHome) {
      plan.subscriptionHome = inputs.subscriptionHome;
      cover("subscription", "ChatGPT login from diffloupe auth login");
      plan.warnings.push(
        "ChatGPT subscription cost is not reported, so --max-cost cannot limit that usage.",
      );
      continue;
    }

    const saved = (inputs.saved ?? []).filter((c) => c.integrationID === provider);
    const keys = saved.filter((c) => c.value?.type === "key" && typeof c.value.key === "string");
    if (keys.length) {
      const chosen = keys.find((c) => c.active) ?? keys[0];
      if (chosen) plan.imports.push({ ...chosen, active: true });
      cover("opencode", "opencode auth login");
      continue;
    }
    const hasOAuth = saved.length > 0;
    if (hasOAuth) {
      plan.warnings.push(
        provider === "openai"
          ? "OpenCode has a ChatGPT login. Run `diffloupe auth login` to sign in to DiffLoupe's separate subscription profile; rotating OAuth credentials are not copied."
          : `OpenCode has a ${provider} login that is not an API key; DiffLoupe does not copy those. ` +
            `Set ${envNames[0] ?? "an API key"} or add apiKeys.${provider} to ~/.config/diffloupe/config.json.`,
      );
    }

    if (providerBlockHasKey(provider, inputs.userProviders)) {
      cover("providers", `providers.${provider} in the OpenCode config`);
      continue;
    }
    if (AMBIENT_PROVIDERS.has(provider)) {
      cover("ambient", "credentials from the machine");
      continue;
    }

    cover("none", "");
    if (PROVIDER_ENV[provider] || hasOAuth) {
      plan.errors.push(missingMessage(provider, stages, envNames));
    } else {
      plan.warnings.push(
        `No credential found for provider \`${provider}\`; assuming OpenCode can reach it without one. ` +
          `If the review fails to authenticate, add apiKeys.${provider} to ~/.config/diffloupe/config.json.`,
      );
    }
  }
  return plan;
}

/** `opencode auth export` from the user's own environment. Undefined when it fails. */
export async function exportSavedCredentials(env: NodeJS.ProcessEnv = process.env): Promise<SavedCredential[] | undefined> {
  try {
    const res = await run("opencode", ["auth", "export"], { env, allowFail: true, timeoutMs: 20_000 });
    if (res.code !== 0) return undefined;
    const parsed: unknown = JSON.parse(res.stdout);
    if (!Array.isArray(parsed)) return undefined;
    return parsed.filter(
      (c): c is SavedCredential =>
        isRecord(c) && typeof c.id === "string" && typeof c.integrationID === "string" && isRecord(c.value),
    );
  } catch {
    return undefined;
  }
}
