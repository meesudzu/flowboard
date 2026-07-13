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

/**
 * Per-file upload state. The route does uploads in parallel (4-at-a-time
 * on the agent side), so each file lands its own status independently.
 *
 * The frontend optimistically adds an entry per File at click time and
 * reconciles against the route response (keyed by filename since the
 * same File may be re-selected after a refresh and we don't have a
 * stable server-side id yet).
 */
export interface PendingUpload {
  clientId: string;
  filename: string;
  /** Local blob URL of the file -- lives only as long as the page,
   *  so we can render a thumbnail while the upload is in flight.
   */
  previewUrl: string;
  status: "uploading" | "done" | "failed";
  error?: string;
}

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
  /** Per-file upload state for the in-flight products. Mirrors the
   *  backend's ``{products, failures}`` aggregation so the grid can
   *  show a per-tile spinner / done / failed badge without forcing
   *  the user to wait for the full bulk response. */
  pendingUploads: PendingUpload[];

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
  pendingUploads: [],

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

    // Optimistically register one pending-tile per File with a local
    // blob: URL so the user sees an immediate thumbnail + spinner per
    // file. The URL is revoked when the entry is cleared below.
    const now = Date.now();
    const optimistic: PendingUpload[] = arr.map((f, i) => ({
      clientId: `${now}-${i}-${f.name}`,
      filename: f.name,
      previewUrl: URL.createObjectURL(f),
      status: "uploading",
    }));
    set((s) => ({
      uploadingProducts: true,
      pendingUploads: [...s.pendingUploads, ...optimistic],
      error: null,
    }));

    try {
      const fd = new FormData();
      for (const f of arr) fd.append("files", f);
      const res = await fetch(`/api/boards/${bid}/generation-mode/products`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        throw new Error(await readError(res));
      }
      // Backend splits outcomes into ``products`` (successes with
      // filenames echoed back) and ``failures`` (filename -> error
      // message). We use the filename to match each result to the
      // optimistic PendingUpload entry.
      const data: {
        products?: Array<{ filename?: string }>;
        failures?: Array<{ filename: string; error: string }>;
      } = await res.json();
      const succeededNames = new Set<string>(
        (data.products ?? [])
          .map((p) => p.filename)
          .filter((n): n is string => Boolean(n))
      );
      const failureByName = new Map<string, string>(
        (data.failures ?? []).map((f) => [f.filename, f.error])
      );
      const stillUploading = new Set(optimistic.map((p) => p.filename));
      set((s) => ({
        pendingUploads: s.pendingUploads.map((pu) => {
          if (!stillUploading.has(pu.filename)) return pu;
          if (succeededNames.has(pu.filename)) {
            return { ...pu, status: "done" };
          }
          return {
            ...pu,
            status: "failed",
            error: failureByName.get(pu.filename) ?? "upload failed",
          };
        }),
      }));

      // Refresh the products list so the actual GenerationProduct rows
      // appear in the gallery. Keep the pending tiles for one tick so
      // the user sees "Done" / "Failed" briefly before they disappear
      // -- otherwise the transition to the real product is jarring.
      await get().refresh();
      window.setTimeout(() => {
        set((s) => ({
          pendingUploads: s.pendingUploads.filter(
            (pu) => !stillUploading.has(pu.filename),
          ),
        }));
        // Revoke blob URLs to free memory (we only needed them for
        // the brief done-and-fading state).
        for (const pu of optimistic) {
          if (pu.previewUrl) URL.revokeObjectURL(pu.previewUrl);
        }
      }, 1200);
    } catch (err) {
      // Bulk request itself failed (4xx/5xx with no body). Mark every
      // pending tile as failed with the same error and stop -- the
      // user can retry.
      const msg = err instanceof Error ? err.message : String(err);
      const stillUploading = new Set(optimistic.map((p) => p.filename));
      set((s) => ({
        pendingUploads: s.pendingUploads.map((pu) =>
          stillUploading.has(pu.filename)
            ? { ...pu, status: "failed", error: msg }
            : pu
        ),
        error: msg,
      }));
      // Still revoke the blob URLs after a brief error-display window.
      window.setTimeout(() => {
        set((s) => ({
          pendingUploads: s.pendingUploads.filter(
            (pu) => !stillUploading.has(pu.filename),
          ),
        }));
        for (const pu of optimistic) {
          if (pu.previewUrl) URL.revokeObjectURL(pu.previewUrl);
        }
      }, 3000);
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
