# Flowboard Background Service — Hướng dẫn cài & vận hành (macOS)

> Chạy Flowboard như một **daemon người-dùng** trên macOS: tự khởi động khi
> login, tự restart khi crash, không cần mở terminal, mở trình duyệt là dùng
> được. Toàn bộ xử lý vẫn chạy **trên máy của bạn** — không có gì rời khỏi
> máy ngoài request LLM (MiniMax) và request Veo/GEM_PIX_2 (đi qua extension).
>
> Đối tượng đọc: dev cá nhân đang dùng Flowboard trên macOS muốn có trải
> nghiệm "app native" thay vì chạy `make agent` + `make frontend` mỗi lần.
>
> Cập nhật lần cuối: 2026-06-16.

---

## 1. Tổng quan

Trong chế độ "background service":

- **Một process duy nhất** (`uvicorn flowboard.main:app`) chạy nền, bind
  `127.0.0.1:8101` (HTTP + FastAPI) và `127.0.0.1:9223` (WebSocket cho
  Chrome extension).
- **Frontend tĩnh** (`frontend/dist/`) được serve thẳng từ FastAPI ở cùng
  port 8101 — không cần Vite dev server, không cần terminal.
- **launchd** (cơ chế quản lý daemon chính thức của macOS) chịu trách
  nhiệm: khởi động khi login, restart khi crash, ghi log ra
  `~/.flowboard/logs/`.
- **`bin/flowboard`** là CLI tự cài cho các thao tác
  `install / dev / start / stop / restart / status / logs / build /
  uninstall`.

Đây **không phải production deployment** — Flowboard vẫn là
"personal local-only" (`docs/PLAN.md`). Chỉ là cách gom tất cả vào một
service chạy nền cho gọn.

---

## 2. Kiến trúc

### 2.1. So sánh với chế độ dev cũ

```
   ── Chế độ dev (cũ) ──────────────────────────────────────────────
   [Bạn mở 2 terminal]                  [Bạn mở Chrome]
        │                                      │
        ▼                                      ▼
   uvicorn :8101  ◄─── Vite proxy ───   http://localhost:5173
   (agent + API)     /api, /ws, /media      (Vite dev server + HMR)

   ── Chế độ background service (mới) ──────────────────────────────
   [launchd tự chạy khi login]           [Bạn mở bất kỳ browser nào]
        │                                      │
        ▼                                      ▼
   uvicorn :8101  ──────────────────►   http://localhost:8101
   (agent + API + static FE)
   + WS :9223 cho extension
```

### 2.2. File layout sau khi cài

```
/Volumes/FX900/personal/flowboard/
├── agent/
│
│   (project files only — venv lives outside the tree, see below)
│

```

> **Venv location:** the LaunchAgent runs the venv python from
> `~/.flowboard/agent-venv/bin/uvicorn` (system disk), not from `agent/.venv`.
> macOS launchd’s sandbox refuses to read `pyvenv.cfg` from a freshly
> created venv on an external volume (`/Volumes/...`) with EPERM, so we
> keep the venv on the boot volume. `bin/flowboard install` creates it
> automatically; you don’t have to run `make install` first.

```
/Volumes/FX900/personal/flowboard/
├── agent/
│   └── flowboard/main.py          # +13 dòng mount StaticFiles ở cuối
├── frontend/
│   └── dist/                      # build output (index.html + assets/)
├── scripts/
│   └── com.flowboard.agent.plist  # template (copy ra ~/Library/LaunchAgents/)
├── bin/
│   └── flowboard                  # CLI điều khiển
├── Makefile                       # +10 dòng: target service-*
└── .gitignore                     # +3 dòng: ignore .flowboard/

~/Library/LaunchAgents/
└── com.flowboard.agent.plist      # bản copy đã cài (KHÔNG commit)

~/.flowboard/
└── logs/
    ├── agent.out.log              # stdout của uvicorn
    └── agent.err.log              # stderr
```

### 2.3. Tại sao mount StaticFiles ở cùng port?

`vite.config.ts` đã có sẵn proxy `/api`, `/media`, `/ws` → `:8101`. Khi
build production, frontend vẫn dùng **relative URL** (`/api/...`), nên
chỉ cần cho FastAPI phục vụ `dist/` ở `/` là React app vẫn gọi được API
đúng cách. Mount ở cuối cùng → API routes ưu tiên, SPA fallback cho các
path không match.

