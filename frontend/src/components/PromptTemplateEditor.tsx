import { useEffect, useRef, useState } from "react";
import type { PromptTemplate } from "../api/client";

interface PromptTemplateEditorProps {
  /**
   * The template to edit, or ``null`` to create a new one. When non-null
   * the form pre-fills with the existing title + body; on save the
   * parent calls ``onSave`` with the new values and triggers a PATCH.
   */
  template: PromptTemplate | null;
  /**
   * Persist the new values.
   *   - ``template === null``  → parent POSTs (create).
   *   - ``template !== null``  → parent PATCHes (update).
   */
  onSave: (values: { title: string; body: string }) => Promise<void>;
  onClose: () => void;
}

const TITLE_MAX = 120;
const BODY_MAX = 2000;

/**
 * Modal editor for creating or editing a single prompt template.
 *
 * Lives behind the "+ Mẫu mới" button in the Templates panel (create)
 * and the "✎" rename action on each template card (edit). The shape
 * is intentionally small — a labeled title input, a labeled body
 * textarea, and a primary Save / Huỷ row at the bottom.
 *
 * Validation mirrors the backend (title non-empty after trim, body
 * length ≤ 2000) so the modal surfaces the same errors the server
 * would, without a round-trip. Esc closes without saving.
 */
export function PromptTemplateEditor({
  template,
  onSave,
  onClose,
}: PromptTemplateEditorProps) {
  const [title, setTitle] = useState(template?.title ?? "");
  const [body, setBody] = useState(template?.body ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  // Reset draft when the target template changes (open for a different
  // edit, or open for create from a previously-edited state). Always
  // focus the title input on open so the user can start typing.
  useEffect(() => {
    setTitle(template?.title ?? "");
    setBody(template?.body ?? "");
    setError(null);
    setSaving(false);
    requestAnimationFrame(() => {
      titleRef.current?.focus();
      const len = (template?.title ?? "").length;
      titleRef.current?.setSelectionRange(len, len);
    });
  }, [template]);

  // Esc closes without saving. Keep parity with ProductPromptModal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const trimmedTitle = title.trim();
  const titleError =
    trimmedTitle.length === 0
      ? "Tiêu đề không được để trống"
      : trimmedTitle.length > TITLE_MAX
      ? `Tiêu đề tối đa ${TITLE_MAX} ký tự`
      : null;
  const bodyError = body.length > BODY_MAX ? `Nội dung tối đa ${BODY_MAX} ký tự` : null;
  const canSave = !titleError && !bodyError && !saving;

  const submit = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ title: trimmedTitle, body });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  const onBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  const isCreate = template === null;
  const title_label = isCreate ? "Tạo prompt mẫu" : "Sửa prompt mẫu";

  return (
    <div
      className="image-preview-modal"
      role="dialog"
      aria-modal="true"
      aria-label={title_label}
      onClick={onBackdropClick}
    >
      <div
        className="prompt-template-editor__panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="prompt-template-editor__header">
          <h3 className="prompt-template-editor__title">{title_label}</h3>
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
        <label className="prompt-template-editor__field">
          <span className="prompt-template-editor__label">Tiêu đề</span>
          <input
            ref={titleRef}
            type="text"
            className="prompt-template-editor__title-input"
            value={title}
            maxLength={TITLE_MAX}
            placeholder="vd: Lookbook studio"
            onChange={(e) => setTitle(e.target.value)}
          />
          {titleError && (
            <span className="prompt-template-editor__field-error">{titleError}</span>
          )}
        </label>
        <label className="prompt-template-editor__field">
          <span className="prompt-template-editor__label">Nội dung prompt</span>
          <textarea
            className="prompt-template-editor__body-input"
            rows={10}
            value={body}
            maxLength={BODY_MAX}
            placeholder="Nhập nội dung prompt để chèn vào textarea khi tạo ảnh…"
            onChange={(e) => setBody(e.target.value)}
          />
          <span className="prompt-template-editor__char-count">
            {body.length}/{BODY_MAX}
          </span>
          {bodyError && (
            <span className="prompt-template-editor__field-error">{bodyError}</span>
          )}
        </label>
        {error && (
          <div className="prompt-template-editor__error" role="alert">
            {error}
          </div>
        )}
        <div className="prompt-template-editor__actions">
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
            onClick={submit}
            disabled={!canSave}
          >
            {saving ? "Đang lưu…" : isCreate ? "Tạo mẫu" : "Lưu thay đổi"}
          </button>
        </div>
      </div>
    </div>
  );
}
