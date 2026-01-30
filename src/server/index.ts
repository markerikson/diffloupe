/**
 * DiffLoupe Server - HTTP API for diff analysis
 *
 * This server exposes the CLI's analysis functionality via HTTP endpoints,
 * allowing the web UI to use the existing analysis pipeline.
 *
 * Architecture:
 * - Server handles ALL business logic (git, LLM, analysis)
 * - Web UI is a pure API client
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import type { HealthResponse } from "./types.js";
import { analyzeRoutes } from "./routes/analyze.js";

/** Create and configure the Hono app */
export function createApp() {
  const app = new Hono();

  // Enable CORS for dev (allow localhost origins)
  app.use(
    "/api/*",
    cors({
      origin: (origin) => {
        // Allow localhost on any port for development
        if (!origin || origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:")) {
          return origin || "*";
        }
        return null;
      },
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type"],
    })
  );

  // Health check endpoint
  app.get("/api/health", (c) => {
    return c.json({ status: "ok" } satisfies HealthResponse);
  });

  // Mount analyze routes
  app.route("/api/analyze", analyzeRoutes);

  return app;
}

/** Default port for the server */
export const DEFAULT_PORT = 3000;

/**
 * Start the server on the specified port.
 *
 * @param port - Port to listen on (defaults to 3000)
 * @returns Server info including the actual port
 */
export function startServer(port = DEFAULT_PORT): { port: number } {
  const app = createApp();

  Bun.serve({
    port,
    fetch: app.fetch,
  });

  return { port };
}

// Export app for direct use
export const app = createApp();

// Export types
export type { HealthResponse, AnalyzeRequest, AnalysisResult, JobStatusResponse } from "./types.js";
