"""CRUD endpoints for user-curated prompt templates.

Templates are plain ``(title, body)`` rows the user creates from the
right-side ``Templates`` panel and reuses by clicking in the
``GenerationDialog`` prompt textarea. Distinct from:

- ``Reference`` (saved media — this table has no media_id), and
- ``GenerationConfig.prompt`` (per-board shared prompt — this table is
  global across boards).

Sort order matches what the frontend's local store applies after a
mutate: ``updated_at DESC`` so the most-recently-edited template surfaces
first. ``created_at`` is recorded for auditing only.
"""
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field
from sqlmodel import select
from sqlalchemy import func

from flowboard.db import get_session
from flowboard.db.models import PromptTemplate

router = APIRouter(prefix="/api/prompt-templates", tags=["prompt-templates"])


class PromptTemplateCreate(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    body: str = Field(min_length=0, max_length=2000)


class PromptTemplatePatch(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=120)
    body: Optional[str] = Field(default=None, min_length=0, max_length=2000)


def _row_dict(row: PromptTemplate) -> dict[str, Any]:
    return {
        "id": row.id,
        "title": row.title,
        "body": row.body,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


@router.post("")
def create_template(payload: PromptTemplateCreate):
    """Create a new template row.

    Title and body are both required (the frontend's editor enforces
    them too) but body may be the empty string — a user can create a
    placeholder and fill it in later via PATCH. Whitespace around title
    is trimmed before persist; body is preserved as-is.

    The parameter is named ``payload`` (not ``body``) to avoid the
    awkward ``body.body`` access — elsewhere in the codebase the param
    is conventionally called ``body``, but here the field collides.
    """
    title = payload.title.strip()
    if not title:
        raise HTTPException(400, "title must not be blank")

    now = datetime.now(timezone.utc)
    with get_session() as s:
        row = PromptTemplate(
            title=title,
            body=payload.body,
            updated_at=now,
        )
        s.add(row)
        s.commit()
        s.refresh(row)
        return _row_dict(row)


@router.get("")
def list_templates(
    q: Optional[str] = None,
    limit: int = 200,
):
    """List templates sorted by ``updated_at DESC``.

    ``q`` is a case-insensitive substring match against the ``title``
    column. Body is intentionally NOT searchable here — the panel
    already pre-truncates bodies for display, and full-text body
    search would slow the query without paying off for v1 (templates
    are short by design).
    """
    with get_session() as s:
        stmt = select(PromptTemplate)
        if q:
            needle = f"%{q.lower()}%"
            stmt = stmt.where(func.lower(PromptTemplate.title).like(needle))
        # Sort by updated_at DESC; created_at tiebreaker keeps ordering
        # stable when two rows happen to land in the same millisecond.
        stmt = stmt.order_by(
            PromptTemplate.updated_at.desc(),
            PromptTemplate.created_at.desc(),
        )
        stmt = stmt.limit(limit)
        rows = s.exec(stmt).all()
        return [_row_dict(r) for r in rows]


@router.patch("/{template_id}")
def patch_template(template_id: int, payload: PromptTemplatePatch):
    """Partial update — only fields present in the request body are touched.

    Touching either ``title`` or ``body`` (or both) refreshes the
    ``updated_at`` timestamp so the template floats to the top of the
    list — this matches what the frontend expects after a rename or
    body edit.
    """
    fields = payload.model_fields_set
    if "title" not in fields and "body" not in fields:
        raise HTTPException(400, "no fields to update")

    with get_session() as s:
        row = s.get(PromptTemplate, template_id)
        if row is None:
            raise HTTPException(404, "prompt template not found")
        if "title" in fields:
            assert payload.title is not None
            title = payload.title.strip()
            if not title:
                raise HTTPException(400, "title must not be blank")
            row.title = title
        if "body" in fields:
            assert payload.body is not None
            row.body = payload.body
        row.updated_at = datetime.now(timezone.utc)
        s.add(row)
        s.commit()
        s.refresh(row)
        return _row_dict(row)


@router.delete("/{template_id}", status_code=204)
def delete_template(template_id: int):
    """Hard delete a template row. No file side-effects (text only)."""
    with get_session() as s:
        row = s.get(PromptTemplate, template_id)
        if row is None:
            raise HTTPException(404, "prompt template not found")
        s.delete(row)
        s.commit()
    return Response(status_code=204)
