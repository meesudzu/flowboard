import { create } from "zustand";

/**
 * Right-side panel shared UI state (open/closed + active tab).
 *
 * Lives in localStorage under a single versioned key so it survives
 * page reload. Data inside the panels (References, Templates) is
 * loaded fresh from the backend on mount — only this chrome state is
 * persisted, matching the pattern set by ``useReferencesStore.panelOpen``.
 *
 * Default ``panelOpen`` is ``true`` so the ★ References tab is visible
 * by default when the app starts — users spend most of their time in
 * the canvas + library workflow. They can still collapse it via the
 * edge tab if they need the full canvas width.
 *
 * Two tabs:
 *   - "references" — the existing saved-media library (★)
 *   - "templates" — the new global prompt-template library (📚)
 *
 * Note: this store replaces what used to be
 * ``useReferencesStore.panelOpen`` in spirit. The old field is left
 * intact on that store for backward compatibility, but the panel
 * components now read from this store instead.
 */
export type RightPanelTab = "references" | "templates";

interface PersistShape {
  panelOpen?: boolean;
  activeTab?: RightPanelTab;
}

const STORAGE_KEY = "flowboard.right-panel.v1";
const VALID_TABS: RightPanelTab[] = ["references", "templates"];

function loadPersisted(): PersistShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: PersistShape = {};
    if (typeof (parsed as PersistShape).panelOpen === "boolean") {
      out.panelOpen = (parsed as PersistShape).panelOpen;
    }
    const tab = (parsed as PersistShape).activeTab;
    if (typeof tab === "string" && (VALID_TABS as string[]).includes(tab)) {
      out.activeTab = tab as RightPanelTab;
    }
    return out;
  } catch {
    return {};
  }
}

function persist(state: PersistShape): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota / disabled storage — non-fatal.
  }
}

const persisted = loadPersisted();

interface RightPanelState {
  panelOpen: boolean;
  activeTab: RightPanelTab;
  setPanelOpen(open: boolean): void;
  togglePanel(): void;
  setActiveTab(tab: RightPanelTab): void;
}

export const useRightPanelStore = create<RightPanelState>((set, get) => ({
  panelOpen: persisted.panelOpen ?? true,
  activeTab: persisted.activeTab ?? "references",
  setPanelOpen(open) {
    if (get().panelOpen === open) return;
    set({ panelOpen: open });
    persist({ panelOpen: open, activeTab: get().activeTab });
  },
  togglePanel() {
    const next = !get().panelOpen;
    set({ panelOpen: next });
    persist({ panelOpen: next, activeTab: get().activeTab });
  },
  setActiveTab(tab) {
    if (get().activeTab === tab) return;
    set({ activeTab: tab });
    persist({ panelOpen: get().panelOpen, activeTab: tab });
  },
}));
