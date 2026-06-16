"""MiniMax provider — REST API only.

MiniMax is the only provider in the registry that is API-only (no CLI
transport available). Auth is a single ``sk-...`` API key minted at
https://platform.minimax.io/user-center/basic-information/interface-key
and stored in the same ``apiKeys`` slot as other providers under the
key ``minimax``.

Endpoint surface (per https://platform.minimax.io/docs/api-reference/text-post):

    POST {base_url}/v1/text/chatcompletion_v2
    Authorization: Bearer <key>
    Content-Type: application/json

Request body (OpenAI-compatible):

    {
      "model": "MiniMax-M3" | "MiniMax-M2.7" | "MiniMax-M2.7-highspeed" | ...,
      "messages": [
        {"role": "system", "content": "..."},
        {"role": "user",   "content": "..."}              # text-only
        # or for vision:
        {"role": "user", "content": [
            {"type": "text", "text": "..."},
            {"type": "image_url", "image_url": {"url": "data:image/...;base64,..."}}
        ]}
      ],
      "max_completion_tokens": 4096,
      "temperature": 1.0
    }

Response shape:

    {
      "id": "...",
      "choices": [{"message": {"role": "assistant", "content": "..."}, "finish_reason": "stop"}],
      "usage": {"prompt_tokens": N, "completion_tokens": M, "total_tokens": N+M},
      "base_resp": {"status_code": 0, "status_msg": ""}
    }

Error code reference:
    1001  Request timeout
    1002  Rate limited
    1004  Authentication failed
    1008  Insufficient balance
    1013  Internal server error
    1027  Invalid output content
    1039  Token limit exceeded
    2013  Invalid parameters

`base_resp.status_code != 0` is the canonical "soft error" signal — the HTTP
status is still 200 but the response is unusable. We treat it as a hard
LLMError.

Models:
    MiniMax-M3              multimodal (text + image), 450K ctx,  reasoning
    MiniMax-M2.7            text-only,                  200K ctx, reasoning
    MiniMax-M2.7-highspeed  text-only,                  200K ctx, reasoning (faster)

We pin a stable production model per capability:

    text    → MiniMax-M2.7-highspeed   (best latency, stable tier)
    vision  → MiniMax-M3               (only vision-capable model in M-series)

Override either via the `model` argument to `run()` if you need to pin a
specific model from a Settings UI later. (Today `run_llm` doesn't
expose a model override — the providers pick the right default per
capability, which matches what the other three providers do.)
"""
from __future__ import annotations

import base64
import logging
import os
import mimetypes
import time
from pathlib import Path
from typing import Optional

import httpx

from .base import LLMError
from . import secrets

# Input validation limits (inlined from the removed cli_utils — only
# these two helpers were still in use after the CLI providers were dropped).
MAX_PROMPT_BYTES = 100 * 1024  # 100 KB
MAX_ATTACHMENTS = 10


def validate_prompt_size(prompt: str, max_bytes: int = MAX_PROMPT_BYTES) -> None:
    """Validate prompt không vượt quá giới hạn kích thước. Raises ValueError."""
    if len(prompt.encode("utf-8")) > max_bytes:
        raise ValueError(
            f"Prompt exceeds {max_bytes // 1024}KB limit "
            f"({len(prompt.encode('utf-8'))} bytes)"
        )


def validate_attachment_paths(
    attachments, max_count: int = MAX_ATTACHMENTS,
) -> None:
    """Validate attachments tồn tại và đọc được. Raises ValueError."""
    if not attachments:
        return
    if len(attachments) > max_count:
        raise ValueError(f"Too many attachments (max {max_count}, got {len(attachments)})")
    for path in attachments:
        abs_path = os.path.abspath(path)
        if not os.path.isfile(abs_path):
            raise ValueError(f"Attachment not found: {path}")
        if not os.access(abs_path, os.R_OK):
            raise ValueError(f"Attachment not readable: {path}")

logger = logging.getLogger(__name__)


# API surface — overridable via FLOWBOARD_MINIMAX_BASE_URL for self-hosted
# or regional endpoints. Default points at the public global endpoint.
_DEFAULT_BASE_URL = "https://api.minimax.io"
_API_PATH = "/v1/text/chatcompletion_v2"

