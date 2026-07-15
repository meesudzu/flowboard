import { useEffect, useMemo, useRef, useState } from "react";
import type { PromptTemplate } from "../api/client";
import {
  filterPromptTemplates,
  usePromptTemplatesStore,
} from "../store/promptTemplates";
import { PromptTemplateEditor } from "./PromptTemplateEditor";

/**
 * Right-side Templates tab content.
 *
 * Renders the list of prompt templates with search, inline rename,
 * 2-step delete confirm, and a copy-to-clipboard action that mirrors
 * how the user would consume the template in another tab. The "+ Mẫu
 * mới" button opens ``PromptTemplateEditor`` in create mode; the
 * per-card "✎" opens it in edit mode.
 *
 * This component is the tab body only — the toggle/header/edge tab
 * live in ``RightPanel``, which is responsible for the open/closed
 * state. Reads from ``usePromptTemplatesStore`` directly so a create
 * elsewhere (e.g. importing templates from another tab) shows up
 * without an explicit reload.
 */
export function PromptTemplatesPanel() {
  const items = usePromptTemplatesStore((s) => s.items);
  const loading = usePromptTemplatesStore((s) => s.loading);
  const error = usePromptTemplatesStore((s) => s.error);
  const load = usePromptTemplatesStore((s) => s.load);
  const create = usePromptTemplatesStore((s) => s.create);
  const update = usePromptTemplatesStore((s) => s.update);
  const remove = usePromptTemplatesStore((s) => s.remove);

  // Local UI state — search query + which template the editor is
  // currently editing (``null`` = editor closed, ``undefined`` = open
  // for create, otherwise the PromptTemplate being edited).
  const [query, setQuery] = useState("");
  // ``null``  → editor closed.
  // object    → editor open, editing that template.
  // We don't have a separate "creating" sentinel because the editor
  // differentiates via ``template === null``; opening it without an
  // argument would conflate "create" and "edit existing". Use a small
  // boolean flag instead.
  const [editing, setEditing] = useState<PromptTemplate | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Hydrate once on mount. Subsequent list changes (create / patch /
  // delete from anywhere) update the store directly, so we don't
  // re-fetch on focus.
  useEffect(() => {
    if (items.length === 0 && !loading && error === null) {
      void load();
    }
    // Intentionally don't depend on `items.length` — that would cause
    // a refetch every time a CRUD mutation succeeds. `load()` is
    // internally idempotent (returns early when `loading` is true).
  }, [items.length, loading, error, load]);

  const filtered = useMemo(() => filterPromptTemplates(items, query), [items, query]);

  const handleSave = async (values: { title: string; body: string }) => {
    if (creating) {
      try {
        await create(values);
      } catch (e) {
        setCreateError(e instanceof Error ? e.message : String(e));
        throw e;
      }
    } else if (editing) {
      await update(editing.id, values);
    }
  };

  const closeEditor = () => {
    setEditing(null);
    setCreating(false);
    setCreateError(null);
  };

  return (
    <div className="prompt-templates-panel">
      <div className="prompt-templates-panel__toolbar">
        <input
          type="text"
          className="prompt-templates-panel__search"
          placeholder="🔍 tìm tiêu đề mẫu…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Tìm kiếm prompt mẫu"
        />
        <button
          type="button"
          className="prompt-templates-panel__add-btn"
          onClick={() => {
            setCreateError(null);
            setEditing(null);
            setCreating(true);
          }}
          title="Tạo prompt mẫu mới"
        >
          + Mẫu mới
        </button>
      </div>

      {error && (
        <div className="prompt-templates-panel__error" role="alert">
          {error}
        </div>
      )}

      {loading && items.length === 0 && (
        <div className="prompt-templates-panel__empty">Đang tải…</div>
      )}

      {!loading && items.length === 0 && (
        <div className="prompt-templates-panel__empty">
          Chưa có prompt mẫu nào. Bấm <strong>+ Mẫu mới</strong> để tạo,
          rồi chèn vào ô tạo ảnh bằng nút <strong>📚 Mẫu</strong> trên dialog.
        </div>
      )}

      {!loading && items.length > 0 && filtered.length === 0 && (
        <div className="prompt-templates-panel__empty">
          Không có mẫu nào khớp "{query}".
        </div>
      )}

      <ul className="prompt-templates-panel__list">
        {filtered.map((tpl) => (
          <PromptTemplateCard
            key={tpl.id}
            item={tpl}
            onEdit={() => {
              setCreateError(null);
              setCreating(false);
              setEditing(tpl);
            }}
            onDelete={() => remove(tpl.id)}
          />
        ))}
      </ul>

      {(creating || editing !== null) && (
        <PromptTemplateEditor
          template={editing}
          onClose={closeEditor}
          onSave={handleSave}
        />
      )}

      {createError && (
        <div className="prompt-templates-panel__toast-error" role="alert">
          {createError}
        </div>
      )}
    </div>
  );
}

interface PromptTemplateCardProps {
  item: PromptTemplate;
  onEdit: () => void;
  onDelete: () => Promise<void>;
}

/**
 * One row in the Templates list — shows the title, a 1-line preview of
 * the body (truncated), and three actions:
 *   - ✎ → opens the editor in update mode
 *   - 📋 → copies the body to clipboard (the most common consumption
 *          path when the user wants to paste it into a non-Flowboard
 *          app, or stash it elsewhere while iterating)
 *   - 🗑 → 2-step delete confirm (matches ReferenceCard)
 *
 * The card is NOT draggable (templates are pure text — there's no
 * canvas asset to drop). Body wrapping is intentionally clamped to
 * ~80 chars so a very long template doesn't dominate the panel.
 */
function PromptTemplateCard({ item, onEdit, onDelete }: PromptTemplateCardProps) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(item.title);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "fail">("idle");
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the rename draft in sync if the underlying title changes
  // (e.g. from a PATCH that bypassed the editor — defensive since the
  // editor closes on save and shouldn't leave a stale draft).
  useEffect(() => {
    if (!renaming) setDraft(item.title);
  }, [item.title, renaming]);

  // Clear timers on unmount so we don't try to setState on a dead node.
  useEffect(() => {
    return () => {
      if (confirmTimerRef.current !== null) clearTimeout(confirmTimerRef.current);
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const trimmedDraft = draft.trim();
  const canRename = trimmedDraft.length > 0 && trimmedDraft !== item.title;

  const commitRename = () => {
    setRenaming(false);
    if (!canRename) {
      setDraft(item.title);
      return;
    }
    // No separate rename endpoint in v1 — open the editor in update
    // mode so the user also sees (and can tweak) the body. This keeps
    // "rename" and "edit" as the same affordance; reduces code paths.
    onEdit();
  };

  function armDeleteConfirm() {
    setConfirmDelete(true);
    if (confirmTimerRef.current !== null) clearTimeout(confirmTimerRef.current);
    confirmTimerRef.current = setTimeout(() => {
      setConfirmDelete(false);
      confirmTimerRef.current = null;
    }, 3000);
  }

  async function handleDelete(e: React.MouseEvent) {
    e.stopPropagation();
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
    } catch {
      // Surface via store.error; revert the local UI so the user can retry.
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  async function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      // Prefer the modern API; fall back to the legacy hidden-textarea
      // trick when navigator.clipboard isn't available (older Safari
      // builds, some embedded webviews).
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(item.body);
      } else {
        const ta = document.createElement("textarea");
        ta.value = item.body;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopyState("copied");
    } catch {
      setCopyState("fail");
    }
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => {
      setCopyState("idle");
      copyTimerRef.current = null;
    }, 1500);
  }

  // Body preview — collapse whitespace to single spaces, clamp to ~80
  // characters, append ellipsis when truncated. Pure text, no markup.
  const preview = item.body.replace(/\s+/g, " ").trim();
  const previewClipped =
    preview.length > 80 ? preview.slice(0, 80).trimEnd() + "…" : preview;

  const copyLabel =
    copyState === "copied"
      ? "✓ Đã sao chép"
      : copyState === "fail"
      ? "✗ Lỗi"
      : "📋 Sao chép";

  return (
    <li
      className="prompt-template-card"
      onClick={() => {
        // Clicking the row outside of an action also opens edit — this
        // matches how the References panel treats click-to-spawn, but
        // here it's click-to-edit (cheap because nothing is dragged
        // onto a canvas).
        if (!renaming) onEdit();
      }}
      title={item.body}
    >
      <div className="prompt-template-card__body">
        {renaming ? (
          <input
            className="prompt-template-card__rename-input"
            value={draft}
            maxLength={120}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitRename();
              }
              if (e.key === "Escape") {
                setRenaming(false);
                setDraft(item.title);
              }
            }}
          />
        ) : (
          <span className="prompt-template-card__title">{item.title}</span>
        )}
        <span className="prompt-template-card__preview">
          {previewClipped || <em>(chưa có nội dung)</em>}
        </span>
      </div>
      <div className="prompt-template-card__actions" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="prompt-template-card__action-btn"
          onClick={handleCopy}
          aria-label="Sao chép nội dung vào clipboard"
          title="Sao chép nội dung"
        >
          {copyLabel}
        </button>
        <button
          type="button"
          className="prompt-template-card__action-btn"
          onClick={(e) => {
            e.stopPropagation();
            setRenaming(true);
          }}
          aria-label="Sửa prompt mẫu"
          title="Sửa"
        >
          ✎
        </button>
        <button
          type="button"
          className={
            "prompt-template-card__action-btn prompt-template-card__action-btn--danger"
            + (confirmDelete ? " prompt-template-card__action-btn--armed" : "")
          }
          onClick={handleDelete}
          disabled={deleting}
          aria-label={
            confirmDelete
              ? "Xác nhận xoá prompt mẫu"
              : "Xoá prompt mẫu"
          }
          title={
            confirmDelete
              ? "Bấm lần nữa để xác nhận — tự huỷ sau 3 giây"
              : "Xoá prompt mẫu"
          }
        >
          {deleting ? "…" : confirmDelete ? "Xác nhận?" : "🗑"}
        </button>
      </div>
    </li>
  );
}
