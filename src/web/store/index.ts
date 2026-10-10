import { configureStore, createListenerMiddleware, isAnyOf } from "@reduxjs/toolkit";
import { api } from "./api.ts";
import { focusSlice } from "./focus.ts";
import {
  diffStyleSet,
  fileTreeLayoutSet,
  selectSavedView,
  sidebarToggled,
  STORAGE_KEY,
  themeSet,
  viewSlice,
  wrapToggled,
} from "./view.ts";

const listener = createListenerMiddleware();

export function makeStore() {
  return configureStore({
    reducer: {
      [api.reducerPath]: api.reducer,
      [viewSlice.reducerPath]: viewSlice.reducer,
      [focusSlice.reducerPath]: focusSlice.reducer,
    },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().prepend(listener.middleware).concat(api.middleware),
  });
}

export type AppStore = ReturnType<typeof makeStore>;
export type RootState = ReturnType<AppStore["getState"]>;
export type AppDispatch = AppStore["dispatch"];

listener.startListening.withTypes<RootState, AppDispatch>()({
  matcher: isAnyOf(diffStyleSet, wrapToggled, themeSet, fileTreeLayoutSet, sidebarToggled),
  effect: (_action, { getState }) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(selectSavedView(getState())));
  },
});
