#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# Flowboard one-shot VPS deploy
#
# Subcommands:
#   init              copy .env.example → .env (idempotent)
#   secrets [key]     write /srv/secrets/secrets.json (interactive if no key)
#   up                build + start the stack (foreground, ctrl-c cancels)
#   up -d             detached
#   down              stop + remove containers (volumes preserved)
#   logs [svc]        tail logs (default: agent)
#   status            health + container state
#   backup            snapshot SQLite + media to ./backups/
#   patch-extension URL   rewrite extension/manifest.json + background.js
#                         so the local Chrome extension points at this VPS
#
# Common first run:
#   ./deploy.sh init
#   ./deploy.sh secrets      # paste MiniMax key
#   $EDITOR .env             # set DOMAIN + EMAIL
#   ./deploy.sh up -d
#   ./deploy.sh status
#   # On local machine:
#   ./deploy.sh patch-extension https://flow.runany.dev
# ─────────────────────────────────────────────────────────────────────

set -euo pipefail

cd "$(dirname "$0")"

RED='\033[0;31m'; GRN='\033[0;32m'; YLW='\033[1;33m'; NC='\033[0m'
say() { printf "${GRN}==>${NC} %s\n" "$*" >&2; }
warn() { printf "${YLW}warn:${NC} %s\n" "$*" >&2; }
die() { printf "${RED}error:${NC} %s\n" "$*" >&2; exit 1; }

require_docker() {
    command -v docker >/dev/null  || die "docker not installed — see https://docs.docker.com/engine/install/"
    docker compose version >/dev/null 2>&1 || die "docker compose plugin missing — install 'docker-compose-plugin'"
}

# ── init ────────────────────────────────────────────────────────────
cmd_init() {
    [[ -f .env ]] && warn ".env already exists — leaving it alone" && return 0
    cp .env.example .env
    say "Created .env — edit it now: \$EDITOR .env"
    say "  • FLOWBOARD_DOMAIN  →  DNS A/AAAA of this VPS"
    say "  • FLOWBOARD_EMAIL   →  Let's Encrypt registration"
}

# ── secrets ─────────────────────────────────────────────────────────
cmd_secrets() {
    local key="${1:-}"
    if [[ -z "$key" ]]; then
        read -r -s -p "MiniMax API key (sk-...): " key
        echo
    fi
    [[ -n "$key" ]] || die "empty key"

    mkdir -p secrets
    cat > secrets/secrets.json <<JSON
{
  "apiKeys": { "minimax": "${key}" },
  "activeProviders": {
    "auto_prompt": "minimax",
    "vision":      "minimax",
    "planner":     "minimax"
  }
}
JSON
    chmod 600 secrets/secrets.json
    say "Wrote secrets/secrets.json (mode 600)"
    warn "If the agent is already running, restart it: ./deploy.sh restart"
}

# ── up ──────────────────────────────────────────────────────────────
cmd_up() {
    require_docker
    [[ -f .env ]] || die "missing .env — run './deploy.sh init' first"
    grep -q '^FLOWBOARD_DOMAIN=[a-z]' .env || die "FLOWBOARD_DOMAIN not set in .env"
    grep -q '^FLOWBOARD_EMAIL=[a-z]'  .env || die "FLOWBOARD_EMAIL not set in .env"

    if [[ ! -f secrets/secrets.json ]]; then
        warn "secrets/secrets.json not found — agent will start but no LLM calls will succeed"
        warn "Run './deploy.sh secrets' once and then './deploy.sh restart'"
    fi

    # Make sure secrets dir exists with sane perms even if empty
    mkdir -p secrets && [[ -f secrets/secrets.json ]] && chmod 600 secrets/secrets.json || true

    # docker compose v2: `up` accepts flags AFTER the subcommand.
    # `./deploy.sh up -d` → `docker compose up --build -d` (detached)
    # `./deploy.sh up`     → `docker compose up --build`         (foreground)
    docker compose up --build "$@"
}

# ── down ────────────────────────────────────────────────────────────
cmd_down() {
    require_docker
    docker compose down
}

# ── restart ─────────────────────────────────────────────────────────
cmd_restart() {
    require_docker
    docker compose restart
}

# ── logs ────────────────────────────────────────────────────────────
cmd_logs() {
    require_docker
    docker compose logs -f --tail=200 "${1:-agent}"
}

# ── status ──────────────────────────────────────────────────────────
cmd_status() {
    require_docker
    say "Containers:"
    docker compose ps
    echo
    say "/api/health (via caddy, requires DNS pointing to this VPS):"
    local domain
    domain=$(grep '^FLOWBOARD_DOMAIN=' .env 2>/dev/null | cut -d= -f2-)
    if [[ -z "$domain" ]]; then
        warn "FLOWBOARD_DOMAIN not set in .env — skipping remote probe"
    elif [[ "$domain" == *.example.com || "$domain" == *example.org ]]; then
        warn "FLOWBOARD_DOMAIN still looks like a placeholder ($domain) — skipping"
    else
        local out
        out=$(curl -sS --max-time 5 "https://${domain}/api/health" 2>&1) \
            && printf "%s\n" "$out" | python3 -m json.tool 2>/dev/null \
            || warn "agent not yet reachable on https://${domain} — $out"
    fi
}

