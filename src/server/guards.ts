/**
 * Request guards applied before routing. The Host allowlist stops a page on
 * another DNS name that resolves to this machine (DNS rebinding) from reading
 * the API; the Origin check stops cross-site pages from starting, cancelling,
 * or deleting runs. The port is not compared, so forwarded ports still work.
 */
import os from "node:os";
import type { MiddlewareHandler } from "hono";
import { isSameOriginOrNoOrigin } from "./request-origin.ts";

export const ALLOWED_HOSTS_ENV = "DIFFLOUPE_ALLOWED_HOSTS";

const LOOPBACK = ["localhost", "127.0.0.1", "::1"];

/**
 * The hostname a Host header names: lower-cased, without port, brackets, or a
 * trailing dot. `undefined` when there is no header, `null` when malformed.
 */
export function hostnameFromHostHeader(header: string | null | undefined): string | null | undefined {
  const value = header?.trim().toLowerCase();
  if (!value) return undefined;
  let host = value;
  let port: string | undefined;
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close < 0) return null;
    host = value.slice(1, close);
    const rest = value.slice(close + 1);
    if (rest) {
      if (!rest.startsWith(":")) return null;
      port = rest.slice(1);
    }
    if (!host.includes(":") || !/^[0-9a-f:.]+$/.test(host)) return null;
  } else {
    const colon = value.indexOf(":");
    if (colon >= 0) {
      host = value.slice(0, colon);
      port = value.slice(colon + 1);
    }
    if (host.endsWith(".")) host = host.slice(0, -1);
    if (!/^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/.test(host)) return null;
  }
  if (port !== undefined && (!/^\d{1,5}$/.test(port) || Number(port) > 65535)) return null;
  return host;
}

export function isLoopbackHost(host: string): boolean {
  const name = host.replace(/^\[|\]$/g, "").toLowerCase();
  return LOOPBACK.includes(name) || name.startsWith("127.") || name.endsWith(".localhost");
}

/**
 * Hostnames the server answers to: loopback names, `DIFFLOUPE_ALLOWED_HOSTS`,
 * and when bound beyond loopback, the bind address and this machine's
 * interface addresses and hostname.
 */
export function allowedHosts(bindHost: string, env: string | undefined = process.env[ALLOWED_HOSTS_ENV]): Set<string> {
  const hosts = new Set(LOOPBACK);
  for (const entry of (env ?? "").split(",")) {
    const name = hostnameFromHostHeader(entry);
    if (name) hosts.add(name);
  }
  if (!isLoopbackHost(bindHost)) {
    const bind = hostnameFromHostHeader(bindHost.includes(":") && !bindHost.startsWith("[") ? `[${bindHost}]` : bindHost);
    if (bind) hosts.add(bind);
    hosts.add(os.hostname().toLowerCase());
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs ?? []) hosts.add(a.address.toLowerCase());
    }
  }
  return hosts;
}

export function hostGuard(allowed: Set<string>): MiddlewareHandler {
  return async (c, next) => {
    const name = hostnameFromHostHeader(c.req.header("host"));
    if (name === null || (name !== undefined && !allowed.has(name) && !isLoopbackHost(name))) {
      return c.json({ error: "host not allowed" }, 403);
    }
    await next();
  };
}

export function originGuard(): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method;
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      const ok = isSameOriginOrNoOrigin(
        c.req.header("origin"),
        c.req.header("host") ?? "",
        c.req.header("sec-fetch-site"),
      );
      if (!ok) return c.json({ error: "cross-origin request refused" }, 403);
    }
    await next();
  };
}
