import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Provider } from "react-redux";
import "./tokens.css";
import "./globals.css";
import { createAppRouter } from "./router.tsx";
import { makeStore } from "./store/index.ts";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

const store = makeStore();
const router = createAppRouter(store);
const poolOptions = {
  workerFactory: () => new DiffsWorker(),
  poolSize: Math.min(4, Math.max(1, navigator.hardwareConcurrency - 1)),
};

createRoot(root).render(
  <StrictMode>
    <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={{}}>
      <Provider store={store}>
        <RouterProvider router={router} />
      </Provider>
    </WorkerPoolContextProvider>
  </StrictMode>,
);
