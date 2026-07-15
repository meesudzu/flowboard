"""Tests for the /api/prompt-templates CRUD endpoints.

These mirror the Reference test suite: each test uses the FastAPI
TestClient fixture from conftest.py and exercises one CRUD path or
error case. The DB is dropped + recreated before every test (see
``conftest.py::_fresh_db``) so state is isolated.
"""
import re


def test_create_template_minimal(client):
    """POST with (title, body) returns the new row, with both timestamps
    populated and ISO-formatted."""
    r = client.post(
        "/api/prompt-templates",
        json={"title": "Lookbook studio", "body": "Studio portrait, soft window light"},
    )
    assert r.status_code == 200, r.text
    row = r.json()
    assert row["title"] == "Lookbook studio"
    assert row["body"] == "Studio portrait, soft window light"
    assert row["created_at"] is not None
    assert row["updated_at"] is not None
    assert "T" in row["created_at"]  # ISO-8601 with T separator
    assert isinstance(row["id"], int)


def test_create_template_trims_title(client):
    """Leading/trailing whitespace on title is stripped; body whitespace
    is preserved verbatim."""
    r = client.post(
        "/api/prompt-templates",
        json={"title": "  spaced  ", "body": "  keep me  "},
    )
    assert r.status_code == 200
    row = r.json()
    assert row["title"] == "spaced"
    assert row["body"] == "  keep me  "


def test_create_template_blank_title_rejected(client):
    """Title that is empty after strip → 400, no row inserted."""
    r = client.post("/api/prompt-templates", json={"title": "   ", "body": "x"})
    assert r.status_code == 400
    # Confirm nothing was inserted (otherwise we'd return the empty one).
    assert client.get("/api/prompt-templates").json() == []


def test_create_template_empty_body_allowed(client):
    """Body may be empty (placeholder workflow: user creates a slot
    and PATCHes in body later)."""
    r = client.post(
        "/api/prompt-templates",
        json={"title": "draft", "body": ""},
    )
    assert r.status_code == 200
    assert r.json()["body"] == ""


def test_create_template_title_too_long_rejected(client):
    """Pydantic max_length=120 — 121-char title → 422."""
    r = client.post(
        "/api/prompt-templates",
        json={"title": "x" * 121, "body": "ok"},
    )
    assert r.status_code == 422


def test_list_templates_sort_updated_desc(client):
    """Most-recently-updated row surfaces first.

    PATCHing A (created first) must bump it to position 0 because its
    ``updated_at`` is now the newest timestamp.
    """
    a = client.post(
        "/api/prompt-templates", json={"title": "A", "body": "old"}
    ).json()
    b = client.post(
        "/api/prompt-templates", json={"title": "B", "body": "newer"}
    ).json()
    # Touch A so its updated_at > B's.
    client.patch(f"/api/prompt-templates/{a['id']}", json={"body": "fresh"})

    rows = client.get("/api/prompt-templates").json()
    assert [r["id"] for r in rows] == [a["id"], b["id"]]


def test_list_templates_q_filter(client):
    """GET ?q substring matches title, case-insensitive, ignores body."""
    client.post("/api/prompt-templates", json={"title": "Lookbook studio", "body": ""})
    client.post("/api/prompt-templates", json={"title": "Street autumn", "body": ""})
    client.post(
        "/api/prompt-templates",
        json={"title": "Plain", "body": "lookbook is only in body"},
    )

    # case-insensitive match
    r1 = client.get("/api/prompt-templates", params={"q": "look"}).json()
    assert len(r1) == 1
    assert r1[0]["title"] == "Lookbook studio"

    # body content NOT searched in this endpoint (documented behaviour)
    r2 = client.get("/api/prompt-templates", params={"q": "lookbook"}).json()
    titles = {x["title"] for x in r2}
    assert titles == {"Lookbook studio"}

    # No hit
    r3 = client.get("/api/prompt-templates", params={"q": "nope"}).json()
    assert r3 == []


