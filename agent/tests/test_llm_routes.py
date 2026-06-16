"""Tests for the /api/llm/* HTTP routes.

Uses FastAPI TestClient + the conftest's app fixture. MiniMax-only
build: there's a single provider (MiniMax) to exercise end-to-end. The
provider's cheap probes are stubbed (httpx mocked) so no real network
call ever lands during the test run.
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from flowboard.services.llm import registry, secrets


@pytest.fixture
def tmp_secrets_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    p = tmp_path / "secrets.json"
    monkeypatch.setenv("FLOWBOARD_SECRETS_PATH", str(p))
    return p


@pytest.fixture(autouse=True)
def _reset_provider_caches():
    """Each route test gets fresh provider probes — module-level singletons
    cache availability between tests otherwise."""
    for p in registry.list_providers():
        if hasattr(p, "reset_cache"):
            p.reset_cache()
    yield


# ── GET /api/llm/providers ────────────────────────────────────────────


def test_list_providers_returns_minimax_only(client, tmp_secrets_path):
    """MiniMax-only build: the providers list contains exactly one entry
    (MiniMax). xAI Grok + the 3 CLI providers (Claude / Gemini / OpenAI
    Codex) were dropped — they were never reachable on the cloud-VPS
    image and added noise to the Settings UI."""
    with patch.object(
        registry._PROVIDERS["minimax"], "is_available", return_value=False
    ):
        resp = client.get("/api/llm/providers")
    assert resp.status_code == 200
    providers = resp.json()
    assert len(providers) == 1
    assert providers[0]["name"] == "minimax"
    assert "available" in providers[0]
    assert "configured" in providers[0]
    assert "supportsVision" in providers[0]
    assert "requiresKey" in providers[0]
    assert "mode" in providers[0]


def test_list_providers_minimax_requires_key(client, tmp_secrets_path):
    """MiniMax is API-only — `requiresKey=True` is the contract the
    Settings UI uses to render the API-key paste input."""
    resp = client.get("/api/llm/providers")
    by_name = {p["name"]: p for p in resp.json()}
    assert by_name["minimax"]["requiresKey"] is True


def test_list_providers_does_not_leak_api_keys(client, tmp_secrets_path):
    """Defensive: a saved key must never round-trip through any response
    field, even indirectly via a debug dump."""
    secrets.set_api_key("minimax", "sk-leaky-secret-1234567890")
    resp = client.get("/api/llm/providers")
    body = resp.text
    assert "sk-leaky-secret-1234567890" not in body


# ── PUT /api/llm/providers/{name} ─────────────────────────────────────


def test_set_minimax_api_key_clear_path(client, tmp_secrets_path):
    """apiKey=null clears a previously-saved MiniMax key."""
    secrets.set_api_key("minimax", "sk-existing")
    resp = client.put("/api/llm/providers/minimax", json={"apiKey": None})
    assert resp.status_code == 200
    assert secrets.get_api_key("minimax") is None


def test_set_minimax_api_key_round_trip(client, tmp_secrets_path):
    """Saved key persists; `configured` flips to true after a successful
    set so the next /providers poll reflects the change immediately."""
    resp = client.put(
        "/api/llm/providers/minimax", json={"apiKey": "sk-test-12345"}
    )
    assert resp.status_code == 200
    assert secrets.get_api_key("minimax") == "sk-test-12345"
    # The set path busts the availability cache; with a key present,
    # is_available() should return True. (is_available is async.)
    assert asyncio.run(registry._PROVIDERS["minimax"].is_available()) is True


def test_set_api_key_unknown_provider_is_404(client, tmp_secrets_path):
    """Defensive: any name other than the registered set returns 404
    instead of silently writing a junk key to secrets.json."""
    resp = client.put(
        "/api/llm/providers/openai", json={"apiKey": "sk-x"}
    )
    assert resp.status_code == 404
    # And the openai slot was not written:
    assert secrets.get_api_key("openai") is None


# ── POST /api/llm/providers/{name}/test ───────────────────────────────


@pytest.mark.asyncio
async def test_minimax_test_success_returns_latency(
    client, tmp_secrets_path, monkeypatch
):
    """Successful ping returns {ok: true, latencyMs: <int>}."""
    secrets.set_api_key("minimax", "sk-test-12345")
    # Stub provider.run so no real HTTP call lands. Returns a single
    # character to mirror what the real implementation does on
    # success.
    async def fake_run(prompt, *, system_prompt=None, attachments=None, timeout=120.0, model=None):
        return "."
    monkeypatch.setattr(
        registry._PROVIDERS["minimax"], "run", fake_run
    )
    resp = client.post("/api/llm/providers/minimax/test")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert isinstance(body["latencyMs"], int)
    assert body["latencyMs"] >= 0


def test_minimax_test_failure_returns_error_message(
    client, tmp_secrets_path, monkeypatch
):
    """Provider raises LLMError → response is {ok: false, error: ...}
    (still 200 OK, so the UI can render the error inline)."""
    from flowboard.services.llm.base import LLMError

    secrets.set_api_key("minimax", "sk-test-12345")
    async def fake_run(prompt, *, system_prompt=None, attachments=None, timeout=120.0, model=None):
        raise LLMError("simulated MiniMax 1004: invalid key")
    monkeypatch.setattr(
        registry._PROVIDERS["minimax"], "run", fake_run
    )
    resp = client.post("/api/llm/providers/minimax/test")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is False
    assert "invalid key" in body["error"]


def test_minimax_test_no_key_returns_unconfigured(
    client, tmp_secrets_path
):
    """Without a key, the test endpoint short-circuits with a friendly
    error rather than calling the API and getting a 401."""
    resp = client.post("/api/llm/providers/minimax/test")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is False
    assert "not configured" in body["error"].lower()


# ── GET /api/llm/config ───────────────────────────────────────────────


def test_get_config_initial_all_null(client, tmp_secrets_path):
    """On a fresh install, every feature is null and `configured` is
    False — the forced-setup gate uses this to keep the dialog open."""
    resp = client.get("/api/llm/config")
    body = resp.json()
    assert body["auto_prompt"] is None
    assert body["vision"] is None
    assert body["planner"] is None
    assert body["configured"] is False


def test_get_config_configured_when_all_pinned_to_minimax(
    client, tmp_secrets_path
):
    """`configured` is True only when all 3 features point at the same
    provider (single-provider UI invariant)."""
    secrets.set_feature_provider("auto_prompt", "minimax")
    secrets.set_feature_provider("vision", "minimax")
    secrets.set_feature_provider("planner", "minimax")
    resp = client.get("/api/llm/config")
    body = resp.json()
    assert body["configured"] is True
    assert body["auto_prompt"] == "minimax"
    assert body["vision"] == "minimax"
    assert body["planner"] == "minimax"


# ── PUT /api/llm/config ───────────────────────────────────────────────


def test_set_config_updates_features(client, tmp_secrets_path):
    resp = client.put(
        "/api/llm/config",
        json={"auto_prompt": "minimax", "vision": "minimax", "planner": "minimax"},
    )
    assert resp.status_code == 200
    cfg = client.get("/api/llm/config").json()
    assert cfg["auto_prompt"] == "minimax"
    assert cfg["vision"] == "minimax"
    assert cfg["planner"] == "minimax"
    assert cfg["configured"] is True


def test_set_config_partial_update_keeps_other_features(
    client, tmp_secrets_path
):
    """PUT with one field only updates that field; the others stay as
    they were (no defaults applied by the route)."""
    secrets.set_feature_provider("planner", "minimax")
    resp = client.put(
        "/api/llm/config", json={"auto_prompt": "minimax"}
    )
    assert resp.status_code == 200
    cfg = client.get("/api/llm/config").json()
    assert cfg["auto_prompt"] == "minimax"
    assert cfg["planner"] == "minimax"
    # vision is still unset:
    assert cfg["vision"] is None
    # …so `configured` is still False (single-provider invariant).
    assert cfg["configured"] is False


def test_set_config_unknown_provider_rejected(client, tmp_secrets_path):
    """The whitelist only contains `minimax` after the refactor."""
    resp = client.put(
        "/api/llm/config", json={"auto_prompt": "claude"}
    )
    assert resp.status_code == 400


def test_set_config_unknown_feature_rejected(client, tmp_secrets_path):
    resp = client.put(
        "/api/llm/config", json={"summary": "minimax"}
    )
    assert resp.status_code == 400


def test_set_config_empty_body_rejected(client, tmp_secrets_path):
    resp = client.put("/api/llm/config", json={})
    assert resp.status_code == 400
