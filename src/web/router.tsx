import { createRouter } from "@tanstack/react-router";
import { rootRoute } from "./routes/root.tsx";
import { runRoute } from "./routes/run.tsx";
import { runsRoute } from "./routes/runs.tsx";
import type { AppStore } from "./store/index.ts";

const routeTree = rootRoute.addChildren([runsRoute, runRoute]);

export function createAppRouter(store: AppStore) {
  return createRouter({
    routeTree,
    context: { store },
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
