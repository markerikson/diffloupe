import { describe, expect, test } from "bun:test";
import { BUILTIN_MODELS } from "../review/models.ts";
import type { RunSetup } from "../review/setup.ts";
import { doctorFails, formatBytes, runDoctorChecks, versionAtLeast, type DoctorDeps } from "./doctor.ts";

describe("doctorFails", () => {
  test("warnings fail only under --strict", () => {
    const checks = [{ status: "ok" as const }, { status: "warn" as const }];
    expect(doctorFails(checks, false)).toBe(false);
    expect(doctorFails(checks, true)).toBe(true);
    expect(doctorFails([{ status: "fail" as const }], false)).toBe(true);
  });
});

const setup: RunSetup = {
  provider: "anthropic",
  models: {
    review: { model: BUILTIN_MODELS.review, provider: "anthropic", id: "claude-opus-5-5", source: "default" },
    coordinator: { model: BUILTIN_MODELS.coordinator, provider: "anthropic", id: "claude-opus-5-5", source: "default" },
    walkthrough: { model: BUILTIN_MODELS.walkthrough, provider: "anthropic", id: "claude-sonnet-5-5", source: "default" },
    intent: { model: BUILTIN_MODELS.intent, provider: "anthropic", id: "claude-haiku-5-5", source: "default" },
  },
  openCodeUser: {},
  credentials: {
    childEnv: {},
    imports: [],
    coverage: [{ provider: "anthropic", stages: ["review"], source: "env", detail: "ANTHROPIC_API_KEY" }],
    warnings: [],
    errors: [],
  },
  catalog: { errors: [], zeroCost: [] },
};

const VERSIONS: Record<string, string> = {
  git: "git version 2.50.1",
  opencode: "2.0.26",
  tilth: "tilth 0.9.0",
  gh: "gh version 2.96.0 (2026-09-01)",
};

function deps(over: Partial<DoctorDeps> & { missing?: string[]; ghAuthed?: boolean } = {}): DoctorDeps {
  const { missing = [], ghAuthed = true, ...rest } = over;
  return {
    platform: "linux",
    bunVersion: "1.4.0",
    which: (cmd) => (missing.includes(cmd) ? null : `/usr/bin/${cmd}`),
    exec: async (cmd, args) =>
      args[0] === "auth" ? { code: ghAuthed ? 0 : 1, output: "" } : { code: 0, output: VERSIONS[cmd] ?? "" },
    setup: async () => setup,
    dataSizes: async () => ({ runs: 2048, artifacts: 0, scratch: 3 * 1024 * 1024 }),
    ...rest,
  };
}

const byName = (checks: Awaited<ReturnType<typeof runDoctorChecks>>, name: string) =>
  checks.find((c) => c.name === name);

describe("doctor", () => {
  test("everything present", async () => {
    const checks = await runDoctorChecks(deps());
    expect(checks.every((c) => c.status === "ok")).toBe(true);
    expect(byName(checks, "opencode")?.detail).toBe("2.0.26");
    expect(byName(checks, "model: walkthrough")?.detail).toBe("anthropic/claude-sonnet-5-5 (built-in default)");
    expect(byName(checks, "credential: anthropic")?.detail).toBe("env: ANTHROPIC_API_KEY");
    expect(byName(checks, "data dir")?.detail).toContain("scratch 3.0 MB");
  });

  test("missing required tools fail, missing or logged-out gh warns", async () => {
    const checks = await runDoctorChecks(deps({ missing: ["tilth", "gh"] }));
    expect(byName(checks, "tilth")?.status).toBe("fail");
    expect(byName(checks, "tilth")?.detail).toContain("cargo install tilth");
    expect(byName(checks, "gh")?.status).toBe("warn");

    const loggedOut = await runDoctorChecks(deps({ ghAuthed: false }));
    expect(byName(loggedOut, "gh")?.status).toBe("warn");
    expect(byName(loggedOut, "gh")?.detail).toContain("gh auth login");
  });

  test("OpenCode 1.x, old Bun, and Windows fail", async () => {
    const checks = await runDoctorChecks(
      deps({
        platform: "win32",
        bunVersion: "1.2.9",
        exec: async (cmd) => ({ code: 0, output: cmd === "opencode" ? "1.14.2" : (VERSIONS[cmd] ?? "") }),
      }),
    );
    expect(byName(checks, "platform")?.detail).toContain("WSL");
    expect(byName(checks, "bun")?.status).toBe("fail");
    expect(byName(checks, "opencode")?.status).toBe("fail");
  });

  test("credential and catalog errors fail", async () => {
    const broken: RunSetup = {
      ...setup,
      credentials: { ...setup.credentials, errors: ["No credential for provider `openai`"] },
      catalog: { errors: ["Model `anthropic/x` is not available"], zeroCost: ["review"] },
    };
    const checks = await runDoctorChecks(deps({ setup: async () => broken }));
    const statuses = checks.filter((c) => c.name === "credentials" || c.name === "model catalog").map((c) => c.status);
    expect(statuses.toSorted()).toEqual(["fail", "fail", "warn"]);
  });

  test("helpers", () => {
    expect(versionAtLeast("1.3.0", "1.3.0")).toBe(true);
    expect(versionAtLeast("1.10.0", "1.3.0")).toBe(true);
    expect(versionAtLeast("1.2.99", "1.3")).toBe(false);
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });
});
