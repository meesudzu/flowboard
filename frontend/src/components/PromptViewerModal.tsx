import { useEffect } from "react";

interface PromptViewerModalProps {
  /** The exact prompt string the worker sent to Flow, plus
   *  the product id for the title. Null closes the modal. */
  prompt: { productId: number; prompt: string } | null;
  onClose: () => void;
}

/**
 * Read-only modal for inspecting the prompt the worker sent
 * to Flow for one product. The user can't edit here (the
 * edit flow lives in ProductPromptModal) — this is just a
 * "show me what the model saw" view.
 *
 * Useful when an output looks wrong: the user can copy the
 * prompt, tweak it in ProductPromptModal, and re-run only
 * that one product.
 */
export function PromptViewerModal({ prompt, onClose }: PromptViewerModalProps) {
  // Esc closes.
  useEffect(() => {
    if (prompt === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [prompt, onClose]);

  if (prompt === null) return null;

  const onBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div
      className="image-preview-modal"
      role="dialog"
      aria-modal="true"
      aria-label={`Prompt đã dùng cho sản phẩm #${prompt.productId}`}
      onClick={onBackdropClick}
    >
      <div
        className="product-prompt-modal__panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="product-prompt-modal__header">
          <h3 className="product-prompt-modal__title">
            Prompt đã dùng · Sản phẩm #{prompt.productId}
          </h3>
          <button
            type="button"
            className="image-preview-modal__close"
            onClick={onClose}
            aria-label="Đóng"
            title="Đóng (Esc)"
          >
            ✕
          </button>
        </div>
        <p className="product-prompt-modal__hint">
          Đây là prompt chính xác đã gửi cho Flow để tạo ảnh này. Bấm vào
          ô để copy hoặc dùng làm base khi sửa prompt riêng cho sản phẩm.
        </p>
        <textarea
          className="product-prompt-modal__textarea"
          rows={12}
          value={prompt.prompt}
          readOnly
          onFocus={(e) => e.currentTarget.select()}
          onClick={(e) => e.currentTarget.select()}
        />
        <div className="product-prompt-modal__actions">
          <button
            type="button"
            className="project-modal__btn project-modal__btn--primary"
            onClick={onClose}
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}
