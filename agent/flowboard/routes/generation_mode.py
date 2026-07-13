"""Image-generation mode endpoints.

For boards created with ``mode="generate"``. The canvas is bypassed entirely;
the user uploads ONE model image + a batch of product images, writes a
shared prompt, then hits "Tạo ảnh" to produce one output image per product
(model + product in the same scene).

Routes (all under ``/api/boards/{board_id}/generation-mode``):

  GET    ""                 -> return config + products + latest results
  POST   "/model"           -> multipart, replaces GenerationConfig.model_media_id
  POST   "/products"        -> multipart (1+ files), appends GenerationProduct rows
  DELETE "/products/{pid}"  -> remove product + its results
  PATCH  "/config"          -> prompt/aspect_ratio/image_model
  POST   "/generate"        -> enqueue one Request per selected product
  POST   "/products/{pid}/regenerate"  -> re-enqueue a single product

All uploads reuse ``_ingest_image_bytes`` from routes/upload.py so the same
10 MB cap + magic-byte sniff + Flow SDK round-trip applies -- we don't
fork that pipeline.

Generation results live in the ``GenerationResult`` table; the gallery
endpoint reads the LATEST row per product (ordered by created_at DESC), so
a failed-then-regenerated product naturally surfaces the new output without
the user seeing the old one in the same row.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlmodel import select

from flowboard.db import get_session
from flowboard.db.models import (
    Board,
    BoardFlowProject,
    GenerationConfig,
    GenerationProduct,
    GenerationResult,
    Reference,
)
from flowboard.routes.upload import (
    ALLOWED_UPLOAD_MIMES,
    _EXT_BY_MIME,
    MAX_UPLOAD_BYTES,
    _ingest_image_bytes,
)
from flowboard.services.flow_sdk import MAX_VARIANT_COUNT
from flowboard.worker.processor import get_worker

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/boards/{board_id}/generation-mode",
    tags=["generation-mode"],
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _require_generate_board(s, board_id: int) -> Board:
    """Load the board and assert it's in generate mode. Returns the row."""
    board = s.get(Board, board_id)
    if board is None:
        raise HTTPException(404, "board not found")
    if board.mode != "generate":
        raise HTTPException(
            409,
            f"board {board_id} is in mode {board.mode!r}; "
            "generation-mode endpoints only accept 'generate' boards",
        )
    return board


def _ensure_config(s, board_id: int) -> GenerationConfig:
    cfg = s.get(GenerationConfig, board_id)
    if cfg is None:
        # Defensive: create the singleton if it's missing for any reason
        # (e.g. legacy generate-mode board created without the auto-spawn
        # in routes/boards.py). PK is board_id so this is idempotent.
        cfg = GenerationConfig(board_id=board_id)
        s.add(cfg)
        s.commit()
        s.refresh(cfg)
    return cfg


def _ensure_flow_project_sync(s, board_id: int) -> Optional[str]:
    """Return the Flow project id from the DB row, or None if not bound yet.

    Synchronous variant of the async ensure_flow_project helper; used by
    endpoints that have already opened a session for the request and want
    to defer the project-creation round-trip to the upload step (which
    has the longer lifecycle anyway).
    """
    bind = s.get(BoardFlowProject, board_id)
    return bind.flow_project_id if bind else None


async def _ensure_flow_project(board_id: int) -> str:
    """Return the Flow project id, creating one via ensure_board_project if missing."""
    from flowboard.routes.projects import ensure_board_project

    with get_session() as s:
        bind = s.get(BoardFlowProject, board_id)
        if bind is not None:
            return bind.flow_project_id
    created = await ensure_board_project(board_id=board_id)
    return created["flow_project_id"]


def _serialize_product(p: GenerationProduct) -> dict[str, Any]:
    return {
        "id": p.id,
        "board_id": p.board_id,
        "media_id": p.media_id,
        "position": p.position,
        "label": p.label,
        "uploaded_at": p.uploaded_at.isoformat() if p.uploaded_at else None,
    }


