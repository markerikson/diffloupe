import { createRoute, notFound } from "@tanstack/react-router";
import { type } from "arktype";
import { parseRunPatch } from "../lib/patch.ts";
import { RunPage, RunPageSkeleton } from "../pages/RunPage.tsx";
import { api } from "../store/api.ts";
import { filesCollapsedSet, selectCollapsedFiles } from "../store/view.ts";
import { rootRoute, RouteError } from "./root.tsx";

const RunSearchSchema = type({ "file?": "string" });

const isNotFound = (err: unknown) =>
  typeof err === "object" && err !== null && "status" in err && err.status === 404;

export const runRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs/$runId",
  validateSearch: RunSearchSchema,
  loader: async ({ context: { store }, params: { runId } }) => {
    const run = store.dispatch(api.endpoints.getRun.initiate(runId));
    const patch = store.dispatch(api.endpoints.getRunPatch.initiate(runId));
    try {
      const [data, text] = await Promise.all([run.unwrap(), patch.unwrap()]);
      if (selectCollapsedFiles(store.getState(), runId) === undefined) {
        const skipped = data.files.filter((f) => f.classification === "skip").map((f) => f.path);
        store.dispatch(filesCollapsedSet({ runId, paths: skipped }));
      }
      return { files: parseRunPatch(runId, text) };
    } catch (err) {
      if (isNotFound(err)) throw notFound();
      throw err;
    } finally {
      run.unsubscribe();
      patch.unsubscribe();
    }
  },
  pendingComponent: RunPageSkeleton,
  errorComponent: RouteError,
  component: RunPage,
});
