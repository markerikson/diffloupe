import { describe, expect, it } from "vitest";
import {
  expandFile,
  inferAliases,
  ModuleResolver,
  packageName,
  parseJsonc,
  projectFilesFromMap,
  type ImportRef,
} from "./module-resolver.ts";

function project(files: Record<string, string>) {
  return projectFilesFromMap(new Map(Object.entries(files)));
}

function resolver(files: Record<string, string>, infer?: ImportRef[]) {
  return ModuleResolver.create(project(files), infer ? { infer } : {});
}

describe("expandFile", () => {
  const files = new Set(["src/a.ts", "src/b/index.tsx", "src/c.tsx"]);

  it("tries extensions, index files and .js-to-.ts swaps", () => {
    expect(expandFile("src/a", files)).toBe("src/a.ts");
    expect(expandFile("./src/b", files)).toBe("src/b/index.tsx");
    expect(expandFile("src/a.js", files)).toBe("src/a.ts");
    expect(expandFile("src/c.js", files)).toBe("src/c.tsx");
    expect(expandFile("src/missing", files)).toBeUndefined();
    expect(expandFile("../a", files)).toBeUndefined();
  });
});

describe("parseJsonc", () => {
  it("strips comments and trailing commas but not slashes inside strings", () => {
    const text = `{
      // line
      "a": "http://x/*y*/", /* block */
      "b": [1, 2,],
    }`;
    expect(parseJsonc(text)).toEqual({ a: "http://x/*y*/", b: [1, 2] });
  });

  it("returns undefined for invalid input", () => {
    expect(parseJsonc("{nope")).toBeUndefined();
  });
});

describe("packageName", () => {
  it("keeps the scope", () => {
    expect(packageName("@scope/pkg/sub/x")).toBe("@scope/pkg");
    expect(packageName("lodash/get")).toBe("lodash");
  });
});

