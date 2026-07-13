import { useEffect, useRef, useState } from "react";
import type { GenerationProduct } from "../store/generationModeStore";

interface ProductPromptModalProps {
  product: GenerationProduct | null;
  /** Shared config prompt — shown as a placeholder so the user can
   *  see the default they're overriding. */
  defaultPrompt: string;
  onClose: () => void;
  /** Persist the override (or the cleared-string when the user
   *  emptied the field) on the server. */
  onSave: (productId: number, promptOverride: string) => Promise<void>;
}

/**
 * Small modal for editing a single product's prompt override.
 *
 * Lives alongside the product tile's "✎" icon. Open -> user types
 * (or clears) -> clicks "Lưu" -> the store PATCHes the row and the
 * render flips the icon to "filled" so the user can see at a
 * glance which products diverge from the shared prompt.
 *
 * The textarea shows the shared prompt as a placeholder so the
 * user can read the default without leaving the modal. Esc and
 * the × button both close without saving.
 */
export function ProductPromptModal({
  product,
  defaultPrompt,
  onClose,
  onSave,
}: ProductPromptModalProps) {
  const [value, setValue] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reset the local draft when the modal target changes (open
  // for a different product). Also auto-focus the textarea so
  // the user can start typing immediately.
  useEffect(() => {
    if (product === null) return;
    setValue(product.prompt_override);
    setError(null);
    setSaving(false);
    // Defer to next paint so the textarea is mounted.
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(
        product.prompt_override.length,
        product.prompt_override.length,
      );
    });
  }, [product]);

  // Esc closes without saving.
  useEffect(() => {
    if (product === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [product, onClose]);

  if (product === null) return null;

  const trimmed = value.trim();
  // \"Use override\" iff non-empty. Empty string falls back to the
  // shared config prompt, so the button label switches between
  // \"Lưu override\" and \"Xoá override\" accordingly.
  const willOverride = trimmed.length > 0;
  const wasOverridden = product.prompt_override.length > 0;

  const onSubmit = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(product.id, trimmed);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const onBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div
      className="image-preview-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Sửa prompt cho ảnh sản phẩm"
      onClick={onBackdropClick}
    >
      <div
        className="product-prompt-modal__panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="product-prompt-modal__header">
          <h3 className="product-prompt-modal__title">Sửa prompt cho sản phẩm này</h3>
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
          {willOverride
            ? "Prompt này sẽ THAY THẾ prompt chung ở panel trên cho riêng sản phẩm này."
            : wasOverridden
            ? "Để trống để dùng lại prompt chung ở panel trên."
            : "Để trống để dùng prompt chung. Prompt dưới đây chỉ áp dụng cho sản phẩm này."}
        </p>
        <textarea
          ref={textareaRef}
          className="product-prompt-modal__textarea"
          rows={10}
          value={value}
          placeholder={defaultPrompt}
          onChange={(e) => setValue(e.target.value)}
        />
        {error && (
          <div className="product-prompt-modal__error" role="alert">
            {error}
          </div>
        )}
        <div className="product-prompt-modal__actions">
          <button
            type="button"
            className="project-modal__btn"
            onClick={onClose}
            disabled={saving}
          >
            Huỷ
          </button>
          <button
            type="button"
            className="project-modal__btn project-modal__btn--primary"
            onClick={onSubmit}
            disabled={saving}
          >
            {saving
              ? "Đang lưu…"
              : willOverride
              ? "Lưu override"
              : wasOverridden
              ? "Xoá override"
              : "Lưu"}
          </button>
        </div>
      </div>
    </div>
  );
}