Lệnh `app.mount("/", StaticFiles(directory=..., html=True), ...)`:
- `html=True` → trả về `index.html` cho path không match (SPA route như
  `/board/abc`).
- Mount sau cùng → không cản các API route đã đăng ký trước đó.

---

## 3. Cài đặt (lần đầu)

### Bước 1 — Tắt mọi instance đang chạy

Nếu bạn đang chạy `make agent` hoặc `uvicorn` thủ công:

```bash
# Tìm PID đang giữ port 8101
lsof -iTCP:8101 -sTCP:LISTEN
# Kill
kill <PID>
```

Nếu muốn kiểm tra cả port 9223 (WS cho extension):

```bash
lsof -iTCP:9223 -sTCP:LISTEN
```

### Bước 2 — Cài service

```bash
cd /Volumes/FX900/personal/flowboard
make service-install
```

Make target này sẽ tự:
1. `npm run build` cho frontend (lần đầu hoặc khi `dist/` chưa tồn tại).
2. Copy `scripts/com.flowboard.agent.plist` → `~/Library/LaunchAgents/`.
3. `launchctl load -w` để launchd tự khởi động + auto-restart.
4. Tạo `~/.flowboard/logs/` nếu chưa có.

### Bước 3 — Cho phép uvicorn qua macOS Firewall

Lần đầu uvicorn bind port, macOS sẽ popup hỏi. Bấm **Allow**.
Nếu lỡ từ chối, mở lại:

> `System Settings → Network → Firewall → Firewall Options…` →
> tìm `uvicorn` → chuyển sang **Allow incoming connections**.

### Bước 4 — Mở app

```
http://localhost:8101
```

### Bước 5 — Kiểm tra trạng thái

```bash
bin/flowboard status
```

Output mẫu khi chạy đúng:

```
● running
91724	-	com.flowboard.agent

tail (out):
2026-06-16 11:42:01 [INFO] flowboard.main: flowboard agent started (ws:9223 + worker)
2026-06-16 11:42:01 [INFO] flowboard.main: serving frontend from /Volumes/FX900/personal/flowboard/frontend/dist

tail (err):
(noop)
```

---

## 4. Vận hành hàng ngày

### 4.1. Bảng lệnh

| Lệnh | Làm gì |
|---|---|
| `bin/flowboard status` | Đang chạy không? + 5 dòng log cuối |
| `bin/flowboard logs` | `tail -f` cả stdout lẫn stderr (Ctrl+C để thoát) |
| `bin/flowboard start` | Load LaunchAgent (chỉ cần khi bị `stop` hoặc sau `uninstall`) |
| `bin/flowboard stop` | Unload LaunchAgent (process bị kill, port được giải phóng) |
| `bin/flowboard restart` | Unload rồi load lại — pick up code mới |
| `bin/flowboard build` | `npm run build` frontend, rồi nhắc `bin/flowboard restart` |
| `bin/flowboard dev` | Foreground + `--reload`, Ctrl+C **tự load lại service** |
| `bin/flowboard uninstall` | Unload + xóa plist (code & data **không** bị đụng) |

### 4.2. Lifecycle khi login / logout macOS

- **Login macOS** → launchd tự load các LaunchAgent trong
  `~/Library/LaunchAgents/` → service khởi động ~1–2s.
- **Logout / shutdown** → service bị kill (macOS gửi SIGTERM, uvicorn
  drain request đang chạy rồi thoát).
- **Sleep / wake** → service vẫn sống, không bị ảnh hưởng.
- **Crash** → launchd đợi `ThrottleInterval=5s` rồi khởi động lại.
  Nếu crash liên tục, vẫn restart mỗi 5s (loop an toàn, không spam
  CPU).

### 4.3. Nơi lưu data — KHÔNG bị service ảnh hưởng

- SQLite: `/Volumes/FX900/personal/flowboard/storage/flowboard.db`
- Media: `/Volumes/FX900/personal/flowboard/storage/media/`
- Secrets: `~/.flowboard/secrets.json` (mode 0600)
- Log service: `~/.flowboard/logs/`

Service chỉ đọc SQLite + ghi media; uninstall service không xóa data.

---

## 5. Quy trình phát triển

Có hai mode dev. Chọn theo việc bạn đang sửa:

### 5.1. Sửa `agent/flowboard/**/*.py` (backend)

