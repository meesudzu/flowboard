import { useEffect, useMemo, useRef, useState } from "react";
import { mediaUrl, type ReferenceItem } from "../api/client";
import { useBoardStore } from "../store/board";
import { filterReferences, useReferencesStore } from "../store/references";

/**
 * References tab content (right-side panel body).
 *
 * Renders the saved-media library — each card is a 64x64 thumbnail +
 * label + shortId tag with hover-revealed actions (pin toggle, rename
 * in-place, delete with confirm). Cards are both clickable (spawns a
 * new visual_asset node at a fixed fallback position) and draggable
 * with a custom `application/x-flowboard-reference` MIME so canvas
 * drop handlers can detect the payload without colliding with the
 * existing file-upload drop path.
 *
 * NOTE: this is the *content* of the References tab; the panel chrome
 * (aside wrapper, header, search-input positioning, open/close toggle
 * tab on the right edge) lives in ``RightPanel`` and is shared with
 * the Templates tab. Kept as a separate component so adding another
 * tab later is just one more body swap in ``RightPanel``.
 *
 * v1 retained the old ``useReferencesStore.panelOpen`` field for
 * backward compatibility with any third-party callers (none today,
 * but cheap to keep). The RightPanel owns the open/closed state now.
 */
export function ReferencesPanelContent() {
  const items = useReferencesStore((s) => s.items);
  const loading = useReferencesStore((s) => s.loading);
  const error = useReferencesStore((s) => s.error);
  const query = useReferencesStore((s) => s.query);
  const setQuery = useReferencesStore((s) => s.setQuery);
  const remove = useReferencesStore((s) => s.remove);
  const rename = useReferencesStore((s) => s.rename);
  const togglePin = useReferencesStore((s) => s.togglePin);

  const filtered = useMemo(() => filterReferences(items, query), [items, query]);

  return (
    <>
      <div className="references-panel__search">
        <input
          type="text"
          placeholder="🔍 tìm kiếm tham chiếu…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Tìm kiếm tham chiếu"
        />
      </div>

      {error && <div className="references-panel__error">{error}</div>}

      {loading && items.length === 0 && (
        <div className="references-panel__empty">Đang tải…</div>
      )}

      {!loading && items.length === 0 && (
        <div className="references-panel__empty">
          Lưu một biến thể từ bất kỳ ô ảnh nào để bắt đầu thư viện.
        </div>
      )}

      {!loading && items.length > 0 && filtered.length === 0 && (
        <div className="references-panel__empty">
          No references match "{query}".
        </div>
      )}

      <ul className="references-panel__list">
        {filtered.map((ref) => (
          <ReferenceCard
            key={ref.id}
            item={ref}
            onRename={(label) => rename(ref.id, label)}
            onTogglePin={() => togglePin(ref.id)}
            onDelete={() => remove(ref.id)}
          />
        ))}
      </ul>
    </>
  );
}

interface ReferenceCardProps {
  // Named `item` rather than `ref` to avoid React's reserved-prop
  // collision (refs are forwarded via a different prop in React 19+).
  item: ReferenceItem;
  onRename(label: string): Promise<void> | void;
  onTogglePin(): Promise<void> | void;
  onDelete(): Promise<void> | void;
}