# ── backup ──────────────────────────────────────────────────────────
cmd_backup() {
    require_docker
    local ts; ts=$(date +%Y%m%d-%H%M%S)
    mkdir -p backups
    say "Snapshotting SQLite + media to backups/${ts}/"
    docker compose exec -T agent \
        sh -c "tar czf - /srv/storage" \
        > "backups/storage-${ts}.tar.gz"
    say "Wrote backups/storage-${ts}.tar.gz"
    ls -lh "backups/storage-${ts}.tar.gz"
}

# ── patch-extension ─────────────────────────────────────────────────
cmd_patch_extension() {
    local url="${1:-}"
    [[ -n "$url" ]] || die "usage: ./deploy.sh patch-extension https://flow.runany.dev"

    # strip trailing slash
    url="${url%/}"
    # ws:// vs wss://
    local ws_url
    case "$url" in
        https://*) ws_url="${url/https/wss}" ;;
        http://*)  ws_url="${url/http/ws}"  ;;
        *) die "URL must start with https:// or http:// (got: $url)" ;;
    esac

    local ext_dir repo_root
    repo_root="$(cd .. && pwd)"
    ext_dir="${repo_root}/extension"
    [[ -d "$ext_dir" ]] || die "extension dir not found at $ext_dir"

    say "Patching extension files in ${ext_dir} → ${url}"

    python3 - "$ext_dir" "$url" "$ws_url" <<'PY'
import json, pathlib, sys, re
ext_dir, url, ws_url = sys.argv[1:]

# 1) manifest.json — preserve original formatting. Do scoped text surgery
#    on just the host_permissions block; don't re-serialize the whole JSON.
mp = pathlib.Path(ext_dir) / "manifest.json"
text = mp.read_text()

# Find the host_permissions array block (greedy on inner contents).
m_hp = re.search(
    r'("host_permissions"\s*:\s*)\[(.*?)\]',
    text, flags=re.DOTALL,
)
if not m_hp:
    print("  • manifest.json: host_permissions block not found — skipped")
else:
    prefix, inner = m_hp.group(1), m_hp.group(2)
    # Pull out individual string entries (each is "..." line).
    entries = re.findall(r'"([^"]+)"', inner)
    # Map loopback → prod URL
    new_entries = []
    for e in entries:
        if e.startswith("http://127.0.0.1:8101") or e.startswith("http://localhost:8101"):
            new_entries.append(f"{url}/*")
        elif e.startswith("ws://127.0.0.1:9223") or e.startswith("ws://localhost:9223"):
            new_entries.append(f"{ws_url}/*")
        else:
            new_entries.append(e)
    # Dedup while preserving order
    seen, deduped = set(), []
    for e in new_entries:
        if e not in seen:
            seen.add(e); deduped.append(e)
    # Re-render the array using the file's existing comma style:
    # pick up the leading whitespace of the first entry from `inner`
    indent_match = re.search(r'\n(\s+)"', inner)
    indent = indent_match.group(1) if indent_match else "    "
    rendered_inner = "".join(f'\n{indent}"{e}",' for e in deduped[:-1])
    rendered_inner += f'\n{indent}"{deduped[-1]}"'  # last entry no trailing comma
    new_block = prefix + "[" + rendered_inner + "\n  ]"  # closing bracket on own line
    text = text[:m_hp.start()] + new_block + text[m_hp.end():]
    mp.write_text(text)
    json.loads(text)  # validate
    print(f"  • manifest.json host_permissions → {len(deduped)} entries (preserved formatting)")

# 2) background.js — replace AGENT_WS_URL and CALLBACK_URL
bp = pathlib.Path(ext_dir) / "background.js"
src = bp.read_text()
src2 = re.sub(
    r"const\s+AGENT_WS_URL\s*=\s*['\"][^'\"]+['\"]",
    f"const AGENT_WS_URL  = '{ws_url}/'",
    src,
)
src2 = re.sub(
    r"const\s+CALLBACK_URL\s*=\s*['\"][^'\"]+['\"]",
    f"const CALLBACK_URL  = '{url}/api/ext/callback'",
    src2,
)
if src2 == src:
    print(f"  • background.js — no URL constants found to patch")
else:
    bp.write_text(src2)
    print(f"  • background.js updated: AGENT_WS_URL={ws_url}/, CALLBACK_URL={url}/api/ext/callback")
PY

    say "Done. Now reload the extension in chrome://extensions."
}

# ── entrypoint ──────────────────────────────────────────────────────
case "${1:-}" in
    init)              shift; cmd_init "$@" ;;
    secrets)           shift; cmd_secrets "$@" ;;
    up)                shift; cmd_up "$@" ;;
    down)              shift; cmd_down "$@" ;;
    restart)           shift; cmd_restart "$@" ;;
    logs)              shift; cmd_logs "$@" ;;
    status)            shift; cmd_status "$@" ;;
    backup)            shift; cmd_backup "$@" ;;
    patch-extension)   shift; cmd_patch_extension "$@" ;;
    ""|help|-h|--help)
        sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
        ;;
    *) die "unknown command: $1 — try '$0 help'" ;;
esac
