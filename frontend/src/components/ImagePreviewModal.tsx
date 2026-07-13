import { useCallback, useEffect } from "react";
import { mediaUrl } from "../api/client";

interface ImagePreviewModalProps {
  /** Flow-issued media id of the image to preview. Ignored if `previewSrc` is set. */
  mediaId: string | null;
  /**
   * Direct image src (e.g. a `data:` URL) to show instead of resolving
   * `mediaId` through the `/media/<id>` endpoint. Used for in-flight
   * previews where the bytes haven't been ingested yet (model upload
   * mid-flight) so there's no Flow media_id to fetch.
   */
  previewSrc?: string | null;
  /** Human-readable label shown above the image (e.g. the product name). */
  alt?: string;
  onClose: () => void;
}

/**
 * Full-viewport lightbox for previewing a single image at full size.
 *
 * Reused from three surfaces in the generation board (model preview,
 * product tile, gallery result) so the close affordances stay
 * consistent — Escape key, click on backdrop, click on the × button.
 *
 * Rendered lazily: the parent only mounts this when a `mediaId` is set,
 * so the modal's own state (Escape listener, body scroll lock) doesn't
 * need to micro-manage mount/unmount.
 */
export function ImagePreviewModal({ mediaId, previewSrc, alt, onClose }: ImagePreviewModalProps) {
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    },
    [onClose],
  );

  useEffect(() => {
    if (mediaId === null && !previewSrc) return;
    document.addEventListener("keydown", onKey);
    // Lock body scroll while open so the page under the modal doesn't
    // jank when the user scrolls. The lock is a class instead of inline
    // `overflow: hidden` so any other open overlays (Toaster) stay
    // visible without competing scroll-restoration side effects.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [mediaId, previewSrc, onKey]);

  if (mediaId === null && !previewSrc) return null;

  const onBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div
      className="image-preview-modal"
      role="dialog"
      aria-modal="true"
      aria-label={alt ?? "Xem ảnh lớn"}
      onClick={onBackdropClick}
    >
      <button
        type="button"
        className="image-preview-modal__close"
        onClick={onClose}
        aria-label="Đóng"
        title="Đóng (Esc)"
      >
        ✕
      </button>
      {alt && <div className="image-preview-modal__caption">{alt}</div>}
      <img
        className="image-preview-modal__img"
        src={previewSrc ?? mediaUrl(mediaId ?? "")}
        alt={alt ?? ""}
        // Drag-prevent so users don't accidentally start an image drag
        // gesture on the modal (the underlying product tile has its own
        // drag-and-drop handler; this prevents a hijacked drag).
        onDragStart={(e) => e.preventDefault()}
      />
    </div>
  );
}
