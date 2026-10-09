import { describe, expect, test } from "bun:test";
import { allowedHosts, hostnameFromHostHeader, isLoopbackHost } from "./guards.ts";
import { createApp } from "./index.ts";
import { FakeDriver, fakeContext, useTempDataDir } from "./test-helpers.ts";

useTempDataDir();

describe("hostnameFromHostHeader", () => {
  test("parses names, ports, and IPv6 brackets", () => {
    expect(hostnameFromHostHeader(undefined)).toBeUndefined();
    expect(hostnameFromHostHeader("localhost:4517")).toBe("localhost");
    expect(hostnameFromHostHeader("Example.COM.")).toBe("example.com");
    expect(hostnameFromHostHeader("[::1]:4517")).toBe("::1");
    expect(hostnameFromHostHeader("127.0.0.1")).toBe("127.0.0.1");
  });

  test("rejects malformed values", () => {
    expect(hostnameFromHostHeader("[::1")).toBeNull();
    expect(hostnameFromHostHeader("[nothex]")).toBeNull();
    expect(hostnameFromHostHeader("localhost:99999")).toBeNull();
    expect(hostnameFromHostHeader("local host")).toBeNull();
    expect(hostnameFromHostHeader("a@b")).toBeNull();
  });
});

describe("allowedHosts", () => {
  test("loopback binds allow loopback names plus the env list", () => {
    const hosts = allowedHosts("127.0.0.1", "my-box.lan, other:8080");
    expect([...hosts].sort()).toEqual(["127.0.0.1", "::1", "localhost", "my-box.lan", "other"]);
  });

  test("non-loopback binds add the bind address", () => {
    expect(allowedHosts("0.0.0.0", "").has("0.0.0.0")).toBe(true);
  });

  test("isLoopbackHost", () => {
    expect(isLoopbackHost("127.0.0.2")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("app.localhost")).toBe(true);
    expect(isLoopbackHost("evil.example")).toBe(false);
  });
});

describe("request guards", () => {
  const app = createApp(fakeContext(new FakeDriver()));

  test("refuses a Host header that is not allowed", async () => {
    const res = await app.request("/api/health", { headers: { Host: "evil.example:4517" } });
    expect(res.status).toBe(403);
  });

  test("accepts loopback Host headers on any port", async () => {
    for (const host of ["localhost:4517", "127.0.0.1:9999", "[::1]:4517"]) {
      const res = await app.request("/api/health", { headers: { Host: host } });
      expect(res.status).toBe(200);
    }
  });

  test("refuses cross-origin POSTs", async () => {
    const res = await app.request("/api/runs", {
      method: "POST",
      headers: { Host: "localhost:4517", Origin: "https://evil.example", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  test("refuses the null origin", async () => {
    const res = await app.request("/api/runs/x/cancel", {
      method: "POST",
      headers: { Host: "localhost:4517", Origin: "null" },
    });
    expect(res.status).toBe(403);
  });

  test("allows same-origin POSTs", async () => {
    const res = await app.request("/api/runs/x/cancel", {
      method: "POST",
      headers: { Host: "localhost:4517", Origin: "http://localhost:4517" },
    });
    expect(res.status).toBe(404);
  });

  test("sends no CORS headers", async () => {
    const res = await app.request("/api/health", { headers: { Origin: "https://evil.example" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
