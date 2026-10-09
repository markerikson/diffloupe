import { createRoute } from "@tanstack/react-router";
import { RunsPage } from "../pages/RunsPage.tsx";
import { api } from "../store/api.ts";
import { rootRoute } from "./root.tsx";

export const runsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  loader: async ({ context: { store } }) => {
    const sub = store.dispatch(api.endpoints.listRuns.initiate());
    try {
      await sub.unwrap();
    } finally {
      sub.unsubscribe();
    }
  },
  component: RunsPage,
});