def _serialize_result(r: GenerationResult) -> dict[str, Any]:
    return {
        "id": r.id,
        "board_id": r.board_id,
        "product_id": r.product_id,
        "output_media_id": r.output_media_id,
        "prompt_used": r.prompt_used,
        "status": r.status,
        "error": r.error,
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "finished_at": r.finished_at.isoformat() if r.finished_at else None,
    }


async def _upload_one(
    file: UploadFile,
    project_id: str,
    node_id: Optional[int] = None,
) -> dict[str, Any]:
    """Run one upload through the existing ingestion pipeline."""
    mime = (file.content_type or "").lower().split(";")[0].strip()
    if mime not in ALLOWED_UPLOAD_MIMES:
        raise HTTPException(
            415,
            f"unsupported mime: {mime!r}; allowed: {sorted(ALLOWED_UPLOAD_MIMES)}",
        )
    raw = await file.read(MAX_UPLOAD_BYTES + 1)
    size = len(raw)
    if size == 0:
        raise HTTPException(400, "empty file")
    if size > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"file too large: {size} > {MAX_UPLOAD_BYTES}")
    file_name = file.filename or f"upload{_EXT_BY_MIME.get(mime, '')}"
    return await _ingest_image_bytes(raw, mime, project_id, file_name, node_id)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("")
def get_generation_mode(board_id: int):
    """Return the full generation-mode state for the board."""
    with get_session() as s:
        _require_generate_board(s, board_id)
        cfg = _ensure_config(s, board_id)
        products = list(
            s.exec(
                select(GenerationProduct)
                .where(GenerationProduct.board_id == board_id)
                .order_by(GenerationProduct.position.asc(), GenerationProduct.uploaded_at.asc())
            ).all()
        )
        all_results = list(
            s.exec(
                select(GenerationResult)
                .where(GenerationResult.board_id == board_id)
                .order_by(GenerationResult.created_at.desc())
            ).all()
        )
    # Latest result per product: iterate created_at DESC, first wins.
    latest_per_product: dict[int, GenerationResult] = {}
    for r in all_results:
        if r.product_id not in latest_per_product:
            latest_per_product[r.product_id] = r
    return {
        "board_id": board_id,
        "config": {
            "model_media_id": cfg.model_media_id,
            "prompt": cfg.prompt,
            "aspect_ratio": cfg.aspect_ratio,
            "image_model": cfg.image_model,
            "updated_at": cfg.updated_at.isoformat() if cfg.updated_at else None,
        },
        "products": [_serialize_product(p) for p in products],
        "results": [
            _serialize_result(latest_per_product[p.id])
            for p in products
            if p.id in latest_per_product
        ],
    }


@router.post("/model")
async def upload_model(board_id: int, file: UploadFile = File(...)):
    """Replace the model image for this generate-mode project."""
    with get_session() as s:
        _require_generate_board(s, board_id)
        _ensure_config(s, board_id)
        project_id = await _ensure_flow_project(board_id)
    # Upload is OUTSIDE the session so the round-trip doesn't hold the DB lock.
    out = await _upload_one(file, project_id, node_id=None)
    with get_session() as s:
        cfg = s.get(GenerationConfig, board_id)
        cfg.model_media_id = out["media_id"]
        cfg.updated_at = datetime.now(timezone.utc)
        s.add(cfg)
        s.commit()
    return {
        "media_id": out["media_id"],
        "mime": out.get("mime"),
        "size": out.get("size"),
        "aspect_ratio": out.get("aspect_ratio"),
        "width": out.get("width"),
        "height": out.get("height"),
    }


#: Bound parallel uploads to keep Chrome-extension round-trips in check.
#: Flow dispatches one WS request at a time per project, so anything
#: beyond ~4 concurrent uploads serialises inside the extension anyway
#: -- but capping here avoids holding N connections open from the agent
#: side and keeps the per-upload latency observable in the UI.
_MAX_UPLOAD_CONCURRENCY = 4