describe("ModuleResolver", () => {
  it("resolves relative imports", () => {
    const r = resolver({ "src/a.ts": "", "src/b.ts": "" });
    expect(r.resolve("./b.js", "src/a.ts")).toEqual({ path: "src/b.ts", via: "relative" });
  });

  it("follows tsconfig paths through extends, with comments", () => {
    const r = resolver({
      "tsconfig.base.json": `{ "compilerOptions": { "baseUrl": ".", /* x */ "paths": { "@/*": ["src/*"] } } }`,
      "tsconfig.json": `{ "extends": "./tsconfig.base.json", }`,
      "src/components/Button.tsx": "",
    });
    expect(r.resolve("@/components/Button", "src/app.ts")).toEqual({
      path: "src/components/Button.tsx",
      via: "tsconfig",
    });
  });

  it("resolves paths relative to baseUrl in a nested project", () => {
    const r = resolver({
      "apps/web/tsconfig.json": `{ "compilerOptions": { "baseUrl": "./src", "paths": { "~/*": ["*"] } } }`,
      "apps/web/src/lib/db.ts": "",
      "apps/web/src/utils/fmt.ts": "",
    });
    expect(r.resolve("~/lib/db", "apps/web/src/page.ts")?.path).toBe("apps/web/src/lib/db.ts");
    expect(r.resolve("utils/fmt", "apps/web/src/page.ts")).toEqual({
      path: "apps/web/src/utils/fmt.ts",
      via: "base-url",
    });
  });

  it("prefers the most specific paths pattern", () => {
    const r = resolver({
      "tsconfig.json": `{ "compilerOptions": { "paths": { "@app/*": ["src/*"], "@app/special/*": ["special/*"] } } }`,
      "src/special/x.ts": "",
      "special/x.ts": "",
    });
    expect(r.resolve("@app/special/x", "src/a.ts")?.path).toBe("special/x.ts");
  });

  it("uses paths from referenced projects when the solution config has none", () => {
    const r = resolver({
      "tsconfig.json": `{ "files": [], "references": [{ "path": "./tsconfig.app.json" }] }`,
      "tsconfig.app.json": `{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }`,
      "src/x.ts": "",
    });
    expect(r.resolve("@/x", "src/main.ts")?.path).toBe("src/x.ts");
  });

  it("resolves package.json subpath imports", () => {
    const r = resolver({
      "package.json": JSON.stringify({ name: "app", imports: { "#lib/*": "./src/lib/*.ts" } }),
      "src/lib/log.ts": "",
    });
    expect(r.resolve("#lib/log", "src/a.ts")).toEqual({ path: "src/lib/log.ts", via: "package-imports" });
  });

  it("maps workspace packages from build output back to source", () => {
    const r = resolver({
      "package.json": JSON.stringify({ name: "root", dependencies: { "@acme/ui": "workspace:*" } }),
      "packages/ui/package.json": JSON.stringify({ name: "@acme/ui", main: "dist/index.js" }),
      "packages/ui/src/index.ts": "",
      "packages/ui/src/button.ts": "",
      "packages/proto/package.json": JSON.stringify({ name: "@acme/proto", main: "js/index.js" }),
      "packages/proto/ts/index.ts": "",
    });
    expect(r.resolve("@acme/ui", "app/a.ts")).toEqual({ path: "packages/ui/src/index.ts", via: "workspace" });
    expect(r.resolve("@acme/ui/button", "app/a.ts")?.path).toBe("packages/ui/src/button.ts");
    expect(r.resolve("@acme/proto", "app/a.ts")?.path).toBe("packages/proto/ts/index.ts");
  });

  it("treats a workspace import it cannot map as external, not as an alias", () => {
    const r = resolver(
      {
        "package.json": JSON.stringify({ name: "root", dependencies: { "@acme/gen": "workspace:*" } }),
        "packages/gen/package.json": JSON.stringify({ name: "@acme/gen", main: "out/index.js" }),
        "src/index.ts": "",
      },
      [{ from: "src/a.ts", spec: "@acme/gen" }],
    );
    expect(r.resolve("@acme/gen", "src/a.ts")).toBeUndefined();
    expect(r.isExternal("@acme/gen")).toBe(true);
  });

  it("knows dependencies, builtins and node_modules paths are external", () => {
    const r = resolver({
      "package.json": JSON.stringify({ dependencies: { react: "19" } }),
      "node_modules/@sentry/browser/index.js": "",
    });
    expect(r.isExternal("react")).toBe(true);
    expect(r.isExternal("node:fs")).toBe(true);
    expect(r.isExternal("path")).toBe(true);
    expect(r.isExternal("@sentry/browser")).toBe(true);
    expect(r.isExternal("@/x")).toBe(false);
  });

  it("infers `@/` when there is no configuration, as with sources recovered from source maps", () => {
    const files = { "src/components/Button.tsx": "", "src/lib/api.ts": "", "src/app.tsx": "" };
    const infer = [
      { from: "src/app.tsx", spec: "@/components/Button" },
      { from: "src/app.tsx", spec: "@/lib/api" },
    ];
    const r = resolver(files, infer);
    expect(r.aliases).toEqual([{ scope: "", prefix: "@/", root: "src/", hits: 2, total: 2 }]);
    expect(r.resolve("@/lib/api", "src/x.ts")).toEqual({ path: "src/lib/api.ts", via: "inferred" });
  });

  it("infers bare baseUrl-style paths by first segment", () => {
    const files = { "src/ui/actions/app.ts": "", "src/ui/state/index.ts": "", "src/main.ts": "" };
    const r = resolver(files, [
      { from: "src/main.ts", spec: "ui/actions/app" },
      { from: "src/main.ts", spec: "ui/state" },
      { from: "src/main.ts", spec: "lodash/get" },
    ]);
    expect(r.aliases).toEqual([{ scope: "", prefix: "ui/", root: "src/ui/", hits: 2, total: 2 }]);
    expect(r.resolve("ui/state", "src/main.ts")?.path).toBe("src/ui/state/index.ts");
    expect(r.resolve("lodash/get", "src/main.ts")).toBeUndefined();
  });

  it("gives each package in a monorepo its own `@/`", () => {
    const files = {
      "apps/a/package.json": "{}",
      "apps/b/package.json": "{}",
      "apps/a/src/store.ts": "",
      "apps/a/src/api.ts": "",
      "apps/b/src/store.ts": "",
      "apps/b/src/api.ts": "",
    };
    const r = resolver(files, [
      { from: "apps/a/src/x.ts", spec: "@/store" },
      { from: "apps/a/src/x.ts", spec: "@/api" },
      { from: "apps/b/src/x.ts", spec: "@/store" },
      { from: "apps/b/src/x.ts", spec: "@/api" },
    ]);
    expect(r.resolve("@/store", "apps/a/src/y.ts")?.path).toBe("apps/a/src/store.ts");
    expect(r.resolve("@/store", "apps/b/src/y.ts")?.path).toBe("apps/b/src/store.ts");
  });
});

describe("inferAliases", () => {
  const scopeOf = () => "";

  it("does not infer a scoped npm package from one local file match", () => {
    const files = new Set(["src/utils/index.ts"]);
    expect(inferAliases([{ from: "src/a.ts", spec: "@sentry/utils" }], files, scopeOf)).toEqual([]);
  });

  it("does not map an npm-style scope onto the repository root", () => {
    const files = new Set(["core/a.ts", "core/b.ts"]);
    const refs = [
      { from: "x.ts", spec: "@acme/core/a" },
      { from: "x.ts", spec: "@acme/core/b" },
    ];
    expect(inferAliases(refs, files, scopeOf)).toEqual([]);
  });

  it("refuses a tie between two roots", () => {
    const files = new Set(["src/a.ts", "lib/a.ts", "src/b.ts", "lib/b.ts"]);
    const refs = [
      { from: "x.ts", spec: "@/a" },
      { from: "x.ts", spec: "@/b" },
    ];
    expect(inferAliases(refs, files, scopeOf)).toEqual([]);
  });

  it("refuses a root that explains under 60% of the prefix", () => {
    const files = new Set(["src/a.ts", "src/b.ts"]);
    const refs = ["a", "b", "c", "d"].map((s) => ({ from: "x.ts", spec: `~/${s}` }));
    expect(inferAliases(refs, files, scopeOf)).toEqual([]);
  });
});
