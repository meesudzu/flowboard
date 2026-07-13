# Flowboard — VPS deploy

One-shot Docker stack để chạy Flowboard (FastAPI agent + React UI) trên
VPS, có TLS tự động qua Let's Encrypt. **Không cần cài LLM CLI** — agent
nói chuyện với MiniMax qua HTTPS.

## Kiến trúc

```
Internet ──443──►  Caddy (TLS + auto-renew)
                      │
        ┌─────────────┴─────────────┐
        │ /ws (Upgrade: websocket)  │ /api, /media, / (static)
        ▼                            ▼
   agent:9223                  agent:8101
   (ws_server.py)              (FastAPI + uvicorn)
                      │
                      ├──►  /srv/storage  (SQLite + media cache)
                      └──►  /srv/secrets  (secrets.json — MiniMax key)
```

`agent:9223` chỉ dùng cho **Chrome extension service worker** kết nối từ
máy bạn ở nhà. `agent:8101` phục vụ UI + REST. Caddy tách luồng bằng
matcher `@ws` (header `Connection: *Upgrade*` + `Upgrade: websocket`).

`FLOWBOARD_WS_HOST` vẫn giữ `127.0.0.1` (guard rail trong `main.py`
được giữ nguyên, không cần patch code) — vì Caddy đã terminate TLS và
chuyển tiếp vào loopback.

## Yêu cầu

- VPS Linux (Debian 12 / Ubuntu 24.04 khuyến nghị)
- Docker Engine ≥ 24 + plugin `docker compose`
- Mở port 80 + 443 ra internet
- DNS A/AAAA record trỏ `flow.runany.dev` về IP VPS **trước khi** chạy
- MiniMax API key

## Setup một lần trên VPS

```bash
# 1. Cài Docker (nếu chưa có)
curl -fsSL https://get.docker.com | sh

# 2. Lấy code
git clone <repo-url> ~/flowboard && cd ~/flowboard/deploy

# 3. Khởi tạo .env + chỉnh domain/email
./deploy.sh init
$EDITOR .env

# 4. Ghi MiniMax API key (lưu ở secrets.json, mode 600)
./deploy.sh secrets
# → nhập key, ví dụ: eyJhbGciOiJIUzI1NiJ9...

# 5. Khởi động stack
./deploy.sh up -d

# 6. Kiểm tra
./deploy.sh status
# → curl /api/health phải trả {"ok":true,"extension_connected":false,...}

./deploy.sh logs       # tail logs agent
```

Lần đầu chạy Caddy sẽ tự động issue Let's Encrypt cert (~30s). Nếu
fail kiểm tra:

```bash
# DNS đã trỏ về đúng IP chưa?
dig +short flow.runany.dev
# Firewall đã mở 80/443 chưa?
sudo ufw status
# Log caddy
docker compose logs caddy
```

## Cập nhật Chrome extension ở local

Sau khi deploy lên VPS xong, bạn cần trỏ extension ở Chrome local về
URL mới:

```bash
# Trên máy local (có repo), KHÔNG cần SSH vào VPS:
cd /path/to/flowboard
./deploy/deploy.sh patch-extension https://flow.runany.dev
```

Script này sửa 2 file:

- `extension/manifest.json` — thay `http://127.0.0.1:8101` và
  `ws://127.0.0.1:9223` trong `host_permissions` bằng URL VPS
- `extension/background.js` — đổi `AGENT_WS_URL` thành
  `wss://flow.runany.dev/` và `CALLBACK_URL` thành
  `https://flow.runany.dev/api/ext/callback`

Sau đó mở `chrome://extensions` → bấm **Reload** trên Flowboard Bridge.

## Vận hành hàng ngày

```bash
./deploy.sh status                    # trạng thái container + /api/health
./deploy.sh logs [agent|caddy]        # tail logs
./deploy.sh restart                   # restart sau khi sửa env/secrets
./deploy.sh backup                    # tar.gz storage ra ./backups/
./deploy.sh down                      # dừng (giữ volumes)
```

Update code mới:

```bash
cd ~/flowboard && git pull
cd deploy && ./deploy.sh up -d --build
```

## Backup & restore

```bash
# Backup
./deploy.sh backup
# → backups/storage-20250713-112300.tar.gz

# Restore (VPS khác hoặc sau khi wipe)
mkdir -p storage_data
tar xzf backups/storage-20250713-112300.tar.gz -C .
# rồi mount volume storage_data vào /srv/storage (xem docker-compose)
```

## Khi muốn đổi domain

```bash
$EDITOR .env             # đổi FLOWBOARD_DOMAIN
./deploy.sh restart caddy
# Cert mới sẽ được issue tự động
```

## Bảo mật

- File `secrets/secrets.json` chứa API key — không commit, mode 600
- Volume `secrets` chỉ mount vào agent, không expose ra ngoài
- Caddy tự chặn HTTP (redirect sang HTTPS)
- HSTS bật trong Caddyfile
- WS server (`:9223`) **không có auth** theo design — được bảo vệ bởi
  guard rail `WS_HOST=127.0.0.1` trong code, không thể bind public

## Troubleshooting

| Triệu chứng | Nguyên nhân | Cách sửa |
|---|---|---|
| `curl /api/health` timeout | Agent chưa healthy | `docker compose logs agent` |
| `ERR_CONNECTION_REFUSED` trong extension | Extension chưa patch URL | `./deploy.sh patch-extension https://...` rồi reload extension |
| `permission denied` khi ghi file | Chạy với user không phải root | Đảm bảo volume mount mode 600 |
| Caddy log: `acme: error: 400` | DNS chưa trỏ về VPS | `dig +short DOMAIN`, đợi DNS propagate |
| LLM call fail 401 | `secrets.json` chưa có key | `./deploy.sh secrets` rồi `restart` |
| `WebSocket connection failed` | Caddy chưa match @ws | Kiểm tra extension có gửi `Upgrade: websocket` |

## Vì sao Caddy chứ không phải nginx?

- Auto-TLS không cần certbot container
- Config 50 dòng thay vì 200
- Cert renew tự động không cần cron

Nếu bạn thích nginx hơn, port từ `Caddyfile` sang `nginx.conf` chỉ mất
~30 phút — liên hệ mình nếu cần.
