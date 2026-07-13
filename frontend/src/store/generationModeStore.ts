import { create } from "zustand";
import { api } from "../api/client";

/** Backend mirror types. Keep field names camelCase to match the DTO. */
export interface GenerationConfig {
  model_media_id: string | null;
  prompt: string;
  aspect_ratio: "IMAGE_ASPECT_RATIO_SQUARE" | "IMAGE_ASPECT_RATIO_PORTRAIT" | "IMAGE_ASPECT_RATIO_LANDSCAPE";
  image_model: string;
  updated_at: string | null;
}

export interface GenerationProduct {
  id: number;
  board_id: number;
  media_id: string;
  position: number;
  label: string;
  uploaded_at: string | null;
}

export type GenerationResultStatus =
  | "pending"
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "canceled";

export interface GenerationResult {
  id: number;
  board_id: number;
  product_id: number;
  output_media_id: string | null;
  prompt_used: string;
  status: GenerationResultStatus;
  error: string | null;
  created_at: string | null;
  finished_at: string | null;
}

export interface GenerationModeState {
  boardId: number | null;
  config: GenerationConfig | null;
  products: GenerationProduct[];
  /** Keyed by product_id for O(1) lookup in the gallery render. */
  results: Record<number, GenerationResult>;
  loading: boolean;
  generating: boolean;
  /** True while POST /generation-mode/model is in flight (file uploads go via the
   *  Chrome extension and take seconds, not ms — show a spinner on the model
   *  drop zone). */
  uploadingModel: boolean;
  /** True while POST /generation-mode/products is in flight. */
  uploadingProducts: boolean;
  /** True while POST /generation-mode/prompt/auto is in flight. */
  autoPrompting: boolean;
  error: string | null;
  /** Last generation batch: list of request ids so cancel/all flows have something to act on. */
  activeRequestIds: number[];

  load(boardId: number): Promise<void>;
  uploadModel(file: File): Promise<void>;
  removeModel(): Promise<void>;
  addProducts(files: File[] | FileList): Promise<void>;
  removeProduct(productId: number): Promise<void>;
  updatePrompt(prompt: string): Promise<void>;
  autoPrompt(seed?: string): Promise<string>;
  updateAspectRatio(aspect: GenerationConfig["aspect_ratio"]): Promise<void>;
  updateImageModel(model: string): Promise<void>;
  startGeneration(): Promise<void>;
  regenerateProduct(productId: number): Promise<void>;
  /** Internal: re-fetch server-side state without resetting local */
  refresh(): Promise<void>;
}

async function readError(res: Response): Promise<string> {
  let detail: unknown;
  try { detail = await res.json(); } catch { detail = await res.text().catch(() => `${res.status}`); }
  const inner = typeof detail === "object" && detail !== null && "detail" in detail
    ? (detail as { detail: unknown }).detail
    : detail;
  if (typeof inner === "string") return inner;
  return `${res.status} ${res.statusText}`;
}

