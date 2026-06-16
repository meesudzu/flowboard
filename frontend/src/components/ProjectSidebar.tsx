import { useEffect, useRef, useState } from "react";
import { useBoardStore } from "../store/board";
import { AccountPanel } from "./AccountPanel";
import {
  getFlowSyncStatus,
  syncBoardsUpToFlow,
  type BoardFlowStatus,
} from "../api/client";

/**
 * Left sidebar listing every local "project" (Board). Click an item to
 * switch the active board; the canvas re-loads its nodes/edges. Provides
 * inline create / rename / delete (with confirm) — all backed by the
 * /api/boards CRUD that already cascades to children on delete.
 */
export function ProjectSidebar() {
  const boards = useBoardStore((s) => s.boards);
  const activeId = useBoardStore((s) => s.boardId);
  const switchBoard = useBoardStore((s) => s.switchBoard);
  const createNewBoard = useBoardStore((s) => s.createNewBoard);
  const deleteBoardById = useBoardStore((s) => s.deleteBoardById);
  const renameBoard = useBoardStore((s) => s.renameBoard);

  const [collapsed, setCollapsed] = useState(false);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [newDialogName, setNewDialogName] = useState("");
  const [newDialogBusy, setNewDialogBusy] = useState(false);
  const newDialogInputRef = useRef<HTMLInputElement>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; name: string } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // Flow project sync — one-way (local → Flow). The map tracks which
  // local boards still have a live Flow project; the sync button
  // auto-creates Flow projects for any board that's missing one.
  const [flowStatus, setFlowStatus] = useState<Map<number, BoardFlowStatus>>(
    () => new Map(),
  );
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncSummary, setSyncSummary] = useState<string | null>(null);

  async function refreshStatus(): Promise<Map<number, BoardFlowStatus>> {
    const res = await getFlowSyncStatus();
    const m = new Map(res.board_status.map((b) => [b.board_id, b]));
    setFlowStatus(m);
    return m;
  }

  async function handleSyncClick() {
    if (syncing) return;
    setSyncing(true);
    setSyncError(null);
    setSyncSummary(null);
    try {
      // Refresh status, then push any orphans up to Flow in one shot.
      const status = await refreshStatus();
      const orphans = Array.from(status.values()).filter(
        (b) => !b.exists_on_flow,
      ).length;
      if (orphans === 0) {
        setSyncSummary("Tất cả bảng vẽ đã có trên Flow ✓");
      } else {
        const res = await syncBoardsUpToFlow();
        await refreshStatus();
        const ok = res.synced.length;
        const fail = res.failed.length;
        setSyncSummary(
          fail === 0
            ? `Đã đẩy ${ok} board${ok !== 1 ? "s" : ""} to Flow ✓`
            : `Đã đẩy ${ok}, ${fail} failed — xem log của agent`,
        );
      }
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : "đồng bộ thất bại");
    } finally {
      setSyncing(false);
    }
  }

  // First-mount status read — best-effort, silent on failure (extension
  // might not be connected yet; user can hit the button to retry).
  useEffect(() => {
    refreshStatus().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (renamingId !== null) {
      setTimeout(() => renameInputRef.current?.select(), 30);
    }
  }, [renamingId]);

  // Click-outside closes the kebab menu.
  useEffect(() => {
    if (openMenuId === null) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && !t.closest(".project-sidebar__menu") && !t.closest(".project-sidebar__kebab")) {
        setOpenMenuId(null);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [openMenuId]);

  function handleNew() {
    setNewDialogName("Chưa đặt tên");
    setNewDialogOpen(true);
    setTimeout(() => newDialogInputRef.current?.select(), 30);
  }

  function closeNewDialog() {
    if (newDialogBusy) return;
    setNewDialogOpen(false);
    setNewDialogName("");
  }

  async function commitNewDialog() {
    if (newDialogBusy) return;
    const name = newDialogName.trim() || "Chưa đặt tên";
    setNewDialogBusy(true);
    try {
      await createNewBoard(name);
    } finally {
      setNewDialogBusy(false);
      setNewDialogOpen(false);
      setNewDialogName("");
    }
  }

  // Esc closes the new-project dialog.
  useEffect(() => {
    if (!newDialogOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeNewDialog();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newDialogOpen, newDialogBusy]);

  function startRename(id: number, currentName: string) {
    setRenamingId(id);
    setRenameDraft(currentName);
    setOpenMenuId(null);
  }

  async function commitRename() {
    if (renamingId === null) return;
    const name = renameDraft.trim();
    if (!name) {
      setRenamingId(null);
      return;
    }
    // Only the active board can be renamed via the existing renameBoard
    // action; for other boards, switch first then rename. Keeps the
    // backend round-trip simple.
    if (renamingId !== activeId) {
      await switchBoard(renamingId);
    }
    await renameBoard(name);
    setRenamingId(null);
  }

  function openDeleteConfirm(id: number, name: string) {
    setOpenMenuId(null);
    setDeleteTarget({ id, name });
  }

  async function commitDelete() {
    if (!deleteTarget || deleteBusy) return;
    setDeleteBusy(true);
    try {
      await deleteBoardById(deleteTarget.id);
    } finally {
      setDeleteBusy(false);
      setDeleteTarget(null);
    }
  }

  function cancelDelete() {
    if (deleteBusy) return;
    setDeleteTarget(null);
  }

  // Esc closes the delete-confirm dialog.
  useEffect(() => {
    if (!deleteTarget) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelDelete();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deleteTarget, deleteBusy]);

  return (
    <aside className={`project-sidebar${collapsed ? " project-sidebar--collapsed" : ""}`}>
      <div className="project-sidebar__header">
        {!collapsed && <span className="project-sidebar__title">Dự án</span>}
        <button
          type="button"
          className="project-sidebar__icon-btn"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "Mở rộng thanh bên" : "Thu gọn thanh bên"}
          title={collapsed ? "Mở rộng" : "Thu gọn"}
        >
          {collapsed ? "›" : "‹"}
        </button>
      </div>
      {!collapsed && (
        <>
          <div className="project-sidebar__row">
            <button
              type="button"
              className="project-sidebar__new"
              onClick={handleNew}
            >
              <span aria-hidden="true">+</span> Dự án mới
            </button>
            <button
              type="button"
              className="project-sidebar__sync"
              onClick={handleSyncClick}
              disabled={syncing}
              title="Đẩy mọi bảng vẽ local lên Google Flow — tạo Flow project cho bảng nào chưa có"
              aria-label="Đồng bộ bảng vẽ local lên Google Flow"
            >
              {syncing ? "…" : "🔄"}
            </button>
          </div>
          {syncError && (
            <div className="project-sidebar__sync-error" role="status">
              Flow sync: {syncError}
            </div>
          )}
          {syncSummary && !syncError && (
            <div className="project-sidebar__sync-ok" role="status">
              {syncSummary}
            </div>
          )}
          <ul className="project-sidebar__list">
            {boards.map((b) => {
              const isActive = b.id === activeId;
              const isRenaming = b.id === renamingId;
              const status = flowStatus.get(b.id);
              // Orphan = bound flow_project_id is missing from Flow's
              // remote list. We only flag once we've synced at least
              // once (status is present); pre-sync state is "unknown".
              const isOrphan =
                status !== undefined
                && status.flow_project_id !== null
                && status.exists_on_flow === false;
              return (
                <li
                  key={b.id}
                  className={`project-sidebar__item${isActive ? " project-sidebar__item--active" : ""}`}
                >
                  {isRenaming ? (
                    <input
                      ref={renameInputRef}
                      className="project-sidebar__rename-input"
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename();
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                    />
                  ) : (
                    <>
                      <button
                        type="button"
                        className="project-sidebar__name"
                        onClick={() => switchBoard(b.id)}
                        title={
                          isOrphan
                            ? `${b.name} — Flow project ${status?.flow_project_id ?? ""} không tồn tại trên Google Flow. Click ⋯ → Rebind to re-link.`
                            : b.name
                        }
                      >
                        {b.name || "Chưa đặt tên"}
                        {isOrphan && (
                          <span
                            className="project-sidebar__orphan-badge"
                            title="Không tìm thấy Flow project — cần rebind"
                            aria-label="orphan"
                          >
                            ⚠
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        className="project-sidebar__kebab"
                        onClick={() =>
                          setOpenMenuId((cur) => (cur === b.id ? null : b.id))
                        }
                        aria-label="Thao tác dự án"
                      >
                        ⋯
                      </button>
                      {openMenuId === b.id && (
                        <div className="project-sidebar__menu" role="menu">
                          <button
                            type="button"
                            onClick={() => startRename(b.id, b.name)}
                          >
                            Đổi tên
                          </button>
                          <button
                            type="button"
                            className="project-sidebar__menu-danger"
                            onClick={() => openDeleteConfirm(b.id, b.name)}
                          >
                            Xoá
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </li>
              );
            })}
            {boards.length === 0 && (
              <li className="project-sidebar__empty">Chưa có dự án nào</li>
            )}
          </ul>
        </>
      )}

      {/* Pinned-bottom account chip — sits below the project list because
          the list above has flex: 1 and pushes everything that follows
          to the bottom of the column. */}
      <AccountPanel collapsed={collapsed} />

      {deleteTarget && (
        <div
          className="project-modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) cancelDelete();
          }}
        >
          <div
            className="project-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-project-title"
          >
            <h2 id="delete-project-title" className="project-modal__title">
              Xoá dự án?
            </h2>
            <p className="project-modal__hint">
              <strong>"{deleteTarget.name}"</strong> sẽ bị xoá vĩnh viễn cùng
              với tất cả nodes, edges, generations, và assets bên trong. Không
              thể khôi phục.
            </p>
            <div className="project-modal__actions">
              <button
                type="button"
                className="project-modal__btn"
                onClick={cancelDelete}
                disabled={deleteBusy}
              >
                Huỷ
              </button>
              <button
                type="button"
                className="project-modal__btn project-modal__btn--danger"
                onClick={commitDelete}
                disabled={deleteBusy}
                autoFocus
              >
                {deleteBusy ? "Đang xoá…" : "Xoá"}
              </button>
            </div>
          </div>
        </div>
      )}

      {newDialogOpen && (
        <div
          className="project-modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeNewDialog();
          }}
        >
          <div
            className="project-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-project-title"
          >
            <h2 id="new-project-title" className="project-modal__title">
              Dự án mới
            </h2>
            <p className="project-modal__hint">
              Tên project hiển thị trong sidebar. Có thể đổi sau.
            </p>
            <input
              ref={newDialogInputRef}
              className="project-modal__input"
              type="text"
              maxLength={80}
              value={newDialogName}
              onChange={(e) => setNewDialogName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitNewDialog();
                if (e.key === "Escape") closeNewDialog();
              }}
              placeholder="Chưa đặt tên"
              disabled={newDialogBusy}
              autoFocus
            />
            <div className="project-modal__actions">
              <button
                type="button"
                className="project-modal__btn"
                onClick={closeNewDialog}
                disabled={newDialogBusy}
              >
                Huỷ
              </button>
              <button
                type="button"
                className="project-modal__btn project-modal__btn--primary"
                onClick={commitNewDialog}
                disabled={newDialogBusy}
              >
                {newDialogBusy ? "Đang tạo…" : "Tạo"}
              </button>
            </div>
          </div>
        </div>
      )}

    </aside>
  );
}
