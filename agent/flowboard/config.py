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

STORAGE_DIR.mkdir(parents=True, exist_ok=True)
