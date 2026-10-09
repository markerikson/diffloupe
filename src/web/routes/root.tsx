import { createRootRouteWithContext, Link, Outlet, useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { lazy, Suspense, useEffect } from "react";
import { useAppSelector } from "../store/hooks.ts";
import type { AppStore } from "../store/index.ts";
import { selectTheme } from "../store/view.ts";
import styles from "./root.module.css";

export interface RouterContext {
  store: AppStore;
}

const RouterDevtools = import.meta.env.DEV
  ? lazy(() => import("@tanstack/react-router-devtools").then((m) => ({ default: m.TanStackRouterDevtools })))
  : () => null;

function useThemeAttribute() {
  const theme = useAppSelector(selectTheme);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") delete root.dataset.theme;
    else root.dataset.theme = theme;
  }, [theme]);
}

function RootLayout() {
  useThemeAttribute();
  return (
    <>
      <Outlet />
      <Suspense>
        <RouterDevtools position="bottom-right" />
      </Suspense>
    </>
  );
}

function NotFound() {
  return (
    <main className={styles.message}>
      <h1>Not found</h1>
      <p>There is nothing at this address.</p>
      <Link to="/">Back to runs</Link>
    </main>
  );
}

export function RouteError({ error }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <main className={styles.message}>
      <h1>Something went wrong</h1>
      <pre className={styles.error}>{errorMessage(error)}</pre>
      <div className={styles.actions}>
        <button type="button" className={styles.button} onClick={() => void router.invalidate()}>
          Retry
        </button>
        <Link to="/">Back to runs</Link>
      </div>
    </main>
  );
}

/** Formats thrown values, including RTK Query errors, for display. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const e = error as { status?: unknown; data?: unknown; error?: unknown };
    if (e.data && typeof e.data === "object" && "error" in e.data) return String(e.data.error);
    if (typeof e.error === "string") return e.error;
    if (e.status !== undefined) return `Request failed (${String(e.status)})`;
  }
  return String(error);
}

export const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  notFoundComponent: NotFound,
  errorComponent: RouteError,
});