Dùng **`bin/flowboard dev`** (tương đương `make dev-loopback`):

```bash
bin/flowboard dev
# → stopping service to free port 8101…
# → uvicorn --reload (Ctrl+C to stop dev + auto-restart service)
#   watching: /Volumes/FX900/personal/flowboard/agent/flowboard/**
#   ignoring: .venv, __pycache__, ../storage
# INFO:     Started server process
# INFO:     Waiting for application startup.
# INFO:     Application startup complete.
# INFO:     Detected file change in '.../minimax.py', reloading…
```

- Mỗi lần save `.py`, worker restart trong ~0.5s. Request đang chạy bị
  fail nhẹ (client tự retry).
- **`--reload-exclude ../storage`**: SQLite + media không bị theo dõi
  (tránh reload do file `.db-journal` sinh ra).
- **Ctrl+C** → uvicorn thoát sạch → script tự `launchctl load -w` lại
  service. Không cần nhớ bật lại.

### 5.2. Sửa `frontend/src/**` (React)

Có 2 sub-mode:

**(a) Chỉ muốn HMR, không cần rebuild static:**

Terminal 1: giữ service chạy nền.
Terminal 2:

```bash
cd /Volumes/FX900/personal/flowboard/frontend
npm run dev
```

Mở `http://localhost:5173` (Vite) — Vite proxy `/api`, `/media`, `/ws` →
`:8101` (service). HMR tức thì, F5 không mất state.

**(b) Sửa xong, muốn ship vào static dist:**

```bash
bin/flowboard build           # npm run build
bin/flowboard restart         # pick up dist/ mới
```

Mở `http://localhost:8101` — sẽ thấy UI mới.

### 5.3. Sửa `extension/*.js`

Extension chạy độc lập với service:

1. Sửa file trong `extension/`.
2. Mở `chrome://extensions` → tìm "Flowboard Bridge" → bấm **↻ reload**.
3. Test ngay. Không cần `bin/flowboard restart`.

### 5.4. Thêm / sửa pip dependency

```bash
cd /Volumes/FX900/personal/flowboard/agent
# Sửa pyproject.toml hoặc: uv pip install --python ~/.flowboard/agent-venv/bin/python <pkg>
make update               # hoặc: uv pip install -U -e .
bin/flowboard restart
```

**Không** dùng `bin/flowboard dev` cho bước này — `--reload` không watch
`pyproject.toml`, và worker sẽ crash vì thiếu module. Restart sạch sẽ
hơn.

### 5.5. Tóm tắt mode nào dùng khi nào

| Đang sửa | Mode | Browser mở |
|---|---|---|
| `agent/**/*.py` (lặp lại nhiều) | `bin/flowboard dev` | `:8101` (FE serve từ dist cũ) |
| `frontend/src/**` | `npm run dev` ở terminal 2 | `:5173` (Vite HMR) |
| `extension/*.js` | Sửa → reload extension | tab Flow + bất kỳ |
| `agent/pyproject.toml` | `make update` + `bin/flowboard restart` | `:8101` |
| Xong hết, đi ngủ | `bin/flowboard restart` (nếu cần) | `:8101` |

---

## 6. Troubleshooting

### 6.1. `bin/flowboard status` báo "not running"

Xem log trước:

```bash
tail -50 ~/.flowboard/logs/agent.err.log
```

Các lỗi thường gặp:

| Dòng đầu của err.log | Nguyên nhân | Cách xử lý |
|---|---|---|
| `ModuleNotFoundError: flowboard` | Sai WorkingDirectory trong plist | Kiểm tra plist có `WorkingDirectory = /Volumes/FX900/personal/flowboard/agent` |
| `Permission denied: .../uvicorn` | `.venv` chưa được cấp quyền exec | `chmod +x ~/.flowboard/agent-venv/bin/uvicorn` |
| `PermissionError: …/.venv/pyvenv.cfg` (EPERM) trên ổ ngoài | launchd sandbox từ chối đọc pyvenv.cfg của venv mới tạo trên `/Volumes/...` | Chạy lại `bin/flowboard install` — nó dời venv về `~/.flowboard/agent-venv` (system disk) |
| `Address already in use` | Có process khác đang giữ :8101 | `lsof -iTCP:8101` rồi `kill` |
| `sqlite3.OperationalError: database is locked` | Hai instance cùng mở DB | `bin/flowboard stop` rồi `start`, kiểm tra còn instance nào khác không |
| `FLOWBOARD_WS_HOST must be loopback` | Ai đó set env `FLOWBOARD_WS_HOST` sang LAN IP | Unset env var, đây là **guard rail cố ý** |