def test_patch_template_title_only(client):
    """PATCH {title} leaves body untouched and refreshes updated_at."""
    original = client.post(
        "/api/prompt-templates",
        json={"title": "old", "body": "keep me"},
    ).json()
    original_updated = original["updated_at"]

    r = client.patch(
        f"/api/prompt-templates/{original['id']}",
        json={"title": "new"},
    )
    assert r.status_code == 200
    updated = r.json()
    assert updated["title"] == "new"
    assert updated["body"] == "keep me"
    assert updated["updated_at"] >= original_updated


def test_patch_template_body_only(client):
    """PATCH {body} leaves title untouched."""
    original = client.post(
        "/api/prompt-templates",
        json={"title": "stable", "body": "old body"},
    ).json()
    r = client.patch(
        f"/api/prompt-templates/{original['id']}",
        json={"body": "new body"},
    )
    assert r.status_code == 200
    updated = r.json()
    assert updated["title"] == "stable"
    assert updated["body"] == "new body"


def test_patch_template_blank_title_rejected(client):
    """PATCH with a title that strips to empty → 400, no changes written."""
    row = client.post(
        "/api/prompt-templates",
        json={"title": "good", "body": "ok"},
    ).json()
    r = client.patch(f"/api/prompt-templates/{row['id']}", json={"title": "   "})
    assert r.status_code == 400
    # state unchanged
    again = client.get("/api/prompt-templates").json()[0]
    assert again["title"] == "good"
    assert again["body"] == "ok"


def test_patch_template_empty_body_allowed(client):
    """PATCH with body='' is allowed (clear-and-replace). Distinct from
    omit entirely (which would 400 from the no-fields-to-update guard)."""
    row = client.post(
        "/api/prompt-templates",
        json={"title": "with-body", "body": "old"},
    ).json()
    r = client.patch(f"/api/prompt-templates/{row['id']}", json={"body": ""})
    assert r.status_code == 200
    assert r.json()["body"] == ""


def test_patch_template_no_fields_rejected(client):
    """Empty PATCH body → 400. Lets the frontend fail loud instead of
    silently issuing a no-op round-trip."""
    row = client.post(
        "/api/prompt-templates",
        json={"title": "x", "body": "y"},
    ).json()
    r = client.patch(f"/api/prompt-templates/{row['id']}", json={})
    assert r.status_code == 400


def test_patch_template_missing_id_404(client):
    r = client.patch("/api/prompt-templates/999999", json={"title": "x"})
    assert r.status_code == 404


def test_delete_template_returns_204(client):
    row = client.post(
        "/api/prompt-templates", json={"title": "doomed", "body": "rip"}
    ).json()
    res = client.delete(f"/api/prompt-templates/{row['id']}")
    assert res.status_code == 204
    # Row really gone.
    listed = client.get("/api/prompt-templates").json()
    assert all(r["id"] != row["id"] for r in listed)


def test_delete_template_missing_id_404(client):
    res = client.delete("/api/prompt-templates/999999")
    assert res.status_code == 404


def test_full_crud_lifecycle(client):
    """End-to-end: create → list → patch → delete. Smoke test that
    the wiring works in concert (catches typos and import order issues
    the per-method tests above can miss)."""
    created = client.post(
        "/api/prompt-templates",
        json={"title": "lifecycle", "body": "v1"},
    ).json()
    assert created["id"] > 0

    listed = client.get("/api/prompt-templates").json()
    assert any(r["id"] == created["id"] for r in listed)

    patched = client.patch(
        f"/api/prompt-templates/{created['id']}",
        json={"body": "v2"},
    )
    assert patched.status_code == 200
    assert patched.json()["body"] == "v2"

    deleted = client.delete(f"/api/prompt-templates/{created['id']}")
    assert deleted.status_code == 204

    assert client.get("/api/prompt-templates").json() == []