async def _do_upload_one(
    board_id: int,
    project_id: str,
    f: "UploadFile",
    pos: int,
) -> dict[str, Any]:
    """Upload a single file + write its GenerationProduct row.

    Returns ``{"ok": True, "filename": ..., "product": {...}}`` on success
    or ``{"ok": False, "filename": ..., "error": str, "position": int}``
    on any failure. The caller aggregates these into the endpoint's
    response (see ``upload_products``).
    """
    try:
        out = await _upload_one(f, project_id, node_id=None)
    except HTTPException as exc:
        # Propagate the user-friendly detail (mime / size / validation
        # errors) so the frontend can show it in the per-file UI.
        detail = exc.detail
        msg = detail.get("message") if isinstance(detail, dict) else str(detail)
        return {"ok": False, "filename": f.filename, "position": pos, "error": str(msg)[:500]}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "filename": f.filename, "position": pos, "error": str(exc)[:500]}

    with get_session() as s:
        prod = GenerationProduct(
            board_id=board_id,
            media_id=out["media_id"],
            position=pos,
        )
        s.add(prod)
        s.commit()
        s.refresh(prod)
    return {
        "ok": True,
        "filename": f.filename,
        "position": pos,
        "product": {
            "id": prod.id,
            "media_id": prod.media_id,
            "position": prod.position,
            "label": prod.label,
            "uploaded_at": prod.uploaded_at.isoformat() if prod.uploaded_at else None,
        },
    }


@router.post("/products")
async def upload_products(board_id: int, files: list[UploadFile] = File(...)):
    """Upload one or more product images. Each becomes a GenerationProduct row.

    Files are uploaded to Flow **in parallel** (concurrency capped at
    ``_MAX_UPLOAD_CONCURRENCY = 4`` -- Flow's uploadImage is dispatched
    one-at-a-time per project inside the extension, so this cap keeps
    round-trips observable in the UI without pointless overshoot).

    Per-file outcomes are echoed back via ``products`` (successes) and
    ``failures`` (rejected / errored), matched to the input by filename.
    The frontend uses this to render an individual state per image
    instead of one global "uploading products" spinner.
    """
    if not files:
        raise HTTPException(400, "no files provided")
    with get_session() as s:
        _require_generate_board(s, board_id)
        project_id = await _ensure_flow_project(board_id)
        max_pos = s.exec(
            select(GenerationProduct.position)
            .where(GenerationProduct.board_id == board_id)
            .order_by(GenerationProduct.position.desc())
        ).first()
        next_pos = (max_pos or 0) + 1

    # Assign positions upfront so the parallel tasks write rows in a
    # deterministic order even when they complete out-of-order. This
    # keeps the gallery stable when the user drops 10 files at once.
    positions = list(range(next_pos, next_pos + len(files)))

    sem = asyncio.Semaphore(_MAX_UPLOAD_CONCURRENCY)
    async def _bounded(f: "UploadFile", pos: int) -> dict[str, Any]:
        async with sem:
            return await _do_upload_one(board_id, project_id, f, pos)

    tasks = [_bounded(f, pos) for f, pos in zip(files, positions)]
    raw_results = await asyncio.gather(*tasks, return_exceptions=True)

    products: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    for f, pos, r in zip(files, positions, raw_results):
        if isinstance(r, Exception):
            # Defensive: if the helper itself raised (it shouldn't --
            # it captures exceptions internally -- but a programming
            # error or asyncio.CancelledError would surface here).
            err_msg = f"{type(r).__name__}: {r}"[:500]
            failures.append({
                "filename": f.filename,
                "position": pos,
                "error": err_msg,
            })
            continue
        if r.get("ok"):
            prod = dict(r["product"])
            prod["filename"] = f.filename
            products.append(prod)
        else:
            failures.append({
                "filename": f.filename,
                "position": pos,
                "error": r.get("error", "unknown"),
            })
    return {"products": products, "failures": failures}


@router.delete("/products/{product_id}")
def delete_product(board_id: int, product_id: int):
    """Remove one product (and all of its generation results).

    GenerationResult has a FK on GenerationProduct.id, so we have to
    delete children before the parent. SQLAlchemy's topological sort
    doesn't always emit child DELETEs first when both rows are queued
    in the same session, so we use raw sql_delete() in explicit order
    (matches the pattern used by delete_board for its cascade).
    """
    from sqlmodel import delete as sql_delete
    with get_session() as s:
        prod = s.get(GenerationProduct, product_id)
        if prod is None or prod.board_id != board_id:
            raise HTTPException(404, "product not found in this project")
        # Children first (FK targets generationproduct.id).
        s.exec(sql_delete(GenerationResult).where(
            (GenerationResult.board_id == board_id)
            & (GenerationResult.product_id == product_id)
        ))
        s.exec(sql_delete(GenerationProduct).where(
            (GenerationProduct.board_id == board_id)
            & (GenerationProduct.id == product_id)
        ))
        s.commit()
    return {"deleted_product_id": product_id}


