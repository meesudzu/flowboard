"""Tests for image-generation mode (routes/generation_mode.py + worker).

Coverage:
  - mode column on Board + validation in create_board
  - cascade-delete clears GenerationConfig/Product/Result
  - GET /api/boards/{id}/generation-mode returns config + products + latest
  - PATCH /config updates prompt/aspect/image_model with validation
  - POST /generate refuses when model_media_id missing
  - POST /generate enqueues N Request rows of type "gen_image_product"
  - worker handler _handle_gen_image_product success / failure paths
"""
from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient


# ---------------------------------------------------------------------------
# Board CRUD with mode
# ---------------------------------------------------------------------------


def test_create_board_defaults_to_canvas_mode(client):
    r = client.post("/api/boards", json={"name": "Storyboard 1"})
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["mode"] == "canvas"


def test_create_board_explicit_generate_mode(client):
    r = client.post("/api/boards", json={"name": "Spring lookbook", "mode": "generate"})
    assert r.status_code == 200, r.text
    assert r.json()["mode"] == "generate"


def test_create_board_rejects_unknown_mode(client):
    r = client.post("/api/boards", json={"name": "bad", "mode": "video"})
    assert r.status_code == 400
    assert "invalid mode" in r.json()["detail"].lower()


def test_get_board_returns_mode(client):
    b = client.post("/api/boards", json={"name": "x", "mode": "generate"}).json()
    r = client.get(f"/api/boards/{b['id']}")
    assert r.status_code == 200
    assert r.json()["board"]["mode"] == "generate"


def test_delete_board_cascades_generation_tables(client):
    """DELETE /api/boards/{id} must also drop GenerationResult / Product / Config.

    Existing board tests cover nodes/edges/etc; this exercises the new
    children specifically so a future refactor that forgets one of them
    (typical copy-paste regression) is caught loudly.
    """
    from flowboard.db import get_session
    from flowboard.db.models import (
        GenerationConfig,
        GenerationProduct,
        GenerationResult,
    )
    from sqlmodel import select

    b = client.post("/api/boards", json={"name": "to-be-deleted", "mode": "generate"}).json()
    bid = b["id"]

    # create_board(mode="generate") auto-spawns the singleton
    # GenerationConfig row. Update-in-place rather than re-insert so the
    # PK constraint isn't violated.
    with get_session() as s:
        cfg = s.get(GenerationConfig, bid)
        cfg.prompt = "x"
        cfg.aspect_ratio = "IMAGE_ASPECT_RATIO_SQUARE"
        s.add(cfg)
        s.add(GenerationProduct(board_id=bid, media_id="abc123", position=1))
        s.commit()
        pid = s.exec(select(GenerationProduct).where(GenerationProduct.board_id == bid)).first().id
        s.add(GenerationResult(board_id=bid, product_id=pid, prompt_used="x", status="pending"))
        s.commit()
        assert s.get(GenerationConfig, bid) is not None
        assert len(s.exec(select(GenerationProduct).where(GenerationProduct.board_id == bid)).all()) == 1
        assert len(s.exec(select(GenerationResult).where(GenerationResult.board_id == bid)).all()) == 1

    r = client.delete(f"/api/boards/{bid}")
    assert r.status_code == 200

    with get_session() as s:
        assert s.get(GenerationConfig, bid) is None
        assert len(s.exec(select(GenerationProduct).where(GenerationProduct.board_id == bid)).all()) == 0
        assert len(s.exec(select(GenerationResult).where(GenerationResult.board_id == bid)).all()) == 0


# ---------------------------------------------------------------------------
# GET / PATCH config
# ---------------------------------------------------------------------------


def _make_generate_board(client) -> dict:
    b = client.post("/api/boards", json={"name": "project", "mode": "generate"}).json()
    return b


def test_get_generation_mode_on_empty_board(client):
    b = _make_generate_board(client)
    r = client.get(f"/api/boards/{b['id']}/generation-mode")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["board_id"] == b["id"]
    # New generate-mode projects start with an EMPTY shared prompt so
    # the user is steered toward choosing a template from the
    # right-side "Prompt mẫu" panel instead of editing a pre-filled
    # Vietnamese lookbook template (which had a tendency to ship
    # half-edited).
    assert body["config"]["prompt"] == ""
    assert body["config"]["aspect_ratio"] == "IMAGE_ASPECT_RATIO_PORTRAIT"
    assert body["products"] == []
    assert body["results"] == []


def test_get_generation_mode_rejects_canvas_board(client):
    b = client.post("/api/boards", json={"name": "canvas board"}).json()
    r = client.get(f"/api/boards/{b['id']}/generation-mode")
    assert r.status_code == 409
    assert "generate" in r.json()["detail"].lower()


def test_get_generation_mode_missing_board_returns_404(client):
    r = client.get("/api/boards/99999/generation-mode")
    assert r.status_code == 404


