/**
 * Serves the built web UI from `webDir`, or a small status page when there
 * is no build. Requests under /api never reach here.
 */
import path from "node:path";
import { existsSync } from "node:fs";
import type { Context } from "hono";
import { STATUS_PAGE } from "./status-page.ts";

/**
 * The built UI directory: `DIFFLOUPE_WEB_DIR`, else `web/` beside the bundle
 * (dist/web), else null.
 */
export function findWebDir(moduleDir: string = import.meta.dir): string | null {
  const fromEnv = process.env.DIFFLOUPE_WEB_DIR;
  if (fromEnv) return path.resolve(fromEnv);
  for (const dir of [path.join(moduleDir, "web"), path.resolve(moduleDir, "../../dist/web")]) {
    if (existsSync(path.join(dir, "index.html"))) return dir;
  }
  return null;
}

export async function serveStatic(c: Context, webDir: string | null): Promise<Response> {
  if (!webDir) return c.html(STATUS_PAGE, 200, { "Cache-Control": "no-cache" });

  let rel: string;
  try {
    rel = decodeURIComponent(new URL(c.req.url).pathname);
  } catch {
    return c.text("bad path", 400);
  }
  const root = path.resolve(webDir);
  const file = path.resolve(root, `.${rel}`);
  if (file !== root && !file.startsWith(root + path.sep)) return c.text("not found", 404);

  if (file !== root && !rel.endsWith("/")) {
    const asset = Bun.file(file);
    if (await asset.exists()) {
      const immutable = rel.startsWith("/assets/");
      return new Response(asset, {
        headers: { "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache" },
      });
    }
    // A missing file with an extension is a missing asset, not a client route.
    if (path.extname(rel)) return c.text("not found", 404);
  }

  const index = Bun.file(path.join(root, "index.html"));
  if (!(await index.exists())) return c.text("web UI not built", 404);
  return new Response(index, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
}