# Stable, production-tier defaults. M3 is the only M-series multimodal
# model, so vision is forced. M2.7-highspeed is the lowest-latency text
# model in the stable tier.
_DEFAULT_TEXT_MODEL = "MiniMax-M2.7-highspeed"
_DEFAULT_VISION_MODEL = "MiniMax-M3"

# Mirrors the OpenAI provider cap so a 20-MB reference image doesn't blow
# the request body budget on Flowboard's local proxy.
_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024

# Cache the `is_available()` key-presence probe for 60s — same TTL as
# OpenAI's API branch. The actual Test endpoint does a real ping.
_AVAILABILITY_TTL_S = 60.0

# Generous timeouts. MiniMax M-series reasoning can spike on the first
# call of a session; auto-prompt + vision both run up to 120s and we
# want headroom for the first token.
_DEFAULT_TIMEOUT = 120.0
_TEST_TIMEOUT = 120.0


class MiniMaxProvider:
    """Conforms to ``LLMProvider`` (structural typing).

    API-only transport. Auth is a single API key stored in
    ``~/.flowboard/secrets.json`` under ``apiKeys.minimax``. The Test
    endpoint sends a one-token ping to verify the key works AND the
    network path is open; ``is_available()`` only checks key presence
    (the Test endpoint is the real probe — same convention as the
    OpenAI API fallback path).
    """

    name: str = "minimax"
    supports_vision: bool = True  # M3 handles image inputs
    test_timeout_secs: float = _TEST_TIMEOUT

    def __init__(self) -> None:
        # API availability cache (mirrors the OpenAI API cache).
        self._api_cached_at: Optional[float] = None
        self._api_value: Optional[bool] = None

    def reset_cache(self) -> None:
        """Testing hook + Settings panel rescan support."""
        self._api_cached_at = None
        self._api_value = None

    # ── availability ─────────────────────────────────────────────────

    async def is_available(self) -> bool:
        """True when an API key is configured. We do NOT ping the API
        here — same reason as OpenAI: ``/v1/text/chatcompletion_v2``
        costs a real call, and the key presence alone is enough for the
        routing decision. The Test endpoint confirms by sending a real
        ping.
        """
        now = time.monotonic()
        if (
            self._api_value is not None
            and self._api_cached_at is not None
            and now - self._api_cached_at < _AVAILABILITY_TTL_S
        ):
            return self._api_value
        key = secrets.get_api_key("minimax")
        ok = bool(key)
        self._api_value = ok
        self._api_cached_at = now
        return ok

    @property
    def mode(self) -> str:
        """Reported by /api/llm/providers so the UI knows which row state
        to render. MiniMax is API-only, so this is always ``'api'`` when
        a key is configured, ``'none'`` otherwise. Values: 'api' / 'none'."""
        if self._api_value:
            return "api"
        # Probe-on-read so the property stays sync; callers that want
        # freshness should await is_available() first.
        return "api" if secrets.get_api_key("minimax") else "none"

    # ── public API ───────────────────────────────────────────────────

    async def run(
        self,
        user_prompt: str,
        *,
        system_prompt: Optional[str] = None,
        attachments: Optional[list[str]] = None,
        timeout: float = _DEFAULT_TIMEOUT,
        model: Optional[str] = None,
    ) -> str:
        return await self._run_api(
            user_prompt, system_prompt, attachments, timeout, model
        )

    async def _run_api(
        self,
        user_prompt: str,
        system_prompt: Optional[str],
        attachments: Optional[list[str]],
        timeout: float,
        model: Optional[str],
    ) -> str:
        key = secrets.get_api_key("minimax")
        if not key:
            raise LLMError("MiniMax API key not configured")

        # Validate inputs (matches the size / path guards the other
        # providers use so a 50-MB paste doesn't blow up differently per
        # provider).
        try:
            validate_prompt_size(user_prompt)
            if system_prompt:
                validate_prompt_size(system_prompt)
            validate_attachment_paths(attachments)
        except ValueError as exc:
            raise LLMError(f"Invalid input: {exc}") from exc

        chosen_model = model or (
            _DEFAULT_VISION_MODEL if attachments else _DEFAULT_TEXT_MODEL
        )

        messages: list[dict] = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})

        if attachments:
            # Multimodal content array — text first, then each image as
            # a data: URL block. MiniMax mirrors OpenAI's image_url shape
            # so the encoding is identical.
            content: list[dict] = [{"type": "text", "text": user_prompt}]
            for path in attachments:
                content.append(_image_url_block(path))
            messages.append({"role": "user", "content": content})
        else:
            messages.append({"role": "user", "content": user_prompt})

        payload: dict = {
            "model": chosen_model,
            "messages": messages,
            # M-series default is "always reasoning" — leaving this unset
            # burns tokens on a thinking block the user can't see for
            # short auto-prompt dispatches. The M-series accepts both
            # with-reasoning and without via stream_options / variants in
            # some configs, but the simple text-completion surface here
            # doesn't expose that knob; we just request the answer and
            # let the model reason. If users need to disable reasoning
            # they can configure a non-M-series model.
            "max_completion_tokens": 4096,
        }

        url = f"{_api_base_url()}{_API_PATH}"

        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(
                    url,
                    headers={
                        "authorization": f"Bearer {key}",
                        "content-type": "application/json",
                    },
                    json=payload,
                )
        except httpx.TimeoutException as exc:
            raise LLMError(
                f"minimax request timed out after {timeout}s"
            ) from exc
        except httpx.HTTPError as exc:
            raise LLMError(f"minimax transport error: {exc}") from exc

        if resp.status_code != 200:
            raise LLMError(
                f"minimax HTTP {resp.status_code}: {_safe_http_error(resp)}"
            )

        try:
            data = resp.json()
        except ValueError as exc:
            raise LLMError("minimax response was not JSON") from exc

        # MiniMax uses a soft-error envelope (base_resp.status_code) on
        # top of HTTP 200 — e.g. 1004 auth fail sometimes returns 200
        # with an error body. Check it before trusting the payload.
        base_resp = data.get("base_resp") or {}
        if isinstance(base_resp, dict) and base_resp.get("status_code"):
            code = base_resp.get("status_code")
            msg = base_resp.get("status_msg") or "(no message)"
            raise LLMError(f"minimax error {code}: {msg[:200]}")

        try:
            return data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise LLMError(
                f"minimax response missing content: {str(data)[:200]}"
            ) from exc


