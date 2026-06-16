"""Tests for the /api/activity routes — focused on the timestamp
serialization contract + the status filter used by frontend rehydration.

Background: SQLite's ``DateTime`` column stores naive ISO strings, so a
TZ-aware ``datetime.now(tz=utc)`` round-trips back as **naive** on read.
Without an explicit UTC marker on the wire, the frontend's
``new Date(string)`` interprets naive ISO as **local** time — Vietnam
clients then read every server timestamp as 7h in the past, and "X
minutes ago" widgets show 7h+ offsets. The route's ``_utc_iso`` helper
guarantees every emitted timestamp ends with ``Z``.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from flowboard.db import get_session
from flowboard.db.models import Request
from flowboard.main import app
from flowboard.routes.activity import _utc_iso


client = TestClient(app)


def test_utc_iso_tags_naive_datetime_as_utc():
    """Naive datetime (the SQLite read-back path) gets the UTC marker
    appended verbatim — we know we wrote UTC, so re-tagging is safe."""
    naive = datetime(2026, 5, 1, 7, 13, 43, 704974)
    out = _utc_iso(naive)
    assert out is not None
    assert out.endswith("Z"), f"missing Z suffix: {out!r}"
    assert "+00:00" not in out
    assert out.startswith("2026-05-01T07:13:43")


def test_utc_iso_converts_aware_non_utc_to_utc():
    """If a tz-aware datetime in another zone slips through (e.g. a
    code path that uses local time), normalize to UTC so the wire format
    is always UTC + Z."""
    plus7 = timezone(timedelta(hours=7))
    aware = datetime(2026, 5, 1, 14, 13, 43, tzinfo=plus7)
    out = _utc_iso(aware)
    assert out is not None
    assert out.endswith("Z")
    # 14:13:43 +07:00 → 07:13:43 UTC
    assert out.startswith("2026-05-01T07:13:43")


def test_utc_iso_passes_through_aware_utc():
    """Already-UTC-aware datetimes serialize cleanly without a double
    conversion."""
    aware_utc = datetime(2026, 5, 1, 7, 13, 43, tzinfo=timezone.utc)
    out = _utc_iso(aware_utc)
    assert out == "2026-05-01T07:13:43Z"


def test_utc_iso_returns_none_for_none():
    """``finished_at`` is None while a request is in flight — the
    helper must propagate that, not raise."""
    assert _utc_iso(None) is None


# ── status filter (used by frontend rehydration on boot) ─────────────────
# The frontend re-attachs poll loops for in-flight requests on page load
# by hitting `/api/activity?status=queued,running`. The route must:
#   1. Filter correctly by status (a 'done' row should not leak into a
#      'running' query and silently hide a stale poll from the user).
#   2. 422 on an unknown status value — a typo would otherwise return
#      zero rows and the user would see "node stuck on idle" forever.
#   3. 422 (not 500) — bad input must surface a clean error code so the
#      frontend can show a real toast instead of a generic network error.

def test_status_filter_excludes_other_statuses():
    """Only rows whose `status` is in the filter set come back. Without
    the filter the list returns every status — important to keep this
    contract explicit because the frontend uses it to find in-flight
    work."""
    # Seed three rows across three statuses.
    payload = {"type": "gen_image", "params": {"prompt": "x"}}
    queued_id = client.post("/api/requests", json=payload).json()["id"]
    running_id = client.post("/api/requests", json=payload).json()["id"]
    done_id = client.post("/api/requests", json=payload).json()["id"]

    # Force the second one to 'running' and the third to 'done' so we
    # can assert the filter only returns the queued+running pair.
    with get_session() as s:
        r1 = s.get(Request, queued_id)
        r2 = s.get(Request, running_id)
        r3 = s.get(Request, done_id)
        r2.status = "running"
        r3.status = "done"
        s.add(r1)
        s.add(r2)
        s.add(r3)
        s.commit()

    # Pull a large enough page that the seeded rows are included.
    resp = client.get("/api/activity", params={"status": "queued,running", "limit": 200})
    assert resp.status_code == 200
    items = resp.json()["items"]
    ids = {it["id"] for it in items}
    assert queued_id in ids
    assert running_id in ids
    assert done_id not in ids, "done row leaked into queued,running filter"

    # Also test a single-value filter.
    resp2 = client.get("/api/activity", params={"status": "running", "limit": 200})
    assert resp2.status_code == 200
    ids2 = {it["id"] for it in resp2.json()["items"]}
    assert running_id in ids2
    assert queued_id not in ids2
    assert done_id not in ids2


def test_status_filter_rejects_unknown_values():
    """A typo'd status filter must return 422 (not an empty list).
    Empty-list would silently hide in-flight work on boot — exactly the
    regression this filter exists to prevent."""
    resp = client.get("/api/activity", params={"status": "runnig"})  # typo
    assert resp.status_code == 422
    assert "runnig" in resp.text


def test_status_filter_accepts_all_known_statuses():
    """All terminal + in-flight status values pass validation; only
    unknown values 422."""
    for s in ("queued", "running", "done", "failed", "timeout", "canceled"):
        resp = client.get("/api/activity", params={"status": s})
        assert resp.status_code == 200, f"{s!r} rejected by status filter"
