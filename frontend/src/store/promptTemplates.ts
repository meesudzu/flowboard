import { create } from "zustand";
import {
  createPromptTemplate,
  deletePromptTemplate,
  listPromptTemplates,
  patchPromptTemplate,
  type PromptTemplate,
  type PromptTemplateCreateInput,
  type PromptTemplatePatchInput,
} from "../api/client";

/**
 * Global prompt-template store.
 *
 * Mirrors the ``/api/prompt-templates`` backend table. The store keeps
 * a flat in-memory array sorted by ``updatedAt DESC`` — same order the
 * backend's GET endpoint returns. Local mutations re-sort with the
 * same comparator so the UI stays consistent without an extra
 * round-trip after each create/update/delete.
 *
 * Unlike ``useReferencesStore``, items are NOT persisted to
 * localStorage: the source of truth is server-side, and the App's
 * mount-time ``load()`` rehydrates them transparently. That keeps a
 * stale local copy from masking a server-side delete when the page
 * reloads on a different device profile.
 *
 * The Templates panel and the GenerationDialog's "📚 Mẫu" popover
 * both read from this store, so changes propagate instantly without
 * a manual reload.
 */
export interface PromptTemplatesState {
  items: PromptTemplate[];
  loading: boolean;
  error: string | null;

  load(): Promise<void>;
  create(input: PromptTemplateCreateInput): Promise<PromptTemplate>;
  update(id: number, patch: PromptTemplatePatchInput): Promise<PromptTemplate>;
  remove(id: number): Promise<void>;
}

/**
 * Sort templates the same way the backend GET endpoint orders them:
 *   updatedAt DESC, then id DESC as a stable tiebreaker for rows that
 *   happen to share a millisecond.
 */
function sortTemplates(items: PromptTemplate[]): PromptTemplate[] {
  return [...items].sort((a, b) => {
    const byUpdated = b.updatedAt.localeCompare(a.updatedAt);
    if (byUpdated !== 0) return byUpdated;
    return b.id - a.id;
  });
}

export const usePromptTemplatesStore = create<PromptTemplatesState>((set, get) => ({
  items: [],
  loading: false,
  error: null,

  async load() {
    if (get().loading) return;
    set({ loading: true, error: null });
    try {
      const items = await listPromptTemplates({ limit: 200 });
      set({ items, loading: false });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  async create(input) {
    const row = await createPromptTemplate(input);
    const next = sortTemplates([row, ...get().items]);
    set({ items: next });
    return row;
  },

  async update(id, patch) {
    const row = await patchPromptTemplate(id, patch);
    const next = sortTemplates(
      get().items.map((r) => (r.id === row.id ? row : r)),
    );
    set({ items: next });
    return row;
  },

  async remove(id) {
    await deletePromptTemplate(id);
    set({ items: get().items.filter((r) => r.id !== id) });
  },
}));

/**
 * Client-side filter on the in-memory items array. Substring match on
 * title only — body intentionally NOT searchable per the documented
 * backend behaviour (``/api/prompt-templates?q=` searches title only).
 * Empty query returns the full sorted list unchanged.
 */
export function filterPromptTemplates(
  items: PromptTemplate[],
  query: string,
): PromptTemplate[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;
  return items.filter((r) => r.title.toLowerCase().includes(needle));
}
