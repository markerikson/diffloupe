import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";

export type PatchFiles = ReadonlyMap<string, FileDiffMetadata>;

/**
 * Parses a run's patch into one entry per file, keyed by the head-side path
 * (the base-side path for a deletion), the same key `RunFile.path` uses.
 */
export function parsePatch(patch: string): PatchFiles {
  const out = new Map<string, FileDiffMetadata>();
  for (const p of parsePatchFiles(patch)) for (const f of p.files) out.set(f.name, f);
  return out;
}

const cache = new Map<string, { patch: string; files: PatchFiles }>();

/** `parsePatch`, remembered per run so revisiting a run skips the parse. */
export function parseRunPatch(runId: string, patch: string): PatchFiles {
  const hit = cache.get(runId);
  if (hit && hit.patch === patch) return hit.files;
  const files = parsePatch(patch);
  cache.set(runId, { patch, files });
  return files;
}