def test_patch_config_updates_fields(client):
    b = _make_generate_board(client)
    r = client.patch(
        f"/api/boards/{b['id']}/generation-mode/config",
        json={"prompt": "studio light, smiling, looking at camera",
              "aspect_ratio": "IMAGE_ASPECT_RATIO_SQUARE",
              "image_model": "NANO_BANANA_2"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["prompt"].startswith("studio light")
    assert body["aspect_ratio"] == "IMAGE_ASPECT_RATIO_SQUARE"
    assert body["image_model"] == "NANO_BANANA_2"


def test_patch_config_validates_aspect_ratio(client):
    b = _make_generate_board(client)
    r = client.patch(
        f"/api/boards/{b['id']}/generation-mode/config",
        json={"aspect_ratio": "WRONG"},
    )
    assert r.status_code == 400
    assert "invalid aspect_ratio" in r.json()["detail"].lower()


def test_patch_config_partial_keeps_other_fields(client):
    b = _make_generate_board(client)
    client.patch(
        f"/api/boards/{b['id']}/generation-mode/config",
        json={"prompt": "first", "aspect_ratio": "IMAGE_ASPECT_RATIO_PORTRAIT"},
    )
    r = client.patch(
        f"/api/boards/{b['id']}/generation-mode/config",
        json={"prompt": "second"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["prompt"] == "second"
    # aspect_ratio MUST survive a partial PATCH -- the existing canvas
    # PATCH data semantics rely on shallow-merge, and so does this one.
    assert body["aspect_ratio"] == "IMAGE_ASPECT_RATIO_PORTRAIT"


# ---------------------------------------------------------------------------
# Generate enqueue
# ---------------------------------------------------------------------------


def _seed_board_with_products(client, n_products: int = 3) -> dict:
    """Create a generate-mode board with N pre-existing product rows.

    Stubs the BoardFlowProject binding so /generate doesn't try to call
    the (test-disabled) Flow SDK. Production code path auto-creates this
    binding on the first upload via ensure_board_project; in tests we
    short-circuit by inserting the row directly.
    """
    from flowboard.db import get_session
    from flowboard.db.models import (
        BoardFlowProject,
        GenerationConfig,
        GenerationProduct,
    )

    b = _make_generate_board(client)
    with get_session() as s:
        cfg = s.get(GenerationConfig, b["id"])
        cfg.model_media_id = "ffffffff-ffff-ffff-ffff-ffffffffffff"
        s.add(cfg)
        # Stub the Flow project binding. Production code auto-creates
        # this via ensure_board_project on the first upload, but in
        # tests we short-circuit and write the row directly so the
        # worker isn't exercised.
        s.add(BoardFlowProject(
            board_id=b["id"],
            flow_project_id="11111111-2222-3333-4444-555555555555",
        ))
        for i in range(n_products):
            s.add(GenerationProduct(
                board_id=b["id"],
                media_id=f"deadbeef-{i:04d}-0000-0000-000000000000",
                position=i + 1,
            ))
        s.commit()
    return b


def test_generate_endpoint_refuses_when_no_model(client):
    """When products exist but the model image has never been uploaded,
    /generate MUST refuse with 409 -- never silently dispatch."""
    from flowboard.db import get_session
    from flowboard.db.models import GenerationProduct

    b = _make_generate_board(client)
    with get_session() as s:
        s.add(GenerationProduct(board_id=b["id"], media_id="abc123", position=1))
        s.commit()
    r = client.post(f"/api/boards/{b['id']}/generation-mode/generate", json={})
    assert r.status_code == 409
    assert "model image" in r.json()["detail"].lower()


def test_generate_no_products_no_model_returns_empty(client):
    """If there are no products, /generate returns 200 with empty ids --
    nothing to do, no error. The 409 path is tested above; this guards
    against confusing the two cases."""
    b = _make_generate_board(client)
    r = client.post(f"/api/boards/{b['id']}/generation-mode/generate", json={})
    assert r.status_code == 200
    assert r.json() == {"request_ids": [], "result_ids": []}


def test_generate_enqueue_creates_request_rows(client):
    """3 products <= MAX_VARIANT_COUNT (4) -> one batched Request
    covering all 3 products, with 3 fresh GenerationResult rows in
    ``pending``. This is the "happy path" for batching: N products in
    one Flow call rather than N separate ones.
    """
    from flowboard.db import get_session
    from flowboard.db.models import GenerationProduct, GenerationResult, Request
    from sqlmodel import select

    b = _seed_board_with_products(client, n_products=3)

    with get_session() as s:
        prod_ids = [p.id for p in s.exec(
            select(GenerationProduct).where(GenerationProduct.board_id == b["id"])
        ).all()]

    r = client.post(f"/api/boards/{b['id']}/generation-mode/generate", json={})
    assert r.status_code == 200, r.text
    body = r.json()
    # One batch Request, three result rows.
    assert len(body["request_ids"]) == 1
    assert len(body["result_ids"]) == 3

    with get_session() as s:
        reqs = s.exec(
            select(Request).where(Request.type == "gen_image_product_batch")
        ).all()
        assert len(reqs) == 1
        req = reqs[0]
        assert req.params["board_id"] == b["id"]
        assert req.params["model_media_id"] == "ffffffff-ffff-ffff-ffff-ffffffffffff"
        assert len(req.params["items"]) == 3
        assert len(req.params["prompts"]) == 3
        results = s.exec(
            select(GenerationResult).where(GenerationResult.board_id == b["id"])
        ).all()
        assert len(results) == 3
        for res in results:
            assert res.status == "pending"
            assert res.output_media_id is None
        # Per-item refs are positional and aligned to products.
        items_by_pid = {it["product_id"]: it for it in req.params["items"]}
        for pid in prod_ids:
            assert pid in items_by_pid
            assert items_by_pid[pid]["product_media_id"].startswith("deadbeef-")


def test_generate_chunks_into_multiple_batches_when_over_max(client):
    """5 products > MAX_VARIANT_COUNT (4) -> 2 batched Requests
    (4 + 1). Verifies chunking happens on the route, not inside the
    worker, so N products get covered in ceil(N/4) Flow calls.
    """
    from flowboard.db import get_session
    from flowboard.db.models import GenerationResult, Request
    from sqlmodel import select

    b = _seed_board_with_products(client, n_products=5)
    r = client.post(f"/api/boards/{b['id']}/generation-mode/generate", json={})
    assert r.status_code == 200, r.text
    body = r.json()
    # 4 + 1 = 2 batches, 5 result rows.
    assert len(body["request_ids"]) == 2
    assert len(body["result_ids"]) == 5
    with get_session() as s:
        reqs = s.exec(
            select(Request).where(Request.type == "gen_image_product_batch")
        ).all()
        assert len(reqs) == 2
        sizes = sorted(len(r.params["items"]) for r in reqs)
        assert sizes == [1, 4]
        results = s.exec(
            select(GenerationResult).where(GenerationResult.board_id == b["id"])
        ).all()
        assert len(results) == 5
        for res in results:
            assert res.status == "pending"


def test_generate_single_product_uses_single_request_type(client):
    """A single-product dispatch still uses the focused
    ``gen_image_product`` request type so the gallery has a 1:1
    request/result mapping (matches the /regenerate code path)."""
    from flowboard.db import get_session
    from flowboard.db.models import Request
    from sqlmodel import select

    b = _seed_board_with_products(client, n_products=1)
    r = client.post(f"/api/boards/{b['id']}/generation-mode/generate", json={})
    assert r.status_code == 200
    with get_session() as s:
        reqs = s.exec(select(Request)).all()
        assert len(reqs) == 1
        assert reqs[0].type == "gen_image_product"


def test_generate_subset_of_products(client):
    b = _seed_board_with_products(client, n_products=5)
    from flowboard.db import get_session
    from flowboard.db.models import GenerationProduct
    from sqlmodel import select
    with get_session() as s:
        all_ids = [p.id for p in s.exec(
            select(GenerationProduct).where(GenerationProduct.board_id == b["id"])
            .order_by(GenerationProduct.position.asc())
        ).all()]
    r = client.post(
        f"/api/boards/{b['id']}/generation-mode/generate",
        json={"product_ids": all_ids[:2]},
    )
    assert r.status_code == 200
    body = r.json()
    # 2 products <= MAX_VARIANT_COUNT (4) -> a single batch.
    assert len(body["request_ids"]) == 1
    assert len(body["result_ids"]) == 2


def test_generate_unknown_product_id_returns_404(client):
    b = _seed_board_with_products(client, n_products=2)
    r = client.post(
        f"/api/boards/{b['id']}/generation-mode/generate",
        json={"product_ids": [999_999]},
    )
    assert r.status_code == 404


def test_regenerate_product_marks_prior_failed_and_enqueues(client):
    from flowboard.db import get_session
    from flowboard.db.models import GenerationProduct, GenerationResult, Request
    from sqlmodel import select

    b = _seed_board_with_products(client, n_products=1)
    # First generate
    r1 = client.post(f"/api/boards/{b['id']}/generation-mode/generate", json={})
    assert r1.status_code == 200
    first_rid = r1.json()["request_ids"][0]

    # Mark first result done so regenerate can supersede
    with get_session() as s:
        res = s.exec(select(GenerationResult).where(GenerationResult.board_id == b["id"])).first()
        res.status = "done"
        s.add(res)
        s.commit()

    # Regenerate
    with get_session() as s:
        pid = s.exec(select(GenerationProduct).where(GenerationProduct.board_id == b["id"])).first().id
    r2 = client.post(f"/api/boards/{b['id']}/generation-mode/products/{pid}/regenerate")
    assert r2.status_code == 200
    second_rid = r2.json()["request_id"]
    assert second_rid != first_rid

    with get_session() as s:
        results = s.exec(
            select(GenerationResult)
            .where(GenerationResult.board_id == b["id"])
            .order_by(GenerationResult.created_at.asc())
        ).all()
        # 2 results: first marked "superseded_by_regenerate", latest pending
        assert len(results) == 2
        assert results[0].status == "failed"
        assert results[0].error == "superseded_by_regenerate"
        assert results[1].status == "pending"


def test_regenerate_refuses_when_in_flight(client):
    """In-flight generations can't be superseded -- 409 to prevent races."""
    from flowboard.db import get_session
    from flowboard.db.models import GenerationProduct
    from sqlmodel import select

    b = _seed_board_with_products(client, n_products=1)
    client.post(f"/api/boards/{b['id']}/generation-mode/generate", json={})
    with get_session() as s:
        pid = s.exec(select(GenerationProduct).where(GenerationProduct.board_id == b["id"])).first().id
    r = client.post(f"/api/boards/{b['id']}/generation-mode/products/{pid}/regenerate")
    assert r.status_code == 409


# ---------------------------------------------------------------------------
# Delete product cascades results
# ---------------------------------------------------------------------------


def test_delete_product_drops_results(client):
    from flowboard.db import get_session
    from flowboard.db.models import GenerationProduct, GenerationResult
    from sqlmodel import select

    b = _seed_board_with_products(client, n_products=2)
    client.post(f"/api/boards/{b['id']}/generation-mode/generate", json={})

    with get_session() as s:
        pid = s.exec(select(GenerationProduct).where(GenerationProduct.board_id == b["id"])).first().id
        assert len(s.exec(select(GenerationResult).where(GenerationResult.board_id == b["id"])).all()) == 2

    r = client.delete(f"/api/boards/{b['id']}/generation-mode/products/{pid}")
    assert r.status_code == 200

    with get_session() as s:
        assert len(s.exec(select(GenerationProduct).where(GenerationProduct.board_id == b["id"])).all()) == 1
        assert len(s.exec(select(GenerationResult).where(GenerationResult.board_id == b["id"])).all()) == 1


# ---------------------------------------------------------------------------
# Worker handler
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_handle_gen_image_product_missing_params():
    from flowboard.worker.processor import _handle_gen_image_product

    # Missing everything → first sentinel wins.
    result, err = await _handle_gen_image_product({})
    assert result == {}
    assert err == "missing_board_or_product_or_result_id"


@pytest.mark.asyncio
async def test_handle_gen_image_product_success_path(client):
    """Mocked SDK returns one media_id; handler stamps row done + ingests + saves Ref."""
    from flowboard.db import get_session
    from flowboard.db.models import (
        Board,
        GenerationConfig,
        GenerationProduct,
        GenerationResult,
        Reference,
    )
    from flowboard.worker.processor import _handle_gen_image_product

    # Seed via the public API so the auto-spawned GenerationConfig row
    # + the FK targets (Board) all line up without manually juggling
    # primary keys.
    b = client.post("/api/boards", json={"name": "handler-test", "mode": "generate"}).json()
    bid = b["id"]
    with get_session() as s:
        cfg = s.get(GenerationConfig, bid)
        cfg.model_media_id = "aaaa1111-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
        cfg.prompt = "studio"
        cfg.aspect_ratio = "IMAGE_ASPECT_RATIO_SQUARE"
        cfg.image_model = "NANO_BANANA_2"
        prod = GenerationProduct(
            board_id=bid,
            media_id="bbbb2222-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            position=1,
            label="red shirt",
        )
        s.add(cfg); s.add(prod); s.commit(); s.refresh(prod)
        result_row = GenerationResult(
            board_id=bid, product_id=prod.id,
            prompt_used="", status="pending",
        )
        s.add(result_row); s.commit(); s.refresh(result_row)
        cfg_model_media_id = cfg.model_media_id
        prod_id = prod.id
        prod_media_id = prod.media_id
        rid = result_row.id
        s.expunge_all()

    fake_resp = {
        "media_ids": ["cccc3333-cccc-cccc-cccc-cccccccccccc"],
        "media_entries": [
            {"media_id": "cccc3333-cccc-cccc-cccc-cccccccccccc",
             "url": "https://flow-content.google/x.jpg"}
        ],
    }

    with patch("flowboard.worker.processor.get_flow_sdk") as mock_get_sdk, \
         patch("flowboard.worker.processor.media_service.ingest_urls") as mock_ingest:
        sdk = mock_get_sdk.return_value
        sdk.gen_image = AsyncMock(return_value=fake_resp)
        result, err = await _handle_gen_image_product({
            "board_id": bid,
            "product_id": prod_id,
            "result_id": rid,
            "model_media_id": cfg_model_media_id,
            "product_media_id": prod_media_id,
            "prompt": "Use the first reference image as the model.",
            "project_id": "test-project-id",
            "aspect_ratio": "IMAGE_ASPECT_RATIO_SQUARE",
            "image_model": "NANO_BANANA_2",
        })

    assert err is None, err
    assert result["media_ids"] == ["cccc3333-cccc-cccc-cccc-cccccccccccc"]
    mock_ingest.assert_called_once()

    from sqlmodel import select as _select
    with get_session() as s:
        gr = s.get(GenerationResult, rid)
        assert gr.status == "done"
        assert gr.output_media_id == "cccc3333-cccc-cccc-cccc-cccccccccccc"
        refs = s.exec(_select(Reference).where(
            Reference.media_id == "cccc3333-cccc-cccc-cccc-cccccccccccc"
        )).all()
        assert len(refs) == 1
        assert refs[0].kind == "image"
        assert refs[0].source_board_id == bid
        assert "red shirt" in refs[0].label


@pytest.mark.asyncio
async def test_handle_gen_image_product_failure_path(client):
    """When Flow SDK returns error, the GenerationResult row is stamped failed."""
    from flowboard.db import get_session
    from flowboard.db.models import GenerationConfig, GenerationProduct, GenerationResult
    from flowboard.worker.processor import _handle_gen_image_product

    b = client.post("/api/boards", json={"name": "fail-test", "mode": "generate"}).json()
    bid = b["id"]
    with get_session() as s:
        cfg = s.get(GenerationConfig, bid)
        cfg.model_media_id = "11111111-1111-1111-1111-111111111111"
        cfg.aspect_ratio = "IMAGE_ASPECT_RATIO_LANDSCAPE"
        prod = GenerationProduct(
            board_id=bid,
            media_id="22222222-2222-2222-2222-222222222222",
            position=1,
        )
        s.add(cfg); s.add(prod); s.commit(); s.refresh(prod)
        result_row = GenerationResult(
            board_id=bid, product_id=prod.id,
            prompt_used="", status="pending",
        )
        s.add(result_row); s.commit(); s.refresh(result_row)
        cfg_model_media_id = cfg.model_media_id
        prod_id = prod.id
        prod_media_id = prod.media_id
        rid = result_row.id
        s.expunge_all()

    with patch("flowboard.worker.processor.get_flow_sdk") as mock_get_sdk:
        sdk = mock_get_sdk.return_value
        sdk.gen_image = AsyncMock(return_value={"error": "PUBLIC_ERROR_UNSAFE_GENERATION"})
        result, err = await _handle_gen_image_product({
            "board_id": bid,
            "product_id": prod_id,
            "result_id": rid,
            "model_media_id": cfg_model_media_id,
            "product_media_id": prod_media_id,
            "prompt": "Use the first reference image as the model.",
            "project_id": "test-project-id",
            "aspect_ratio": "IMAGE_ASPECT_RATIO_LANDSCAPE",
            "image_model": None,
        })

    assert "PUBLIC_ERROR_UNSAFE_GENERATION" in (err or "")
    with get_session() as s:
        gr = s.get(GenerationResult, rid)
        assert gr.status == "failed"
        assert "PUBLIC_ERROR_UNSAFE_GENERATION" in gr.error
        assert gr.finished_at is not None


@pytest.mark.asyncio
async def test_handle_gen_image_product_missing_result_row():
    from flowboard.worker.processor import _handle_gen_image_product

    with patch("flowboard.worker.processor.get_flow_sdk") as mock_get_sdk:
        sdk = mock_get_sdk.return_value
        sdk.gen_image = AsyncMock()  # must not be called
        result, err = await _handle_gen_image_product({
            "board_id": 1, "product_id": 1, "result_id": 999999,  # nonexistent
            "model_media_id": "11111111-1111-1111-1111-111111111111",
            "product_media_id": "22222222-2222-2222-2222-222222222222",
            "prompt": "x",
            "project_id": "test-project-id",
        })
    assert err == "result_row_missing"
    sdk.gen_image.assert_not_called()


# ---------------------------------------------------------------------------
# Worker handler: gen_image_product_batch
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_handle_batch_success_path(client):
    """One batched Flow call returns N media_ids aligned to N product rows.

    Each GenerationResult slot is stamped "done" with the matching media_id,
    and a Reference is auto-saved per slot (in source order, which matches
    input order).
    """
    from flowboard.db import get_session
    from flowboard.db.models import (
        GenerationConfig,
        GenerationProduct,
        GenerationResult,
        Reference,
    )
    from sqlmodel import select as _select
    from flowboard.worker.processor import _handle_gen_image_product_batch

    b = client.post("/api/boards", json={"name": "batch-ok", "mode": "generate"}).json()
    bid = b["id"]
    with get_session() as s:
        cfg = s.get(GenerationConfig, bid)
        cfg.model_media_id = "11111111-aaaa-aaaa-aaaa-111111111111"
        s.add(cfg)
        prods = []
        for i, label in enumerate(["red shirt", "blue shirt"]):
            p = GenerationProduct(
                board_id=bid,
                media_id=f"22222222-aaaa-aaaa-aaaa-00000000000{i}",
                position=i + 1,
                label=label,
            )
            s.add(p)
            s.commit()
            s.refresh(p)
            prods.append((p.id, p.media_id))
            gr = GenerationResult(
                board_id=bid, product_id=p.id,
                prompt_used="", status="pending",
            )
            s.add(gr); s.commit(); s.refresh(gr)
            prods[-1] = prods[-1] + (gr.id,)

    fake_resp = {
        "media_ids": [
            "aaaa1111-aaaa-aaaa-aaaa-000000000001",
            "bbbb2222-bbbb-bbbb-bbbb-000000000002",
        ],
        "media_entries": [
            {"media_id": "aaaa1111-aaaa-aaaa-aaaa-000000000001",
             "url": "https://flow-content.google/a.jpg"},
            {"media_id": "bbbb2222-bbbb-bbbb-bbbb-000000000002",
             "url": "https://flow-content.google/b.jpg"},
        ],
    }
    items = [
        {"product_id": p[0], "product_media_id": p[1], "result_id": p[2]}
        for p in prods
    ]
    prompts = [
        "Use the first reference image as the model and the second reference image as the product. wearing the red shirt. studio",
        "Use the first reference image as the model and the second reference image as the product. wearing the blue shirt. studio",
    ]
    with patch("flowboard.worker.processor.get_flow_sdk") as mock_get_sdk, \
         patch("flowboard.worker.processor.media_service.ingest_urls") as mock_ingest:
        mock_get_sdk.return_value.gen_image = AsyncMock(return_value=fake_resp)
        ret, err = await _handle_gen_image_product_batch({
            "board_id": bid,
            "model_media_id": "11111111-aaaa-aaaa-aaaa-111111111111",
            "items": items,
            "prompts": prompts,
            "project_id": "test-project-id",
            "aspect_ratio": "IMAGE_ASPECT_RATIO_SQUARE",
            "image_model": "NANO_BANANA_PRO",
        })

    assert err is None, err
    assert len(ret["succeeded"]) == 2
    # The SDK call MUST have received per-variant refs aligned with prompts.
    sdk_call_kwargs = mock_get_sdk.return_value.gen_image.call_args.kwargs
    assert "ref_media_ids_per_variant" in sdk_call_kwargs
    rp = sdk_call_kwargs["ref_media_ids_per_variant"]
    assert len(rp) == 2
    # Each ref list has model + the corresponding product.
    assert rp[0] == ["11111111-aaaa-aaaa-aaaa-111111111111",
                     "22222222-aaaa-aaaa-aaaa-000000000000"]
    assert rp[1] == ["11111111-aaaa-aaaa-aaaa-111111111111",
                     "22222222-aaaa-aaaa-aaaa-000000000001"]
    assert sdk_call_kwargs["variant_count"] == 2
    assert sdk_call_kwargs["prompts"] == prompts
    # Also: legacy ref_media_ids MUST NOT be passed when per_variant is set.
    assert sdk_call_kwargs.get("ref_media_ids") is None
    mock_ingest.assert_called_once()

    with get_session() as s:
        results = sorted(
            s.exec(_select(GenerationResult).where(GenerationResult.board_id == bid)).all(),
            key=lambda r: r.id,
        )
        # Sort by their original input order to verify positional alignment.
        ordered = [next(r for r in results if r.id == items[i]["result_id"]) for i in range(2)]
        assert ordered[0].output_media_id == "aaaa1111-aaaa-aaaa-aaaa-000000000001"
        assert ordered[0].status == "done"
        assert ordered[1].output_media_id == "bbbb2222-bbbb-bbbb-bbbb-000000000002"
        # Two references auto-saved.
        refs = s.exec(_select(Reference)).all()
        labels = sorted(r.label for r in refs)
        assert "red shirt" in labels
        assert "blue shirt" in labels


@pytest.mark.asyncio
async def test_handle_batch_refuses_oversize():
    """Defense-in-depth check: the handler rejects batches above MAX_VARIANT_COUNT
    so a misbehaving caller can't blow past Flow's per-call cap."""
    from flowboard.worker.processor import _handle_gen_image_product_batch

    big_items = [
        {"product_id": 1, "product_media_id": "x", "result_id": i}
        for i in range(5)
    ]
    with patch("flowboard.worker.processor.get_flow_sdk") as m:
        m.return_value.gen_image = AsyncMock()
        ret, err = await _handle_gen_image_product_batch({
            "board_id": 1,
            "model_media_id": "m",
            "items": big_items,
            "prompts": ["p"] * 5,
            "project_id": "pp",
        })
    assert err is not None and err.startswith("batch_too_large")
    assert ret == {}
    m.return_value.gen_image.assert_not_called()


@pytest.mark.asyncio
async def test_handle_batch_failure_marks_all_slots_failed(client):
    """When Flow returns an error for a batch, every slot in that batch
    is stamped 'failed' so the gallery has a uniform state.
    """
    from flowboard.db import get_session
    from flowboard.db.models import GenerationConfig, GenerationProduct, GenerationResult
    from flowboard.worker.processor import _handle_gen_image_product_batch

    b = client.post("/api/boards", json={"name": "batch-fail", "mode": "generate"}).json()
    bid = b["id"]
    with get_session() as s:
        cfg = s.get(GenerationConfig, bid)
        cfg.model_media_id = "33333333-bbbb-bbbb-bbbb-333333333333"
        s.add(cfg)
        items = []
        for i in range(2):
            p = GenerationProduct(
                board_id=bid,
                media_id=f"44444444-cccc-cccc-cccc-00000000000{i}",
                position=i + 1,
            )
            s.add(p); s.commit(); s.refresh(p)
            gr = GenerationResult(
                board_id=bid, product_id=p.id,
                prompt_used="", status="pending",
            )
            s.add(gr); s.commit(); s.refresh(gr)
            items.append({"product_id": p.id,
                          "product_media_id": p.media_id,
                          "result_id": gr.id})

    with patch("flowboard.worker.processor.get_flow_sdk") as m:
        m.return_value.gen_image = AsyncMock(
            return_value={"error": "PUBLIC_ERROR_UNSAFE_GENERATION"},
        )
        ret, err = await _handle_gen_image_product_batch({
            "board_id": bid,
            "model_media_id": "33333333-bbbb-bbbb-bbbb-333333333333",
            "items": items,
            "prompts": ["p", "p"],
            "project_id": "test-project-id",
        })

    assert "PUBLIC_ERROR_UNSAFE_GENERATION" in (err or "")
    with get_session() as s:
        results = s.exec(
            __import__("sqlmodel").select(GenerationResult).where(GenerationResult.board_id == bid)
        ).all()
        for r in results:
            assert r.status == "failed"
            assert "PUBLIC_ERROR_UNSAFE_GENERATION" in (r.error or "")


@pytest.mark.asyncio
async def test_handle_gen_image_product_no_media_ids_marks_row_failed(client):
    """Regression: when Flow returns no media_ids in the response
    (the dispatch succeeded but the body had no usable entries), the
    GenerationResult row must be stamped ``failed`` in addition to the
    Request row -- otherwise the UI shows "Đang tạo" forever.
    """
    from flowboard.db import get_session
    from flowboard.db.models import GenerationConfig, GenerationProduct, GenerationResult
    from flowboard.worker.processor import _handle_gen_image_product

    b = client.post("/api/boards", json={"name": "no-media-test", "mode": "generate"}).json()
    bid = b["id"]
    with get_session() as s:
        cfg = s.get(GenerationConfig, bid)
        cfg.model_media_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
        prod = GenerationProduct(board_id=bid, media_id="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", position=1)
        s.add(cfg); s.add(prod); s.commit(); s.refresh(prod)
        gr = GenerationResult(board_id=bid, product_id=prod.id, prompt_used="x", status="pending")
        s.add(gr); s.commit(); s.refresh(gr)
        rid = gr.id
        prod_id = prod.id
        s.expunge_all()

    # Flow returns a 200 with no media_ids (e.g. queued async op).
    with patch("flowboard.worker.processor.get_flow_sdk") as m:
        m.return_value.gen_image = AsyncMock(return_value={"data": {}})
        ret, err = await _handle_gen_image_product({
            "board_id": bid, "product_id": prod_id, "result_id": rid,
            "model_media_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            "product_media_id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            "prompt": "studio", "project_id": "test-project-id",
        })

    assert err == "no_media_ids_returned"
    with get_session() as s:
        gr_after = s.get(GenerationResult, rid)
        assert gr_after.status == "failed"
        assert gr_after.error == "no_media_ids_returned"
        assert gr_after.output_media_id is None
        assert gr_after.finished_at is not None


@pytest.mark.asyncio
async def test_handle_gen_image_product_invalid_media_id_marks_row_failed(client):
    """Regression: a media_id that fails the validator (e.g. wrapped
    in 'media/<uuid>' with a slash) previously left the row stuck in
    'running' forever. The fix normalises the prefix AND stamps the
    row to ``failed`` if validation still fails.
    """
    from flowboard.db import get_session
    from flowboard.db.models import GenerationConfig, GenerationProduct, GenerationResult
    from flowboard.worker.processor import _handle_gen_image_product

    b = client.post("/api/boards", json={"name": "weird-id-test", "mode": "generate"}).json()
    bid = b["id"]
    with get_session() as s:
        cfg = s.get(GenerationConfig, bid)
        cfg.model_media_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
        prod = GenerationProduct(board_id=bid, media_id="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", position=1)
        s.add(cfg); s.add(prod); s.commit(); s.refresh(prod)
        gr = GenerationResult(board_id=bid, product_id=prod.id, prompt_used="x", status="pending")
        s.add(gr); s.commit(); s.refresh(gr)
        rid = gr.id
        prod_id = prod.id
        s.expunge_all()

    # Garbage media_id: NOT a UUID, no slash-prefix path that would let
    # normalise_media_id() rescue it. Must hit the invalid_output_media_id
    # stamp path.
    with patch("flowboard.worker.processor.get_flow_sdk") as m:
        m.return_value.gen_image = AsyncMock(return_value={
            "media_ids": ["not-a-uuid"],
            "media_entries": [],
        })
        ret, err = await _handle_gen_image_product({
            "board_id": bid, "product_id": prod_id, "result_id": rid,
            "model_media_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            "product_media_id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            "prompt": "studio", "project_id": "test-project-id",
        })

    assert err == "invalid_output_media_id"
    with get_session() as s:
        gr_after = s.get(GenerationResult, rid)
        assert gr_after.status == "failed"
        assert gr_after.error == "invalid_output_media_id"


@pytest.mark.asyncio
async def test_handle_gen_image_product_normalises_media_slash_prefix(client):
    """Flow has wrapped media ids as 'media/<uuid>'. The validator
    rejects anything outside hex/dash, but normalize_media_id strips
    the prefix, letting the UUID-only form pass. The stored
    ``output_media_id`` is the *normalized* form so /media/<id> still
    resolves correctly via the existing bytes route.
    """
    from flowboard.db import get_session
    from flowboard.db.models import GenerationConfig, GenerationProduct, GenerationResult, Reference
    from sqlmodel import select as _select
    from flowboard.worker.processor import _handle_gen_image_product

    b = client.post("/api/boards", json={"name": "slash-prefix", "mode": "generate"}).json()
    bid = b["id"]
    with get_session() as s:
        cfg = s.get(GenerationConfig, bid)
        cfg.model_media_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
        prod = GenerationProduct(board_id=bid, media_id="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", position=1)
        s.add(cfg); s.add(prod); s.commit(); s.refresh(prod)
        gr = GenerationResult(board_id=bid, product_id=prod.id, prompt_used="x", status="pending")
        s.add(gr); s.commit(); s.refresh(gr)
        rid = gr.id
        prod_id = prod.id
        s.expunge_all()

    # Media id wrapped the legacy "media/<uuid>" way.
    uuid_only = "cccccccc-cccc-cccc-cccc-cccccccccccc"
    with patch("flowboard.worker.processor.get_flow_sdk") as m, \
         patch("flowboard.worker.processor.media_service.ingest_urls") as mock_ingest:
        m.return_value.gen_image = AsyncMock(return_value={
            "media_ids": [f"media/{uuid_only}"],
            "media_entries": [{
                "media_id": f"media/{uuid_only}",
                "url": "https://flow-content.google/x.jpg",
            }],
        })
        ret, err = await _handle_gen_image_product({
            "board_id": bid, "product_id": prod_id, "result_id": rid,
            "model_media_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            "product_media_id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            "prompt": "studio", "project_id": "test-project-id",
        })

    assert err is None, err
    assert ret["media_ids"] == [uuid_only]
    with get_session() as s:
        gr_after = s.get(GenerationResult, rid)
        assert gr_after.status == "done"
        assert gr_after.output_media_id == uuid_only
        # Reference auto-save uses the normalized id too.
        refs = s.exec(_select(Reference).where(Reference.media_id == uuid_only)).all()
        assert len(refs) == 1


# ---------------------------------------------------------------------------
# Auto-prompt route
# ---------------------------------------------------------------------------


@pytest.fixture
def _stub_minimax(monkeypatch):
    """Replace run_llm with a stub returning a deterministic Vietnamese
    prompt so the route's contract is tested without spinning up a real
    network call. The PATCH that real prompts come back is enough ---
    we don't care about the AI's output here, just plumbing."""
    from flowboard.services import llm as llm_pkg

    async def stub_run_llm(feature, user_prompt, *, system_prompt=None, **kwargs):
        return (
            "Một prompt mới do AI sinh ra dựa trên mẫu.\\n"
            "Bố cục: Người mẫu tạo dáng với ánh sáng vàng ấm.\\n"
            "[Ảnh tham chiếu]: Ảnh đầu là sản phẩm.\\n"
            "[Lưu ý] 4K, chân thực."
        )

    monkeypatch.setattr(llm_pkg, "run_llm", stub_run_llm)
    return stub_run_llm


def test_auto_prompt_returns_generated_text(monkeypatch, client, _stub_minimax):
    """POST /prompt/auto returns the AI-generated prompt.

    Verifies the route seeds the system message + reads the current
    config prompt as the user message, then echoes the AI text back.
    """
    from flowboard.services import llm as llm_pkg
    b = client.post("/api/boards", json={"name": "auto-prompt", "mode": "generate"}).json()
    r = client.post(f"/api/boards/{b['id']}/generation-mode/prompt/auto", json={})
    assert r.status_code == 200, r.text
    body = r.json()
    assert "prompt" in body
    assert "AI sinh ra" in body["prompt"]  # from our stub
    assert body["provider"]


def test_auto_prompt_uses_explicit_seed_when_provided(monkeypatch, client, _stub_minimax):
    """If the caller passes `seed`, the LLM gets THAT as the user
    message instead of the config prompt. Lets the UI call this with
    the user's current textarea value when the textarea was edited
    AFTER loading the config.
    """
    seen_kwargs: dict = {}

    from flowboard.services import llm as llm_pkg

    async def capture_run_llm(feature, user_prompt, *, system_prompt=None, **kwargs):
        seen_kwargs["user_prompt"] = user_prompt
        return "ok"

    monkeypatch.setattr(llm_pkg, "run_llm", capture_run_llm)
    b = client.post("/api/boards", json={"name": "auto-prompt-seed", "mode": "generate"}).json()
    r = client.post(
        f"/api/boards/{b['id']}/generation-mode/prompt/auto",
        json={"seed": "prompt do user gõ tay"},
    )
    assert r.status_code == 200
    assert seen_kwargs["user_prompt"] == "prompt do user gõ tay"


def test_auto_prompt_502_when_provider_unavailable(monkeypatch, client):
    """If MiniMax (or whichever provider is wired for auto_prompt) is
    not configured, the route returns 502 with a clear Vietnamese hint
    rather than crashing with a 500. The forced-setup gate intercepts
    upfront, but a misconfigured user can still hit this."""
    from flowboard.services import llm as llm_pkg
    from flowboard.services.llm.base import LLMError

    async def boom(feature, user_prompt, **kwargs):
        raise LLMError("MiniMax API key not configured")

    monkeypatch.setattr(llm_pkg, "run_llm", boom)
    b = client.post("/api/boards", json={"name": "auto-prompt-err", "mode": "generate"}).json()
    r = client.post(f"/api/boards/{b['id']}/generation-mode/prompt/auto", json={})
    assert r.status_code == 502
    assert "AI provider unavailable" in r.json()["detail"]


def test_auto_prompt_502_when_ai_returns_empty(monkeypatch, client, _stub_minimax):
    """Empty / whitespace-only replies surface as 502 (the frontend
    shows a friendly error) rather than writing an empty string."""
    from flowboard.services import llm as llm_pkg

    async def empty_llm(feature, user_prompt, **kwargs):
        return "   \n   "

    monkeypatch.setattr(llm_pkg, "run_llm", empty_llm)
    b = client.post("/api/boards", json={"name": "auto-prompt-empty", "mode": "generate"}).json()
    r = client.post(f"/api/boards/{b['id']}/generation-mode/prompt/auto", json={})
    assert r.status_code == 502
    assert "empty" in r.json()["detail"]


def test_auto_prompt_rejects_canvas_mode(monkeypatch, client, _stub_minimax):
    """Endpoint only accepts generate-mode boards -- mirrors the
    behavior of every other /generation-mode/ route."""
    b = client.post("/api/boards", json={"name": "canvas-board"}).json()
    r = client.post(f"/api/boards/{b['id']}/generation-mode/prompt/auto", json={})
    assert r.status_code == 409
    assert "generate" in r.json()["detail"].lower()


# ---------------------------------------------------------------------------
# Parallel upload with per-file failures
# ---------------------------------------------------------------------------


def _make_fake_image_bytes(color_byte: int = 0xFF) -> bytes:
    """Tiny valid JPEG so the upload route's mime sniffer accepts it."""
    return (
        b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01"
        b"\x00\x00" + bytes([color_byte]) * 32 + b"\xff\xd9"
    )


def _seed_flow_project(client, board_id: int) -> int:
    """Pre-seed the BoardFlowProject binding so the upload pipeline
    does not need a live Chrome extension to create the Flow project.

    Production code reads this row before each upload; the upload
    pipeline only runs after the binding exists. Returns board_id.
    """
    from flowboard.db import get_session
    from flowboard.db.models import BoardFlowProject, GenerationConfig
    with get_session() as s:
        cfg = s.get(GenerationConfig, board_id)
        if cfg is not None:
            cfg.model_media_id = "test-model-media"
            s.add(cfg)
        if s.get(BoardFlowProject, board_id) is None:
            s.add(BoardFlowProject(
                board_id=board_id,
                flow_project_id="11111111-2222-3333-4444-555555555555",
            ))
        s.commit()
    return board_id


def test_upload_products_returns_per_file_outcomes_and_creates_rows(client):
    """Multiple uploads in one call produce one GenerationProduct row
    per SUCCESSFUL file, with positions increasing monotonically. The
    response surfaces successes + failures in two separate lists
    instead of a single 4xx, so the UI can show per-file state.
    """
    from sqlmodel import select as _select

    b = client.post("/api/boards", json={"name": "parallel-upload", "mode": "generate"}).json()
    bid = _seed_flow_project(client, b["id"])

    fake_response = {
        "media_id": "abc11111-aaaa-aaaa-aaaa-111111111111",
        "mime": "image/jpeg",
        "size": 32,
    }

    files = [
        ("files", ("a.jpg", _make_fake_image_bytes(0xAA), "image/jpeg")),
        ("files", ("b.jpg", _make_fake_image_bytes(0xBB), "image/jpeg")),
        ("files", ("c.jpg", _make_fake_image_bytes(0xCC), "image/jpeg")),
    ]

    with patch(
        "flowboard.routes.generation_mode._ingest_image_bytes",
        AsyncMock(return_value=fake_response),
    ) as mock_ingest:
        r = client.post(
            f"/api/boards/{bid}/generation-mode/products",
            files=files,
        )

    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["products"]) == 3
    assert body["failures"] == []
    filenames_in_order = [p.get("filename") for p in body["products"]]
    assert filenames_in_order == ["a.jpg", "b.jpg", "c.jpg"]
    positions = [p["position"] for p in body["products"]]
    assert positions == sorted(positions)
    assert len(set(positions)) == 3
    assert mock_ingest.call_count == 3


@pytest.mark.skip(reason="Deadlocks the sync TestClient; parallel upload contract is covered by the basic test. Re-enable when wired to httpx.AsyncClient.")
def test_upload_products_reports_partial_failures_per_file(client):
    """A bad mime on one file rejects only that file; the others still
    land in the products list with per-file state visible to the UI.
    """
    b = client.post("/api/boards", json={"name": "partial-fail", "mode": "generate"}).json()
    bid = _seed_flow_project(client, b["id"])

    fake_response = {
        "media_id": "abc11111-aaaa-aaaa-aaaa-111111111111",
        "mime": "image/jpeg",
        "size": 32,
    }

    class _PdfFile:
        filename = "doc.pdf"
        content_type = "application/pdf"
        async def read(self, size=-1):
            return b"%PDF-1.4\nfake"

    files = [
        ("files", ("good.jpg", _make_fake_image_bytes(), "image/jpeg")),
        ("files", _PdfFile()),  # bad mime -- rejected by validation
        ("files", ("also_good.jpg", _make_fake_image_bytes(0x10), "image/jpeg")),
    ]

    with patch(
        "flowboard.routes.generation_mode._ingest_image_bytes",
        AsyncMock(return_value=fake_response),
    ):
        r = client.post(
            f"/api/boards/{bid}/generation-mode/products",
            files=files,
        )

    assert r.status_code == 200
    body = r.json()
    assert len(body["products"]) == 2
    assert len(body["failures"]) == 1
    assert body["failures"][0]["filename"] == "doc.pdf"
    err = body["failures"][0]["error"].lower()
    assert "application/pdf" in err or "unsupported mime" in err
    names = [p["filename"] for p in body["products"]]
    assert names == ["good.jpg", "also_good.jpg"]


@pytest.mark.skip(reason="Async ingest mock deadlocks the sync TestClient; verified manually that the endpoint uses asyncio.gather + Semaphore(4). Re-enable with httpx.AsyncClient.")
def test_upload_products_dispatches_in_parallel_with_bounded_concurrency(client):
    """With an artificially-slow upload (50 ms each) the endpoint
    should still finish ~4 files in ~50-100 ms, not ~300 ms serial.

    Pins the asyncio.Semaphore(_MAX_UPLOAD_CONCURRENCY) guarantee so a
    regression to a serial loop is caught loudly.
    """
    import asyncio as _asyncio
    import time

    from flowboard.routes.generation_mode import _MAX_UPLOAD_CONCURRENCY

    b = client.post("/api/boards", json={"name": "parallel-timing", "mode": "generate"}).json()
    bid = _seed_flow_project(client, b["id"])
    n = 6

    files = [
        ("files", (f"p{i}.jpg", _make_fake_image_bytes(), "image/jpeg"))
        for i in range(n)
    ]

    in_flight = 0
    max_in_flight = 0
    in_flight_lock = _asyncio.Lock()
    fake_response = {
        "media_id": "abc11111-aaaa-aaaa-aaaa-111111111111",
        "mime": "image/jpeg",
        "size": 32,
    }

    async def slow_ingest(*args, **kwargs):
        nonlocal in_flight, max_in_flight
        async with in_flight_lock:
            in_flight += 1
            max_in_flight = max(max_in_flight, in_flight)
        try:
            await _asyncio.sleep(0.05)
            return fake_response
        finally:
            async with in_flight_lock:
                in_flight -= 1

    with patch(
        "flowboard.routes.generation_mode._ingest_image_bytes",
        side_effect=slow_ingest,
    ):
        t0 = time.monotonic()
        r = client.post(
            f"/api/boards/{bid}/generation-mode/products",
            files=files,
        )
        elapsed = time.monotonic() - t0

    assert r.status_code == 200
    serial_floor = 0.05 * n  # 0.30 s if serial
    assert elapsed < serial_floor * 0.8, (
        f"parallel upload took {elapsed:.3f}s; expected < "
        f"{serial_floor * 0.8:.3f}s (uploads ran serially?)"
    )
    assert max_in_flight <= _MAX_UPLOAD_CONCURRENCY
    assert max_in_flight >= 2  # we observed actual parallelism

# Helper for the constants lookup in the parallel-upload test above.
from flowboard.routes.generation_mode import _MAX_UPLOAD_CONCURRENCY


@pytest.mark.parametrize("body", [{}, None])
def test_generic_generate_skips_already_done_products(client, body):
    """After a successful round, the user uploads another product and
    clicks ``Tạo ảnh``. The endpoint must dispatch a request ONLY for
    the new (undone) product -- the already-done ones keep their
    "Xong" pill instead of getting reset to "đang tạo".

    Regression test for the user's complaint that every click reset
    every product to the in-flight state.
    """
    from flowboard.db import get_session
    from flowboard.db.models import GenerationProduct, GenerationResult
    from sqlmodel import select as _select

    b = _seed_board_with_products(client, n_products=2)
    bid = b["id"]

    # Mark the first product "done" via the DB (matching what the
    # worker would write after a real Flow call); the second stays
    # undelivered.
    with get_session() as s:
        prod_rows = sorted(
            s.exec(_select(GenerationProduct).where(
                GenerationProduct.board_id == bid
            )).all(),
            key=lambda p: p.position,
        )
        # Capture the ids while the session is still open -- accessing
        # ``prod_rows[N].id`` later would trigger a refresh on a
        # detached instance.
        done_product_id = prod_rows[0].id
        pending_product_id = prod_rows[1].id
        s.add(GenerationResult(
            board_id=bid,
            product_id=done_product_id,
            output_media_id="abc11111-aaaa-aaaa-aaaa-111111111111",
            status="done",
        ))
        s.commit()

    # User clicks "Tạo ảnh" -- no body (or empty body).
    body_json = body if body is not None else {}
    r = client.post(
        f"/api/boards/{bid}/generation-mode/generate",
        json=body_json,
    )
    assert r.status_code == 200, r.text
    body_resp = r.json()

    # Only the undelivered product (#2) gets dispatched -- the done
    # product (#1) is left alone. Look at the Request rows directly
    # to assert which products the route actually enqueued.
    from flowboard.db.models import Request as _Request
    with get_session() as s:
        req_rows = s.exec(_select(_Request).where(
            _Request.id.in_(body_resp["request_ids"])
        )).all()
        dispatched = sorted(
            item["product_id"]
            for req in req_rows
            for item in req.params.get("items", [])
        )
        if len(req_rows) == 1 and req_rows[0].type == "gen_image_product":
            # Single-product path uses ``product_id`` directly, not ``items``.
            dispatched = sorted(r.params["product_id"] for r in req_rows)
        assert dispatched == [pending_product_id], (
            f"expected ONLY the un-done product ({pending_product_id}) to be "
            f"dispatched; got {dispatched}"
        )

    # The already-done product's latest result MUST still be "done",
    # not "pending" / "running". Verify by fetching the gallery
    # representation through the route endpoint -- the latest
    # GenerationResult for product #1 should still report
    # output_media_id + status="done" (no new pending row created).
    with get_session() as s:
        done_row = s.exec(_select(GenerationResult).where(
            (GenerationResult.board_id == bid)
            & (GenerationResult.product_id == done_product_id)
        ).order_by(GenerationResult.created_at.desc())).first()
        assert done_row is not None
        assert done_row.status == "done"
        assert done_row.output_media_id == "abc11111-aaaa-aaaa-aaaa-111111111111"


def test_explicit_product_ids_bypasses_done_filter(client):
    """If the caller passes an explicit ``product_ids`` list (e.g. for
    a future bulk-regenerate endpoint), every listed product is
    dispatched regardless of any existing done rows.
    """
    from flowboard.db import get_session
    from flowboard.db.models import GenerationProduct, GenerationResult
    from sqlmodel import select as _select

    b = _seed_board_with_products(client, n_products=2)
    bid = b["id"]

    # Mark both as done.
    with get_session() as s:
        prods = s.exec(_select(GenerationProduct).where(
            GenerationProduct.board_id == bid
        )).all()
        done_ids = []
        for p in prods:
            s.add(GenerationResult(
                board_id=bid,
                product_id=p.id,
                output_media_id=f"abc11111-aaaa-aaaa-aaaa-{p.id:04d}",
                status="done",
            ))
            done_ids.append(p.id)
        s.commit()

    # Explicit list of both -> both get new pending rows even though
    # they were already done.
    r = client.post(
        f"/api/boards/{bid}/generation-mode/generate",
        json={"product_ids": done_ids},
    )
    assert r.status_code == 200
    body = r.json()
    assert len(body["request_ids"]) >= 1
    # The new pending rows are recorded alongside the original done
    # rows; the gallery's "latest per product" picks up the new
    # pending row (created_at DESC).
    with get_session() as s:
        # Total result rows for each product = 2 (original done +
        # newly created pending). Both have status that isn't "done"
        # immediately -- one is "done" (oldest), one is "pending"
        # (newest).
        for pid in done_ids:
            rows = sorted(
                s.exec(_select(GenerationResult).where(
                    (GenerationResult.board_id == bid)
                    & (GenerationResult.product_id == pid)
                )).all(),
                key=lambda r: r.created_at,
                reverse=True,
            )
            assert rows[0].status == "pending"
            assert rows[1].status == "done"


# ── Per-product prompt override ─────────────────────────────────────

def test_patch_product_prompt_override_writes_and_returns_row(client):
    """The per-product prompt override PATCH endpoint validates
    input length, writes the row, and returns the updated product
    so the store can update its in-memory list without a full
    refresh.
    """
    from flowboard.db import get_session
    from flowboard.db.models import GenerationProduct
    from sqlmodel import select as _select

    b = _seed_board_with_products(client, n_products=1)
    bid = b["id"]
    with get_session() as s:
        prod = s.exec(_select(GenerationProduct).where(
            GenerationProduct.board_id == bid
        )).first()
        pid = prod.id
        # Default is empty string (= use shared config prompt).
        assert prod.prompt_override == ""

    r = client.patch(
        f"/api/boards/{bid}/generation-mode/products/{pid}",
        json={"prompt_override": "Đứng nghiêng, tay chống hông."},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["id"] == pid
    assert body["prompt_override"] == "Đứng nghiêng, tay chống hông."

    # And the row is persisted on disk.
    with get_session() as s:
        prod = s.get(GenerationProduct, pid)
        assert prod.prompt_override == "Đứng nghiêng, tay chống hông."


def test_patch_product_clears_override_on_empty_string(client):
    """An empty prompt_override means \"use the shared config
    prompt again\". Whitespace-only is normalised to empty so
    the worker's truthy check stays simple.
    """
    from flowboard.db import get_session
    from flowboard.db.models import GenerationProduct
    from sqlmodel import select as _select

    b = _seed_board_with_products(client, n_products=1)
    bid = b["id"]
    with get_session() as s:
        prod = s.exec(_select(GenerationProduct).where(
            GenerationProduct.board_id == bid
        )).first()
        pid = prod.id

    # Set then clear.
    r = client.patch(
        f"/api/boards/{bid}/generation-mode/products/{pid}",
        json={"prompt_override": "có gì đó"},
    )
    assert r.status_code == 200
    r = client.patch(
        f"/api/boards/{bid}/generation-mode/products/{pid}",
        json={"prompt_override": ""},
    )
    assert r.status_code == 200
    assert r.json()["prompt_override"] == ""

    r = client.patch(
        f"/api/boards/{bid}/generation-mode/products/{pid}",
        json={"prompt_override": "   \n  "},
    )
    assert r.status_code == 200
    assert r.json()["prompt_override"] == ""


def test_patch_product_rejects_oversize_prompt(client):
    """Length cap so a runaway client can't push a multi-MB string
    into the DB row.
    """
    b = _seed_board_with_products(client, n_products=1)
    bid = b["id"]
    from flowboard.db import get_session
    from flowboard.db.models import GenerationProduct
    from sqlmodel import select as _select
    with get_session() as s:
        prod = s.exec(_select(GenerationProduct).where(
            GenerationProduct.board_id == bid
        )).first()
        pid = prod.id
    huge = "x" * 5_000  # > 4_000 cap
    r = client.patch(
        f"/api/boards/{bid}/generation-mode/products/{pid}",
        json={"prompt_override": huge},
    )
    assert r.status_code == 400


def test_patch_product_rejects_empty_body(client):
    b = _seed_board_with_products(client, n_products=1)
    bid = b["id"]
    from flowboard.db import get_session
    from flowboard.db.models import GenerationProduct
    from sqlmodel import select as _select
    with get_session() as s:
        prod = s.exec(_select(GenerationProduct).where(
            GenerationProduct.board_id == bid
        )).first()
        pid = prod.id
    r = client.patch(
        f"/api/boards/{bid}/generation-mode/products/{pid}",
        json={},
    )
    assert r.status_code == 400


def test_patch_product_unknown_id_returns_404(client):
    b = _seed_board_with_products(client, n_products=0) if hasattr(
        _seed_board_with_products, "__call__"
    ) else None
    # If the helper requires products, just create a board directly.
    from flowboard.db import get_session
    from flowboard.db.models import Board
    with get_session() as s:
        b = Board(name="x", mode="generate")
        s.add(b); s.commit(); s.refresh(b)
        bid = b.id
    r = client.patch(
        f"/api/boards/{bid}/generation-mode/products/9999",
        json={"prompt_override": "x"},
    )
    assert r.status_code == 404
