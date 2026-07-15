import { useCallback } from "react";

/**
 * Shared inject-handler for `<PromptTemplateButton/>` callers.
 *
 * Two production surfaces today:
 *   1. ``GenerationDialog`` (canvas mode) — overwrites local `prompt` state.
 *   2. ``GenerationBoard``  (generate mode) — calls `updatePrompt`.
 *
 * Both want the SAME consumer-side semantics:
 *   - Read the current textarea value via ``getCurrent()``.
 *   - If non-empty AND/OR the chosen template is longer than the cap,
 *     show ONE consolidated ``window.confirm`` (not two popups).
 *   - Truncate the body to the cap when needed.
 *   - Fire ``onInject(next)`` with the final string.
 *
 * The default cap (``500``) matches the hard cap on the canvas-mode
 * textarea; callers in generate mode (where there's no enforced cap)
 * can override it.
 */
export interface UsePromptTemplateInjectOptions {
  /** Return the CURRENT textarea contents. Used to decide if the user
   *  has unsaved work that would be discarded by an overwrite. */
  getCurrent: () => string;
  /** Apply the (possibly-truncated) chosen body to the textarea. */
  onInject: (next: string) => void;
  /** Hard ceiling on the inject length. Defaults to 500 to match the
   *  canvas-mode GenerationDialog textarea. */
  maxLength?: number;
}

export function usePromptTemplateInject({
  getCurrent,
  onInject,
  maxLength = 500,
}: UsePromptTemplateInjectOptions): (body: string) => void {
  return useCallback(
    (body: string) => {
      const willTruncate = body.length > maxLength;
      const willOverwrite = getCurrent().trim().length > 0;
      if (willOverwrite || willTruncate) {
        const lines: string[] = [];
        if (willOverwrite) {
          lines.push("Nội dung prompt đang có sẽ bị thay thế.");
        }
        if (willTruncate) {
          lines.push(
            `Prompt mẫu dài ${body.length} ký tự — chỉ lấy ${maxLength} ký tự đầu tiên (bạn có thể nối phần còn lại trong ô nhập).`,
          );
        }
        const ok = window.confirm(lines.join("\n") + "\n\nTiếp tục?");
        if (!ok) return;
      }
      onInject(willTruncate ? body.slice(0, maxLength) : body);
    },
    [getCurrent, onInject, maxLength],
  );
}
