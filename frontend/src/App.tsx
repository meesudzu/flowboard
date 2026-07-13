import { useEffect, useRef } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { Board } from "./canvas/Board";
import { GenerationBoard } from "./canvas/GenerationBoard";
import { AddNodePalette } from "./canvas/AddNodePalette";
import { StatusBar } from "./components/StatusBar";
import { Toolbar } from "./components/Toolbar";
// import { ChatSidebar } from "./components/ChatSidebar";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { ReferencesPanel } from "./components/ReferencesPanel";
import { Toaster } from "./components/Toaster";
import { GenerationDialog } from "./components/GenerationDialog";
import { ResultViewer } from "./components/ResultViewer";
import { ForcedSetupGate } from "./components/ForcedSetupGate";
import { useBoardStore } from "./store/board";
import { useReferencesStore } from "./store/references";
import { useGenerationStore } from "./store/generation";

export function App() {
  const loadInitialBoard = useBoardStore((s) => s.loadInitialBoard);
  const boardMode = useBoardStore((s) => s.boardMode);
  const loadReferences = useReferencesStore((s) => s.load);
  const loading = useBoardStore((s) => s.loading);
  const boardId = useBoardStore((s) => s.boardId);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    loadInitialBoard();
    // Fire-and-forget: panel renders the loading state inline and the
    // app stays usable even if references fail to hydrate.
    void loadReferences();
    // Re-attach poll loops for any in-flight Request rows the backend
    // has been processing while the page was reloaded — without this
    // the in-memory `active` map starts empty and nodes fall back to
    // whatever status was last persisted (typically "idle" for a node
    // that never finished rendering), losing the "running" spinner
    // even though Flow is still working on the variant.
    void useGenerationStore.getState().rehydrateRunningPolls();
  }, [loadInitialBoard, loadReferences]);

  return (
    <div className="app">
      <ProjectSidebar />
      <ReactFlowProvider>
        <div className="canvas-wrap">
          {boardMode === "generate" ? (
            loading && boardId === null ? (
              <div className="canvas-loading">Loading board…</div>
            ) : (
              <GenerationBoard />
            )
          ) : (
            <>
              <Toolbar />
              {loading && boardId === null ? (
                <div className="canvas-loading">Loading board…</div>
              ) : (
                <>
                  <Board />
                  <AddNodePalette />
                </>
              )}
              <StatusBar />
            </>
          )}
          {boardMode !== "generate" && <ReferencesPanel />}
        </div>
      </ReactFlowProvider>
      {/* <ChatSidebar /> */}
      <Toaster />
      <GenerationDialog />
      <ResultViewer />
      <ForcedSetupGate />
    </div>
  );
}
