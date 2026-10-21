/**
 * Changes to a run's reviewer state. Pure, so the server applies them before
 * writing `state.json` and the web UI applies the same ones optimistically.
 */
import { type } from "arktype";
import {
  RunUserStateSchema,
  type DismissReason,
  type FindingStatus,
  type ReviewRun,
  type RunUserState,
} from "../types/review-run.ts";

export type StateOp =
  | {
      op: "finding";
      ids: string[];
      status: FindingStatus;
      reason?: DismissReason | undefined;
      note?: string | undefined;
      at: string;
    }
  | { op: "reviewed"; paths: string[]; value: boolean };

/** An operation that names findings or files the run does not have, or lacks a field it needs. */
export class StateOpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateOpError";
  }
}

export type StateRun = Pick<ReviewRun, "findings" | "overCapFindings" | "files">;

export function emptyState(): RunUserState {
  return { reviewedFiles: {}, findingStatus: {}, comments: [] };
}

/**
 * Validates a parsed `state.json`. Files written before reviewed files were
 * keyed by blob id hold an empty `reviewedFiles` array; that reads as none.
 */
export function parseState(raw: unknown): RunUserState | type.errors {
  const legacy =
    typeof raw === "object" && raw !== null && Array.isArray((raw as { reviewedFiles?: unknown }).reviewedFiles);
  return RunUserStateSchema(legacy ? { ...(raw as object), reviewedFiles: {} } : raw);
}

const ZERO_BLOB = /^0+$/;

function checkKnown(kind: string, names: string[], known: Set<string>): void {
  const unknown = names.filter((name) => !known.has(name));
  if (unknown.length > 0) throw new StateOpError(`unknown ${kind}: ${unknown.join(", ")}`);
}

/**
 * Returns the state after `op`. Setting a finding back to open removes its
 * entry and note; accepting removes the note. Throws `StateOpError` for ids or
 * paths the run does not have, or a dismissal with no reason.
 */
export function applyStateOp(state: RunUserState, op: StateOp, run: StateRun): RunUserState {
  if (op.op === "reviewed") {
    const files = new Map(run.files.map((f) => [f.path, f]));
    checkKnown(op.paths.length === 1 ? "file" : "files", op.paths, new Set(files.keys()));
    const reviewedFiles = { ...state.reviewedFiles };
    for (const p of op.paths) {
      const file = files.get(p);
      if (!op.value) delete reviewedFiles[p];
      else reviewedFiles[p] = file?.status === "removed" || !file?.blob || ZERO_BLOB.test(file.blob) ? "" : file.blob;
    }
    return { ...state, reviewedFiles };
  }

  if (op.ids.length === 0) throw new StateOpError("no finding ids given");
  const known = new Set([...run.findings, ...run.overCapFindings].map((f) => f.id));
  checkKnown(op.ids.length === 1 ? "finding" : "findings", op.ids, known);
  if (op.status === "dismissed" && !op.reason) throw new StateOpError("dismissing a finding needs a reason");

  const findingStatus = { ...state.findingStatus };
  const findingNotes = { ...state.findingNotes };
  for (const id of op.ids) {
    delete findingNotes[id];
    if (op.status === "open") delete findingStatus[id];
    else findingStatus[id] = op.status;
    if (op.status === "dismissed" && op.reason) {
      findingNotes[id] = { reason: op.reason, ...(op.note ? { note: op.note } : {}), at: op.at };
    }
  }
  const next: RunUserState = { ...state, findingStatus, findingNotes };
  if (Object.keys(findingNotes).length === 0) delete next.findingNotes;
  return next;
}

export function isDismissed(state: Pick<RunUserState, "findingStatus"> | undefined, id: string): boolean {
  return state?.findingStatus[id] === "dismissed";
}
