import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { run } from "../review/core/lib/proc.ts";
import { describeSource, MODEL_STAGES } from "../review/models.ts";
import { INSTALL_HINTS } from "../review/run-driver.ts";
import { artifactsDir, dataDir, runsDir, scratchDir } from "../review/run-store.ts";
import { loadReviewSettings, type ReviewSettings } from "../review/settings.ts";
import { resolveRunSetup, type RunSetup } from "../review/setup.ts";
import { loadConfig } from "../services/config.ts";
import pkg from "../../package.json" with { type: "json" };

export type CheckStatus = "ok" | "warn" | "fail";

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorDeps {
  platform: NodeJS.Platform;
  bunVersion: string;
  which: (cmd: string) => string | null;
  /** Exit code and combined output of a command, or null when it could not start. */
  exec: (cmd: string, args: string[]) => Promise<{ code: number; output: string } | null>;
  setup: () => Promise<RunSetup>;
  dataSizes: () => Promise<Record<string, number>>;
}

const MIN_BUN = pkg.engines.bun.replace(/^>=\s*/, "");

/** True when dotted version `a` is at least `b`. */
export function versionAtLeast(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

function firstVersion(output: string): string | null {
  return /\d+\.\d+(?:\.\d+)?/.exec(output)?.[0] ?? null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

async function toolCheck(
  deps: DoctorDeps,
  name: string,
  missing: CheckStatus,
  validate?: (version: string | null) => { status: CheckStatus; note?: string },
): Promise<Check> {
  if (!deps.which(name)) {
    return { name, status: missing, detail: `not found on PATH. Install: ${INSTALL_HINTS[name] ?? name}` };
  }
  const res = await deps.exec(name, ["--version"]);
  const version = res && res.code === 0 ? firstVersion(res.output) : null;
  const verdict = validate?.(version) ?? { status: "ok" };
  const detail = [version ?? "version unknown", verdict.note].filter(Boolean).join(", ");
  return { name, status: verdict.status, detail };
}

export async function runDoctorChecks(deps: DoctorDeps): Promise<Check[]> {
  const checks: Check[] = [];
  if (deps.platform === "win32") {
    checks.push({
      name: "platform",
      status: "fail",
      detail: "Windows is not supported natively. Run DiffLoupe inside WSL.",
    });
  }
  checks.push({
    name: "bun",
    status: versionAtLeast(deps.bunVersion, MIN_BUN) ? "ok" : "fail",
    detail: versionAtLeast(deps.bunVersion, MIN_BUN) ? deps.bunVersion : `${deps.bunVersion}, needs ${MIN_BUN} or newer`,
  });
  checks.push(await toolCheck(deps, "git", "fail"));
  checks.push(
    await toolCheck(deps, "opencode", "fail", (v) =>
      v && v.startsWith("2.")
        ? { status: "ok" }
        : { status: "fail", note: "needs OpenCode 2.x (https://opencode.ai/v2/docs/)" },
    ),
  );
  checks.push(await toolCheck(deps, "tilth", "fail"));

  const gh = await toolCheck(deps, "gh", "warn");
  if (gh.status === "warn") gh.detail += " (only needed to review pull requests)";
  else {
    const auth = await deps.exec("gh", ["auth", "status"]);
    if (!auth || auth.code !== 0) {
      gh.status = "warn";
      gh.detail += ", not logged in: run `gh auth login` to review pull requests";
    } else gh.detail += ", logged in";
  }
  checks.push(gh);

  let setup: RunSetup | undefined;
  try {
    setup = await deps.setup();
  } catch (err) {
    checks.push({ name: "models", status: "fail", detail: err instanceof Error ? err.message : String(err) });
  }
  if (setup) {
    for (const stage of MODEL_STAGES) {
      const m = setup.models[stage];
      checks.push({ name: `model: ${stage}`, status: "ok", detail: `${m.model} (${describeSource(m.source)})` });
    }
    if (!setup.catalog) {
      checks.push({ name: "model catalog", status: "warn", detail: "could not ask OpenCode for its models; not checked" });
    } else {
      for (const e of setup.catalog.errors) checks.push({ name: "model catalog", status: "fail", detail: e });
      if (setup.catalog.zeroCost.length > 0) {
        checks.push({
          name: "model catalog",
          status: "warn",
          detail: `no cost reported for ${setup.catalog.zeroCost.join(", ")}: --max-cost cannot be enforced`,
        });
      }
    }
    for (const c of setup.credentials.coverage) {
      if (c.source === "none") continue;
      checks.push({ name: `credential: ${c.provider}`, status: "ok", detail: `${c.source}: ${c.detail}` });
    }
    for (const w of setup.credentials.warnings) checks.push({ name: "credentials", status: "warn", detail: w });
    for (const e of setup.credentials.errors) checks.push({ name: "credentials", status: "fail", detail: e });
  }

  const sizes = await deps.dataSizes();
  const total = Object.values(sizes).reduce((a, b) => a + b, 0);
  checks.push({
    name: "data dir",
    status: "ok",
    detail: `${dataDir()}: ${formatBytes(total)} (${Object.entries(sizes)
      .map(([k, v]) => `${k} ${formatBytes(v)}`)
      .join(", ")}). \`diffloupe runs prune\` removes old runs`,
  });
  return checks;
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) total += await stat(p).then((s) => s.size, () => 0);
  }
  return total;
}

async function exec(cmd: string, args: string[]): Promise<{ code: number; output: string } | null> {
  try {
    const r = await run(cmd, args, { allowFail: true, timeoutMs: 20_000 });
    return { code: r.code, output: `${r.stdout}\n${r.stderr}` };
  } catch {
    return null;
  }
}

const MARK: Record<CheckStatus, string> = { ok: pc.green("ok  "), warn: pc.yellow("warn"), fail: pc.red("FAIL") };

export function createDoctorCommand(): Command {
  return new Command("doctor")
    .description("Check tools, models, credentials and disk use")
    .option("--config <file>", "Per-repo review settings, as passed to review")
    .action(async (options: { config?: string }) => {
      const checks = await runDoctorChecks({
        platform: process.platform,
        bunVersion: Bun.version,
        which: (cmd) => Bun.which(cmd),
        exec,
        setup: async () => {
          const settings: ReviewSettings = options.config
            ? await loadReviewSettings(path.resolve(options.config))
            : {};
          return resolveRunSetup({ settings, userConfig: await loadConfig() });
        },
        dataSizes: async () => ({
          runs: await dirSize(runsDir()),
          artifacts: await dirSize(artifactsDir()),
          scratch: await dirSize(scratchDir()),
        }),
      });
      for (const c of checks) console.log(`${MARK[c.status]}  ${pc.bold(c.name)}: ${c.detail}`);
      if (checks.some((c) => c.status === "fail")) process.exit(1);
    });
}