# ── helpers ───────────────────────────────────────────────────────────


def _api_base_url() -> str:
    """Resolve the base URL. Static import + env override hook so tests
    and self-hosted deployments can point at a regional endpoint without
    editing the module.

    Set ``FLOWBOARD_MINIMAX_BASE_URL`` to override; the default is the
    public global endpoint.
    """
    import os

    return os.environ.get("FLOWBOARD_MINIMAX_BASE_URL") or _DEFAULT_BASE_URL


def _image_url_block(path: str) -> dict:
    """Build an OpenAI-style ``image_url`` content block from a local file.

    Encodes to base64 ``data:<mime>;base64,...`` URL. MiniMax accepts both
    remote URLs and base64 data URLs in this slot — the local-proxy
    pattern of inlining via base64 is identical to the OpenAI provider
    and keeps us off any URL-fetching path.
    """
    p = Path(path)
    size = p.stat().st_size
    if size > _MAX_ATTACHMENT_BYTES:
        raise LLMError(
            f"attachment too large for minimax: "
            f"{size // (1024 * 1024)}MB > 5MB cap"
        )
    mime = mimetypes.guess_type(path)[0] or "image/jpeg"
    b64 = base64.b64encode(p.read_bytes()).decode("ascii")
    return {
        "type": "image_url",
        "image_url": {"url": f"data:{mime};base64,{b64}"},
    }


def _safe_http_error(resp: httpx.Response) -> str:
    """Extract a short, non-leaky error message from a non-200 response.

    Some error paths return a MiniMax envelope (``base_resp``), others
    return a plain HTTP problem detail (``detail`` / ``message``). Try
    the common shapes; fall back to a generic marker so we never echo
    the full body.
    """
    try:
        body = resp.json()
    except ValueError:
        return "(non-JSON body)"
    if isinstance(body, dict):
        # MiniMax soft-error envelope on non-200 (rare but seen on 5xx).
        base = body.get("base_resp") or {}
        if isinstance(base, dict):
            code = base.get("status_code")
            msg = base.get("status_msg")
            if msg:
                return f"{code}: {msg[:160]}" if code else msg[:200]
        # OpenAI-style error object
        err = body.get("error")
        if isinstance(err, dict):
            m = err.get("message")
            if isinstance(m, str):
                return m[:200]
        # FastAPI / generic problem detail
        m = body.get("message") or body.get("detail")
        if isinstance(m, str):
            return m[:200]
    return "(unrecognised body)"