class ConfigPatch(BaseModel):
    prompt: Optional[str] = None
    aspect_ratio: Optional[str] = None
    image_model: Optional[str] = None


_VALID_ASPECTS = (
    "IMAGE_ASPECT_RATIO_SQUARE",
    "IMAGE_ASPECT_RATIO_PORTRAIT",
    "IMAGE_ASPECT_RATIO_LANDSCAPE",
)


@router.patch("/config")
def patch_config(board_id: int, body: ConfigPatch):
    with get_session() as s:
        _require_generate_board(s, board_id)
        cfg = _ensure_config(s, board_id)
        if body.prompt is not None:
            cfg.prompt = body.prompt
        if body.aspect_ratio is not None:
            if body.aspect_ratio not in _VALID_ASPECTS:
                raise HTTPException(
                    400,
                    f"invalid aspect_ratio {body.aspect_ratio!r}; "
                    f"allowed: {list(_VALID_ASPECTS)}",
                )
            cfg.aspect_ratio = body.aspect_ratio
        if body.image_model is not None:
            cfg.image_model = body.image_model
        cfg.updated_at = datetime.now(timezone.utc)
        s.add(cfg)
        s.commit()
        s.refresh(cfg)
    return {
        "model_media_id": cfg.model_media_id,
        "prompt": cfg.prompt,
        "aspect_ratio": cfg.aspect_ratio,
        "image_model": cfg.image_model,
        "updated_at": cfg.updated_at.isoformat() if cfg.updated_at else None,
    }


class GenerateBody(BaseModel):
    product_ids: Optional[list[int]] = None


def _build_prompt(user_prompt: str, product_label: str) -> str:
    """Compose the final structuredPrompt sent to Flow.

    Diffusion models weight earlier tokens more, so the product-aware
    prefix lands FIRST. The product label (if set) is woven into the
    caption so the model has a textual hint matching the second
    reference image -- critical when several product images are
    visually similar (e.g. three different colored t-shirts).
    """
    label_clause = (
        f'wearing the {product_label}' if product_label
        else 'wearing the product shown in the second reference image'
    )
    parts = [
        'Use the first reference image as the model and the second reference image as the product.',
        label_clause + '.',
    ]
    user = (user_prompt or '').strip()
    if user:
        parts.append(user)
    parts.append(
        "Match the product exactly -- same color, material, pattern, "
        "and details. Keep the model's face, hairstyle, and identity "
        "consistent with the first reference."
    )
    return ' '.join(parts)


def _enqueue_one(board_id: int, product_id: int) -> dict[str, int]:
    """Single-product enqueue (regenerate one + /generate single fallback).

    Uses the legacy ``gen_image_product`` worker type. Kept around for the
    regenerate-one path so re-running a single product after a partial
    batch failure still has a focused request row to inspect.
    """
    from flowboard.db.models import Request
    from flowboard.services.flow_sdk import is_valid_project_id

    with get_session() as s:
        prod = s.get(GenerationProduct, product_id)
        if prod is None or prod.board_id != board_id:
            raise HTTPException(404, "product not found in this project")
        cfg = _ensure_config(s, board_id)
        if not cfg.model_media_id:
            raise HTTPException(
                409,
                "no model image uploaded yet -- POST /generation-mode/model first",
            )
        bind = s.get(BoardFlowProject, board_id)
        if bind is None:
            raise HTTPException(
                409,
                "no Flow project bound to this board; upload a model "
                "image first to auto-create one",
            )
        flow_project_id = bind.flow_project_id
        if not is_valid_project_id(flow_project_id):
            raise HTTPException(500, f"stored flow project id invalid: {flow_project_id!r}")

        prompt = _build_prompt(cfg.prompt, prod.label)

        result = GenerationResult(
            board_id=board_id,
            product_id=product_id,
            output_media_id=None,
            prompt_used=prompt,
            status="pending",
        )
        s.add(result)
        s.commit()
        s.refresh(result)
        result_id = result.id

        req = Request(
            node_id=None,
            type="gen_image_product",
            params={
                "board_id": board_id,
                "product_id": product_id,
                "model_media_id": cfg.model_media_id,
                "product_media_id": prod.media_id,
                "prompt": prompt,
                "project_id": flow_project_id,
                "aspect_ratio": cfg.aspect_ratio,
                "image_model": cfg.image_model,
                "result_id": result_id,
            },
            status="queued",
        )
        s.add(req)
        s.commit()
        s.refresh(req)
        rid = req.id

    get_worker().enqueue(rid)
    return {"request_id": rid, "result_id": result_id}


