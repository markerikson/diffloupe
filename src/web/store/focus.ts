import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

export type SidebarMode = "groups" | "findings" | "guide";

export interface FocusState {
  runId: string | null;
  file: string | null;
  finding: string | null;
  stop: string | null;
  /** Which of the current stop's locations is shown. */
  stopLocation: number;
  sidebarMode: SidebarMode;
  showOverCap: boolean;
  helpOpen: boolean;
}

const initialState: FocusState = {
  runId: null,
  file: null,
  finding: null,
  stop: null,
  stopLocation: 0,
  sidebarMode: "groups",
  showOverCap: false,
  helpOpen: false,
};

export const focusSlice = createSlice({
  name: "focus",
  initialState,
  reducers: {
    runEntered(state, action: PayloadAction<string>) {
      if (state.runId === action.payload) return;
      return { ...initialState, runId: action.payload, sidebarMode: state.sidebarMode };
    },
    fileFocused(state, action: PayloadAction<string | null>) {
      state.file = action.payload;
    },
    findingFocused(state, action: PayloadAction<{ id: string | null; file?: string }>) {
      state.finding = action.payload.id;
      if (action.payload.file) state.file = action.payload.file;
      if (action.payload.id) state.stop = null;
    },
    stopFocused(state, action: PayloadAction<{ id: string | null; location?: number; file?: string }>) {
      state.stop = action.payload.id;
      state.stopLocation = action.payload.location ?? 0;
      if (action.payload.file) state.file = action.payload.file;
      if (action.payload.id) state.finding = null;
    },
    sidebarModeSet(state, action: PayloadAction<SidebarMode>) {
      state.sidebarMode = action.payload;
    },
    overCapToggled(state) {
      state.showOverCap = !state.showOverCap;
    },
    helpSet(state, action: PayloadAction<boolean>) {
      state.helpOpen = action.payload;
    },
  },
  selectors: {
    selectFocusedFile: (state) => state.file,
    selectFocusedFinding: (state) => state.finding,
    selectFocusedStop: (state) => state.stop,
    selectStopLocation: (state) => state.stopLocation,
    selectSidebarMode: (state) => state.sidebarMode,
    selectShowOverCap: (state) => state.showOverCap,
    selectHelpOpen: (state) => state.helpOpen,
  },
});

export const { runEntered, fileFocused, findingFocused, stopFocused, sidebarModeSet, overCapToggled, helpSet } =
  focusSlice.actions;

export const {
  selectFocusedFile,
  selectFocusedFinding,
  selectFocusedStop,
  selectStopLocation,
  selectSidebarMode,
  selectShowOverCap,
  selectHelpOpen,
} = focusSlice.selectors;
