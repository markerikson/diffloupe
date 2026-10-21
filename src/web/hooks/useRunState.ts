import { useCallback, useMemo } from "react";
import { emptyState, type StateOp } from "../../review/state-ops.ts";
import type { RunUserState } from "../../types/review-run.ts";
import { useGetRunStateQuery, useUpdateRunStateMutation } from "../store/api.ts";

const EMPTY_STATE = emptyState();

/** The reviewer's triage and reviewed files for a run; empty until loaded. */
export function useRunState(runId: string): RunUserState {
  return useGetRunStateQuery(runId).data ?? EMPTY_STATE;
}

export function useDismissedIds(runId: string): ReadonlySet<string> {
  const state = useRunState(runId);
  return useMemo(
    () => new Set(Object.entries(state.findingStatus).flatMap(([id, s]) => (s === "dismissed" ? [id] : []))),
    [state.findingStatus],
  );
}

/** Sends one state change; the cache shows it right away and rolls back if the server rejects it. */
export function useChangeRunState(runId: string): (op: StateOp) => void {
  const [update] = useUpdateRunStateMutation();
  return useCallback((op: StateOp) => void update({ runId, op }), [runId, update]);
}
