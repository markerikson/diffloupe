import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";
import { type } from "arktype";
import {
  HealthResponseSchema,
  StartRunResponseSchema,
  type ReviewStage,
  type StartRunRequest,
} from "../../server/types.ts";
import { ReviewRunSchema, RunHeaderSchema, type ReviewRun } from "../../types/review-run.ts";
import { withGroups } from "../../review/run-groups.ts";
import { followRunEvents } from "./run-events.ts";

export interface RunProgress {
  stage?: ReviewStage;
  slicesTotal: number;
  slicesDone: number;
  slicesFailed: number;
  /** Titles of slices that have started and not finished. */
  activeSlices: string[];
  costUsd: number;
  lastMessage?: string;
}

export type RunWithProgress = ReviewRun & { progress?: RunProgress };

const RunIdSchema = type("string > 0");

const emptyProgress = (): RunProgress => ({
  slicesTotal: 0,
  slicesDone: 0,
  slicesFailed: 0,
  activeSlices: [],
  costUsd: 0,
});

export const api = createApi({
  reducerPath: "api",
  baseQuery: fetchBaseQuery({ baseUrl: "/api" }),
  tagTypes: ["Run", "RunList"],
  onSchemaFailure: (error, info) => {
    console.error(`[diffloupe] ${info.endpoint} ${error.schemaName} failed:`, error.issues);
  },
  catchSchemaFailure: (error, info) => ({
    status: "CUSTOM_ERROR" as const,
    error: `${info.endpoint} returned data that does not match the expected shape: ${error.message}`,
  }),
  endpoints: (build) => ({
    getHealth: build.query({
      query: (_arg: void) => "/health",
      responseSchema: HealthResponseSchema,
    }),
    listRuns: build.query({
      query: (_arg: void) => "/runs",
      responseSchema: RunHeaderSchema.array(),
      providesTags: ["RunList"],
    }),
    getRun: build.query<RunWithProgress, string>({
      query: (id) => `/runs/${encodeURIComponent(id)}`,
      argSchema: RunIdSchema,
      responseSchema: ReviewRunSchema,
      providesTags: (_result, _error, id) => [{ type: "Run", id }],
      async onCacheEntryAdded(id, { cacheDataLoaded, cacheEntryRemoved, updateCachedData, dispatch, getCacheEntry }) {
        try {
          await cacheDataLoaded;
        } catch {
          return;
        }
        if (getCacheEntry().data?.status !== "running") return;

        const stop = followRunEvents(id, {
          onEvent(event) {
            if (event.type === "groups") {
              updateCachedData((draft) => {
                const next = withGroups(draft, event);
                draft.groups = next.groups;
                draft.files = next.files;
              });
              return;
            }
            updateCachedData((draft) => {
              const p = (draft.progress ??= emptyProgress());
              switch (event.type) {
                case "stage":
                  p.stage = event.stage;
                  break;
                case "slice":
                  p.slicesTotal = event.total;
                  if (event.status === "started") p.activeSlices.push(event.title);
                  else {
                    p.activeSlices = p.activeSlices.filter((t) => t !== event.title);
                    if (event.status === "ok") p.slicesDone += 1;
                    else p.slicesFailed += 1;
                  }
                  if (event.costUsd !== undefined) p.costUsd = Math.max(p.costUsd, event.costUsd);
                  break;
                case "cost":
                  p.costUsd = event.totalUsd;
                  break;
                case "log":
                  p.lastMessage = event.message;
                  break;
                case "budget":
                  p.lastMessage = `Budget reached: $${event.totalUsd.toFixed(2)} of $${event.limitUsd.toFixed(2)}`;
                  break;
                default:
                  break;
              }
            });
          },
          onEnd() {
            dispatch(api.util.invalidateTags([{ type: "Run", id }, "RunList"]));
          },
        });
        await cacheEntryRemoved;
        stop();
      },
    }),
    getRunPatch: build.query<string, string>({
      query: (id) => ({ url: `/runs/${encodeURIComponent(id)}/diff`, responseHandler: "text" }),
      argSchema: RunIdSchema,
      providesTags: (_result, _error, id) => [{ type: "Run", id }],
    }),
    startRun: build.mutation({
      query: (body: StartRunRequest) => ({ url: "/runs", method: "POST", body }),
      responseSchema: StartRunResponseSchema,
      invalidatesTags: ["RunList"],
    }),
    deleteRun: build.mutation<{ removed: boolean }, string>({
      query: (id) => ({ url: `/runs/${encodeURIComponent(id)}`, method: "DELETE" }),
      argSchema: RunIdSchema,
      invalidatesTags: ["RunList"],
    }),
  }),
});

export const {
  useGetHealthQuery,
  useListRunsQuery,
  useGetRunQuery,
  useGetRunPatchQuery,
  useStartRunMutation,
  useDeleteRunMutation,
} = api;