export const useGenerationModeStore = create<GenerationModeState>((set, get) => ({
  boardId: null,
  config: null,
  products: [],
  results: {},
  loading: false,
  generating: false,
  uploadingModel: false,
  uploadingProducts: false,
  autoPrompting: false,
  error: null,
  activeRequestIds: [],

  async load(boardId) {
    set({ boardId, loading: true, error: null });
    try {
      const data = await api<{
        config: GenerationConfig;
        products: GenerationProduct[];
        results: GenerationResult[];
      }>(`/api/boards/${boardId}/generation-mode`);
      const results: Record<number, GenerationResult> = {};
      for (const r of data.results) results[r.product_id] = r;
      set({
        config: data.config,
        products: data.products,
        results,
        loading: false,
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), loading: false });
    }
  },

  async refresh() {
    const bid = get().boardId;
    if (bid === null) return;
    const data = await api<{
      config: GenerationConfig;
      products: GenerationProduct[];
      results: GenerationResult[];
    }>(`/api/boards/${bid}/generation-mode`);
    const results: Record<number, GenerationResult> = {};
    for (const r of data.results) results[r.product_id] = r;
    set({ config: data.config, products: data.products, results });
  },

  async uploadModel(file) {
    const bid = get().boardId;
    if (bid === null) return;
    set({ uploadingModel: true, error: null });
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/boards/${bid}/generation-mode/model`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) throw new Error(await readError(res));
      await get().refresh();
    } finally {
      set({ uploadingModel: false });
    }
  },

  async removeModel() {
    const bid = get().boardId;
    if (bid === null) return;
    await api(`/api/boards/${bid}/generation-mode/config`, {
      method: "PATCH",
      body: JSON.stringify({}), // Backend doesn't expose a model clear -- future iteration.
    });
  },

  async addProducts(files) {
    const bid = get().boardId;
    if (bid === null) return;
    const arr = Array.from(files);
    if (arr.length === 0) return;
    set({ uploadingProducts: true, error: null });
    try {
      const fd = new FormData();
      for (const f of arr) fd.append("files", f);
      const res = await fetch(`/api/boards/${bid}/generation-mode/products`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) throw new Error(await readError(res));
      await get().refresh();
    } finally {
      set({ uploadingProducts: false });
    }
  },

  async removeProduct(productId) {
    const bid = get().boardId;
    if (bid === null) return;
    await api(`/api/boards/${bid}/generation-mode/products/${productId}`, {
      method: "DELETE",
    });
    await get().refresh();
  },

  async updatePrompt(prompt) {
    const bid = get().boardId;
    if (bid === null) return;
    const cfg = await api<GenerationConfig>(`/api/boards/${bid}/generation-mode/config`, {
      method: "PATCH",
      body: JSON.stringify({ prompt }),
    });
    set({ config: cfg });
  },

  /**
   * Ask MiniMax for a Vietnamese prompt variation based on the
   * current config (or a caller-supplied seed). Returns the new
   * prompt text; caller is expected to call updatePrompt() with the
   * returned value to persist it on the server.
   *
   * Throws on MiniMax failure so the UI can render an error message
   * inline; the caller is responsible for that UX.
   */
  async autoPrompt(seed) {
    const bid = get().boardId;
    if (bid === null) throw new Error("chưa chọn dự án");
    set({ autoPrompting: true, error: null });
    try {
      const out = await api<{ prompt: string; provider: string }>(
        `/api/boards/${bid}/generation-mode/prompt/auto`,
        {
          method: "POST",
          body: JSON.stringify(seed ? { seed } : {}),
        },
      );
      return out.prompt;
    } finally {
      set({ autoPrompting: false });
    }
  },

  async updateAspectRatio(aspect_ratio) {
    const bid = get().boardId;
    if (bid === null) return;
    const cfg = await api<GenerationConfig>(`/api/boards/${bid}/generation-mode/config`, {
      method: "PATCH",
      body: JSON.stringify({ aspect_ratio }),
    });
    set({ config: cfg });
  },

  async updateImageModel(image_model) {
    const bid = get().boardId;
    if (bid === null) return;
    const cfg = await api<GenerationConfig>(`/api/boards/${bid}/generation-mode/config`, {
      method: "PATCH",
      body: JSON.stringify({ image_model }),
    });
    set({ config: cfg });
  },

  async startGeneration() {
    const bid = get().boardId;
    if (bid === null) return;
    set({ generating: true, error: null });
    try {
      const out = await api<{ request_ids: number[]; result_ids: number[] }>(
        `/api/boards/${bid}/generation-mode/generate`,
        { method: "POST", body: JSON.stringify({}) },
      );
      set({ activeRequestIds: out.request_ids });
      // Optimistically mark all pending products as pending in the local
      // cache so the UI immediately re-renders. A refresh picks up the
      // server-side truth on next poll.
      const products = get().products;
      const results = { ...get().results };
      for (const p of products) {
        if (!results[p.id] || results[p.id].status !== "pending") {
          results[p.id] = {
            id: 0,
            board_id: bid,
            product_id: p.id,
            output_media_id: null,
            prompt_used: "",
            status: "pending",
            error: null,
            created_at: null,
            finished_at: null,
          };
        }
      }
      set({ results });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ generating: false });
    }
  },

  async regenerateProduct(productId) {
    const bid = get().boardId;
    if (bid === null) return;
    await api(`/api/boards/${bid}/generation-mode/products/${productId}/regenerate`, {
      method: "POST",
    });
    await get().refresh();
  },
}));
