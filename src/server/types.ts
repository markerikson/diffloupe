/**
 * Server Types - Type definitions for the HTTP API
 */

/** Health check response */
export interface HealthResponse {
  status: "ok";
}

/** Error response */
export interface ErrorResponse {
  error: string;
  code?: string;
}
