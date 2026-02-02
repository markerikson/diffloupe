import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";
import type { AnalyzeRequest, AnalysisResult } from "../../server/types.js";

// Re-export for convenience
export type { AnalyzeRequest, AnalysisResult } from "../../server/types.js";

export const api = createApi({
  reducerPath: "api",
  baseQuery: fetchBaseQuery({ baseUrl: "/api" }),
  tagTypes: ["Analysis"],
  endpoints: (builder) => ({
    // Synchronous analysis - waits for complete result
    analyzeSync: builder.mutation<AnalysisResult, AnalyzeRequest>({
      query: (body) => ({
        url: "/analyze/sync",
        method: "POST",
        body,
      }),
    }),

    // Get analysis by ID (for async polling workflow)
    getAnalysis: builder.query<AnalysisResult, string>({
      query: (id) => `/analyze/${id}`,
      providesTags: (_result, _error, id) => [{ type: "Analysis", id }],
    }),
  }),
});

export const { useAnalyzeSyncMutation, useGetAnalysisQuery } = api;
