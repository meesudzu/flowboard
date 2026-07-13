"""HTTP Basic auth gate for the FastAPI app.

Optional, env-gated. When both ``BASIC_AUTH_USER`` and
``BASIC_AUTH_PASSWORD`` are set in the environment, every request
must present matching ``Authorization: Basic ...`` credentials — with
a small allowlist of paths that the system needs to remain
reachable without auth (health checks, the extension's HMAC
callback, and any in-flight WebSocket upgrade from the extension
to the agent's HTTP port).

When either env var is empty, the middleware is a no-op (preserves
backward-compat for existing single-user installs).

The path/header allowlist is also why we use ASGI middleware rather
than a FastAPI dependency: a dependency only fires on routes that
declare it, and we don't want to retrofit every existing endpoint
in this file. ASGI runs once per request and can short-circuit
before any router even sees the call.
"""
from __future__ import annotations

import base64
import logging
import secrets
from typing import Iterable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp

logger = logging.getLogger(__name__)


# Paths that must remain reachable without auth. The extension
# authenticates these by other means (HMAC for /api/ext/callback;
# the dedicated WS server is on a different port entirely) and the
# health check is what Cloudflare / uptime monitors hit.
_PUBLIC_PATH_PREFIXES: tuple[str, ...] = (
    "/api/health",
    "/api/ext/callback",
)


class BasicAuthMiddleware(BaseHTTPMiddleware):
    """Gate the entire app behind a single Basic-auth credential.

    Constructor takes the expected user/password so the values come
    from a single source of truth (``flowboard.config``) and tests
    can inject alternates without monkey-patching env vars.
    """

    def __init__(
        self,
        app: ASGIApp,
        *,
        expected_user: str,
        expected_password: str,
        public_path_prefixes: Iterable[str] = _PUBLIC_PATH_PREFIXES,
    ) -> None:
        super().__init__(app)
        # Fail-closed: an empty stored credential would let any
        # anonymous caller match ``secrets.compare_digest("", "")``
        # and slip through. The factory guards against this with
        # ``BASIC_AUTH_ENABLED`` but we re-check here so any future
        # caller of the constructor directly stays safe.
        if not expected_user or not expected_password:
            raise ValueError(
                "BasicAuthMiddleware requires non-empty "
                "expected_user and expected_password; check "
                "BASIC_AUTH_ENABLED before instantiating."
            )
        self._expected_user = expected_user
        self._expected_password = expected_password
        self._public = tuple(public_path_prefixes)

    def _is_public(self, path: str) -> bool:
        return any(path == p or path.startswith(p + "/") for p in self._public)

    @staticmethod
    def _is_ws_upgrade(headers) -> bool:
        """Defence-in-depth: even though the extension WS lives on
        its own port (9223), allow any in-flight Upgrade: websocket
        through. Some reverse-proxies (Caddy) can occasionally route
        an upgrade request to the HTTP port and we don't want to
        401 the handshake.
        """
        upgrade = headers.get("upgrade", "").lower()
        if "websocket" in upgrade:
            return True
        # Some clients (curl --http1.0, older reverse-proxies) only
        # signal the intent via Connection: Upgrade.
        connection = headers.get("connection", "").lower()
        return "upgrade" in connection.split(",")

    def _unauthorised(self) -> Response:
        # Use starlette.responses.Response so we don't accidentally
        # import the JSON variant and pull in a Content-Type that
        # hides the prompt. The browser pops the native auth dialog
        # when it sees WWW-Authenticate.
        from starlette.responses import Response as _Resp

        return _Resp(
            status_code=401,
            headers={"WWW-Authenticate": 'Basic realm="Flowboard"'},
            content="Unauthorized",
            media_type="text/plain",
        )

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        method = request.method.upper()
        if self._is_public(path):
            return await call_next(request)
        if self._is_ws_upgrade(request.headers):
            return await call_next(request)
        # CORS preflight: the browser does NOT send Authorization on
        # OPTIONS preflight, so a 401 here would block every cross-
        # origin request. Let CORS handle the preflight; the real
        # request that follows will include the header.
        if method == "OPTIONS":
            return await call_next(request)

        auth = request.headers.get("authorization") or ""
        if not auth.lower().startswith("basic "):
            return self._unauthorised()
        encoded = auth[6:].strip()
        try:
            decoded = base64.b64decode(encoded).decode("utf-8", errors="replace")
        except Exception:
            return self._unauthorised()
        # Standard "user:password" form. Split on the FIRST colon so
        # passwords with colons in them still work.
        if ":" not in decoded:
            return self._unauthorised()
        user, _, password = decoded.partition(":")
        user_ok = secrets.compare_digest(user, self._expected_user)
        pass_ok = secrets.compare_digest(password, self._expected_password)
        if not (user_ok and pass_ok):
            return self._unauthorised()
        return await call_next(request)


def make_basic_auth_middleware(app: ASGIApp) -> ASGIApp:
    """Factory: returns either the gate or a no-op.

    Importing this from main.py keeps the conditional logic out of
    the wiring code — main.py just calls ``make_basic_auth_middleware(app)``
    and gets back something it can wrap, regardless of whether auth
    is enabled.
    """
    # Imported lazily so test fixtures that monkey-patch the env
    # between tests still pick up the latest values.
    from flowboard.config import BASIC_AUTH_ENABLED, BASIC_AUTH_PASSWORD, BASIC_AUTH_USER

    if not BASIC_AUTH_ENABLED:
        return app
    logger.info(
        "HTTP Basic auth enabled (user=%r); protecting all paths except %s",
        BASIC_AUTH_USER, list(_PUBLIC_PATH_PREFIXES),
    )
    return BasicAuthMiddleware(
        app,
        expected_user=BASIC_AUTH_USER,
        expected_password=BASIC_AUTH_PASSWORD,
    )
