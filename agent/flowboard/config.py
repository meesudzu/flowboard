from pathlib import Path
import os

ROOT = Path(__file__).resolve().parent.parent.parent
STORAGE_DIR = Path(os.getenv("FLOWBOARD_STORAGE", ROOT / "storage"))
DB_PATH = Path(os.getenv("FLOWBOARD_DB", STORAGE_DIR / "flowboard.db"))

HTTP_PORT = int(os.getenv("FLOWBOARD_HTTP_PORT", "8101"))
WS_HOST = os.getenv("FLOWBOARD_WS_HOST", "127.0.0.1")
EXTENSION_WS_PORT = int(os.getenv("FLOWBOARD_EXT_WS_PORT", "9223"))

# MiniMax-only build: PLANNER_MODEL is informational only (the actual
# model is pinned inside ``MiniMaxProvider`` per capability — text vs.
# vision). Kept as an env override so ops can pin a specific MiniMax
# variant for the planner path if needed.
PLANNER_MODEL = os.getenv("FLOWBOARD_PLANNER_MODEL", "MiniMax-M2.7-highspeed")
# "real" → always hit MiniMax; "mock" → always mock; "auto" → MiniMax if
# the API key is configured, else mock. Default auto.
PLANNER_BACKEND = os.getenv("FLOWBOARD_PLANNER_BACKEND", "auto")

# ── Optional HTTP Basic auth ──────────────────────────────────────────
# When both vars are non-empty, the FastAPI app gates every request
# behind ``Authorization: Basic <user>:<password>``. The path
# allowlist (health, ext/callback, WS upgrade) still passes through
# unauthenticated so the extension and uptime monitors keep working.
# Leave either var empty to disable auth entirely (default — keeps
# backward compatibility for existing single-user installs).
BASIC_AUTH_USER = os.getenv("FLOWBOARD_BASIC_AUTH_USER", "") or ""
BASIC_AUTH_PASSWORD = os.getenv("FLOWBOARD_BASIC_AUTH_PASSWORD", "") or ""
BASIC_AUTH_ENABLED = bool(BASIC_AUTH_USER) and bool(BASIC_AUTH_PASSWORD)

STORAGE_DIR.mkdir(parents=True, exist_ok=True)
