"""Basic-auth middleware tests.

Covers the four states we care about:
  • auth disabled (no env vars) -- backward compat, no gate
  • auth enabled + missing creds  -- 401 with WWW-Authenticate
  • auth enabled + right creds   -- 200
  • auth enabled + wrong creds   -- 401
  • public path bypass           -- 200 without creds
  • WebSocket upgrade bypass     -- 200 without creds
  • CORS preflight bypass        -- 200 without creds

These tests mock ``flowboard.config`` attributes rather than
mutating env vars + reloading the module — the reload path has
nasty test-isolation side effects (config state leaks into the
generation-mode tests that share the same Python process).
"""
from __future__ import annotations

import base64

import pytest
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.testclient import TestClient


def _basic(user: str, password: str) -> str:
    return "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()


@pytest.fixture
def auth_state(monkeypatch):
    """Patch ``flowboard.config`` attributes for the duration of one
    test. Returns a setter so each test can flip auth on/off.
    """
    from flowboard import config

    def _set(enabled: bool, user: str = "admin", password: str = "secret123") -> None:
        monkeypatch.setattr(config, "BASIC_AUTH_ENABLED", enabled)
        monkeypatch.setattr(config, "BASIC_AUTH_USER", user)
        monkeypatch.setattr(config, "BASIC_AUTH_PASSWORD", password)

    yield _set


@pytest.fixture
def app_with_auth():
    """Tiny Starlette app with both a public path and a protected
    path, gated by the middleware under test. Lets us exercise the
    middleware in isolation without spinning up the whole FastAPI
    app (and its worker/lifespan concerns).
    """
    from flowboard.middleware import basic_auth

    async def handler(_request):
        return JSONResponse({"ok": True})

    a = Starlette(
        routes=[
            Route("/api/health", handler),
            Route("/api/ext/callback", handler, methods=["POST"]),
            Route("/api/boards", handler),
        ]
    )
    a.add_middleware(basic_auth.make_basic_auth_middleware)
    return a, TestClient(a)


def test_auth_disabled_allows_everything(auth_state, app_with_auth):
    auth_state(enabled=False)
    _, client = app_with_auth
    r = client.get("/api/boards")
    assert r.status_code == 200


def test_auth_enabled_blocks_missing_credentials(auth_state, app_with_auth):
    auth_state(enabled=True)
    _, client = app_with_auth
    r = client.get("/api/boards")
    assert r.status_code == 401
    assert "Basic" in r.headers.get("WWW-Authenticate", "")


def test_auth_enabled_accepts_valid_credentials(auth_state, app_with_auth):
    auth_state(enabled=True, user="admin", password="secret123")
    _, client = app_with_auth
    r = client.get(
        "/api/boards",
        headers={"Authorization": _basic("admin", "secret123")},
    )
    assert r.status_code == 200


def test_auth_enabled_rejects_wrong_credentials(auth_state, app_with_auth):
    auth_state(enabled=True, user="admin", password="secret123")
    _, client = app_with_auth
    # Wrong password
    r = client.get(
        "/api/boards", headers={"Authorization": _basic("admin", "wrong")}
    )
    assert r.status_code == 401
    # Wrong user
    r = client.get(
        "/api/boards", headers={"Authorization": _basic("intruder", "secret123")}
    )
    assert r.status_code == 401
    # Malformed header
    r = client.get("/api/boards", headers={"Authorization": "Bearer xyz"})
    assert r.status_code == 401
    # Just a colon (empty creds)
    r = client.get("/api/boards", headers={"Authorization": _basic("", "")})
    assert r.status_code == 401


def test_public_paths_bypass_auth(auth_state, app_with_auth):
    auth_state(enabled=True)
    _, client = app_with_auth
    # Public paths don't need creds.
    assert client.get("/api/health").status_code == 200
    # The /api/ext/callback is configured for POST; sending a POST
    # (with no body) should still pass the auth gate, then hit
    # the handler.
    r = client.post("/api/ext/callback", content=b"{}")
    assert r.status_code == 200
    # Protected path requires creds.
    r = client.get("/api/boards")
    assert r.status_code == 401


def test_websocket_upgrade_header_bypasses_auth(auth_state, app_with_auth):
    """Defence in depth: even though the extension WS is on a
    different port, allow any in-flight Upgrade header through so a
    misrouted upgrade request doesn't 401.
    """
    auth_state(enabled=True)
    _, client = app_with_auth
    r = client.get(
        "/api/boards",
        headers={"Upgrade": "websocket", "Connection": "Upgrade"},
    )
    assert r.status_code == 200


def test_options_preflight_bypasses_auth(auth_state, app_with_auth):
    """CORS preflight must pass without an Authorization header —
    the browser doesn't send one on preflight, and a 401 would block
    every cross-origin request.
    """
    auth_state(enabled=True)
    _, client = app_with_auth
    # OPTIONS on a route the app doesn't declare returns 405
    # (because the route is GET-only), but importantly it does
    # NOT return 401 -- the auth gate is bypassed.
    r = client.options(
        "/api/boards",
        headers={"Origin": "https://x.test", "Access-Control-Request-Method": "GET"},
    )
    assert r.status_code != 401


def test_password_with_colon_is_parsed_correctly(auth_state, app_with_auth):
    """Standard "user:password" form, but a user might pick a
    password that itself contains a colon. The middleware splits on
    the FIRST colon so the password stays intact.
    """
    auth_state(enabled=True, user="admin", password="p:a:s:s")
    _, client = app_with_auth
    r = client.get(
        "/api/boards",
        headers={"Authorization": _basic("admin", "p:a:s:s")},
    )
    assert r.status_code == 200


def test_empty_stored_credentials_fail_closed_at_construct():
    """Defence in depth: an empty stored credential would let any
    anonymous caller match ``secrets.compare_digest("", "")`` and
    slip through. The middleware constructor must refuse to
    initialise with empty creds so a misuse can't silently disable
    auth. The factory ``make_basic_auth_middleware`` already guards
    against this with ``BASIC_AUTH_ENABLED``; this test pins the
    class-level invariant so a future refactor doesn't drop it.
    """
    from flowboard.middleware import basic_auth

    # Empty password
    with pytest.raises(ValueError):
        basic_auth.BasicAuthMiddleware(
            app=None,  # never reached
            expected_user="admin",
            expected_password="",
        )
    # Empty user
    with pytest.raises(ValueError):
        basic_auth.BasicAuthMiddleware(
            app=None,
            expected_user="",
            expected_password="secret123",
        )
