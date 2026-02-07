import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";
import type {
  AnalyzeRequest,
  AnalysisResult,
  CreateJobResponse,
  JobStatusResponse,
} from "../../server/types.js";

// Re-export for convenience
export type {
  AnalyzeRequest,
  AnalysisResult,
  JobStatusResponse,
  AnalysisProgress,
} from "../../server/types.js";

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

    // Start async analysis - returns job ID immediately
    startAnalysis: builder.mutation<CreateJobResponse, AnalyzeRequest>({
      query: (body) => ({
        url: "/analyze",
        method: "POST",
        body,
      }),
    }),

    // Get analysis job status (for async polling workflow)
    getAnalysisStatus: builder.query<JobStatusResponse, string>({
      query: (id) => `/analyze/${id}`,
      providesTags: (_result, _error, id) => [{ type: "Analysis", id }],
    }),
  }),
});

export const {
  useAnalyzeSyncMutation,
  useStartAnalysisMutation,
  useGetAnalysisStatusQuery,
} = api;