def _enqueue_batch(board_id: int, product_ids: list[int]) -> dict[str, list[int]]:
    """Batched enqueue: groups ``product_ids`` into chunks of up to
    ``MAX_VARIANT_COUNT`` (4) and emits one ``gen_image_product_batch``
    Request per chunk. Each chunk produces one Flow call that returns
    one media id per variant. One Request, N GenerationResult rows.

    Per-chunk failure isolation: if a chunk's Flow call fails, only the
    products in that chunk are marked failed -- sibling chunks are
    untouched. The worker handler does this internally per-slot.
    """
    from flowboard.db.models import Request
    from flowboard.services.flow_sdk import is_valid_project_id

    if not product_ids:
        return {"request_ids": [], "result_ids": []}

    with get_session() as s:
        cfg = _ensure_config(s, board_id)
        if not cfg.model_media_id:
            raise HTTPException(
                409,
                "no model image uploaded yet -- POST /generation-mode/model first",
            )
        bind = s.get(BoardFlowProject, board_id)
        if bind is None:
            raise HTTPException(
                409,
                "no Flow project bound to this board; upload a model "
                "image first to auto-create one",
            )
        flow_project_id = bind.flow_project_id
        if not is_valid_project_id(flow_project_id):
            raise HTTPException(500, f"stored flow project id invalid: {flow_project_id!r}")

        products = {
            p.id: p
            for p in s.exec(
                select(GenerationProduct)
                .where(
                    (GenerationProduct.board_id == board_id)
                    & (GenerationProduct.id.in_(product_ids))
                )
            ).all()
        }
        missing = sorted(set(product_ids) - set(products.keys()))
        if missing:
            raise HTTPException(
                404,
                f"unknown product_ids for this board: {missing}",
            )
        # Snapshot everything we need for the worker so it doesn't have
        # to re-read mutable state.
        snapshot = [
            {
                "id": p.id,
                "media_id": p.media_id,
                "label": p.label,
                "prompt": _build_prompt(cfg.prompt, p.label),
            }
            for p in (products[pid] for pid in product_ids)
        ]
        model_media_id = cfg.model_media_id
        aspect_ratio = cfg.aspect_ratio
        image_model = cfg.image_model

    request_ids: list[int] = []
    result_ids: list[int] = []

    # Chunk products into MAX_VARIANT_COUNT-sized batches. The worker
    # validates this on its end too; doing it client-side keeps DB
    # writes grouped (one Request + N Results per chunk) so a Gallery
    # refresh sees whole chunks at a time.
    for chunk_start in range(0, len(snapshot), MAX_VARIANT_COUNT):
        chunk = snapshot[chunk_start : chunk_start + MAX_VARIANT_COUNT]
        prompts = [item["prompt"] for item in chunk]
        with get_session() as s:
            chunk_result_ids: list[int] = []
            for item in chunk:
                gr = GenerationResult(
                    board_id=board_id,
                    product_id=item["id"],
                    output_media_id=None,
                    prompt_used=item["prompt"],
                    status="pending",
                )
                s.add(gr)
                s.commit()
                s.refresh(gr)
                chunk_result_ids.append(gr.id)
                result_ids.append(gr.id)
            items = [
                {
                    "product_id": item["id"],
                    "product_media_id": item["media_id"],
                    "result_id": rid,
                }
                for item, rid in zip(chunk, chunk_result_ids)
            ]
            req = Request(
                node_id=None,
                type="gen_image_product_batch",
                params={
                    "board_id": board_id,
                    "model_media_id": model_media_id,
                    "items": items,
                    "prompts": prompts,
                    "project_id": flow_project_id,
                    "aspect_ratio": aspect_ratio,
                    "image_model": image_model,
                },
                status="queued",
            )
            s.add(req)
            s.commit()
            s.refresh(req)
            rid = req.id
        request_ids.append(rid)
        get_worker().enqueue(rid)

    return {"request_ids": request_ids, "result_ids": result_ids}


