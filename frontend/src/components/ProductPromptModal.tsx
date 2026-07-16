import { useEffect, useRef, useState } from "react";
import type { GenerationProduct } from "../store/generationModeStore";
import { PromptTemplateButton } from "./PromptTemplateButton";
import { usePromptTemplateInject } from "../hooks/usePromptTemplateInject";

interface ProductPromptModalProps {
  product: GenerationProduct | null;
  /** Shared config prompt — used as the textarea's initial value
   *  when the product has no override yet, and as a placeholder
   *  for reference. */
  defaultPrompt: string;
  onClose: () => void;
  /** Persist the override (or the cleared-string when the user
   *  emptied the field) on the server. */
  onSave: (productId: number, promptOverride: string) => Promise<void>;
  /** Ask the AI to compose a Vietnamese prompt variation. The
   *  optional seed lets the caller steer the variant (e.g. by
   *  passing the current shared prompt). The returned string
   *  REPLACES the textarea contents (the user can still edit
   *  before saving). */
  onAutoPrompt: (seed?: string) => Promise<string>;
}

/**
 * Small modal for editing a single product's prompt override.
 *
 * Lives alongside the product tile's "✎" icon. Open -> user
 * edits (or clears) -> clicks the primary button -> the store
 * PATCHes the row and the render flips the icon to "filled"
 * so the user can see at a glance which products diverge from
 * the shared prompt.
 *
 * Pre-fill behavior: when the product has NO existing override
 * the textarea is pre-filled with the CURRENT shared config
 * prompt (whatever the user has typed in the input above).
 * The user is in "duplicate-and-tweak" mode — they can edit
 * a single line and click Save to make that product diverge
 * from the default, without retyping or copy-pasting the
 * whole shared prompt. The placeholder still shows the
 * shared prompt underneath as a reminder of the default.
 *
 * Esc and the × button both close without saving.
 */
export function ProductPromptModal({
  product,
  defaultPrompt,
  onClose,
  onSave,
  onAutoPrompt,
}: ProductPromptModalProps) {
  const [value, setValue] = useState<string>("");
  const [saving, setSaving] = useState(false);
  /** True while onAutoPrompt is in flight. Independent of saving
   *  so the spinner on the AI button doesn't conflict with the
   *  primary "Lưu" button's loading state. */
  const [autoPrompting, setAutoPrompting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Shared inject logic — same contract as the canvas-mode
  // GenerationDialog picker: confirm before replacing any non-empty
  // textarea contents and warn if the chosen template is over the
  // 500-char soft cap. After the (possibly-truncated) body is
  // committed back into local state, refocus + selectAll so the
  // user can immediately edit before saving.
  const injectTemplate = usePromptTemplateInject({
    getCurrent: () => value,
    onInject: (next) => {
      setValue(next);
      // Mirror ProductPromptModal.handleAutoPrompt — push caret to
      // end so the user can keep typing without manual clicking.
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(next.length, next.length);
      });
    },
  });

  // Hand the AI a seed that reflects where the user is now:
  // existing override > shared prompt > "". The AI then writes
  // a Vietnamese variation in the same lookbook style. The user
  // can still edit the result before clicking Save.
  const handleAutoPrompt = async () => {
    const seed = (product?.prompt_override || defaultPrompt || "").trim();
    setAutoPrompting(true);
    setError(null);
    try {
      const fresh = await onAutoPrompt(seed || undefined);
      setValue(fresh);
      // Move the caret to the end so the user can keep typing.
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(fresh.length, fresh.length);
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAutoPrompting(false);
    }
  };

  // Reset the local draft when the modal target changes (open
  // for a different product) OR when the shared prompt changes
  // (e.g. the user typed in the input above while the modal was
  // open, then opened it for another product and the snapshot
  // would be stale). Auto-focus the textarea.
  useEffect(() => {
    if (product === null) return;
    const initial =
      product.prompt_override.length > 0 ? product.prompt_override : defaultPrompt;
    setValue(initial);
    setError(null);
    setSaving(false);
    // Defer to next paint so the textarea is mounted.
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      const end = initial.length;
      textareaRef.current?.setSelectionRange(end, end);
    });
  }, [product, defaultPrompt]);

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
  // Three orthogonal booleans drive the button + hint labels.
  // Previously we conflated "empty" and "same as shared"; now
  // we expose all three so the user sees the right action.
  const isEmpty = trimmed.length === 0;
  const isSameAsShared = trimmed === defaultPrompt;
  const wasOverridden = product.prompt_override.length > 0;

  // Save action: do we actually need to PATCH the row?
  //   * empty + no override  -> nothing to save, just close
  //   * same as shared + no override -> nothing to save
  //   * otherwise (modified OR clearing an existing override) -> save
  const needsSave = wasOverridden
    ? !isSameAsShared // clear OR modify
    : !isEmpty && !isSameAsShared; // create new override

  // Primary button label. Picks the verb that best matches the
  // user's intent given the current textarea state.
  const saveLabel = isEmpty
    ? wasOverridden
      ? "Xoá override"
      : "Đóng"
    : isSameAsShared
    ? wasOverridden
      ? "Khôi phục shared"
      : "Đóng"
    : wasOverridden
    ? "Lưu thay đổi"
    : "Lưu override";

  const onSubmit = async () => {
    if (!needsSave) {
      // No PATCH needed: the user either cleared (no prior
      // override to clear) or left the textarea matching the
      // shared prompt. Just close.
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Empty trimmed means "clear the override"; the store
      // accepts an empty string and persists it as "" (whitespace
      // is normalised on the server). We pass the raw trimmed
      // value so the backend can echo it back.
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
          <h3 className="product-prompt-modal__title product-prompt-modal__header-title">Sửa prompt cho sản phẩm này</h3>
          <div className="product-prompt-modal__header-actions">
            <PromptTemplateButton
              onSelect={injectTemplate}
              disabled={autoPrompting || saving}
              title="Chèn nhanh prompt mẫu từ bảng bên phải vào textarea"
            />
            <button
              type="button"
              className="product-prompt-modal__autoprompt-btn"
              onClick={handleAutoPrompt}
              disabled={autoPrompting || saving}
              title="Dùng MiniMax viết lại prompt theo mẫu mặc định"
            >
              {autoPrompting ? (
                <>
                  <span
                    className="generation-board__inline-spinner"
                    aria-hidden="true"
                  />
                  Đang tạo…
                </>
              ) : (
                "Tự tạo prompt"
              )}
            </button>
            <button
              type="button"
              className="product-prompt-modal__close"
              onClick={onClose}
              aria-label="Đóng"
              title="Đóng (Esc)"
            >
              ✕
            </button>
          </div>
        </div>
        <p className="product-prompt-modal__hint">
          {isEmpty
            ? wasOverridden
              ? "Để trống và lưu để xoá override — sản phẩm sẽ quay lại dùng prompt chung."
              : "Để trống và đóng — sản phẩm giữ nguyên dùng prompt chung."
            : isSameAsShared
            ? wasOverridden
              ? "Nội dung giống prompt chung — lưu để xoá override và quay lại mặc định."
              : "Nội dung giống prompt chung — không cần lưu, có thể đóng hoặc sửa để tạo override."
            : "Prompt này sẽ THAY THẾ prompt chung cho riêng sản phẩm này."}
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
            {saving ? "Đang lưu…" : saveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
