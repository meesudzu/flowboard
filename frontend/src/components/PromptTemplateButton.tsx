import { useEffect, useRef, useState } from "react";
import { usePromptTemplatesStore } from "../store/promptTemplates";

/**
 * Shared "📚 Mẫu" picker used wherever a prompt textarea wants to
 * accept a one-click injection from the right-side Templates panel.
 *
 * Two production surfaces today:
 *   1. ``GenerationDialog`` — canvas-mode node creation.
 *   2. ``GenerationBoard`` — generate-mode shared prompt input.
 *
 * The component is intentionally minimal:
 *   - Reads the template list from ``usePromptTemplatesStore``.
 *   - Renders a small button + an absolute-positioned popover anchored
 *     beneath it (matches the variant-picker pattern already used for
 *     upstream source references).
 *   - Closes itself on outside-click via a ``mousedown`` listener —
 *     same contract as the existing picker patterns.
 *   - When the user picks a row, fires ``onSelect(body)`` and closes.
 *
 * Empty template list → the popover shows a short hint directing the
 * user to the Templates tab in the right panel.
 *
 * The picker DOES NOT mutate the textarea itself — that's the caller's
 * job, because the surrounding context (truncation cap, dirty-state
 * confirm) differs per surface.
 */
interface PromptTemplateButtonProps {
  /** Called with the chosen template's body. Caller decides what to do
   *  with it (overwrite / concat / truncate / etc.). */
  onSelect: (body: string) => void;
  /** Disable the button (and skip rendering the popover). Useful when
   *  the surrounding textarea is read-only. */
  disabled?: boolean;
  /** Override the button's hover tooltip. Defaults to a short hint. */
  title?: string;
  /** Tailwind-style override for the wrapper className. The default
   *  lets the outside-click listener match self + popover. */
  wrapClassName?: string;
}

const DEFAULT_WRAP = "prompt-template-btn-wrap";

export function PromptTemplateButton({
  onSelect,
  disabled,
  title,
  wrapClassName = DEFAULT_WRAP,
}: PromptTemplateButtonProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const items = usePromptTemplatesStore((s) => s.items);

  // Close on outside click. The check uses the wrap className so the
  // button itself, the popover, and any future internal element all
  // count as "inside" — clicking anywhere else closes.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(`.${wrapClassName}`)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open, wrapClassName]);

  return (
    <div className={wrapClassName} ref={wrapRef}>
      <button
        type="button"
        className={
          "prompt-template-btn"
          + (open ? " prompt-template-btn--active" : "")
        }
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title={title ?? "Chèn nhanh prompt mẫu từ bảng bên phải"}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        📚 Mẫu
      </button>
      {open && (
        <div className="prompt-template-btn__picker" role="menu">
          {items.length === 0 ? (
            <div className="prompt-template-btn__picker-empty">
              Chưa có prompt mẫu nào. Mở bảng bên phải, chọn tab
              <strong> &nbsp;Prompt mẫu</strong>, bấm
              <strong> + Mẫu mới</strong> để tạo.
            </div>
          ) : (
            <ul className="prompt-template-btn__picker-list">
              {items.map((tpl) => {
                const preview = tpl.body.replace(/\s+/g, " ").trim();
                return (
                  <li key={tpl.id}>
                    <button
                      type="button"
                      className="prompt-template-btn__picker-item"
                      role="menuitem"
                      onClick={() => {
                        onSelect(tpl.body);
                        setOpen(false);
                      }}
                      title={tpl.body}
                    >
                      <span className="prompt-template-btn__picker-title">
                        {tpl.title}
                      </span>
                      <span className="prompt-template-btn__picker-preview">
                        {preview.slice(0, 60)}
                        {preview.length > 60 ? "…" : ""}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
