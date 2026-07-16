import { useEffect } from "react";
import { useRightPanelStore, type RightPanelTab } from "../store/rightPanel";
import { useReferencesStore } from "../store/references";
import { usePromptTemplatesStore } from "../store/promptTemplates";
import { useBoardStore } from "../store/board";
import { ReferencesPanelContent } from "./ReferencesPanel";
import { PromptTemplatesPanel } from "./PromptTemplatesPanel";

/**
 * Right-side collapsible panel — chrome shared by the References and
 * Templates tabs.
 *
 * Mounted once in ``App.tsx``. Renders:
 *   1. A fixed vertical tab on the right edge that toggles the panel
 *      open / closed. Closed = just the tab; open = full-height aside.
 *   2. When open, a header with two tab buttons (References ★,
 *      Templates 📚) and a close button on the right.
 *   3. The body that corresponds to the active tab — References tab
 *      renders ``ReferencesPanelContent``, Templates tab renders
 *      ``PromptTemplatesPanel``.
 *
 * Open/closed state and active tab are persisted to localStorage via
 * ``useRightPanelStore`` (single key) so the user keeps the same
 * configuration across page reloads.
 *
 * Hydration on first mount: both stores load on App boot already;
 * this component fires them once more (idempotent in both stores) so
 * the panel can stand alone if a future refactor mounts it elsewhere.
 */
export function RightPanel() {
  const panelOpen = useRightPanelStore((s) => s.panelOpen);
  const togglePanel = useRightPanelStore((s) => s.togglePanel);
  const activeTab = useRightPanelStore((s) => s.activeTab);
  const setActiveTab = useRightPanelStore((s) => s.setActiveTab);

  const loadReferences = useReferencesStore((s) => s.load);
  const loadTemplates = usePromptTemplatesStore((s) => s.load);
  // Generation-mode boards have no canvas to drag references onto, so
  // the References tab is irrelevant there — we hide its button and
  // force-switch to Templates whenever a generate-mode board mounts.
  // This keeps the right-side panel useful in both modes (the
  // Templates tab is mode-agnostic).
  const boardMode = useBoardStore((s) => s.boardMode);
  const isGenerateMode = boardMode === "generate";

  // When the user opens a generate-mode board, the references tab is
  // hidden (no canvas to drop references onto). Auto-flip any
  // references-tab state to templates so the panel renders correctly
  // without a manual click.
  useEffect(() => {
    if (isGenerateMode && activeTab === "references") {
      setActiveTab("templates");
    }
  }, [isGenerateMode, activeTab, setActiveTab]);

  // Eagerly hydrate both stores the first time the panel opens so
  // switching tabs is instant. Both load() helpers short-circuit when
  // a load is already in flight, so calling them here is cheap.
  useEffect(() => {
    if (panelOpen) {
      void loadReferences();
      void loadTemplates();
    }
    // Intentionally only re-run when panelOpen flips — the load
    // helpers themselves manage their own idempotency.
  }, [panelOpen, loadReferences, loadTemplates]);

  // When switching to Templates for the very first time (empty items
  // and no error), make sure we kick a load. References already loads
  // app-wide on mount, but Templates doesn't yet.
  useEffect(() => {
    if (panelOpen && activeTab === "templates") {
      void loadTemplates();
    }
  }, [panelOpen, activeTab, loadTemplates]);

  // References tab is hidden in generate mode (no canvas to drag onto);
  // Templates tab is shown in both modes — it's how the user reuses
  // prompts in GenerationBoard's prompt textarea.
  const tabs: { key: RightPanelTab; label: string; icon: string }[] = isGenerateMode
    ? [{ key: "templates", label: "Prompt mẫu", icon: "📚" }]
    : [
        { key: "references", label: "Tham chiếu", icon: "★" },
        { key: "templates", label: "Prompt mẫu", icon: "📚" },
      ];

  return (
    <>
      <aside
        className={
          panelOpen
            ? "references-panel references-panel--open"
            : "references-panel references-panel--collapsed"
        }
        aria-hidden={!panelOpen}
      >
        {/* Always-visible edge tab — sits on the canvas side of the
            panel so the user can collapse (or re-open) it from any
            state without scrolling into the panel header. Default is
            open so the panel is on screen at app start. */}
        <button
          type="button"
          className="references-panel__edge-tab"
          onClick={togglePanel}
          aria-label={panelOpen ? "Thu gọn bảng bên phải" : "Mở bảng bên phải"}
          title={panelOpen ? "Thu gọn" : "Mở bảng bên phải"}
        >
          <span aria-hidden="true">{panelOpen ? "›" : "📚"}</span>
        </button>
        <div className="references-panel__header">
          <div className="references-panel__tabs" role="tablist">
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={activeTab === t.key}
                className={
                  "references-panel__tab"
                  + (activeTab === t.key ? " references-panel__tab--active" : "")
                }
                onClick={() => setActiveTab(t.key)}
                title={t.label}
              >
                <span aria-hidden="true">{t.icon}</span>{" "}
                <span className="references-panel__tab-label">{t.label}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            className="references-panel__close"
            onClick={togglePanel}
            aria-label="Thu gọn bảng bên phải"
            title="Thu gọn"
          >
            ›
          </button>
        </div>

        <div
          className="right-panel__body"
          role="tabpanel"
          aria-label={activeTab === "references" ? "Tham chiếu" : "Prompt mẫu"}
        >
          {activeTab === "references" ? (
            <ReferencesPanelContent />
          ) : (
            <PromptTemplatesPanel />
          )}
        </div>
      </aside>
    </>
  );
}
