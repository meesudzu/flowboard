"""Tests for the MiniMax REST provider.

The MiniMax provider is API-only — no CLI transport, no subprocess, no
OAuth dance. Auth is a single API key in ``apiKeys.minimax``. Tests
stub ``httpx.AsyncClient`` at the module boundary so no real network
call ever lands. The response shape under test mirrors the public
OpenAPI spec at https://platform.minimax.io/docs/api-reference/text-post.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

import httpx
import pytest

from flowboard.services.llm import secrets
from flowboard.services.llm.base import LLMError
from flowboard.services.llm.minimax import MiniMaxProvider


# ── fixtures ──────────────────────────────────────────────────────────


@pytest.fixture
def tmp_secrets_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    p = tmp_path / "secrets.json"
    monkeypatch.setenv("FLOWBOARD_SECRETS_PATH", str(p))
    return p


# ── httpx stubs ───────────────────────────────────────────────────────


@dataclass
class _FakeResponse:
    status_code: int
    body: Any  # dict for JSON responses

    def json(self):
        if self._is_json_body():
            return self.body
        raise ValueError("not JSON")

    def _is_json_body(self) -> bool:
        return isinstance(self.body, (dict, list))


class _FakeClient:
    def __init__(self, *args, response: _FakeResponse, capture: dict, **kwargs):
        self._response = response
        self._capture = capture

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    async def post(self, url, **kwargs):
        self._capture["url"] = url
        self._capture["headers"] = kwargs.get("headers")
        self._capture["json"] = kwargs.get("json")
        return self._response


def _patch_httpx(monkeypatch, response: _FakeResponse) -> dict:
    capture: dict = {}

    def _factory(*args, **kwargs):
        return _FakeClient(*args, response=response, capture=capture, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", _factory)
    return capture


def _ok_response(content: str = "hello", model: str = "MiniMax-M2.7-highspeed") -> _FakeResponse:
    return _FakeResponse(
        status_code=200,
        body={
            "id": "test-id",
            "choices": [
                {"finish_reason": "stop", "index": 0,
                 "message": {"role": "assistant", "content": content}}
            ],
            "model": model,
            "usage": {"prompt_tokens": 5, "completion_tokens": 5, "total_tokens": 10},
            "base_resp": {"status_code": 0, "status_msg": ""},
        },
    )


# ── is_available / mode ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_is_available_false_without_key(tmp_secrets_path):
    p = MiniMaxProvider()
    assert await p.is_available() is False


@pytest.mark.asyncio
async def test_is_available_true_with_key(tmp_secrets_path):
    secrets.set_api_key("minimax", "sk-test-1234")
    p = MiniMaxProvider()
    assert await p.is_available() is True


def test_mode_is_none_without_key(tmp_secrets_path):
    p = MiniMaxProvider()
    assert p.mode == "none"


def test_mode_is_api_with_key(tmp_secrets_path):
    secrets.set_api_key("minimax", "sk-test-1234")
    p = MiniMaxProvider()
    assert p.mode == "api"


# ── run — text dispatch ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_run_text_sends_bearer_and_text_model(
    tmp_secrets_path, monkeypatch
):
    secrets.set_api_key("minimax", "sk-test-1234")
    p = MiniMaxProvider()
    capture = _patch_httpx(monkeypatch, _ok_response(content="hi there"))

    out = await p.run("hello", system_prompt="be terse")
    assert out == "hi there"

    # URL points at the public v2 chat completion endpoint.
    assert capture["url"].endswith("/v1/text/chatcompletion_v2")
    # Auth header carries the key in the OpenAI-style Bearer format.
    assert capture["headers"]["authorization"] == "Bearer sk-test-1234"
    # Default text model is M2.7-highspeed.
    assert capture["json"]["model"] == "MiniMax-M2.7-highspeed"
    # system + user messages in the correct roles + content shape.
    msgs = capture["json"]["messages"]
    assert msgs[0] == {"role": "system", "content": "be terse"}
    assert msgs[1] == {"role": "user", "content": "hello"}


@pytest.mark.asyncio
async def test_run_text_without_system_prompt(
    tmp_secrets_path, monkeypatch
):
    secrets.set_api_key("minimax", "sk-test-1234")
    p = MiniMaxProvider()
    capture = _patch_httpx(monkeypatch, _ok_response())

    await p.run("hello")
    msgs = capture["json"]["messages"]
    # No system message when system_prompt is None.
    assert len(msgs) == 1
    assert msgs[0] == {"role": "user", "content": "hello"}


# ── run — vision dispatch ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_run_vision_sends_multimodal_content(
    tmp_secrets_path, monkeypatch, tmp_path
):
    """When attachments are present, content flips to a list with text +
    image_url blocks and the model upgrades to M3 (the only vision-
    capable M-series model)."""
    secrets.set_api_key("minimax", "sk-test-1234")
    img = tmp_path / "x.jpg"
    img.write_bytes(b"\xff\xd8\xff fake jpeg")

    p = MiniMaxProvider()
    capture = _patch_httpx(
        monkeypatch,
        _ok_response(content="orange", model="MiniMax-M3"),
    )

    out = await p.run("what color?", attachments=[str(img)])
    assert out == "orange"

    # Model bumped to M3 for vision.
    assert capture["json"]["model"] == "MiniMax-M3"
    # Multimodal content array, text first, then image_url.
    user = capture["json"]["messages"][-1]
    assert user["role"] == "user"
    content = user["content"]
    assert isinstance(content, list)
    assert content[0] == {"type": "text", "text": "what color?"}
    # Image encoded as data: URL (base64).
    img_block = content[1]
    assert img_block["type"] == "image_url"
    url = img_block["image_url"]["url"]
    assert url.startswith("data:image/jpeg;base64,")


@pytest.mark.asyncio
async def test_run_vision_rejects_oversized_attachment(
    tmp_secrets_path, monkeypatch, tmp_path
):
    """5 MB cap on inline base64 (matches OpenAI provider's guard)."""
    secrets.set_api_key("minimax", "sk-test-1234")
    big = tmp_path / "big.jpg"
    big.write_bytes(b"x" * (6 * 1024 * 1024))  # 6 MB

    p = MiniMaxProvider()
    _patch_httpx(monkeypatch, _ok_response())  # should never be called

    with pytest.raises(LLMError, match="attachment too large"):
        await p.run("describe", attachments=[str(big)])


# ── run — key / config errors ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_run_without_key_raises(tmp_secrets_path):
    """No key in secrets → clear LLMError, never a network attempt."""
    p = MiniMaxProvider()
    with pytest.raises(LLMError, match="API key not configured"):
        await p.run("hello")


# ── run — error envelope handling ─────────────────────────────────────


@pytest.mark.asyncio
async def test_soft_error_in_base_resp_raises(
    tmp_secrets_path, monkeypatch
):
    """MiniMax sometimes returns HTTP 200 with ``base_resp.status_code != 0``
    (e.g. 1004 auth fail, 1008 insufficient balance). Surface as LLMError
    so callers don't silently treat it as success."""
    secrets.set_api_key("minimax", "sk-test-1234")
    p = MiniMaxProvider()
    _patch_httpx(
        monkeypatch,
        _FakeResponse(
            status_code=200,
            body={
                "base_resp": {"status_code": 1004, "status_msg": "auth failed"},
                "choices": [],
            },
        ),
    )
    with pytest.raises(LLMError, match=r"minimax error 1004"):
        await p.run("hello")


@pytest.mark.asyncio
async def test_http_500_surfaces_status_and_message(
    tmp_secrets_path, monkeypatch
):
    secrets.set_api_key("minimax", "sk-test-1234")
    p = MiniMaxProvider()
    _patch_httpx(
        monkeypatch,
        _FakeResponse(
            status_code=500,
            body={"base_resp": {"status_code": 1013, "status_msg": "server boom"}},
        ),
    )
    with pytest.raises(LLMError, match=r"minimax HTTP 500"):
        await p.run("hello")


@pytest.mark.asyncio
async def test_transport_error_raises(
    tmp_secrets_path, monkeypatch
):
    """httpx.TimeoutException + other HTTPError map to LLMError with a
    clear transport-style message — never bubble raw exceptions to callers."""
    secrets.set_api_key("minimax", "sk-test-1234")
    p = MiniMaxProvider()

    class _Boom:
        def __init__(self, *a, **kw): pass
        async def __aenter__(self): raise httpx.ConnectError("connection refused")
        async def __aexit__(self, *a): return None

    monkeypatch.setattr(httpx, "AsyncClient", _Boom)
    with pytest.raises(LLMError, match="transport error"):
        await p.run("hello")


@pytest.mark.asyncio
async def test_timeout_maps_to_clear_error(
    tmp_secrets_path, monkeypatch
):
    secrets.set_api_key("minimax", "sk-test-1234")
    p = MiniMaxProvider()

    class _Slow:
        def __init__(self, *a, **kw): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return None
        async def post(self, *a, **kw):
            raise httpx.TimeoutException("read timeout")

    monkeypatch.setattr(httpx, "AsyncClient", _Slow)
    with pytest.raises(LLMError, match=r"timed out after"):
        await p.run("hello", timeout=5.0)


# ── run — response shape edge cases ───────────────────────────────────


@pytest.mark.asyncio
async def test_missing_choices_raises(
    tmp_secrets_path, monkeypatch
):
    """200 with an unparseable body must surface a clear error rather
    than KeyError-ing the caller."""
    secrets.set_api_key("minimax", "sk-test-1234")
    p = MiniMaxProvider()
    _patch_httpx(monkeypatch, _FakeResponse(status_code=200, body={"oops": True}))
    with pytest.raises(LLMError, match="missing content"):
        await p.run("hello")
