import { useEffect } from "react";
import type { LLMProviderName } from "../../api/client";

/**
 * Inline setup guide opened from the "Hướng dẫn cài đặt" button on the
 * MiniMax row. The cloud-VPS build is API-only — no CLI transport
 * exists for any provider, so the modal collapses to a single
 * MiniMax content body (get-a-key / save-it / models / endpoint).
 *
 * Backdrop click + ESC + Close button all dismiss. Focus trap is
 * provided by the Settings panel backdrop already (we render inside it).
 *
 * The `provider` prop is kept in the type for forward-compat: if the
 * UI ever re-enables another API-key provider, this modal gains a
 * switch over the prop instead of a rewrite. For now the body is
 * MiniMax-only.
 */

interface ProviderSetupModalProps {
  provider: LLMProviderName;
  open: boolean;
  onClose(): void;
}

export function ProviderSetupModal({ provider, open, onClose }: ProviderSetupModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="setup-modal-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="setup-modal" role="dialog" aria-modal="true">
        <div className="setup-modal__header">
          <span className="setup-modal__title">🤖 Cài đặt MiniMax</span>
          <button
            type="button"
            className="setup-modal__close"
            onClick={onClose}
            aria-label="Đóng hướng dẫn"
          >
            ×
          </button>
        </div>

        <MiniMaxContent provider={provider} />

        <div className="setup-modal__footer">
          <a
            className="setup-modal__docs-link"
            href="https://platform.minimax.io/docs/api-reference/text-post"
            target="_blank"
            rel="noopener noreferrer"
          >
            Mở tài liệu API MiniMax ↗
          </a>
          <button
            type="button"
            className="setup-modal__close-btn"
            onClick={onClose}
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}

function MiniMaxContent({ provider: _provider }: { provider: LLMProviderName }) {
  // The provider prop is unused for now (the body is MiniMax-only),
  // but accepting it keeps the component ready for a future switch
  // when more API-key providers get re-enabled.
  return (
    <div className="setup-modal__body">
      <p>
        MiniMax là nhà cung cấp duy nhất trong bản cloud-VPS — không có
        CLI, bạn dán Bearer key thẳng vào Flowboard và chúng tôi sẽ gọi
        endpoint <code>v1/text/chatcompletion_v2</code> thay bạn.
      </p>
      <ol className="setup-modal__steps">
        <li>
          <span className="setup-modal__step-label">Lấy key</span>
          <a
            className="setup-modal__step-link"
            href="https://platform.minimax.io/user-center/basic-information/interface-key"
            target="_blank"
            rel="noopener noreferrer"
          >
            platform.minimax.io/user-center/basic-information/interface-key ↗
          </a>
        </li>
        <li>
          <span className="setup-modal__step-label">Lưu key</span>
          <span className="setup-modal__step-hint">
            Dán vào dòng MiniMax ở trên rồi bấm Lưu.
          </span>
        </li>
        <li>
          <span className="setup-modal__step-label">Model</span>
          <span className="setup-modal__step-hint">
            Text: <code>MiniMax-M2.7-highspeed</code> · Vision: <code>MiniMax-M3</code>.
            Mặc định tự chọn theo khả năng — không cần chỉnh model.
          </span>
        </li>
      </ol>
      <p className="setup-modal__note">
        Key được lưu trong <code>~/.flowboard/secrets.json</code> (quyền 600,
        chỉ lưu cục bộ) và không bao giờ gửi đi đâu ngoài{" "}
        <code>api.minimax.io</code>. Có thể đổi endpoint cho bản tự host
        hoặc khu vực khác bằng cách đặt biến môi trường{" "}
        <code>FLOWBOARD_MINIMAX_BASE_URL</code> trong môi trường của bạn.
      </p>
    </div>
  );
}