@router.post("/generate")
def enqueue_generation(board_id: int, body: GenerateBody):
    """Enqueue generation for the selected products.

    Dispatches in batches of up to ``MAX_VARIANT_COUNT`` (4). One Flow
    call per batch; one Request row per batch; one GenerationResult
    row per product. A single bad product does not take down other
    batches (only its own).

    A single-product call still dispatches as a focused
    ``gen_image_product`` Request (via _enqueue_one) so error
    inspection has a 1:1 request/result mapping.
    """
    with get_session() as s:
        _require_generate_board(s, board_id)
        if body.product_ids is not None:
            products = list(
                s.exec(
                    select(GenerationProduct).where(
                        (GenerationProduct.board_id == board_id)
                        & (GenerationProduct.id.in_(body.product_ids))
                    )
                ).all()
            )
            missing = set(body.product_ids) - {p.id for p in products}
            if missing:
                raise HTTPException(
                    404,
                    f"unknown product_ids for this board: {sorted(missing)}",
                )
        else:
            products = list(
                s.exec(
                    select(GenerationProduct)
                    .where(GenerationProduct.board_id == board_id)
                    .order_by(GenerationProduct.position.asc())
                ).all()
            )
        product_ids = [p.id for p in products]

    if len(product_ids) <= 1:
        # Single product -> focused request for inspection. Empty list
        # returns 200 with empty arrays (nothing to do).
        request_ids: list[int] = []
        result_ids: list[int] = []
        for pid in product_ids:
            ret = _enqueue_one(board_id, pid)
            request_ids.append(ret["request_id"])
            result_ids.append(ret["result_id"])
        return {"request_ids": request_ids, "result_ids": result_ids}

    out = _enqueue_batch(board_id, product_ids)
    return {"request_ids": out["request_ids"], "result_ids": out["result_ids"]}


@router.post("/products/{product_id}/regenerate")
def regenerate_product(board_id: int, product_id: int):
    """Mark the latest prior run as failed and enqueue a new one."""
    with get_session() as s:
        prod = s.get(GenerationProduct, product_id)
        if prod is None or prod.board_id != board_id:
            raise HTTPException(404, "product not found in this project")
        latest = s.exec(
            select(GenerationResult)
            .where(
                (GenerationResult.board_id == board_id)
                & (GenerationResult.product_id == product_id)
            )
            .order_by(GenerationResult.created_at.desc())
        ).first()
        if latest is not None and latest.status not in ("done", "failed", "canceled"):
            raise HTTPException(
                409,
                f"a generation for this product is already {latest.status!r}; "
                "wait for it to finish or cancel it first",
            )
        if latest is not None:
            latest.status = "failed"
            latest.error = "superseded_by_regenerate"
            latest.finished_at = datetime.now(timezone.utc)
            s.add(latest)
            s.commit()

    ret = _enqueue_one(board_id, product_id)
    return ret


