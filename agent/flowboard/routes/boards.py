from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlmodel import delete as sql_delete, select

from flowboard.db import get_session
from flowboard.db.models import (
    Asset,
    Board,
    BoardFlowProject,
    ChatMessage,
    Edge,
    Node,
    PipelineRun,
    Plan,
    PlanRevision,
    Request,
)

router = APIRouter(prefix="/api/boards", tags=["boards"])


class BoardCreate(BaseModel):
    name: str
    # Optional at the wire level so existing callers (and tests) that
    # POST only {"name": "..."} still work — defaults to "canvas".
    # Supported values: "canvas", "generate". Any other value is
    # rejected below rather than silently coerced so the typo is loud.
    mode: Optional[str] = None


class BoardUpdate(BaseModel):
    name: str


@router.get("")
def list_boards():
    with get_session() as s:
        return s.exec(select(Board)).all()


_VALID_MODES = ("canvas", "generate")


@router.post("")
def create_board(body: BoardCreate):
    mode = body.mode or "canvas"
    if mode not in _VALID_MODES:
        raise HTTPException(
            status_code=400,
            detail=f"invalid mode {mode!r}; must be one of {list(_VALID_MODES)}",
        )
    with get_session() as s:
        board = Board(name=body.name, mode=mode)
        s.add(board)
        # Insert first so the autoincrement id is populated (used as
        # the FK for the GenerationConfig row below).
        s.flush()
        # Generate-mode projects get a 1:1 config row up-front so the
        # GET endpoint can always return a config (even before the
        # user uploads anything). PK is board_id so the invariant is
        # enforced by the schema.
        if mode == "generate":
            from flowboard.db.models import GenerationConfig
            s.add(GenerationConfig(board_id=board.id))
        # Single commit covers both Board + (optional) GenerationConfig
        # so the Board instance never has to be re-hydrated by a
        # follow-up call -- expire_on_commit would otherwise blow it
        # away between the two commits.
        s.commit()
        s.refresh(board)
        return board


@router.get("/{board_id}")
def get_board(board_id: int):
    with get_session() as s:
        board = s.get(Board, board_id)
        if not board:
            raise HTTPException(404, "board not found")
        nodes = s.exec(select(Node).where(Node.board_id == board_id)).all()
        edges = s.exec(select(Edge).where(Edge.board_id == board_id)).all()
        return {"board": board, "nodes": nodes, "edges": edges}


@router.patch("/{board_id}")
def update_board(board_id: int, body: BoardUpdate):
    with get_session() as s:
        board = s.get(Board, board_id)
        if not board:
            raise HTTPException(404, "board not found")
        board.name = body.name
        s.add(board)
        s.commit()
        s.refresh(board)
        return board


@router.delete("/{board_id}")
def delete_board(board_id: int):
    """Cascade-delete a board and everything that hangs off it.

    SQLite enforces FK constraints, so we have to clear children before
    the parent. Order:
      Asset(node_id) → Request(node_id) → Node
      PipelineRun(plan_id) → PlanRevision(plan_id) → Plan
      Edge → ChatMessage → BoardFlowProject → Board.

    Note: this only removes the *local* mapping to a Google Flow project.
    The project on labs.google itself is NOT deleted (Flow doesn't expose a
    delete-project API through the flow_client we use).
    """
    with get_session() as s:
        board = s.get(Board, board_id)
        if not board:
            raise HTTPException(404, "board not found")

        # Children-of-children first.
        node_ids = [
            n.id for n in s.exec(select(Node).where(Node.board_id == board_id)).all()
        ]
        if node_ids:
            s.exec(sql_delete(Asset).where(Asset.node_id.in_(node_ids)))
            s.exec(sql_delete(Request).where(Request.node_id.in_(node_ids)))

        plan_ids = [
            p.id for p in s.exec(select(Plan).where(Plan.board_id == board_id)).all()
        ]
        if plan_ids:
            s.exec(sql_delete(PipelineRun).where(PipelineRun.plan_id.in_(plan_ids)))
            s.exec(sql_delete(PlanRevision).where(PlanRevision.plan_id.in_(plan_ids)))

        # Edge has FK on Node (source_id, target_id) — must clear before Node.
        s.exec(sql_delete(Edge).where(Edge.board_id == board_id))
        s.exec(sql_delete(Node).where(Node.board_id == board_id))
        s.exec(sql_delete(Plan).where(Plan.board_id == board_id))
        s.exec(sql_delete(ChatMessage).where(ChatMessage.board_id == board_id))
        s.exec(sql_delete(BoardFlowProject).where(BoardFlowProject.board_id == board_id))
        # Generation-mode children: result → product → config. All
        # scoped by board_id (we don't even need to follow product_id
        # because GenerationResult.board_id is independently indexed,
        # making the cascade a constant-time two-pass delete).
        from flowboard.db.models import GenerationConfig, GenerationProduct, GenerationResult
        s.exec(sql_delete(GenerationResult).where(GenerationResult.board_id == board_id))
        s.exec(sql_delete(GenerationProduct).where(GenerationProduct.board_id == board_id))
        s.exec(sql_delete(GenerationConfig).where(GenerationConfig.board_id == board_id))
        s.delete(board)
        s.commit()
        return {"deleted": board_id}
