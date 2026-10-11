/**
 * Which model each review stage runs, and where that choice came from.
 *
 * Per stage, first match wins:
 * 1. `REVIEW_MODEL`, `REVIEW_MODEL_MERGE`, `REVIEW_MODEL_WALK` (overrides for experiments)
 * 2. `--model stage=id`
 * 3. the settings file passed to `--config`
 * 4. ~/.config/diffloupe/config.json
 * 5. the `model` in the user's global OpenCode config, unless `opencode.useDefaultModel` is false
 * 6. the built-in defaults
 *
 * Effort becomes a `#variant` on the model only when the user set it, or when
 * the model is a built-in default (which get `medium`). A model the user
 * picked, or OpenCode's default, runs with no variant unless effort is set. A
 * `#variant` written into the model name wins over effort.
 */
import type { ReviewModelStage } from "./options.ts";

export type ModelSource = "env" | "cli" | "settings" | "config" | "opencode" | "default";

export const MODEL_STAGES: ReviewModelStage[] = ["review", "coordinator", "walkthrough"];

export const BUILTIN_MODELS: Record<ReviewModelStage, string> = {
  review: "anthropic/claude-opus-5-5",
  coordinator: "anthropic/claude-opus-5-5",
  walkthrough: "anthropic/claude-sonnet-5-5",
};

/** The config and settings field naming each stage's model. */
export const STAGE_SETTING: Record<ReviewModelStage, string> = {
  review: "models.review",
  coordinator: "models.coordinator",
  walkthrough: "models.walkthrough",
};

export const BUILTIN_EFFORT = "medium";
export const DEFAULT_PROVIDER = "anthropic";

const SOURCE_LABELS: Record<ModelSource, string> = {
  env: "REVIEW_* environment variable",
  cli: "--model",
  settings: "settings file",
  config: "~/.config/diffloupe/config.json",
  opencode: "OpenCode default model",
  default: "built-in default",
};

export function describeSource(source: ModelSource): string {
  return SOURCE_LABELS[source];
}

export interface ResolvedModel {
  /** `provider/model` or `provider/model#variant`, as passed to `opencode run --model`. */
  model: string;
  provider: string;
  /** The model id without provider or variant. */
  id: string;
  variant?: string;
  source: ModelSource;
}

export type ResolvedModels = Record<ReviewModelStage, ResolvedModel>;

type StageModels = Partial<Record<ReviewModelStage, string>>;

export interface ModelInputs {
  env?: NodeJS.ProcessEnv;
  cli?: { models?: StageModels; effort?: string };
  settings?: { provider?: string; models?: StageModels; effort?: string };
  config?: { provider?: string; models?: StageModels; effort?: string; opencode?: { useDefaultModel?: boolean } };
  /** `model` from the user's global OpenCode config. */
  openCodeModel?: string;
}

function nonEmpty(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

function envModels(env: NodeJS.ProcessEnv): StageModels {
  const review = nonEmpty(env.REVIEW_MODEL);
  const coordinator = nonEmpty(env.REVIEW_MODEL_MERGE) ?? review;
  const walkthrough = nonEmpty(env.REVIEW_MODEL_WALK);
  return {
    ...(review ? { review } : {}),
    ...(coordinator ? { coordinator } : {}),
    ...(walkthrough ? { walkthrough } : {}),
  };
}

function envEffort(env: NodeJS.ProcessEnv, stage: ReviewModelStage): string | undefined {
  const main = nonEmpty(env.REVIEW_EFFORT);
  return stage === "review" ? main : (nonEmpty(env.REVIEW_EFFORT_AUX) ?? main);
}

/** Splits `provider/model#variant`, prefixing a bare name with `provider`. */
export function parseModelName(name: string, provider: string): { provider: string; id: string; variant?: string } {
  const hash = name.indexOf("#");
  const base = hash === -1 ? name : name.slice(0, hash);
  const variant = hash === -1 ? undefined : nonEmpty(name.slice(hash + 1));
  const slash = base.indexOf("/");
  const p = slash === -1 ? provider : base.slice(0, slash);
  const id = slash === -1 ? base : base.slice(slash + 1);
  return { provider: p, id, ...(variant ? { variant } : {}) };
}

export function resolveProvider(inputs: ModelInputs): string {
  return (
    nonEmpty(inputs.env?.REVIEW_PROVIDER) ??
    nonEmpty(inputs.settings?.provider) ??
    nonEmpty(inputs.config?.provider) ??
    DEFAULT_PROVIDER
  );
}

export function resolveModels(inputs: ModelInputs): ResolvedModels {
  const env = inputs.env ?? {};
  const provider = resolveProvider(inputs);
  const useOpenCode = inputs.config?.opencode?.useDefaultModel !== false;
  const fromEnv = envModels(env);
  const openCodeModel = useOpenCode ? nonEmpty(inputs.openCodeModel) : undefined;

  const out = {} as ResolvedModels;
  for (const stage of MODEL_STAGES) {
    const candidates: [ModelSource, string | undefined][] = [
      ["env", fromEnv[stage]],
      ["cli", inputs.cli?.models?.[stage]],
      ["settings", inputs.settings?.models?.[stage]],
      ["config", inputs.config?.models?.[stage]],
      ["opencode", openCodeModel],
      ["default", BUILTIN_MODELS[stage]],
    ];
    let source: ModelSource = "default";
    let name = BUILTIN_MODELS[stage];
    for (const [s, v] of candidates) {
      const n = nonEmpty(v);
      if (n) {
        source = s;
        name = n;
        break;
      }
    }
    const parsed = parseModelName(name, provider);
    const effort =
      envEffort(env, stage) ??
      nonEmpty(inputs.cli?.effort) ??
      nonEmpty(inputs.settings?.effort) ??
      nonEmpty(inputs.config?.effort) ??
      (source === "default" ? BUILTIN_EFFORT : undefined);
    const variant = parsed.variant ?? effort;
    out[stage] = {
      model: `${parsed.provider}/${parsed.id}${variant ? `#${variant}` : ""}`,
      provider: parsed.provider,
      id: parsed.id,
      ...(variant ? { variant } : {}),
      source,
    };
  }
  return out;
}

/** The distinct providers the stages use, with the stages using each. */
export function providersInUse(
  models: ResolvedModels,
  stages: readonly ReviewModelStage[] = MODEL_STAGES,
): Map<string, ReviewModelStage[]> {
  const out = new Map<string, ReviewModelStage[]>();
  for (const stage of stages) {
    const p = models[stage].provider;
    out.set(p, [...(out.get(p) ?? []), stage]);
  }
  return out;
}
