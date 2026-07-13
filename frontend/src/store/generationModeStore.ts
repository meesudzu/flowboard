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
  /** Per-product prompt override. Empty string = use the shared
   *  config prompt. Non-empty = the worker uses this text
   *  INSTEAD of the shared prompt for this product only (other
   *  products in the same batch are unaffected). The frontend
   *  exposes a small "✎" button on each product tile to edit
   *  this. */
  prompt_override: string;
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
  /** Local data: URL (base64) of the file -- used as a live
   *  thumbnail while the upload is in flight. The image is the
   *  user's own selected file so they get a real preview, not a
   *  spinner placeholder.
   */
  previewUrl: string;
  status: "uploading" | "done" | "failed";
  error?: string;
  /** Set once the server has created the GenerationProduct row.
   *  When present, the render merges this entry INTO the matching
   *  ProductTile (same React key = same DOM element) so the user
   *  sees the SAME tile morph from a blurred preview to a sharp
   *  product over the 1.2s blur-out transition. No swap, no
   *  layout jump. */
  productId?: number;
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
  /** Live preview of the model image currently being uploaded. Set
   *  as soon as the user picks a file (so the tile flips to their
   *  image with a blur overlay immediately) and cleared once the
   *  upload resolves. Distinct from the persisted `config.model_media_id`
   *  (which only updates after the POST completes) so the UI can
   *  show "what's being uploaded" vs "what's saved". */
  modelUploadingFile: { previewUrl: string; filename: string } | null;
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
  /** Update per-product metadata. Either field may be omitted. */
  updateProduct(
    productId: number,
    patch: { label?: string; prompt_override?: string },
  ): Promise<void>;
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

/**
 * Read a `File` as a data: URL (base64-encoded). Used to back the
 * optimistic per-tile thumbnail during an upload — the user sees
 * their own selected image with a blur overlay while Flow ingests
 * the bytes, instead of a generic spinner.
 *
 * Returns a string like `data:image/jpeg;base64,/9j/4AAQ...`. The
 * browser garbage-collects the underlying ArrayBuffer when the
 * FileReader emits; we don't need to revoke anything. The data
 * URL stays alive only as long as the JS string ref does.
 */
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const r = reader.result;
      if (typeof r === "string") resolve(r);
      else reject(new Error("FileReader returned non-string"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsDataURL(file);
  });
}

export const useGenerationModeStore = create<GenerationModeState>((set, get) => ({
  boardId: null,
  config: null,
  products: [],
  results: {},
  loading: false,
  generating: false,
  uploadingModel: false,
  modelUploadingFile: null,
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
    // Show the user's own file as a blurred preview IMMEDIATELY
    // (no waiting for Flow's WS round-trip). Reads the file as a
    // data: URL in parallel with the POST — both are bounded by
    // the file size, the smaller of the two wins.
    const previewUrl = await readFileAsBase64(file);
    set({
      uploadingModel: true,
      modelUploadingFile: { previewUrl, filename: file.name },
      error: null,
    });
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
      // Keep the preview up for one tick so the blur-to-sharp
      // transition is visible — refresh() has just set the new
      // config.model_media_id, so React will swap the <img src>
      // to the real URL on the next paint.
      window.setTimeout(() => {
        set({ uploadingModel: false, modelUploadingFile: null });
      }, 250);
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

    // Optimistically register one pending-tile per File with a
    // base64 data: URL thumbnail so the user sees their own
    // selected image with a blur overlay while Flow ingests the
    // bytes. We resolve all data: URLs in parallel — the typical
    // case is 1-4 files at a time, so Promise.all is plenty fast.
    const now = Date.now();
    const dataUrls = await Promise.all(arr.map(readFileAsBase64));
    const optimistic: PendingUpload[] = arr.map((f, i) => ({
      clientId: `${now}-${i}-${f.name}`,
      filename: f.name,
      previewUrl: dataUrls[i],
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
        // Each product entry has the same shape as a
        // GenerationProduct plus the ``filename`` we echoed back
        // from the multipart form (the DB row doesn't store the
        // original filename, so this is the only place to match
        // it). The id is what the render keys on to merge the
        // pending tile with the product tile.
        products?: Array<{ id?: number; filename?: string }>;
        failures?: Array<{ filename: string; error: string }>;
      } = await res.json();
      const succeededNames = new Set<string>(
        (data.products ?? [])
          .map((p) => p.filename)
          .filter((n): n is string => Boolean(n))
      );
      // filename -> product_id map for the just-uploaded rows. The
      // render merges each pending entry into its product tile by
      // id once we set productId here -- same React key = same DOM
      // element, so the tile morphs from "pending preview" to
      // "real product" without a layout jump.
      const productIdByName = new Map<string, number>();
      for (const p of data.products ?? []) {
        if (typeof p.filename === "string" && typeof p.id === "number") {
          productIdByName.set(p.filename, p.id);
        }
      }
      const failureByName = new Map<string, string>(
        (data.failures ?? []).map((f) => [f.filename, f.error])
      );
      const stillUploading = new Set(optimistic.map((p) => p.filename));
      set((s) => ({
        pendingUploads: s.pendingUploads.map((pu) => {
          if (!stillUploading.has(pu.filename)) return pu;
          if (succeededNames.has(pu.filename)) {
            // Stamp the server-assigned product_id so the render
            // can MERGE this pending entry into the matching
            // ProductTile (same React key) instead of removing the
            // tile and rendering a new one in its place.
            return {
              ...pu,
              status: "done",
              productId: productIdByName.get(pu.filename),
            };
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
        // data: URLs are GC'd with the string refs — nothing to revoke.
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
      // Brief error-display window before removing the tile. data:
      // URLs are GC'd with the string refs — nothing to revoke.
      window.setTimeout(() => {
        set((s) => ({
          pendingUploads: s.pendingUploads.filter(
            (pu) => !stillUploading.has(pu.filename),
          ),
        }));
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

  async updateProduct(productId, patch) {
    const bid = get().boardId;
    if (bid === null) return;
    const updated = await api<GenerationProduct>(
      `/api/boards/${bid}/generation-mode/products/${productId}`,
      {
        method: "PATCH",
        body: JSON.stringify(patch),
      },
    );
    // Update the in-memory list in place so the "✎" icon flips
    // on/off immediately without waiting for the next poll.
    set((s) => ({
      products: s.products.map((p) => (p.id === productId ? updated : p)),
    }));
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
      // Optimistically mark NEW products as pending in the local
      // cache so the UI immediately re-renders. A refresh picks up
      // the server-side truth on the next poll tick.
      //
      // The previous version of this loop reset every product to
      // "pending" — including ones the server would SKIP because
      // they already had a ``done`` row. That made the "Xong" pill
      // flicker to "Đang chờ" for a second or two after every
      // click (until the next poll restored the server truth),
      // which the user found jarring. Now we only reset rows that
      // are still actionable from the worker's perspective:
      //
      //   * no result row        -> new product, needs a "pending"
      //   * status == "failed"  -> retrying; show in-flight state
      //   * status == "canceled" -> re-enqueueing after a stop
      //
      // ``done``, ``running``, ``queued`` rows are left alone — the
      // server won't touch them on this dispatch.
      const products = get().products;
      const results = { ...get().results };
      for (const p of products) {
        const cur = results[p.id];
        const needsPending =
          !cur || cur.status === "failed" || cur.status === "canceled";
        if (needsPending) {
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