def save_result_as_reference(
    s,
    *,
    board_id: int,
    product_id: int,
    output_media_id: str,
    label: str,
) -> bool:
    """Auto-save a successful output to the cross-project Reference library.

    Called by the worker after a successful Flow call so the user can
    drag-and-drop the same image into any later canvas board. Idempotent
    on media_id (the upstream Reference.create_reference route enforces
    the unique constraint). Errors are swallowed + logged -- this is a
    convenience feature, not required for the generation pipeline itself.
    """
    try:
        existing = s.exec(
            select(Reference).where(Reference.media_id == output_media_id)
        ).first()
        if existing is not None:
            return False
        ref_label = (label or '').strip() or f"gen #{product_id}"
        ref = Reference(
            media_id=output_media_id,
            url=None,
            label=ref_label,
            kind="image",
            ai_brief=None,
            aspect_ratio=None,
            tags=["generation-mode"],
            pinned=False,
            position=0,
            source_board_id=board_id,
            source_node_short_id=None,
        )
        s.add(ref)
        s.commit()
        return True
    except Exception:  # noqa: BLE001
        logger.exception(
            "failed to auto-save output as Reference (board=%s, product=%s)",
            board_id, product_id,
        )
        return False


# ---------------------------------------------------------------------------
# Auto-prompt: use MiniMax to compose a Vietnamese prompt variation
# based on the existing config template.
# ---------------------------------------------------------------------------


_AUTO_PROMPT_SYSTEM = (
    "Bạn là trợ lý soạn prompt tiếng Việt cho hệ thống tạo ảnh sản phẩm "
    "bằng AI (Google Flow / Imagen). Mỗi lần được gọi, bạn phải viết MỘT "
    "prompt mới, ngắn gọn (khoảng 150-300 từ), giữ phong cách và cấu "
    "trúc của prompt mẫu dưới đây nhưng thay đổi các chi tiết sáng tạo "
    "(bối cảnh, ánh sáng, góc máy, tâm trạng, trang phục, phụ kiện). "
    "Không lặp lại y nguyên prompt mẫu. Luôn giữ:\n"
    "  • Một dòng mở đầu mô tả rõ yêu cầu bảo toàn chi tiết sản phẩm.\n"
    "  • Một đoạn 'Bố cục: ...' mô tả tư thế / ánh mắt người mẫu.\n"
    "  • Một dòng '[Ảnh tham chiếu]: ...' mô tả thứ tự hai ảnh tham chiếu.\n"
    "  • Một dòng '[Lưu ý] ...' về độ phân giải / chất lượng.\n"
    "Trả về CHỈ phần prompt mới, không giải thích, không tiêu đề."
)


class AutoPromptRequest(BaseModel):
    # Optional: re-seed from a different prompt (e.g. user typed a new
    # one and wants the AI to expand on it). Falls back to the current
    # config prompt when omitted.
    seed: Optional[str] = None


class AutoPromptResponse(BaseModel):
    prompt: str
    provider: str  # which LLM provider produced it, for the activity log


@router.post("/prompt/auto", response_model=AutoPromptResponse)
async def auto_prompt_endpoint(board_id: int, body: AutoPromptRequest) -> AutoPromptResponse:
    """Generate a Vietnamese prompt variation via MiniMax.

    Pulls the current ``GenerationConfig.prompt`` (or the body-supplied
    ``seed``) and asks the MiniMax provider for a same-style variant.
    The frontend then calls PATCH /config with the returned text to
    surface it in the textarea. Useful as a "Tự tạo prompt" button
    next to the textarea — the user can hit it whenever they want a
    fresh angle without typing the full Vietnamese lookbook template.
    """
    from flowboard.services.llm import run_llm
    from flowboard.services.llm.base import LLMError

    with get_session() as s:
        _require_generate_board(s, board_id)
        cfg = _ensure_config(s, board_id)
        seed_prompt = (body.seed or "").strip() or cfg.prompt
        # Pull the active provider name so the activity log records which
        # LLM produced the variant. We avoid expanding the prompts so the
        # tokens stay bounded.
        from flowboard.services.llm import secrets, registry
        active = secrets.read_active_providers().get("auto_prompt") or "minimax"

    try:
        new_prompt = await run_llm(
            "auto_prompt",
            user_prompt=seed_prompt,
            system_prompt=_AUTO_PROMPT_SYSTEM,
            timeout=60.0,
        )
    except LLMError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"AI provider unavailable: {exc}",
        )

    new_prompt = (new_prompt or "").strip()
    if not new_prompt:
        raise HTTPException(
            status_code=502,
            detail="AI provider returned an empty prompt",
        )

    return AutoPromptResponse(prompt=new_prompt, provider=active)
