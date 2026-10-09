import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "./index.ts";
import { findWebDir } from "./static.ts";
import { FakeDriver, fakeContext, useTempDataDir } from "./test-helpers.ts";

useTempDataDir();

let webDir = "";

beforeAll(async () => {
  webDir = await mkdtemp(path.join(os.tmpdir(), "diffloupe-web-"));
  await mkdir(path.join(webDir, "assets"));
  await writeFile(path.join(webDir, "index.html"), "<html>app</html>");
  await writeFile(path.join(webDir, "assets", "main-abc.js"), "console.log(1)");
  await writeFile(path.join(webDir, "favicon.svg"), "<svg/>");
});

afterAll(async () => {
  await rm(webDir, { recursive: true, force: true });
});

function app(dir: string | null) {
  return createApp({ ...fakeContext(new FakeDriver()), webDir: dir });
}

describe("static UI", () => {
  test("serves hashed assets with a long cache", async () => {
    const res = await app(webDir).request("/assets/main-abc.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("console.log(1)");
    expect(res.headers.get("cache-control")).toContain("immutable");
  });

  test("serves other files without a long cache", async () => {
    const res = await app(webDir).request("/favicon.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  test("falls back to index.html for client routes", async () => {
    for (const p of ["/", "/runs/abc", "/runs/abc/files/"]) {
      const res = await app(webDir).request(p);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("<html>app</html>");
      expect(res.headers.get("cache-control")).toBe("no-cache");
    }
  });

  test("missing assets are 404, not index.html", async () => {
    expect((await app(webDir).request("/assets/missing.js")).status).toBe(404);
  });

  test("rejects path traversal", async () => {
    const encodedSlash = await app(webDir).request("/..%2f..%2f..%2fetc%2fpasswd");
    expect(encodedSlash.status).toBe(404);
    const dotSegments = await app(webDir).request("/%2e%2e/%2e%2e/etc/passwd");
    expect(await dotSegments.text()).toBe("<html>app</html>");
  });

  test("unknown /api paths are JSON 404s, not the UI", async () => {
    const res = await app(webDir).request("/api/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  test("serves the status page when there is no build", async () => {
    const res = await app(null).request("/runs/abc");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("EventSource");
  });

  test("findWebDir prefers the env override, then web/ beside the module", () => {
    const saved = process.env.DIFFLOUPE_WEB_DIR;
    try {
      process.env.DIFFLOUPE_WEB_DIR = webDir;
      expect(findWebDir("/nowhere")).toBe(webDir);
      delete process.env.DIFFLOUPE_WEB_DIR;
      expect(findWebDir(path.dirname(webDir).concat("/does-not-exist"))).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.DIFFLOUPE_WEB_DIR;
      else process.env.DIFFLOUPE_WEB_DIR = saved;
    }
  });
});
