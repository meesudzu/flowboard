"""Provider registry + ``run_llm`` dispatch.

The single entry point used by ``prompt_synth``, ``vision``, ``planner``.
Looks up the configured provider for a feature, runs the capability gates
(vision attachment vs. text-only provider), then delegates to the
provider's ``run()``.

MiniMax-only build: MiniMax is the sole registered provider. Auth is a
single Bearer API key stored in ``~/.flowboard/secrets.json`` under
``apiKeys.minimax``. The earlier multi-provider design (Claude / Gemini /
OpenAI Codex CLI + OpenAI REST fallback) was removed for this build —
the cloud-VPS image doesn't bundle any of the CLI tools, and a single
API-key provider is enough to drive every Flowboard feature
(Auto-Prompt / Vision / Planner).
"""
from __future__ import annotations

import logging
from typing import Literal, Optional

from .base import LLMError, LLMProvider
from .minimax import MiniMaxProvider
from . import secrets

logger = logging.getLogger(__name__)


Feature = Literal["auto_prompt", "vision", "planner"]


# Module-level singleton. Provider keeps an availability cache (60s TTL)
# so re-instantiating per call would defeat the cache. Same lifetime as
# the agent process.
_PROVIDERS: dict[str, LLMProvider] = {
    "minimax": MiniMaxProvider(),
}


def get_provider(name: str) -> Optional[LLMProvider]:
    """Lookup by name. None if the name is unknown."""
    return _PROVIDERS.get(name)


def list_providers() -> list[LLMProvider]:
    """All registered providers, in deterministic order."""
    return list(_PROVIDERS.values())


async def run_llm(
    feature: Feature,
    user_prompt: str,
    *,
    system_prompt: Optional[str] = None,
    attachments: Optional[list[str]] = None,
    timeout: float = 90.0,
) -> str:
    """Feature-routed LLM dispatch (MiniMax-only).

    Resolution chain:
      1. Look up the configured provider for ``feature`` in
         ``~/.flowboard/secrets.json``. No defaults — if the user hasn't
         picked one yet, raise loud so the UI's forced-setup gate
         intercepts before the call lands.
      2. Vision capability gate — if ``attachments`` is non-empty and the
         provider declares ``supports_vision = False``, raise immediately
         (no model call). MiniMax M3 is vision-capable, so this gate is
         effectively a no-op in this build; kept for defense in depth
         and forward-compat if a future vision-disabled provider is added.
      3. Availability gate — if the MiniMax API key isn't configured, raise
         immediately so the caller doesn't eat the full HTTP timeout.
      4. Dispatch.
    """
    config = secrets.read_active_providers()
    provider_name = config.get(feature)
    if provider_name is None:
        raise LLMError(
            f"No AI provider configured for {feature}; "
            f"open the AI Provider settings to set one up."
        )
    provider = _PROVIDERS.get(provider_name)
    if provider is None:
        raise LLMError(
            f"Unknown provider {provider_name!r} configured for {feature}; "
            f"reconfigure in Settings → AI Providers."
        )

    if attachments and not provider.supports_vision:
        raise LLMError(
            f"{provider_name} doesn't support vision; "
            f"reconfigure Vision provider in Settings → AI Providers."
        )

    if not await provider.is_available():
        raise LLMError(
            f"{provider_name} is not configured (API key not set); "
            f"open Settings → AI Providers to paste your MiniMax key."
        )

    logger.info(
        "llm: provider=%s feature=%s attachments=%d",
        provider_name, feature, len(attachments) if attachments else 0,
    )
    return await provider.run(
        user_prompt,
        system_prompt=system_prompt,
        attachments=attachments,
        timeout=timeout,
    )