function ReferenceCard({
  item,
  onRename,
  onTogglePin,
  onDelete,
}: ReferenceCardProps) {
  const [thumbBroken, setThumbBroken] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(item.label);
  // Inline 2-step delete confirm: first click arms the button (label →
  // "Xác nhận?", colour shifts to red), second click within 3s commits
  // the DELETE. Anywhere else (timeout, blur, panel scroll) → revert.
  // Replaces the native window.confirm() which was modal + ugly.
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Auto-revert the confirm-armed state after 3s of no second click.
    return () => {
      if (confirmTimerRef.current !== null) {
        clearTimeout(confirmTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (renaming) {
      setDraft(item.label);
      setTimeout(() => inputRef.current?.select(), 20);
    }
  }, [renaming, item.label]);

  function handleDragStart(e: React.DragEvent<HTMLLIElement>) {
    const payload = {
      mediaId: item.mediaId,
      aiBrief: item.aiBrief,
      aspectRatio: item.aspectRatio,
      kind: item.kind,
      label: item.label,
    };
    e.dataTransfer.setData(
      "application/x-flowboard-reference",
      JSON.stringify(payload),
    );
    e.dataTransfer.effectAllowed = "copy";
  }

  async function handleClick() {
    // Click-to-spawn: drop a new visual_asset node onto the canvas at a
    // fixed fallback position. A future polish pass can pipe in the real
    // canvas center via ReactFlow's screenToFlowPosition once it's
    // exposed outside <ReactFlow> (this component lives outside that
    // subtree, so we don't have access to the hook here).
    const pos = { x: 200, y: 200 };
    await useBoardStore.getState().addReferenceNode(
      {
        mediaId: item.mediaId,
        aiBrief: item.aiBrief,
        aspectRatio: item.aspectRatio,
        kind: item.kind,
        label: item.label,
      },
      pos,
    );
  }

  async function commitRename() {
    const next = draft.trim();
    setRenaming(false);
    if (!next || next === item.label) return;
    try {
      await onRename(next);
    } catch {
      // Swallow — surface via store.error already.
    }
  }

  function armDeleteConfirm() {
    setConfirmDelete(true);
    if (confirmTimerRef.current !== null) {
      clearTimeout(confirmTimerRef.current);
    }
    confirmTimerRef.current = setTimeout(() => {
      setConfirmDelete(false);
      confirmTimerRef.current = null;
    }, 3000);
  }

  async function handleDelete(e: React.MouseEvent) {
    e.stopPropagation();
    // First click: arm the confirm (visual red + label change). Second
    // click within 3s commits. Timeout → revert.
    if (!confirmDelete) {
      armDeleteConfirm();
      return;
    }
    if (confirmTimerRef.current !== null) {
      clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
    setDeleting(true);
    try {
      await onDelete();
      // The card unmounts on success — no need to flip state back.
    } catch {
      // Swallow — surfaced via store.error. Revert UI so the user can
      // retry or move on.
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  // Short id derived from sourceNodeShortId if present; otherwise show
  // the numeric ref id. Provenance-first because users tend to scan the
  // panel by "which node was this from?".
  const shortIdTag = item.sourceNodeShortId
    ? `#${item.sourceNodeShortId}`
    : `#${item.id}`;

  const tooltip = item.aiBrief
    ? `${item.label}\n\n${item.aiBrief}`
    : item.label;

  return (
    <li
      className="reference-card"
      draggable
      onDragStart={handleDragStart}
      onClick={() => {
        void handleClick();
      }}
      title={tooltip}
    >
      <div className="reference-card__thumb">
        {thumbBroken ? (
          <div className="reference-card__thumb-missing" aria-hidden="true">
            📷
          </div>
        ) : (
          <img
            src={mediaUrl(item.mediaId)}
            alt=""
            onError={() => setThumbBroken(true)}
            draggable={false}
          />
        )}
      </div>

      <div className="reference-card__body">
        {renaming ? (
          <input
            ref={inputRef}
            className="reference-card__rename-input"
            value={draft}
            maxLength={120}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") {
                setRenaming(false);
                setDraft(item.label);
              }
            }}
          />
        ) : (
          <span className="reference-card__label">{item.label}</span>
        )}
        <span className="reference-card__id">{shortIdTag}</span>
      </div>

      <div className="reference-card__actions">
        <button
          type="button"
          className={`reference-card__action-btn${
            item.pinned ? " reference-card__action-btn--active" : ""
          }`}
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin();
          }}
          aria-label={item.pinned ? "Bỏ ghim tham chiếu" : "Ghim tham chiếu"}
          title={item.pinned ? "Bỏ ghim" : "Ghim lên đầu"}
        >
          {item.pinned ? "★" : "☆"}
        </button>
        <button
          type="button"
          className="reference-card__action-btn"
          onClick={(e) => {
            e.stopPropagation();
            setRenaming(true);
          }}
          aria-label="Đổi tên tham chiếu"
          title="Đổi tên"
        >
          ✎
        </button>
        <button
          type="button"
          className={
            "reference-card__action-btn reference-card__action-btn--danger"
            + (confirmDelete ? " reference-card__action-btn--armed" : "")
          }
          onClick={handleDelete}
          disabled={deleting}
          aria-label={
            confirmDelete
              ? "Xác nhận xoá tham chiếu"
              : "Xoá tham chiếu"
          }
          title={
            confirmDelete
              ? "Bấm lần nữa để xác nhận — tự huỷ sau 3 giây"
              : "Xoá (ảnh gốc vẫn còn trong bộ nhớ)"
          }
        >
          {deleting ? "…" : confirmDelete ? "Xác nhận?" : "🗑"}
        </button>
      </div>
    </li>
  );
}

