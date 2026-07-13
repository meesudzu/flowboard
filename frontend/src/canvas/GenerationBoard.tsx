import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  useGenerationModeStore,
  type GenerationProduct,
  type GenerationResult,
} from "../store/generationModeStore";
import { useBoardStore } from "../store/board";
import { useSettingsStore, type ImageModelKey } from "../store/settings";
import { mediaUrl } from "../api/client";
import { ImagePreviewModal } from "../components/ImagePreviewModal";
import { ProductPromptModal } from "../components/ProductPromptModal";

const PRODUCT_STATUS_LABEL: Record<string, string> = {
  pending: "Đang chờ",
  queued: "Trong hàng đợi",
  running: "Đang tạo",
  done: "Xong",
  failed: "Lỗi",
  canceled: "Đã huỷ",
};

const ASPECT_RATIOS = [
  { key: "IMAGE_ASPECT_RATIO_SQUARE" as const, label: "1:1" },
  { key: "IMAGE_ASPECT_RATIO_PORTRAIT" as const, label: "9:16" },
  { key: "IMAGE_ASPECT_RATIO_LANDSCAPE" as const, label: "16:9" },
];

const IMAGE_MODEL_CHIPS: { key: ImageModelKey; label: string }[] = [
  { key: "NANO_BANANA_PRO", label: "Premium" },
  { key: "NANO_BANANA_2", label: "Fast" },
];

// Two-tier poll cadence while any result is in flight.
//
// We poll aggressively (1.5 s) for the first 30 seconds because that's
// when the worker is most likely to flip the row to "done" -- a faster
// tick makes the "Xong" pill appear within ~1-2 s of completion
// rather than waiting up to 3 s.
//
// After 30 s of unbroken "in-flight" we relax to 5 s so a long Flow
// dispatch doesn't cost us one HTTP call per second indefinitely. The
// effective user-visible latency stays low because a completion flips
// the cadence back to FAST on the next poll cycle (results change ->
// useMemo recomputes -> the effect re-runs).
const FAST_POLL_MS = 1_500;
const SLOW_POLL_MS = 5_000;
const FAST_WINDOW_MS = 30_000;

