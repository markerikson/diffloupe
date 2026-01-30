import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";

// Types for API responses (matching server types)
export interface AnalysisRequest {
  diff: string;
  context?: string;
}

export interface AnalysisResult {
  id: string;
  status: "pending" | "analyzing" | "complete" | "error";
  intent?: {
    summary: string;
    categories: string[];
    scope: string;
  };
  risks?: Array<{
    severity: "critical" | "high" | "medium" | "low";
    category: string;
    description: string;
    file?: string;
    line?: number;
  }>;
  alignment?: {
    score: number;
    analysis: string;
  };
  error?: string;
}

export const api = createApi({
  reducerPath: "api",
  baseQuery: fetchBaseQuery({ baseUrl: "/api" }),
  tagTypes: ["Analysis"],
  endpoints: (builder) => ({
    // Synchronous analysis - waits for complete result
    analyzeSync: builder.mutation<AnalysisResult, AnalysisRequest>({
      query: (body) => ({
        url: "/analyze",
        method: "POST",
        body,
      }),
    }),

    // Get analysis by ID (for async polling workflow)
    getAnalysis: builder.query<AnalysisResult, string>({
      query: (id) => `/analysis/${id}`,
      providesTags: (_result, _error, id) => [{ type: "Analysis", id }],
    }),
  }),
});

export const { useAnalyzeSyncMutation, useGetAnalysisQuery } = api;
