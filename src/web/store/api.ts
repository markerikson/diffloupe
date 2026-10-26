import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";
import { type } from "arktype";
import {
  HealthResponseSchema,
  StartRunResponseSchema,
  type ReviewStage,
  type StartRunRequest,
  type StoredEvent,
} from "../../server/types.ts";
import {
  ReviewRunSchema,
  RunHeaderSchema,
  RunUserStateSchema,
  type ReviewRun,
  type RunUserState,
} from "../../types/review-run.ts";
import { withGroups } from "../../review/run-groups.ts";
import { applyStateOp, type StateOp } from "../../review/state-ops.ts";
import { followRunEvents } from "./run-events.ts";

export interface RunProgress {
  stage?: ReviewStage;
  slicesTotal: number;
  /** Slices that finished successfully; failures are counted separately. */
  slicesDone: number;
  slicesFailed: number;
  /** Titles of slices that have started and not finished. */
  activeSlices: string[];
  costUsd: number;
  /** Latest detail message since the current stage was announced. */
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
  tagTypes: ["Run", "RunList", "RunState"],
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
      // HTTP snapshots do not contain the progress reconstructed from SSE.
      merge(current, incoming) {
        return incoming.status === "running" && current.progress
          ? { ...incoming, progress: current.progress }
          : incoming;
      },
      async onCacheEntryAdded(id, { cacheDataLoaded, cacheEntryRemoved, updateCachedData, dispatch, getCacheEntry }) {
        try {
          await cacheDataLoaded;
        } catch {
          return;
        }
        if (getCacheEntry().data?.status !== "running") return;

        // Titles are display text, not identities: separate slices may share one.
        const slices = new Map<number, Extract<StoredEvent, { type: "slice" }>>();
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
                  if (p.stage !== event.stage) delete p.lastMessage;
                  p.stage = event.stage;
                  break;
                case "slice":
                  slices.set(event.index, event);
                  p.slicesTotal = event.total;
                  p.activeSlices = [];
                  p.slicesDone = 0;
                  p.slicesFailed = 0;
                  for (const slice of slices.values()) {
                    if (slice.status === "started") p.activeSlices.push(slice.title);
                    else if (slice.status === "ok") p.slicesDone += 1;
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
            dispatch(api.util.invalidateTags([{ type: "Run", id }, { type: "RunState", id }, "RunList"]));
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
    getRunState: build.query<RunUserState, string>({
      query: (id) => `/runs/${encodeURIComponent(id)}/state`,
      argSchema: RunIdSchema,
      responseSchema: RunUserStateSchema,
      providesTags: (_result, _error, id) => [{ type: "RunState", id }],
    }),
    /** Applies one change to the run's reviewer state, showing it before the server confirms. */
    updateRunState: build.mutation<RunUserState, { runId: string; op: StateOp }>({
      query: ({ runId, op }) => {
        const base = `/runs/${encodeURIComponent(runId)}/state`;
        if (op.op === "reviewed") {
          return { url: `${base}/files`, method: "PUT", body: { path: op.paths[0], reviewed: op.value } };
        }
        const { status, reason, note } = op;
        return {
          url: `${base}/findings/${encodeURIComponent(op.ids[0] ?? "")}`,
          method: "PUT",
          body: { status, ...(reason ? { reason } : {}), ...(note ? { note } : {}) },
        };
      },
      responseSchema: RunUserStateSchema,
      async onQueryStarted({ runId, op }, { dispatch, getState, queryFulfilled }) {
        const run = api.endpoints.getRun.select(runId)(getState()).data;
        const patch = run
          ? dispatch(
              api.util.updateQueryData("getRunState", runId, (draft) => {
                try {
                  return applyStateOp(draft, op, run);
                } catch {
                  return draft;
                }
              }),
            )
          : undefined;
        try {
          const { data } = await queryFulfilled;
          dispatch(api.util.upsertQueryData("getRunState", runId, data));
        } catch {
          patch?.undo();
        }
      },
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
  useGetRunStateQuery,
  useUpdateRunStateMutation,
  useStartRunMutation,
  useDeleteRunMutation,
} = api;