export function GenerationBoard() {
  const boardId = useBoardStore((s) => s.boardId);
  const boardName = useBoardStore((s) => s.boardName);

  const config = useGenerationModeStore((s) => s.config);
  const products = useGenerationModeStore((s) => s.products);
  const results = useGenerationModeStore((s) => s.results);
  const loading = useGenerationModeStore((s) => s.loading);
  const generating = useGenerationModeStore((s) => s.generating);
  const error = useGenerationModeStore((s) => s.error);
  const uploadingModel = useGenerationModeStore((s) => s.uploadingModel);
  const modelUploadingFile = useGenerationModeStore((s) => s.modelUploadingFile);
  const uploadingProducts = useGenerationModeStore((s) => s.uploadingProducts);
  const autoPrompting = useGenerationModeStore((s) => s.autoPrompting);
  const autoPrompt = useGenerationModeStore((s) => s.autoPrompt);
  const load = useGenerationModeStore((s) => s.load);
  const refresh = useGenerationModeStore((s) => s.refresh);
  const uploadModel = useGenerationModeStore((s) => s.uploadModel);
  const addProducts = useGenerationModeStore((s) => s.addProducts);
  const removeProduct = useGenerationModeStore((s) => s.removeProduct);
  const updatePrompt = useGenerationModeStore((s) => s.updatePrompt);
  const pendingUploads = useGenerationModeStore((s) => s.pendingUploads);
  const updateAspectRatio = useGenerationModeStore((s) => s.updateAspectRatio);
  const updateImageModel = useGenerationModeStore((s) => s.updateImageModel);
  const startGeneration = useGenerationModeStore((s) => s.startGeneration);
  const regenerateProduct = useGenerationModeStore((s) => s.regenerateProduct);
  const updateProduct = useGenerationModeStore((s) => s.updateProduct);

  const settingsImageModel = useSettingsStore((s) => s.imageModel);
  const setSettingsImageModel = useSettingsStore((s) => s.setImageModel);

  const [modelHover, setModelHover] = useState(false);
  const [productsHover, setProductsHover] = useState(false);
  const [showModelSizeHint, setShowModelSizeHint] = useState(false);
  /** Full-viewport preview: when non-null, the ImagePreviewModal renders
   *  over the page with this media id. Click any image tile to set. */
  const [previewMediaId, setPreviewMediaId] = useState<string | null>(null);
  /** Direct data: URL for the preview modal — used by the model
   *  upload in-flight preview where there's no Flow media_id yet.
   *  Mutually exclusive with `previewMediaId`; the modal renders
   *  whichever is set. */
  const [previewBase64, setPreviewBase64] = useState<string | null>(null);
  const [previewAlt, setPreviewAlt] = useState<string | undefined>(undefined);
  /** When set, opens the per-product prompt override modal for
   *  this product. The user can type a custom prompt that the
   *  worker uses INSTEAD of the shared config prompt for this
   *  product only. */
  const [editingPromptProductId, setEditingPromptProductId] = useState<number | null>(null);

  // Track when the latest in-flight batch started so we can compute
  // the poll cadence per tick (FAST for the first 30s, SLOW after).
  const inFlightStartedAtRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const productsInputRef = useRef<HTMLInputElement>(null);
  const promptTimer = useRef<number | null>(null);

  // Initial load when boardId changes; reset store on cleanup so
  // switching boards doesn't leak state between them.
  useEffect(() => {
    if (boardId === null) return;
    load(boardId);
  }, [boardId, load]);

  // Poll while any result is in flight.
  const inFlightCount = useMemo(
    () =>
      Object.values(results).filter((r) =>
        ["pending", "queued", "running"].includes(r.status),
      ).length,
    [results],
  );
  useEffect(() => {
    if (boardId === null) return;
    if (inFlightCount === 0) {
      inFlightStartedAtRef.current = null;
      return;
    }
    // First time we observe in-flight after a quiet period, anchor a
    // fresh "started at" so the FAST cadence window restarts. When
    // inFlightCount rises further (e.g. user clicks regenerate on a
    // second product mid-batch) we keep the original anchor so the
    // cadence doesn't reset.
    if (inFlightStartedAtRef.current === null) {
      inFlightStartedAtRef.current = Date.now();
    }
    const startedAt = inFlightStartedAtRef.current;
    let cancelled = false;
    let timer: number | undefined;
    const tick = () => {
      if (cancelled) return;
      const elapsed = Date.now() - startedAt;
      const interval = elapsed < FAST_WINDOW_MS ? FAST_POLL_MS : SLOW_POLL_MS;
      refresh().catch(() => {});
      timer = window.setTimeout(tick, interval);
    };
    timer = window.setTimeout(tick, FAST_POLL_MS);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [boardId, inFlightCount, refresh]);

  // Debounce prompt typing so we don't hammer PATCH /config on every
  // keystroke. 400 ms feels instant for the user but groups updates.
  const onPromptChange = useCallback(
    (next: string) => {
      // Local echo immediately so the textarea reflects input.
      const cfg = useGenerationModeStore.getState().config;
      if (cfg) useGenerationModeStore.setState({ config: { ...cfg, prompt: next } });
      if (promptTimer.current !== null) {
        window.clearTimeout(promptTimer.current);
      }
      const bid = boardId;
      if (bid === null) return;
      promptTimer.current = window.setTimeout(() => {
        updatePrompt(next).catch(() => {
          // Restore the prior prompt on failure so the UI doesn't lie.
          useGenerationModeStore.getState().refresh().catch(() => {});
        });
      }, 400);
    },
    [boardId, updatePrompt],
  );

  const onModelUpload = useCallback(
    async (file: File) => {
      try {
        await uploadModel(file);
      } catch (e) {
        // Surface error inline; refresh so any stale state clears.
        useGenerationModeStore.setState({
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [uploadModel],
  );

  const onProductsUpload = useCallback(
    async (files: File[] | FileList) => {
      try {
        await addProducts(files);
      } catch (e) {
        useGenerationModeStore.setState({
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [addProducts],
  );

  // "Pending" products: those whose latest GenerationResult is NOT
  // ``done``. They're the next-batch candidates for the "Tạo ảnh"
  // button: freshly-uploaded products (no row yet) AND any product
  // that previously failed or is mid-cycle. Already-done products
  // are intentionally excluded so clicking "Tạo ảnh" only ever
  // enqueues NEW work -- the user can hit per-product "⟳" to retry
  // an individual one.
  //
  // NOTE: this ``useMemo`` MUST live above the loading/early-return
  // branch below. Putting it after the return flips the hook count
  // between renders (``loading`` toggles true→false on every load),
  // which trips React #310 ("Rendered fewer hooks than expected")
  // and crashes the page. The memo only reads ``products`` and
  // ``results`` so it's safe to run before ``config`` is hydrated.
  const pendingCount = useMemo(() => {
    return products.filter((p) => {
      const r = results[p.id];
      return !r || r.status !== "done";
    }).length;
  }, [products, results]);

  if (boardId === null || loading || config === null) {
    return (
      <div className="generation-board">
        <div className="generation-board__loading">Đang tải…</div>
      </div>
    );
  }

  const hasModel = Boolean(config.model_media_id);

  const canGenerate =
    hasModel && pendingCount > 0 && !generating && inFlightCount === 0;

  return (
    <div className="generation-board">
      <header className="generation-board__header">
        <div className="generation-board__title-row">
          <h1 className="generation-board__title">{boardName || "Dự án"}</h1>
          <span className="generation-board__mode-badge" aria-label="Chế độ tạo ảnh">
            Tạo ảnh
          </span>
        </div>
        {error && (
          <div className="generation-board__error" role="alert">
            {error}
          </div>
        )}
      </header>

      <section className="generation-board__input-row">
        {/* ── Model column (left) ───────────────────────────────────── */}
        <div className="generation-board__input-col generation-board__input-col--model">
          <div className="generation-board__model-header">
            <h2 className="generation-board__subtitle">Ảnh Người Mẫu</h2>
            {uploadingModel && (
              <span
                className="generation-board__inline-spinner"
                aria-label="Đang upload model"
                title="Đang upload model"
              />
            )}
          </div>
          <div
            className={
              "generation-board__model-drop" +
              (modelHover ? " generation-board__drop--hover" : "") +
              (hasModel ? " generation-board__drop--filled" : "")
            }
            onDragOver={(e) => {
              e.preventDefault();
              setModelHover(true);
            }}
            onDragLeave={() => setModelHover(false)}
            onDrop={(e) => {
              e.preventDefault();
              setModelHover(false);
              const f = e.dataTransfer.files?.[0];
              if (f) onModelUpload(f);
            }}
          >
            {hasModel || modelUploadingFile ? (
              <div className="generation-board__model-preview">
                <button
                  type="button"
                  className="generation-board__thumb-button"
                  onClick={() => {
                    // While uploading, the media isn't yet in the
                    // gallery; show the in-flight base64 preview
                    // instead. After the upload completes,
                    // config.model_media_id is set and this branch
                    // reverts to opening the persisted image.
                    if (modelUploadingFile) {
                      setPreviewAlt("Ảnh model đang upload");
                      setPreviewMediaId(null);
                      setPreviewBase64(modelUploadingFile.previewUrl);
                    } else if (config.model_media_id) {
                      setPreviewBase64(null);
                      setPreviewAlt("Ảnh model");
                      setPreviewMediaId(config.model_media_id);
                    }
                  }}
                  aria-label="Xem ảnh model lớn"
                  title="Bấm để xem lớn"
                >
                  <img
                    src={
                      modelUploadingFile
                        ? modelUploadingFile.previewUrl
                        : mediaUrl(config.model_media_id as string)
                    }
                    alt="Ảnh model"
                    className={
                      "generation-board__model-thumb" +
                      (modelUploadingFile
                        ? " generation-board__model-thumb--uploading"
                        : "")
                    }
                  />
                  {modelUploadingFile && (
                    <span
                      className="generation-board__inline-spinner"
                      aria-label="Đang upload model"
                    />
                  )}
                </button>
                <div className="generation-board__model-actions">
                  <button
                    type="button"
                    className="project-modal__btn"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadingModel}
                  >
                    {uploadingModel ? "Đang upload…" : "Thay ảnh"}
                  </button>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onModelUpload(f);
                    e.target.value = "";
                  }}
                />
              </div>
            ) : (
              <button
                type="button"
                className="generation-board__drop-empty"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadingModel}
              >
                {uploadingModel && (
                  <span className="generation-board__inline-spinner" aria-hidden="true" />
                )}
                <span className="generation-board__drop-icon" aria-hidden="true">＋</span>
                <span className="generation-board__drop-title">Upload ảnh model</span>
                <span className="generation-board__drop-desc">
                  1 ảnh chân dung hoặc figure rõ mặt — neo danh tính xuyên suốt cả lookbook.
                </span>
                <span className="generation-board__drop-formats">JPG / PNG / WebP · tối đa 10 MB</span>
                {showModelSizeHint && (
                  <span className="generation-board__drop-error">
                    File vượt quá 10 MB hoặc không đúng định dạng.
                  </span>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) {
                      if (f.size > 10 * 1024 * 1024) {
                        setShowModelSizeHint(true);
                      } else {
                        setShowModelSizeHint(false);
                        onModelUpload(f);
                      }
                    }
                    e.target.value = "";
                  }}
                />
              </button>
            )}
          </div>
        </div>

        {/* ── Prompt column (right) ─────────────────────────────────── */}
        <div className="generation-board__input-col generation-board__input-col--prompt">
          <div className="generation-board__prompt-row">
            <label className="generation-board__prompt-label" htmlFor="generation-prompt">
              Prompt
            </label>
            <button
              type="button"
              className="project-modal__btn generation-board__autoprompt-btn"
              onClick={async () => {
                try {
                  const fresh = await autoPrompt();
                  await updatePrompt(fresh);
                } catch (e) {
                  useGenerationModeStore.setState({
                    error: e instanceof Error ? e.message : String(e),
                  });
                }
              }}
              disabled={autoPrompting}
              title="Dùng MiniMax viết lại prompt theo mẫu mặc định"
            >
              {autoPrompting ? "Đang tạo prompt…" : "Tự tạo prompt"}
            </button>
            <textarea
              id="generation-prompt"
              className="generation-board__prompt-input"
              rows={6}
              value={config.prompt}
              placeholder="Mô tả bối cảnh, ánh sáng, tư thế, tâm trạng… áp dụng cho tất cả ảnh sản phẩm."
              onChange={(e) => onPromptChange(e.target.value)}
            />
            <div className="generation-board__chips">
              <span className="generation-board__chip-label">Tỉ lệ:</span>
              {ASPECT_RATIOS.map((a) => (
                <button
                  key={a.key}
                  type="button"
                  className={
                    "generation-board__chip" +
                    (config.aspect_ratio === a.key ? " generation-board__chip--active" : "")
                  }
                  onClick={() => updateAspectRatio(a.key).catch(() => {})}
                >
                  {a.label}
                </button>
              ))}
              <span className="generation-board__chip-label">Model:</span>
              {IMAGE_MODEL_CHIPS.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  className={
                    "generation-board__chip" +
                    ((config.image_model || settingsImageModel) === m.key
                      ? " generation-board__chip--active"
                      : "")
                  }
                  onClick={() => {
                    setSettingsImageModel(m.key);
                    updateImageModel(m.key).catch(() => {});
                  }}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section
        className={
          "generation-board__products" +
          (productsHover ? " generation-board__drop--hover" : "")
        }
        onDragOver={(e) => {
          e.preventDefault();
          setProductsHover(true);
        }}
        onDragLeave={() => setProductsHover(false)}
        onDrop={(e) => {
          e.preventDefault();
          setProductsHover(false);
          const files = Array.from(e.dataTransfer.files ?? []);
          if (files.length > 0) onProductsUpload(files);
        }}
      >
        <div className="generation-board__products-header">
          <h2 className="generation-board__subtitle">
            Ảnh sản phẩm ({products.length})
            {uploadingProducts && (
              <span
                className="generation-board__inline-spinner"
                aria-label="Uploading"
                title="Uploading"
              />
            )}
          </h2>
          <button
            type="button"
            className="project-modal__btn"
            onClick={() => productsInputRef.current?.click()}
            disabled={uploadingProducts}
          >
            {uploadingProducts ? "Đang upload…" : "+ Thêm sản phẩm"}
          </button>
          <input
            ref={productsInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            hidden
            multiple
            onChange={(e) => {
              const files = e.target.files ? Array.from(e.target.files) : [];
              if (files.length > 0) onProductsUpload(files);
              e.target.value = "";
            }}
          />
        </div>
        {products.length === 0 ? (
          <button
            type="button"
            className="generation-board__products-empty"
            onClick={() => productsInputRef.current?.click()}
            disabled={uploadingProducts}
          >
            <span className="generation-board__drop-icon" aria-hidden="true">＋</span>
            <span>
              {uploadingProducts
                ? "Đang upload lên Flow…"
                : "Thả ảnh sản phẩm vào đây (nhiều ảnh cùng lúc)"}
            </span>
          </button>
        ) : (
          <ul className="generation-board__product-grid">
            {products.map((p) => {
              // If the user JUST uploaded this product, there's a
              // matching pending entry that the store linked by
              // product_id. Pass its previewUrl + a "blurred"
              // hint so the ProductTile keeps rendering the
              // user's own base64 with the blur effect, then
              // morphs to the server image once the pending
              // entry is removed (~1.2s after upload). Same React
              // key (p.id) on both sides = same DOM element, so
              // the layout doesn't shift.
              const linked = pendingUploads.find(
                (pu) => pu.productId === p.id,
              );
              return (
                <ProductTile
                  key={p.id}
                  product={p}
                  result={results[p.id]}
                  previewOverride={linked?.previewUrl}
                  onRemove={() => {
                    if (window.confirm("Xoá ảnh sản phẩm này? Kết quả tạo của nó cũng bị xoá.")) {
                      removeProduct(p.id).catch(() => {});
                    }
                  }}
                  onRegenerate={() => regenerateProduct(p.id).catch(() => {})}
                  onPreview={() => {
                    setPreviewAlt(`Sản phẩm #${p.id}`);
                    setPreviewMediaId(p.media_id);
                  }}
                  onEditPrompt={() => setEditingPromptProductId(p.id)}
                />
              );
            })}
            {pendingUploads
              .filter((pu) => pu.productId === undefined)
              .map((pu) => (
                <PendingUploadTile key={pu.clientId} upload={pu} />
              ))}
            <li>
              <button
                type="button"
                className="generation-board__product-add"
                onClick={() => productsInputRef.current?.click()}
                aria-label="Thêm sản phẩm"
              >
                ＋
              </button>
            </li>
          </ul>
        )}
      </section>

      <ResultsGallery
        products={products}
        results={results}
        onRegenerate={(pid) => regenerateProduct(pid).catch(() => {})}
        onPreviewProduct={(mid) => {
          setPreviewAlt("Ảnh sản phẩm gốc");
          setPreviewMediaId(mid);
        }}
        onPreviewOutput={(r) => {
          setPreviewAlt(`Kết quả tạo ảnh #${r.product_id}`);
          setPreviewMediaId(r.output_media_id);
        }}
      />

      <ImagePreviewModal
        mediaId={previewMediaId}
        previewSrc={previewBase64}
        alt={previewAlt}
        onClose={() => {
          setPreviewMediaId(null);
          setPreviewBase64(null);
          setPreviewAlt(undefined);
        }}
      />

      <ProductPromptModal
        product={
          editingPromptProductId === null
            ? null
            : products.find((p) => p.id === editingPromptProductId) ?? null
        }
        defaultPrompt={config.prompt}
        onClose={() => setEditingPromptProductId(null)}
        onSave={async (productId, promptOverride) => {
          await updateProduct(productId, { prompt_override: promptOverride });
        }}
        onAutoPrompt={async (seed) => {
          // Reuse the same store action the main prompt area
          // uses — the backend endpoint accepts a seed so the
          // modal can hand the AI the current shared prompt
          // (or the product's existing override) instead of
          // the hard-coded template. Same provider, same
          // style, no duplicated wiring.
          return await autoPrompt(seed);
        }}
      />

      <div className="generation-board__action-bar">
        <button
          type="button"
          className="project-modal__btn project-modal__btn--primary generation-board__generate-btn"
          onClick={() => startGeneration()}
          disabled={!canGenerate}
          title={pendingCount === 0
            ? "Tất cả ảnh đã hoàn thành — bấm 'Tạo lại' trên từng ảnh để chạy lại"
            : `Tạo ảnh cho ${pendingCount} sản phẩm mới (đã tạo rồi giữ nguyên)`}
        >
          {generating
            ? "Đang gửi…"
            : inFlightCount > 0
            ? `Đang tạo (${inFlightCount})`
            : pendingCount > 0
            ? `Tạo ${pendingCount} ảnh mới`
            : "Tạo ảnh"}
        </button>
      </div>
    </div>
  );
}

function ProductTile({
  product,
  result,
  previewOverride,
  onRemove,
  onRegenerate,
  onPreview,
  onEditPrompt,
}: {
  product: GenerationProduct;
  result: GenerationResult | undefined;
  /** When set, render this base64 (or any URL) as the thumbnail
   *  instead of resolving ``product.media_id`` through the media
   *  endpoint. Used during the 1.2s "just uploaded" window so
   *  the same tile morphs from preview to server image without
   *  a layout swap. */
  previewOverride?: string;
  onRemove: () => void;
  onRegenerate: () => void;
  onPreview: () => void;
  /** Open the per-product prompt override modal for this tile. */
  onEditPrompt: () => void;
}) {
  const hasOverride = product.prompt_override.length > 0;
  const status = result?.status;
  const statusLabel = status ? PRODUCT_STATUS_LABEL[status] ?? status : null;
  // While previewOverride is set, also mark the tile as "just
  // uploaded" so the CSS blurs + dims the image. The blur eases
  // out 1.2s later when the parent removes the matching pending
  // entry, at which point previewOverride flips to undefined and
  // the same <img> swaps src to the server image.
  const justUploaded = Boolean(previewOverride);
  return (
    <li
      className={
        "generation-board__product-tile"
        + (justUploaded ? " generation-board__product-tile--uploading" : "")
      }
    >
      <button
        type="button"
        className="generation-board__thumb-button generation-board__product-thumb"
        onClick={() => onPreview()}
        aria-label="Xem ảnh sản phẩm lớn"
        title="Bấm để xem lớn"
      >
        <img
          src={previewOverride ?? mediaUrl(product.media_id)}
          alt="Sản phẩm"
          className={
            justUploaded
              ? "generation-board__product-thumb-img generation-board__product-thumb-img--uploading"
              : "generation-board__product-thumb-img"
          }
        />
        {statusLabel && (
          <span
            className={
              "generation-board__product-pill generation-board__product-pill--" +
              (status ?? "idle")
            }
          >
            {statusLabel}
          </span>
        )}
      </button>
      <div className="generation-board__product-actions">
        <button
          type="button"
          className="generation-board__icon-btn"
          onClick={onRegenerate}
          aria-label="Tạo lại ảnh này"
          title="Tạo lại ảnh này"
        >
          ⟳
        </button>
        <button
          type="button"
          className={
            "generation-board__icon-btn"
            + (hasOverride
              ? " generation-board__icon-btn--active"
              : "")
          }
          onClick={onEditPrompt}
          aria-label={
            hasOverride
              ? "Sửa prompt override (đang dùng prompt riêng)"
              : "Sửa prompt cho ảnh này"
          }
          title={
            hasOverride
              ? "Đang dùng prompt riêng — bấm để sửa"
              : "Sửa prompt cho ảnh này"
          }
        >
          ✎
        </button>
        <button
          type="button"
          className="generation-board__icon-btn generation-board__icon-btn--danger"
          onClick={onRemove}
          aria-label="Xoá ảnh sản phẩm"
          title="Xoá ảnh sản phẩm"
        >
          ✕
        </button>
      </div>
    </li>
  );
}

function ResultsGallery({
  products,
  results,
  onRegenerate,
  onPreviewProduct,
  onPreviewOutput,
}: {
  products: GenerationProduct[];
  results: Record<number, GenerationResult>;
  onRegenerate: (productId: number) => void;
  onPreviewProduct: (mediaId: string) => void;
  onPreviewOutput: (result: GenerationResult) => void;
}) {
  if (products.length === 0) return null;
  const anyResult = products.some((p) => results[p.id]);
  if (!anyResult) {
    return (
      <section className="generation-board__gallery">
        <h2 className="generation-board__subtitle">Kết quả</h2>
        <p className="generation-board__gallery-hint">
          Bấm <strong>Tạo ảnh</strong> để tạo ảnh cho từng sản phẩm.
        </p>
      </section>
    );
  }
  return (
    <section className="generation-board__gallery">
      <h2 className="generation-board__subtitle">Kết quả</h2>
      <ul className="generation-board__result-grid">
        {products.map((p) => {
          const r = results[p.id];
          return (
            <li key={p.id} className="generation-board__result-tile">
              <div className="generation-board__result-pair">
                <figure className="generation-board__result-side">
                  <button
                    type="button"
                    className="generation-board__thumb-button generation-board__result-thumb"
                    onClick={() => onPreviewProduct(p.media_id)}
                    aria-label="Xem ảnh sản phẩm gốc lớn"
                    title="Bấm để xem lớn"
                  >
                    <img src={mediaUrl(p.media_id)} alt="Sản phẩm gốc" />
                  </button>
                  <figcaption>Sản phẩm</figcaption>
                </figure>
                <figure className="generation-board__result-side">
                  {r?.status === "done" && r.output_media_id ? (
                    <button
                      type="button"
                      className="generation-board__thumb-button generation-board__result-thumb"
                      onClick={() => onPreviewOutput(r)}
                      aria-label="Xem ảnh kết quả lớn"
                      title="Bấm để xem lớn"
                    >
                      <img src={mediaUrl(r.output_media_id)} alt="Kết quả tạo ảnh" />
                    </button>
                  ) : (
                    <div className="generation-board__result-placeholder">
                      {r?.status === "failed"
                        ? "Lỗi"
                        : r?.status === "running" || r?.status === "queued"
                        ? "Đang tạo…"
                        : r?.status === "pending"
                        ? "Đang chờ"
                        : "Chưa tạo"}
                    </div>
                  )}
                  <figcaption>
                    {r?.status === "done"
                      ? `Xong${formatDuration(r.created_at, r.finished_at)}`
                      : "Kết quả"}
                  </figcaption>
                </figure>
              </div>
              {r?.error && (
                <div className="generation-board__result-error">{r.error}</div>
              )}
              {r?.status === "failed" && (
                <button
                  type="button"
                  className="project-modal__btn"
                  onClick={() => onRegenerate(p.id)}
                >
                  Thử lại
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function formatDuration(
  createdAt: string | null | undefined,
  finishedAt: string | null | undefined,
): string {
  // Render the elapsed time between created_at and finished_at as
  // a short suffix for the "Xong" pill (e.g. " 5s", " 1m 20s",
  // " 2m"). Returns an empty string if either timestamp is missing
  // or the duration is non-positive.
  //
  // Bounded at 99 minutes so a runaway duration doesn't push the
  // label past the figcaption width -- past that the user almost
  // certainly knows it took a while and would rather see "99m+".
  if (!createdAt || !finishedAt) return "";
  const start = Date.parse(createdAt);
  const end = Date.parse(finishedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return "";
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return ` ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSec = seconds % 60;
  if (remSec === 0) return minutes >= 99 ? " 99m+" : ` ${minutes}m`;
  return minutes >= 99 ? " 99m+" : ` ${minutes}m ${remSec}s`;
}


/**
 * Live upload slot rendered in the products grid while a file is in
 * flight. Uses the local blob: URL for a real thumbnail (the user's
 * own selected image) and shows a per-tile status pill so the user
 * can track each upload independently instead of staring at one
 * global "uploading products…" spinner.
 */
function PendingUploadTile({
  upload,
}: {
  upload: import("../store/generationModeStore").PendingUpload;
}) {
  const label =
    upload.status === "uploading"
      ? "Đang upload…"
      : upload.status === "failed"
      ? `Lỗi: ${upload.error ?? "unknown"}`
      : "Xong";
  return (
    <li
      className={
        "generation-board__product-tile generation-board__pending-tile"
        + (upload.status === "failed" ? " generation-board__pending-tile--failed" : "")
        + (upload.status === "done" ? " generation-board__pending-tile--done" : "")
      }
      title={upload.filename + " — " + label}
    >
      <div className="generation-board__product-thumb">
        <img src={upload.previewUrl} alt={upload.filename} />
        <span
          className={
            "generation-board__product-pill"
            + (upload.status === "uploading"
              ? " generation-board__pending-tile-pill--uploading"
              : upload.status === "failed"
              ? " generation-board__product-pill--failed"
              : " generation-board__product-pill--done")
          }
        >
          {upload.status === "uploading"
            ? "Uploading"
            : upload.status === "failed"
            ? "Lỗi"
            : "Xong"}
        </span>
      </div>
    </li>
  );
}
