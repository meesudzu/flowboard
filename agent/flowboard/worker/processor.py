"""In-process worker that drains queued generation requests.

Scope for Run 3 (Phase 2 bridge): a single handler type `"proxy"` that
forwards `params = {url, method?, headers?, body?}` through the extension
via ``flow_client.api_request``. Further types (gen_image, gen_video,
upload_image, etc.) land in later runs once the full Flow protocol + captcha
round-trip is ported.
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Optional

from flowboard.db import get_session
from flowboard.db.models import GenerationProduct, GenerationResult, Request
from flowboard.services import media as media_service
from flowboard.services.media import normalize_media_id
from flowboard.services.flow_client import flow_client
from flowboard.services.flow_sdk import get_flow_sdk

logger = logging.getLogger(__name__)


# type → coroutine(params) → (result_dict, error_or_None)
Handler = Callable[[dict], Awaitable[tuple[dict, Optional[str]]]]


_ALLOWED_URL_PREFIXES: tuple[str, ...] = (
    "https://aisandbox-pa.googleapis.com/",
)


async def _handle_proxy(params: dict) -> tuple[dict, Optional[str]]:
    url = params.get("url")
    method = params.get("method", "POST")
    if not isinstance(url, str) or not url:
        return {}, "missing_url"
    # Defense-in-depth: refuse to proxy URLs outside the expected allowlist
    # even if the extension's own check was somehow bypassed.
    if not any(url.startswith(p) for p in _ALLOWED_URL_PREFIXES):
        return {}, "url_not_allowed"
    resp = await flow_client.api_request(
        url=url,
        method=method,
        headers=params.get("headers") or {},
        body=params.get("body"),
    )
    if not isinstance(resp, dict):
        return {"value": resp}, None
    if resp.get("error"):
        return resp, str(resp["error"])[:200]
    status = resp.get("status")
    if isinstance(status, int) and status >= 400:
        return resp, f"API_{status}"
    return resp, None


async def _handle_create_project(params: dict) -> tuple[dict, Optional[str]]:
    name = params.get("name") or params.get("title") or "Untitled"
    if not isinstance(name, str) or not name.strip():
        return {}, "missing_name"
    tool = params.get("tool", "PINHOLE")
    resp = await get_flow_sdk().create_project(name.strip(), tool)
    if resp.get("error"):
        return resp, str(resp["error"])[:200]
    return resp, None


async def _handle_gen_image(params: dict) -> tuple[dict, Optional[str]]:
    from flowboard.services.flow_sdk import is_valid_project_id

    prompt = params.get("prompt")
    project_id = params.get("project_id")
    if not isinstance(prompt, str) or not prompt.strip():
        return {}, "missing_prompt"
    if not isinstance(project_id, str) or not project_id.strip():
        return {}, "missing_project_id"
    project_id = project_id.strip()
    if not is_valid_project_id(project_id):
        return {}, "invalid_project_id"
    aspect = params.get("aspect_ratio") or "IMAGE_ASPECT_RATIO_LANDSCAPE"
    # Tier resolution: caller-stamped value first (set at dispatch time),
    # then the live value from `flow_client` (resolved authoritatively
    # via /v1/credits on token capture). NO silent default — if both
    # are absent we fail loud with `paygate_tier_unknown`. The old
    # behaviour (default `PAYGATE_TIER_ONE`) silently downgraded Ultra
    # users to Pro and stamped the wrong tier into request.params, which
    # then fed back through `_last_observed_paygate_tier_from_db()` and
    # corrupted /api/auth/me responses for the rest of the session.
    tier = params.get("paygate_tier") or flow_client.paygate_tier
    if tier is None:
        return {}, "paygate_tier_unknown"
    # `ref_media_ids` is the broader name (any upstream image / character /
    # visual_asset feeds in as IMAGE_INPUT_TYPE_REFERENCE). Older callers used
    # `character_media_ids` — accept both.
    raw_ref_ids = params.get("ref_media_ids")
    if not isinstance(raw_ref_ids, list):
        raw_ref_ids = params.get("character_media_ids")
    ref_media_ids: Optional[list[str]] = None
    if isinstance(raw_ref_ids, list):
        cleaned = [m for m in raw_ref_ids if isinstance(m, str) and m]
        ref_media_ids = cleaned or None
    raw_count = params.get("variant_count")
    variant_count = 1
    if isinstance(raw_count, int) and raw_count > 0:
        variant_count = raw_count
    # Per-variant prompts (optional). When provided, each variant gets its
    # own text — used by auto-prompt batch mode so variants don't collapse
    # to the same stance.
    raw_prompts = params.get("prompts")
    per_variant_prompts: Optional[list[str]] = None
    if isinstance(raw_prompts, list):
        cleaned = [p for p in raw_prompts if isinstance(p, str) and p.strip()]
        per_variant_prompts = cleaned or None
    image_model = params.get("image_model")
    if not isinstance(image_model, str) or not image_model.strip():
        image_model = None
    resp = await get_flow_sdk().gen_image(
        prompt=prompt.strip(),
        project_id=project_id,
        aspect_ratio=aspect,
        paygate_tier=tier,
        ref_media_ids=ref_media_ids,
        variant_count=variant_count,
        prompts=per_variant_prompts,
        image_model=image_model,
    )
    if resp.get("error"):
        return resp, str(resp["error"])[:200]
    # Flow returns signed fifeUrls directly in the response — persist them
    # immediately so `/media/:id` can serve bytes without any extra round-trip.
    entries_with_urls = [
        e for e in (resp.get("media_entries") or []) if isinstance(e, dict) and e.get("url")
    ]
    if entries_with_urls:
        try:
            media_service.ingest_urls(entries_with_urls)
        except Exception:  # noqa: BLE001
            logger.exception("auto-ingest from gen_image response failed")
    return resp, None


# Video polling knobs — overridable in tests. 5-minute hard deadline
# (30 cycles × 10s). When the budget runs out without all ops finishing
# the handler returns the ``timeout_waiting_video`` sentinel and the
# worker stamps the row as ``status='timeout'`` (distinct from
# ``failed``) so the UI can render it as a soft auto-cancel rather than
# a generation error.
VIDEO_POLL_INTERVAL_S = 10.0
VIDEO_POLL_MAX_CYCLES = 30


def _is_request_canceled(rid: Optional[int]) -> bool:
    """Return True iff the cancel endpoint flipped this row to canceled.

    Long-running handlers call this between polls so a user-initiated
    cancel takes effect mid-flight (we can't abort the Flow HTTP calls
    themselves, but we can stop polling and let _process_one keep the
    canceled status intact).
    """
    if not isinstance(rid, int):
        return False
    with get_session() as s:
        req = s.get(Request, rid)
        if req is None:
            return True
        return req.status == "canceled"


async def _handle_gen_video(params: dict) -> tuple[dict, Optional[str]]:
    from flowboard.services.flow_sdk import is_valid_project_id

    prompt = params.get("prompt")
    project_id = params.get("project_id")
    start_media_id = params.get("start_media_id") or params.get("startMediaId")
    raw_starts = params.get("start_media_ids")
    start_media_ids: Optional[list[str]] = None
    if isinstance(raw_starts, list):
        cleaned = [m for m in raw_starts if isinstance(m, str) and m.strip()]
        start_media_ids = [m.strip() for m in cleaned] or None

    if not isinstance(prompt, str) or not prompt.strip():
        return {}, "missing_prompt"
    if not isinstance(project_id, str) or not project_id.strip():
        return {}, "missing_project_id"
    project_id = project_id.strip()
    if not is_valid_project_id(project_id):
        return {}, "invalid_project_id"
    # Either a single start_media_id OR a non-empty start_media_ids list.
    if start_media_ids is None and (
        not isinstance(start_media_id, str) or not start_media_id.strip()
    ):
        return {}, "missing_start_media_id"
    aspect = params.get("aspect_ratio") or "VIDEO_ASPECT_RATIO_LANDSCAPE"
    # Tier resolution — see the matching block in _handle_gen_image for
    # the rationale. No silent default; missing tier is a hard error so
    # we never dispatch an Ultra user's video at the Pro checkpoint.
    tier = params.get("paygate_tier") or flow_client.paygate_tier
    if tier is None:
        return {}, "paygate_tier_unknown"
    video_quality = params.get("video_quality")
    if not isinstance(video_quality, str) or not video_quality.strip():
        video_quality = None

    sdk = get_flow_sdk()
    dispatch = await sdk.gen_video(
        prompt=prompt.strip(),
        project_id=project_id,
        start_media_id=start_media_id.strip()
        if isinstance(start_media_id, str) and start_media_id.strip()
        else None,
        start_media_ids=start_media_ids,
        aspect_ratio=aspect,
        paygate_tier=tier,
        video_quality=video_quality,
    )
    if dispatch.get("error"):
        return dispatch, str(dispatch["error"])[:200]

    op_names = dispatch.get("operation_names") or []
    if not op_names:
        return dispatch, "no_operations_returned"
    # NEW low-priority models return workflows (`{name, primary_media_id}`)
    # instead of operations; the SDK surfaces them on `dispatch["workflows"]`
    # so we can route the poll to /v1/media/<id> instead of batchCheckAsync.
    workflows = dispatch.get("workflows") or None

    poll_attempts = 0
    last_poll: dict = {}
    done_by_name: dict[str, bool] = {name: False for name in op_names}
    entry_by_name: dict[str, dict] = {}
    op_errors: dict[str, str] = {}
    rid = params.get("__request_id")
    # Per-op, per-error-code consecutive count for "soft" errors. A soft
    # error is one the SDK returns with `done: False` — currently only
    # the workflow-mode 404 ("media not found") falls in this bucket.
    # Transient 404s (Flow briefly 404-ing the media endpoint mid-render)
    # only last 1-2 polls so the counter resets on the next 200 OK.
    # Persistent 404s (prompt blocked at the safety stage — media was
    # never created) hit 3+ in a row within ~30s, so we promote them to
    # a hard terminal error instead of waiting the full 5-minute timeout.
    soft_error_streak: dict[str, dict[str, int]] = {}
    SOFT_ERROR_PROMOTE_THRESHOLD = 3

    # Per-op resolution: each operation in the batch resolves
    # independently (success, content-filter rejection, or timeout). We
    # used to break the whole loop on the first per-op error, which
    # collapsed a 4-variant gen into a hard failure even when 3/4 clips
    # had already rendered. Now we let every op terminate on its own
    # and aggregate the outcome at the end so partial batches still
    # surface the variants that did succeed.
    while (
        poll_attempts < VIDEO_POLL_MAX_CYCLES
        and not all(done_by_name.values())
    ):
        await asyncio.sleep(VIDEO_POLL_INTERVAL_S)
        poll_attempts += 1
        if _is_request_canceled(rid):
            # User canceled mid-poll. Bail with the special error code
            # so _process_one knows to leave the row's canceled status
            # intact (the cancel endpoint already stamped finished_at +
            # error='canceled'). Any partial state we collected is
            # preserved on `result` for the detail viewer.
            return (
                {
                    "raw_dispatch": dispatch,
                    "last_poll": last_poll,
                    "operation_names": op_names,
                    "done": done_by_name,
                    "canceled": True,
                },
                "canceled",
            )
        last_poll = await sdk.check_async(op_names, workflows=workflows)
        if last_poll.get("error"):
            continue
        for op in last_poll.get("operations") or []:
            if not isinstance(op, dict):
                continue
            name = op.get("name")
            if not isinstance(name, str) or done_by_name.get(name, False):
                continue
            # Per-op terminal failure (e.g. content filter
            # PUBLIC_ERROR_UNSAFE_GENERATION / PUBLIC_ERROR_AUDIO_FILTERED).
            # Mark this op resolved-with-error and keep polling the rest.
            err = op.get("error")
            is_done = bool(op.get("done"))
            if isinstance(err, str) and err and is_done:
                # Hard terminal: SDK set both error and done=True (e.g.
                # 4xx non-404 from the workflow poll endpoint, or a
                # MEDIA_GENERATION_STATUS_FAILED on the OLD schema).
                done_by_name[name] = True
                op_errors[name] = err
                continue
            if isinstance(err, str) and err and not is_done:
                # Soft error: SDK surfaced an error hint but the op is
                # still "not done" — currently only workflow-mode 404
                # (media not found, likely a content filter that
                # rejected the dispatch). Track the streak per error
                # code; if the same code repeats SOFT_ERROR_PROMOTE_THRESHOLD
                # times in a row, promote it to a hard terminal so we
                # don't wait the full 5-minute timeout.
                streak = soft_error_streak.setdefault(name, {})
                # Reset other error codes for this op — only an identical
                # streak is suspicious. A different transient error
                # shouldn't carry over the previous count.
                for k in list(streak.keys()):
                    if k != err:
                        streak.pop(k, None)
                streak[err] = streak.get(err, 0) + 1
                if streak[err] >= SOFT_ERROR_PROMOTE_THRESHOLD:
                    logger.warning(
                        "op %s: %d consecutive '%s' soft errors — promoting to terminal "
                        "(likely a persistent content filter on the workflow)",
                        name[:8], streak[err], err,
                    )
                    done_by_name[name] = True
                    op_errors[name] = err
                continue
            if is_done:
                # Clear any soft-error streak for this op on a clean
                # success — protects against a stray 404 right before
                # the encodedVideo payload lands.
                soft_error_streak.pop(name, None)
                done_by_name[name] = True
                # Each op is expected to yield exactly one media entry
                # on success; capture the first valid one.
                for e in op.get("media_entries") or []:
                    if isinstance(e, dict) and e.get("media_id"):
                        entry_by_name[name] = e
                        break

    # Slots still unresolved after the max cycles — record as timeout
    # so the partial summary names them alongside any filter failures.
    for name in op_names:
        if not done_by_name.get(name) and name not in op_errors:
            op_errors[name] = "timeout_waiting_video"

    # Build positional outcome aligned to dispatch order. Slot i in
    # `media_ids` corresponds to slot i in the original
    # `start_media_ids` array, so the frontend can keep upstream-image
    # variant ↔ video-variant alignment even when middle slots fail.
    # `slot_errors` mirrors the same indexing — `None` for succeeded
    # slots, error code for blocked ones — so the detail viewer can
    # render the exact filter reason on the blocked tile without
    # having to know the internal Flow op-name keys.
    positional_ids: list[Optional[str]] = []
    slot_errors: list[Optional[str]] = []
    succeeded_entries: list[dict] = []
    for name in op_names:
        e = entry_by_name.get(name)
        if isinstance(e, dict) and isinstance(e.get("media_id"), str):
            positional_ids.append(e["media_id"])
            succeeded_entries.append(e)
            slot_errors.append(None)
        else:
            positional_ids.append(None)
            slot_errors.append(op_errors.get(name))

    success_count = sum(1 for x in positional_ids if x)
    total = len(op_names)

    if success_count == 0:
        # No op produced a clip — surface the first error verbatim.
        # When all errors are "timeout_waiting_video" this matches the
        # legacy single-op timeout contract; tests rely on it.
        first_err = next(iter(op_errors.values()), "timeout_waiting_video")
        return (
            {
                "raw_dispatch": dispatch,
                "last_poll": last_poll,
                "operation_names": op_names,
                "done": done_by_name,
                "op_errors": op_errors,
            },
            first_err,
        )

    # ≥1 op succeeded — ingest only the bytes we actually have.
    entries_with_urls = [
        e for e in succeeded_entries if isinstance(e, dict) and e.get("url")
    ]
    if entries_with_urls:
        try:
            media_service.ingest_urls(entries_with_urls)
        except Exception:  # noqa: BLE001
            logger.exception("auto-ingest from gen_video response failed")
    # Workflow-mode (Low Priority) deliveries arrive inline as base64 MP4
    # bytes on the `/v1/media/<id>` poll — there is no GCS URL to chase.
    # Plant the bytes in the local cache directly so the `/media/<id>` route
    # serves them like any URL-backed asset.
    for entry in succeeded_entries:
        if not isinstance(entry, dict):
            continue
        encoded = entry.get("encoded_video")
        mid = entry.get("media_id")
        if not isinstance(encoded, str) or not isinstance(mid, str):
            continue
        try:
            import base64 as _b64
            media_service.ingest_inline_bytes(
                mid, _b64.b64decode(encoded, validate=False),
                kind="video", mime="video/mp4",
            )
        except Exception:  # noqa: BLE001
            logger.exception("inline ingest from workflow-mode poll failed for %s", mid)

    partial_error: Optional[str] = None
    if op_errors:
        # De-dup distinct error codes for a compact one-line summary
        # (e.g. "1/4 variants blocked: PUBLIC_ERROR_UNSAFE_GENERATION").
        unique_errs = sorted({err for err in op_errors.values()})
        partial_error = (
            f"{len(op_errors)}/{total} variants blocked: {', '.join(unique_errs)}"
        )

    return (
        {
            "raw_dispatch": dispatch,
            "last_poll": last_poll,
            "operation_names": op_names,
            "media_ids": positional_ids,
            "media_entries": succeeded_entries,
            "op_errors": op_errors,
            "slot_errors": slot_errors,
            "partial_error": partial_error,
        },
        None,
    )


async def _handle_edit_image(params: dict) -> tuple[dict, Optional[str]]:
    from flowboard.services.flow_sdk import is_valid_project_id

    prompt = params.get("prompt")
    project_id = params.get("project_id")
    source_media_id = params.get("source_media_id") or params.get("sourceMediaId")
    if not isinstance(prompt, str) or not prompt.strip():
        return {}, "missing_prompt"
    if not isinstance(project_id, str) or not project_id.strip():
        return {}, "missing_project_id"
    project_id = project_id.strip()
    if not is_valid_project_id(project_id):
        return {}, "invalid_project_id"
    if not isinstance(source_media_id, str) or not source_media_id.strip():
        return {}, "missing_source_media_id"
    aspect = params.get("aspect_ratio") or "IMAGE_ASPECT_RATIO_LANDSCAPE"
    # Tier resolution — see _handle_gen_image for rationale. Fail loud,
    # no silent fallback to Pro.
    tier = params.get("paygate_tier") or flow_client.paygate_tier
    if tier is None:
        return {}, "paygate_tier_unknown"
    raw_refs = params.get("ref_media_ids")
    ref_ids: Optional[list[str]] = None
    if isinstance(raw_refs, list):
        cleaned = [m for m in raw_refs if isinstance(m, str) and m]
        ref_ids = cleaned or None
    image_model = params.get("image_model")
    if not isinstance(image_model, str) or not image_model.strip():
        image_model = None

    resp = await get_flow_sdk().edit_image(
        prompt=prompt.strip(),
        project_id=project_id,
        source_media_id=source_media_id.strip(),
        ref_media_ids=ref_ids,
        aspect_ratio=aspect,
        paygate_tier=tier,
        image_model=image_model,
    )
    if resp.get("error"):
        return resp, str(resp["error"])[:200]
    entries_with_urls = [
        e for e in (resp.get("media_entries") or []) if isinstance(e, dict) and e.get("url")
    ]
    if entries_with_urls:
        try:
            media_service.ingest_urls(entries_with_urls)
        except Exception:  # noqa: BLE001
            logger.exception("auto-ingest from edit_image response failed")
    return resp, None



# ── Omni Flash r2v ────────────────────────────────────────────────────────
# Variable-duration video model with a distinct endpoint + body shape from
# Veo i2v. See agent/flowboard/services/flow_sdk.py::gen_video_omni for the
# request assembly. Single operation per request (no multi-source batching
# like Veo's start_media_ids), so the polling logic collapses to a single
# op + first-error-wins, simpler than _handle_gen_video.

async def _handle_gen_video_omni(params: dict) -> tuple[dict, Optional[str]]:
    from flowboard.services.flow_sdk import is_valid_project_id
    from flowboard.services.media_project_sync import (
        MediaSyncError,
        ensure_media_ids_in_project,
    )

    prompt = params.get("prompt")
    project_id = params.get("project_id")
    raw_refs = params.get("ref_media_ids")
    if not isinstance(raw_refs, list):
        # Also accept the legacy single-source field for symmetry with
        # Veo's start_media_id, so the same upstream-walk on the frontend
        # works without a special-case.
        raw_refs = (
            [params.get("start_media_id")]
            if isinstance(params.get("start_media_id"), str)
            else []
        )
    ref_media_ids = [m for m in raw_refs if isinstance(m, str) and m.strip()]
    duration_s = params.get("duration_s")

    if not isinstance(prompt, str) or not prompt.strip():
        return {}, "missing_prompt"
    if not isinstance(project_id, str) or not project_id.strip():
        return {}, "missing_project_id"
    project_id = project_id.strip()
    if not is_valid_project_id(project_id):
        return {}, "invalid_project_id"
    if not ref_media_ids:
        return {}, "missing_ref_media_ids"
    if not isinstance(duration_s, int) or duration_s not in (4, 6, 8, 10):
        return {}, "invalid_duration_s"
    aspect = params.get("aspect_ratio") or "VIDEO_ASPECT_RATIO_PORTRAIT"
    tier = params.get("paygate_tier") or flow_client.paygate_tier
    if tier is None:
        return {}, "paygate_tier_unknown"

    # ── Cross-project ref sync ────────────────────────────────────────
    # Flow scopes mediaIds to the project they were uploaded in. When
    # the user references media generated under another board's project
    # (the cross-board Reference library case), Flow returns 404 because
    # the asset is unknown in this project. Re-upload bytes from the
    # local cache and substitute the project-local id before dispatch.
    # First sync hits the Flow upload endpoint per ref; subsequent
    # syncs use the MediaProjectMapping cache and are free.
    try:
        synced_refs, sync_failures = await ensure_media_ids_in_project(
            ref_media_ids, project_id
        )
    except MediaSyncError as exc:
        return {}, f"sync_failed: {exc}"[:200]
    if not synced_refs:
        # Every ref failed to sync — surface the first reason.
        first = sync_failures[0][1] if sync_failures else "no_refs_synced"
        return (
            {"sync_failures": sync_failures},
            f"sync_failed: {first}"[:200],
        )
    if sync_failures:
        # Partial sync — log; proceed with the refs that worked.
        logger.warning(
            "gen_video_omni: %d ref(s) failed to sync, proceeding with %d",
            len(sync_failures), len(synced_refs),
        )

    sdk = get_flow_sdk()
    dispatch = await sdk.gen_video_omni(
        prompt=prompt.strip(),
        project_id=project_id,
        ref_media_ids=synced_refs,
        duration_s=duration_s,
        aspect_ratio=aspect,
        paygate_tier=tier,
    )
    if dispatch.get("error"):
        return dispatch, str(dispatch["error"])[:200]

    op_names = dispatch.get("operation_names") or []
    if not op_names:
        return dispatch, "no_operations_returned"
    workflows = dispatch.get("workflows") or None

    poll_attempts = 0
    last_poll: dict = {}
    done_by_name: dict[str, bool] = {name: False for name in op_names}
    entry_by_name: dict[str, dict] = {}
    op_errors: dict[str, str] = {}
    rid = params.get("__request_id")
    # Per-op, per-error-code consecutive count for soft errors (see the
    # matching block in _handle_gen_video for the full rationale). Omni
    # Flash also polls /v1/media/<id>, so it hits the same workflow-mode
    # 404 ("media not found, likely a content filter") case.
    soft_error_streak: dict[str, dict[str, int]] = {}
    SOFT_ERROR_PROMOTE_THRESHOLD = 3

    while (
        poll_attempts < VIDEO_POLL_MAX_CYCLES
        and not all(done_by_name.values())
    ):
        await asyncio.sleep(VIDEO_POLL_INTERVAL_S)
        poll_attempts += 1
        if _is_request_canceled(rid):
            return (
                {
                    "raw_dispatch": dispatch,
                    "last_poll": last_poll,
                    "operation_names": op_names,
                    "done": done_by_name,
                    "canceled": True,
                },
                "canceled",
            )
        last_poll = await sdk.check_async(op_names, workflows=workflows)
        if last_poll.get("error"):
            continue
        for op in last_poll.get("operations") or []:
            if not isinstance(op, dict):
                continue
            name = op.get("name")
            if not isinstance(name, str) or done_by_name.get(name, False):
                continue
            err = op.get("error")
            is_done = bool(op.get("done"))
            if isinstance(err, str) and err and is_done:
                done_by_name[name] = True
                op_errors[name] = err
                continue
            if isinstance(err, str) and err and not is_done:
                # Soft error streak — see _handle_gen_video for the
                # full rationale. 3+ identical soft errors in a row
                # means the dispatch was rejected (likely a content
                # filter) and polling further is pointless.
                streak = soft_error_streak.setdefault(name, {})
                for k in list(streak.keys()):
                    if k != err:
                        streak.pop(k, None)
                streak[err] = streak.get(err, 0) + 1
                if streak[err] >= SOFT_ERROR_PROMOTE_THRESHOLD:
                    logger.warning(
                        "omni op %s: %d consecutive '%s' soft errors — promoting to terminal",
                        name[:8], streak[err], err,
                    )
                    done_by_name[name] = True
                    op_errors[name] = err
                continue
            if is_done:
                soft_error_streak.pop(name, None)
                done_by_name[name] = True
                for e in op.get("media_entries") or []:
                    if isinstance(e, dict) and e.get("media_id"):
                        entry_by_name[name] = e
                        break

    for name in op_names:
        if not done_by_name.get(name) and name not in op_errors:
            op_errors[name] = "timeout_waiting_video"

    positional_ids: list[Optional[str]] = []
    slot_errors: list[Optional[str]] = []
    succeeded_entries: list[dict] = []
    for name in op_names:
        e = entry_by_name.get(name)
        if isinstance(e, dict) and isinstance(e.get("media_id"), str):
            positional_ids.append(e["media_id"])
            succeeded_entries.append(e)
            slot_errors.append(None)
        else:
            positional_ids.append(None)
            slot_errors.append(op_errors.get(name))

    if not any(positional_ids):
        first_err = next(iter(op_errors.values()), "timeout_waiting_video")
        return (
            {
                "raw_dispatch": dispatch,
                "last_poll": last_poll,
                "operation_names": op_names,
                "done": done_by_name,
                "op_errors": op_errors,
            },
            first_err,
        )

    entries_with_urls = [
        e for e in succeeded_entries if isinstance(e, dict) and e.get("url")
    ]
    if entries_with_urls:
        try:
            media_service.ingest_urls(entries_with_urls)
        except Exception:  # noqa: BLE001
            logger.exception("auto-ingest from gen_video_omni response failed")
    # Omni Flash uses workflow-mode polling: Flow delivers the rendered MP4
    # inline as base64 on `/v1/media/<id>` with no signed GCS URL. Plant the
    # bytes in the local cache so `/media/<id>` can serve them.
    for entry in succeeded_entries:
        if not isinstance(entry, dict):
            continue
        encoded = entry.get("encoded_video")
        mid = entry.get("media_id")
        if not isinstance(encoded, str) or not isinstance(mid, str):
            continue
        try:
            import base64 as _b64
            media_service.ingest_inline_bytes(
                mid, _b64.b64decode(encoded, validate=False),
                kind="video", mime="video/mp4",
            )
        except Exception:  # noqa: BLE001
            logger.exception("inline ingest from omni workflow poll failed for %s", mid)

    return (
        {
            "raw_dispatch": dispatch,
            "last_poll": last_poll,
            "operation_names": op_names,
            "media_ids": positional_ids,
            "media_entries": succeeded_entries,
            "op_errors": op_errors,
            "slot_errors": slot_errors,
            "duration_s": duration_s,
        },
        None,
    )


async def _handle_gen_image_product(params: dict) -> tuple[dict, Optional[str]]:
    """Generate-mode per-product dispatch.

    Workflow:
      1. Validate params (project_id, model_media_id, product_media_id,
         result_id, prompt) -- fail loud if any are missing rather than
         letting ``gen_image`` later fail with a confusing 4xx that hides
         the real cause.
      2. Call ``gen_image`` with the model image as the FIRST reference
         (so diffusion weights it as the identity anchor) and the
         product image as the SECOND reference. ``variant_count=1``
         because each product gets exactly one output -- the gallery
         grid is N products wide, not N variants of one product.
      3. Persist the output media_id on the GenerationResult row,
         stamp the row ``done``, and ingest the URL via the existing
         media_service cache so /media/<id> can serve bytes.
      4. Auto-save the output as a Reference with kind="image" so the
         user can drag-and-drop it into any later canvas board (best-
         effort; failures here don't fail the request).

    The flow SDK is the source of truth on tier resolution -- we forward
    ``paygate_tier`` the same way ``_handle_gen_image`` does, refusing to
    dispatch when neither the worker (extension) nor params have one.
    """
    from flowboard.services.flow_sdk import is_valid_project_id

    board_id = params.get("board_id")
    product_id = params.get("product_id")
    result_id = params.get("result_id")
    model_media_id = params.get("model_media_id")
    product_media_id = params.get("product_media_id")
    prompt = params.get("prompt")
    project_id = params.get("project_id")
    aspect_ratio = params.get("aspect_ratio") or "IMAGE_ASPECT_RATIO_LANDSCAPE"
    image_model = params.get("image_model")

    if not (isinstance(board_id, int) and isinstance(product_id, int) and isinstance(result_id, int)):
        return {}, "missing_board_or_product_or_result_id"
    if not (isinstance(model_media_id, str) and model_media_id):
        return {}, "missing_model_media_id"
    if not (isinstance(product_media_id, str) and product_media_id):
        return {}, "missing_product_media_id"
    if not (isinstance(prompt, str) and prompt.strip()):
        return {}, "missing_prompt"
    if not (isinstance(project_id, str) and project_id.strip()):
        return {}, "missing_project_id"
    project_id = project_id.strip()
    if not is_valid_project_id(project_id):
        return {}, "invalid_project_id"

    # Tier resolution: caller-stamped first, then the live value from
    # ``flow_client``. NO silent default -- see gen_image's matching
    # block for the rationale. Earlier code defaulted silently and
    # corrupted /api/auth/me responses for the rest of the session.
    tier = params.get("paygate_tier") or flow_client.paygate_tier
    if tier is None:
        return {}, "paygate_tier_unknown"

    # Mark the GenerationResult row as "running" BEFORE we dispatch so
    # the gallery's latest-result-per-product query reflects it
    # immediately.
    with get_session() as s:
        gr = s.get(GenerationResult, result_id)
        if gr is None:
            return {}, "result_row_missing"
        gr.status = "running"
        s.add(gr)
        s.commit()

    sdk = get_flow_sdk()
    resp = await sdk.gen_image(
        prompt=prompt.strip(),
        project_id=project_id,
        aspect_ratio=aspect_ratio,
        paygate_tier=tier,
        ref_media_ids=[model_media_id, product_media_id],
        variant_count=1,
        image_model=image_model if isinstance(image_model, str) and image_model.strip() else None,
    )
    if resp.get("error"):
        # Persist the error on the GenerationResult row too so the
        # gallery can render the reason verbatim without re-deriving
        # it from the Request row (the Request row's error is what
        # ``_process_one`` stamps; both stay consistent).
        with get_session() as s:
            gr_err = s.get(GenerationResult, result_id)
            if gr_err is not None:
                gr_err.status = "failed"
                gr_err.error = str(resp["error"])[:500]
                gr_err.finished_at = datetime.now(timezone.utc)
                s.add(gr_err)
                s.commit()
        return resp, str(resp["error"])[:200]

    raw_media_ids = resp.get("media_ids") or []
    # Normalize the candidate media id before validating: Flow has
    # historically wrapped ids as "media/<uuid>" (with a slash), which
    # the validator (^[0-9a-fA-F-]{1,64}$) rejects. Stripping the
    # prefix handles that variant without changing the UUID-only case.
    normalized_first = (
        normalize_media_id(raw_media_ids[0])
        if raw_media_ids and isinstance(raw_media_ids[0], str)
        else None
    )
    if not raw_media_ids or not normalized_first or not media_service.is_valid_media_id(normalized_first):
        # Stamp the GenerationResult row "failed" here too -- without
        # this, the row stays in "running" and the UI shows "Đang tạo"
        # forever even though the Request row stamped "failed".
        reason = "no_media_ids_returned" if not raw_media_ids else "invalid_output_media_id"
        with get_session() as s:
            gr_err = s.get(GenerationResult, result_id)
            if gr_err is not None:
                gr_err.status = "failed"
                gr_err.error = reason
                gr_err.finished_at = datetime.now(timezone.utc)
                s.add(gr_err)
                s.commit()
        return resp, reason

    output_media_id = normalized_first

    # Ingest the Flow CDN URL into the local cache + Asset table so
    # /media/<id> can serve bytes. Same machinery gen_image uses.
    entries_with_urls = [
        e for e in (resp.get("media_entries") or []) if isinstance(e, dict) and e.get("url")
    ]
    if entries_with_urls:
        try:
            media_service.ingest_urls(entries_with_urls)
        except Exception:  # noqa: BLE001
            logger.exception(
                "auto-ingest from gen_image_product failed (result=%s)", result_id,
            )

    # Persist + auto-save as Reference. Both in their own sessions so
    # we don't hold the SQLite connection during the (potentially
    # long-running) ingest.
    product_label = ""
    with get_session() as s:
        gr_done = s.get(GenerationResult, result_id)
        prod_row = s.get(GenerationProduct, product_id)
        product_label = prod_row.label if prod_row is not None else ""
        gr_done.output_media_id = output_media_id
        gr_done.status = "done"
        gr_done.error = None
        gr_done.finished_at = datetime.now(timezone.utc)
        s.add(gr_done)
        s.commit()
        # Best-effort Reference save -- the helper swallows errors and
        # logs; do NOT let it fail the request.
        from flowboard.routes.generation_mode import save_result_as_reference
        save_result_as_reference(
            s,
            board_id=board_id,
            product_id=product_id,
            output_media_id=output_media_id,
            label=product_label,
        )

    return (
        {
            "media_ids": [output_media_id],
            "media_entries": resp.get("media_entries") or [],
            "product_id": product_id,
            "result_id": result_id,
        },
        None,
    )


async def _handle_gen_image_product_batch(params: dict) -> tuple[dict, Optional[str]]:
    """Generate-mode BATCH dispatch.

    Batches up to ``MAX_VARIANT_COUNT`` (4) products into a single
    ``gen_image`` call, each variant conditioned on its own product
    reference (model + products[i]). One Request row covers N product
    rows in ``GenerationResult`` -- partial failures are tracked per
    slot so the remaining rows still complete.

    Worker params (same envelope as ``_handle_gen_image_product`` plus
    a per-product list):

      - board_id: int
      - model_media_id: str
      - prompts: list[str]      # length == N
      - project_id: str
      - aspect_ratio: str
      - image_model: Optional[str]
      - items: list[{product_id, product_media_id, result_id}]

    Return value mirrors ``gen_image`` shape plus a ``succeeded`` list
    so the route can map each variant back to its GenerationResult row.
    """
    from flowboard.services.flow_sdk import MAX_VARIANT_COUNT, is_valid_project_id

    board_id = params.get("board_id")
    model_media_id = params.get("model_media_id")
    project_id = params.get("project_id")
    aspect_ratio = params.get("aspect_ratio") or "IMAGE_ASPECT_RATIO_LANDSCAPE"
    image_model = params.get("image_model")
    prompts = params.get("prompts")
    items = params.get("items")

    if not isinstance(board_id, int):
        return {}, "missing_board_id"
    if not (isinstance(model_media_id, str) and model_media_id):
        return {}, "missing_model_media_id"
    if not (isinstance(project_id, str) and project_id.strip()):
        return {}, "missing_project_id"
    if not is_valid_project_id(project_id):
        return {}, "invalid_project_id"
    if not isinstance(items, list) or not items:
        return {}, "missing_items"
    if not isinstance(prompts, list) or len(prompts) != len(items):
        return {}, "prompts_length_mismatch"
    # Refuse oversize batches -- caller must chunk before enqueuing.
    if len(items) > MAX_VARIANT_COUNT:
        return {}, f"batch_too_large:{len(items)}>MAX_VARIANT_COUNT"

    # Tier resolution: caller-stamped first, then the live value.
    tier = params.get("paygate_tier") or flow_client.paygate_tier
    if tier is None:
        return {}, "paygate_tier_unknown"

    # Mark all GenerationResult rows in the batch as "running" so the
    # gallery UI flips to in-flight state for the whole batch atomically.
    result_ids = [it["result_id"] for it in items if isinstance(it.get("result_id"), int)]
    with get_session() as s:
        for rid in result_ids:
            gr = s.get(GenerationResult, rid)
            if gr is not None:
                gr.status = "running"
                s.add(gr)
        s.commit()

    # Per-variant refs: entry i = [model_media_id, items[i]["product_media_id"]].
    refs_per_variant: list[list[str]] = []
    for it in items:
        if not (isinstance(it.get("product_media_id"), str) and it["product_media_id"]):
            return {}, "missing_product_media_id"
        refs_per_variant.append([model_media_id, it["product_media_id"]])

    sdk = get_flow_sdk()
    resp = await sdk.gen_image(
        prompt=prompts[0] if prompts else "",
        project_id=project_id,
        aspect_ratio=aspect_ratio,
        paygate_tier=tier,
        variant_count=len(items),
        prompts=prompts,
        ref_media_ids_per_variant=refs_per_variant,
        image_model=image_model if isinstance(image_model, str) and image_model.strip() else None,
    )

    if resp.get("error"):
        err_str = str(resp["error"])[:500]
        with get_session() as s:
            for rid in result_ids:
                gr = s.get(GenerationResult, rid)
                if gr is not None:
                    gr.status = "failed"
                    gr.error = err_str
                    gr.finished_at = datetime.now(timezone.utc)
                    s.add(gr)
            s.commit()
        return resp, err_str[:200]

    # Persist outputs aligned to the request positions. ``media_ids`` and
    # ``media_entries`` from the SDK are positional in variant order.
    media_ids = resp.get("media_ids") or []
    media_entries = resp.get("media_entries") or []

    # Ingest URLs in one shot so /media/<id> can serve bytes.
    entries_with_urls = [
        e for e in media_entries if isinstance(e, dict) and e.get("url")
    ]
    if entries_with_urls:
        try:
            media_service.ingest_urls(entries_with_urls)
        except Exception:  # noqa: BLE001
            logger.exception("auto-ingest from gen_image_product_batch failed (board=%s)", board_id)

    succeeded_payload: list[dict[str, Any]] = []
    with get_session() as s:
        for idx, it in enumerate(items):
            rid = it["result_id"]
            product_id = it["product_id"]
            mid = media_ids[idx] if idx < len(media_ids) else None
            gr = s.get(GenerationResult, rid)
            prod_row = s.get(GenerationProduct, product_id)
            product_label = prod_row.label if prod_row is not None else ""
            if isinstance(mid, str) and media_service.is_valid_media_id(mid):
                gr.output_media_id = mid
                gr.status = "done"
                gr.error = None
                gr.finished_at = datetime.now(timezone.utc)
                succeeded_payload.append({
                    "result_id": rid,
                    "product_id": product_id,
                    "output_media_id": mid,
                })
                # Auto-save Reference (best effort).
                from flowboard.routes.generation_mode import save_result_as_reference
                save_result_as_reference(
                    s,
                    board_id=board_id,
                    product_id=product_id,
                    output_media_id=mid,
                    label=product_label,
                )
            else:
                gr.status = "failed"
                gr.error = "no_media_id_for_slot"
                gr.finished_at = datetime.now(timezone.utc)
            s.add(gr)
        s.commit()

    return (
        {
            "succeeded": succeeded_payload,
            "media_ids": media_ids,
            "all_request_ids": result_ids,
        },
        None,
    )


_DEFAULT_HANDLERS: dict[str, Handler] = {
    "proxy": _handle_proxy,
    "create_project": _handle_create_project,
    "gen_image": _handle_gen_image,
    "gen_video": _handle_gen_video,
    "gen_video_omni": _handle_gen_video_omni,
    "edit_image": _handle_edit_image,
    "gen_image_product": _handle_gen_image_product,
    "gen_image_product_batch": _handle_gen_image_product_batch,
}


class WorkerController:
    """Single-consumer async queue worker."""

    def __init__(self, handlers: Optional[dict[str, Handler]] = None) -> None:
        self._queue: asyncio.Queue[int] = asyncio.Queue()
        self._handlers = dict(handlers or _DEFAULT_HANDLERS)
        self._shutdown = asyncio.Event()
        self._active = 0
        self._started_at: Optional[float] = None

    # ── enqueue ────────────────────────────────────────────────────────────
    def enqueue(self, request_id: int) -> None:
        self._queue.put_nowait(request_id)

    # ── lifecycle ──────────────────────────────────────────────────────────
    async def start(self) -> None:
        self._started_at = time.time()
        logger.info("worker started")
        while not self._shutdown.is_set():
            try:
                rid = await asyncio.wait_for(self._queue.get(), timeout=0.5)
            except asyncio.TimeoutError:
                continue
            await self._process_one(rid)

    def request_shutdown(self) -> None:
        self._shutdown.set()

    async def drain(self) -> None:
        # Wait for any in-flight task to finish.
        while self._active > 0:
            await asyncio.sleep(0.05)

    @property
    def active_count(self) -> int:
        return self._active

    @property
    def uptime_s(self) -> Optional[float]:
        if self._started_at is None:
            return None
        return time.time() - self._started_at

    # ── execution ──────────────────────────────────────────────────────────
    async def _process_one(self, rid: int) -> None:
        self._active += 1
        try:
            with get_session() as s:
                req = s.get(Request, rid)
                if req is None:
                    logger.warning("worker: request %s not found", rid)
                    return
                # Drift guard — the row might have been canceled (or
                # otherwise transitioned out of queued) between enqueue
                # and pop. The cancel endpoint mutates the DB row only;
                # it can't yank the rid back off the in-memory queue, so
                # we re-check here and bail without flipping status.
                if req.status != "queued":
                    logger.info(
                        "worker: skipping rid=%s (status=%s)", rid, req.status
                    )
                    return
                handler = self._handlers.get(req.type)
                if handler is None:
                    req.status = "failed"
                    req.error = f"unknown_request_type:{req.type}"
                    req.finished_at = datetime.now(timezone.utc)
                    s.add(req)
                    s.commit()
                    return

                req.status = "running"
                s.add(req)
                s.commit()
                params = dict(req.params or {})
                # Enrich with the request's node_id so handlers that need
                # to look up Node.data don't depend on the caller copying
                # it into params explicitly. Underscore prefix avoids
                # colliding with handler-defined fields.
                if req.node_id is not None and "__node_id" not in params:
                    params["__node_id"] = req.node_id
                # Long-running handlers re-check this rid between polls
                # to honor user-initiated cancels.
                params["__request_id"] = rid

            # Release the session during the possibly-long RPC.
            result, err = await handler(params)

            with get_session() as s:
                req = s.get(Request, rid)
                if req is None:
                    return
                # Don't overwrite a canceled row with a late-arriving
                # done/failed stamp. The cancel endpoint already set
                # status='canceled' and finished_at; we only persist the
                # partial result for debugging visibility.
                if req.status == "canceled":
                    if isinstance(result, dict):
                        req.result = result
                        s.add(req)
                        s.commit()
                    return
                req.result = result if isinstance(result, dict) else {"value": result}
                req.finished_at = datetime.now(timezone.utc)
                if err:
                    # Video-poll exhaustion gets its own status so the UI
                    # can render "TIMEOUT" instead of a generic failure.
                    req.status = "timeout" if err == "timeout_waiting_video" else "failed"
                    req.error = err
                else:
                    req.status = "done"
                    req.error = None
                s.add(req)
                s.commit()
        except Exception as exc:  # noqa: BLE001
            logger.exception("worker exception on rid=%s", rid)
            try:
                with get_session() as s:
                    req = s.get(Request, rid)
                    if req is not None and req.status != "canceled":
                        req.status = "failed"
                        req.error = str(exc)[:500]
                        req.finished_at = datetime.now(timezone.utc)
                        s.add(req)
                        s.commit()
            except Exception:  # noqa: BLE001
                logger.exception("worker: failed to record failure for rid=%s", rid)
        finally:
            self._active -= 1


_worker: Optional[WorkerController] = None


def get_worker() -> WorkerController:
    global _worker
    if _worker is None:
        _worker = WorkerController()
    return _worker
