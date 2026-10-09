import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

export type DiffStyle = "split" | "unified";
export type ThemeSetting = "system" | "light" | "dark";
export type FileTreeLayout = "tree" | "list";

export interface ViewState {
  diffStyle: DiffStyle;
  wrap: boolean;
  theme: ThemeSetting;
  fileTreeLayout: FileTreeLayout;
  sidebar: boolean;
  /** Collapsed file paths per run, for this visit only. */
  collapsedFiles: Record<string, string[]>;
  /** Group ids whose subgroups are folded in the sidebar, per run. */
  collapsedGroups: Record<string, string[]>;
}

export type SavedView = Pick<ViewState, "diffStyle" | "wrap" | "theme" | "fileTreeLayout" | "sidebar">;

export const STORAGE_KEY = "diffloupe:view";

const defaults: ViewState = {
  diffStyle: "split",
  wrap: false,
  theme: "system",
  fileTreeLayout: "tree",
  sidebar: true,
  collapsedFiles: {},
  collapsedGroups: {},
};

export function loadSavedView(): Partial<SavedView> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!raw || typeof raw !== "object") return {};
    const r = raw as Record<string, unknown>;
    const out: Partial<SavedView> = {};
    if (r.diffStyle === "split" || r.diffStyle === "unified") out.diffStyle = r.diffStyle;
    if (typeof r.wrap === "boolean") out.wrap = r.wrap;
    if (r.theme === "system" || r.theme === "light" || r.theme === "dark") out.theme = r.theme;
    if (r.fileTreeLayout === "tree" || r.fileTreeLayout === "list") out.fileTreeLayout = r.fileTreeLayout;
    if (typeof r.sidebar === "boolean") out.sidebar = r.sidebar;
    return out;
  } catch {
    return {};
  }
}

function toggleIn(list: string[] | undefined, item: string): string[] {
  const current = list ?? [];
  return current.includes(item) ? current.filter((x) => x !== item) : [...current, item];
}

export const viewSlice = createSlice({
  name: "view",
  initialState: (): ViewState => ({ ...defaults, ...loadSavedView() }),
  reducers: {
    diffStyleSet(state, action: PayloadAction<DiffStyle>) {
      state.diffStyle = action.payload;
    },
    wrapToggled(state) {
      state.wrap = !state.wrap;
    },
    themeSet(state, action: PayloadAction<ThemeSetting>) {
      state.theme = action.payload;
    },
    fileTreeLayoutSet(state, action: PayloadAction<FileTreeLayout>) {
      state.fileTreeLayout = action.payload;
    },
    sidebarToggled(state) {
      state.sidebar = !state.sidebar;
    },
    filesCollapsedSet(state, action: PayloadAction<{ runId: string; paths: string[] }>) {
      state.collapsedFiles[action.payload.runId] = action.payload.paths;
    },
    fileCollapseToggled(state, action: PayloadAction<{ runId: string; path: string }>) {
      const { runId, path } = action.payload;
      state.collapsedFiles[runId] = toggleIn(state.collapsedFiles[runId], path);
    },
    fileExpanded(state, action: PayloadAction<{ runId: string; path: string }>) {
      const { runId, path } = action.payload;
      const list = state.collapsedFiles[runId];
      if (list?.includes(path)) state.collapsedFiles[runId] = list.filter((p) => p !== path);
    },
    groupFoldToggled(state, action: PayloadAction<{ runId: string; groupId: string }>) {
      const { runId, groupId } = action.payload;
      state.collapsedGroups[runId] = toggleIn(state.collapsedGroups[runId], groupId);
    },
  },
  selectors: {
    selectSavedView: (state): SavedView => ({
      diffStyle: state.diffStyle,
      wrap: state.wrap,
      theme: state.theme,
      fileTreeLayout: state.fileTreeLayout,
      sidebar: state.sidebar,
    }),
    selectDiffStyle: (state) => state.diffStyle,
    selectWrap: (state) => state.wrap,
    selectTheme: (state) => state.theme,
    selectFileTreeLayout: (state) => state.fileTreeLayout,
    selectSidebar: (state) => state.sidebar,
    selectCollapsedFiles: (state, runId: string) => state.collapsedFiles[runId],
    selectCollapsedGroups: (state, runId: string) => state.collapsedGroups[runId],
  },
});

export const {
  diffStyleSet,
  wrapToggled,
  themeSet,
  fileTreeLayoutSet,
  sidebarToggled,
  filesCollapsedSet,
  fileCollapseToggled,
  fileExpanded,
  groupFoldToggled,
} = viewSlice.actions;

export const {
  selectSavedView,
  selectDiffStyle,
  selectWrap,
  selectTheme,
  selectFileTreeLayout,
  selectSidebar,
  selectCollapsedFiles,
  selectCollapsedGroups,
} = viewSlice.selectors;