### 6.2. Mở `http://localhost:8101` thấy 404

`frontend/dist/` bị trống hoặc bị xóa:

```bash
ls /Volumes/FX900/personal/flowboard/frontend/dist/
# Trống → build lại:
bin/flowboard build
# Không có thư mục dist/ → build:
make frontend-build
bin/flowboard restart
```

### 6.3. Extension không connect được WS :9223

1. Mở popup extension (click icon "Flowboard Bridge" trên thanh Chrome)
   xem status indicator.
2. Nếu status = **off**: service chưa chạy → `bin/flowboard start`.
3. Nếu status = **idle** nhưng Generation vẫn fail: mở
   `chrome://extensions` → reload extension.
4. Nếu vẫn không được: bạn đã logout khỏi `labs.google` → đăng nhập lại
   trên tab Flow; extension tự capture Bearer token mới.

### 6.4. macOS Firewall chặn uvicorn

Lần đầu bind port macOS sẽ popup. Nếu bạn bấm "Don't Allow":

> `System Settings → Network → Firewall → Firewall Options…` →
> bật lại cho `uvicorn` (hoặc Python).

### 6.5. Sau khi sửa `main.py`, `--reload` không bắt

`uvicorn --reload` chỉ theo dõi file đã import. Khi bạn thêm import mới
ở top-level của `main.py`, cần full restart:

```bash
bin/flowboard restart
```

Hoặc thoát `bin/flowboard dev` rồi chạy lại.

### 6.6. Logs phình to

`agent.out.log` mặc định không rotate. Nếu log quá lớn (>100MB):

```bash
# Xoay thủ công
: > ~/.flowboard/logs/agent.out.log
: > ~/.flowboard/logs/agent.err.log
# Sau đó
bin/flowboard restart
```

(Tự động rotate có thể thêm bằng cách đổi path trong plist sang
`agent.out.log.$(date +%Y%m%d)`, nhưng cho personal use thì xoay tay
vài tháng 1 lần là đủ.)

---

## 7. Gỡ cài đặt

Sạch sẽ, không đụng data:

```bash
bin/flowboard uninstall   # unload + xóa plist
```

Hoặc thủ công:

```bash
launchctl unload ~/Library/LaunchAgents/com.flowboard.agent.plist
rm ~/Library/LaunchAgents/com.flowboard.agent.plist
```

Sau đó nếu muốn quay lại dev mode cũ, dùng bình thường:

```bash
make agent       # foreground, port 8101 (uses ~/.flowboard/agent-venv)
make frontend    # foreground, port 5173
```

SQLite, media, secrets **không bị xóa** — chỉ gỡ service.

Để gỡ **luôn cả data** (reset hoàn toàn):

```bash
rm -rf /Volumes/FX900/personal/flowboard/storage/flowboard.db*
rm -rf /Volumes/FX900/personal/flowboard/storage/media/*
rm -rf ~/.flowboard/
```

⚠️ Không thể undo. Chỉ chạy khi bạn thật sự muốn xóa mọi thứ.

---

## 8. Tham chiếu

### 8.1. File do tài liệu này mô tả

| File | Vai trò |
|---|---|
| `agent/flowboard/main.py` | FastAPI app + mount StaticFiles (dòng 157–169) |
| `scripts/com.flowboard.agent.plist` | launchd plist template |
| `bin/flowboard` | CLI: install/dev/start/stop/restart/status/logs/build/uninstall |
| `Makefile` | target `service-install`, `service-status`, `service-logs`, … |
| `docs/PLAN.md` | "Personal local use. No team, no cloud, no auth." |

### 8.2. Liên quan

- `docs/architecture/EXTENSION-BRIDGE.md` — Chrome extension ↔ Flow
  session, reCAPTCHA, Bearer token.
- `docs/PLAN.md` — kiến trúc tổng thể, data model, API surface.
- `README.md` — quick start, cài dependencies, demo.
- `.omc/RELEASE_RULE.md` — quy tắc bump version trước khi release
  (service này không tạo version mới — chỉ là thay đổi cục bộ).
