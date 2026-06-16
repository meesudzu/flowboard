# Flowboard Extension Bridge — Kiến trúc & Cơ chế hoạt động

> Tài liệu mô tả cách Chrome MV3 extension trong `extension/` đóng vai trò
> cầu nối giữa Python agent (local FastAPI) và Google Flow (Veo 3.1 / GEM_PIX_2).
>
> Đối tượng đọc: developer muốn hiểu/sửa mơ hình bridge, debug reCAPTCHA,
> hoặc thêm endpoint mới.
>
> Cập nhật lần cuối: 2026-06-16.

---

## 1. Bối cảnh & vấn đề

Google Flow là giao diện web tại `https://labs.google/fx/tools/flow` cho phép
tạo ảnh/video bằng Veo 3.1 i2v, GEM_PIX_2 (image) và một số model khác.
Flowboard cần gọi những model này theo lô, theo DAG, có version control —
không có UI web nào hỗ trợ.

Vấn đề: Google **không cung cấp public API** cho những model này. Không có
mục "Enable API" trong Google Cloud Console, không có API key riêng, không
nhận service account. Mọi model đều chỉ chạy trong **session browser đã đăng
nhập labs.google với gói Pro/Ultra trả phí**.

Flowboard giải quyết bằng cách **mượn session thật của user thông qua một
Chrome extension nhỏ** — extension chỉ là proxy, mọi generation vẫn chạy
trong browser của user, với cookie + Bearer token + reCAPTCHA của họ.

---

## 2. Kiến trúc tổng thể

Flowboard có 3 lớp. Extension là lớp giữa, là phần "browser-in-the-middle".

```
┌─────────────────────────────────────────────────────────────────────┐
│                            Frontend (React)                          │
│  - Canvas (React Flow)                                               │
│  - Chat sidebar (LLM planning)                                       │
│  - Giao tiếp với agent qua HTTP /api/* và WS /ws/board/:id          │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ HTTP + WebSocket
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       Python Agent (FastAPI :8101)                   │
│  - REST API: boards, nodes, edges, requests, plans, llm, vision…    │
│  - SQLite (SQLModel) cho persistence                                 │
│  - WebSocket server :9223 cho extension                              │
│  - HTTP callback /api/ext/callback cho extension responses          │
│  - Worker queue xử lý generation jobs                                │
│                                                                       │
│  flow_client.py ── singleton ── gửi lệnh api_request/trpc_request   │
│                  ◄── nhận response qua HTTP callback hoặc WS        │
└──────────────────┬───────────────────────────────────┬──────────────┘
                   │ WebSocket :9223                   │ HTTP POST
                   │ (control + push)                  │ /api/ext/callback
                   │                                   │ (response, có secret)
                   ▼                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│              Chrome MV3 Extension (Flowboard Bridge)                 │
│                                                                       │
│  background.js (service worker) — bộ não điều phối                  │
│    ├─ webRequest.onBeforeSendHeaders  → bắt Bearer token             │
│    ├─ declarativeNetRequest (rules.json) → sửa Referer/Origin       │
│    ├─ WebSocket client → ws://127.0.0.1:9223                         │
│    ├─ handleApiRequest(url, body, captchaAction)                     │
│    └─ handleTrpcRequest(url, body)                                   │
│                                                                       │
│  content.js (ISOLATED world) — cầu nối trung gian                    │
│    - Inject injected.js vào MAIN world                               │
│    - Relay CustomEvent 'GET_CAPTCHA' / 'CAPTCHA_RESULT'              │
│                                                                       │
│  injected.js (MAIN world) — giải reCAPTCHA                           │
│    - await window.grecaptcha.enterprise.execute(siteKey, action)     │
│    - Trả token về qua CustomEvent                                     │
│                                                                       │
│  popup.html / popup.js — UI 260px, status + 3 nút                   │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ fetch() với Bearer + cookies
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          Google Flow                                 │
│                                                                       │
│  https://labs.google/fx/tools/flow          (web UI, user đã login) │
│  https://aisandbox-pa.googleapis.com/*      (media generation API)  │
│    ├─ /v1/projects/{id}/flowMedia:batchGenerateImages                │
│    ├─ /v1/video:batchAsyncGenerateVideoStartImage                    │
│    ├─ /v1/video:batchAsyncGenerateVideoReferenceImages               │
│    ├─ /v1/video:batchCheckAsyncVideoGenerationStatus                 │
│    └─ /v1/credits                                                    │
│  https://labs.google/fx/api/trpc/*         (project management)      │
│  window.grecaptcha.enterprise.execute()    (reCAPTCHA Enterprise)    │
└─────────────────────────────────────────────────────────────────────┘
```

**Điểm mấu chốt**: extension **không tự quyết định** phải làm gì. Nó là
proxy thuần túy — agent ra lệnh, extension chuyển sang Google Flow kèm
bearer + captcha, response đẩy ngược về agent.

---

## 3. Tại sao không gọi thẳng từ Python?

`aisandbox-pa.googleapis.com` là endpoint thật, có thể truy cập được, có
query string `?key=AIzaSyBtrm0o5ab1c-Ec8ZuLcGt3oJAA5VWt3pY` (key project
lộ trong bundle JS của labs.google — **không phải secret**). Nhưng gọi
thẳng từ `httpx` sẽ fail ở **4 thứ chỉ browser mới có**:

| Thứ | Vai trò | Tại sao server Python không có |
|---|---|---|
| **OAuth Bearer `ya29.*`** | Xác thực user, scope `userinfo.email/profile` | Phải do user thật login; service account không có scope Flow cần |
| **reCAPTCHA Enterprise token** | Anti-bot, single-use, bound to browser context | Token chỉ Google cấp cho `grecaptcha.enterprise.execute()` chạy trong browser |
| **Cookie session** | Stateful session, CSRF guard | Cookie chỉ có trong browser sau khi user vào labs.google |
| **Origin/Referer hợp lệ** | Google kiểm tra request có từ UI chính hãng | Từ curl thì thiếu; extension dùng `declarativeNetRequest` sửa tự động |

Một endpoint duy nhất mà Python gọi thẳng được: `/v1/credits` (dùng để
detect tier Pro/Ultra). Nó chỉ cần Bearer + Origin, không cần captcha.
Mọi endpoint còn lại đều **phải đi qua extension**.

So sánh với các trường hợp tương tự: Spotify Web Player API, Twitter
GraphQL, Instagram private API — cùng pattern: API thật có, nhưng buộc
phải mượn browser session.

---

## 4. Các file của extension

```
extension/
├── manifest.json     Khai báo MV3, permissions, host_permissions, content_scripts, DNR
├── background.js     Service worker (707 dòng) — bộ não điều phối
├── content.js        Content script (ISOLATED world) — cầu nối trung gian
├── injected.js       Script chạy ở MAIN world — gọi grecaptcha.enterprise.execute()
├── rules.json        Declarative Net Request rule — sửa Referer/Origin
├── popup.html        UI 260px — header + status + 3 nút
├── popup.js          Polling mỗi 1.5s, render status, wire 3 nút
├── _metadata/        Chrome Web Store metadata
└── README.md         Hướng dẫn cài đặt
```

`manifest.json` highlights:

```json
{
  "manifest_version": 3,
  "permissions": ["storage", "alarms", "tabs", "webRequest",
                  "scripting", "declarativeNetRequest"],
  "host_permissions": [
    "https://aisandbox-pa.googleapis.com/*",
    "https://labs.google/*",
    "http://127.0.0.1:8101/*",
    "http://localhost:8101/*"
  ],
  "background": { "service_worker": "background.js" },
  "content_scripts": [{
    "matches": [
      "https://labs.google/fx/tools/flow*",
      "https://labs.google/fx/*/tools/flow*"
    ],
    "js": ["content.js"],
    "run_at": "document_start"
  }],
  "web_accessible_resources": [{
    "resources": ["injected.js"],
    "matches": ["https://labs.google/*"]
  }]
}
```

`web_accessible_resources` cần thiết để content script có thể inject
`injected.js` vào MAIN world (script ở extension origin không accessible
trực tiếp từ page).

---

## 5. Cơ chế kết nối Agent ↔ Extension

### 5.1. WebSocket điều khiển (port 9223)

```js
// extension/background.js
const AGENT_WS_URL = 'ws://127.0.0.1:9223';
```

```python
# agent/flowboard/services/ws_server.py
async def _handler(websocket):
    flow_client.set_extension(websocket)
    await websocket.send(json.dumps({
        "type": "callback_secret",
        "secret": flow_client.callback_secret,  # 32-char URL-safe random
    }))
    async for raw in websocket:
        await flow_client.handle_message(json.loads(raw))
```

**Handshake:**

1. Extension mở WS khi `chrome.runtime.onInstalled` / `onStartup` /
   reconnect alarm.
2. Agent frame đầu gửi `callback_secret` (random 32 bytes URL-safe, tạo
   mỗi lần agent restart). Extension lưu vào `chrome.storage.local` để
   dùng cho HTTP callback auth.
3. Extension trả `extension_ready` + `flowKeyPresent` + `tokenAge`.
4. Nếu extension đã có token (sau khi user vào Flow), gửi ngay
   `token_captured` + `user_info` để agent không phải đợi.

**Keepalive & reconnect:**

- `chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 })` → 24s gửi
  `{type:"ping"}`, agent trả `pong`.
- WS đóng không phải do user → `chrome.alarms.create('reconnect',
  {delayInMinutes: 0.083})` ≈ 5s reconnect.
- User bấm "Disconnect" trong popup → set `manualDisconnect = true`,
  không auto-reconnect.

### 5.2. HTTP callback (port 8101, primary response path)

```js
// extension/background.js — sendToAgent
function sendToAgent(msg) {
  if (msg.id) {
    // Response có request id → HTTP (an toàn với WS drop)
    fetch('http://127.0.0.1:8101/api/ext/callback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Callback-Secret': callbackSecret,
      },
      body: JSON.stringify(msg),
    }).catch(() => {
      // HTTP fail → fallback WS
      ws?.send(JSON.stringify(msg));
    });
  } else {
    // Push messages (token_captured, status) → chỉ WS
    ws?.send(JSON.stringify(msg));
  }
}
```

```python
# agent/flowboard/main.py
@app.post("/api/ext/callback")
async def ext_callback(body, x_callback_secret=Header(alias="X-Callback-Secret")):
    if not hmac.compare_digest(x_callback_secret, flow_client.callback_secret):
        raise HTTPException(401, "invalid callback secret")
    payload = await body.json()
    matched = flow_client.resolve_callback(payload)
    return {"ok": matched}
```

**Tại sao HTTP primary, WS fallback?**

- WS có thể rớt mid-flight → response mất → agent future treo vĩnh viễn.
- HTTP one-shot: gửi xong là xong, agent resolve future ngay. Không phụ
  thuộc WS connection.
- `hmac.compare_digest` chống timing attack (constant-time comparison).
- Secret chỉ trong header, không log ra console.

### 5.3. Hai loại message đi qua WS

**Agent → Extension (commands):**

```js
{ id, method: "api_request",  params: { url, method, headers, body, captchaAction? } }
{ id, method: "trpc_request", params: { url, method, headers, body } }
{ id, method: "get_status" }
{ type: "callback_secret", secret }    // agent tự push, extension chỉ nhận
{ type: "logout" }                      // agent bảo extension clear token
{ type: "please_resend_userinfo" }      // agent cache miss, xin lại profile
```

**Extension → Agent (events / responses):**

```js
{ type: "extension_ready", flowKeyPresent, tokenAge }
{ type: "token_captured", flowKey }    // chỉ gửi khi token XOAY, không mỗi request
{ type: "user_info", userInfo }         // email/name/picture từ oauth2/v2/userinfo
{ type: "ping" } / { type: "pong" }
{ id, status, data }                    // response legacy (qua WS, hiếm)
```

---

## 6. Cơ chế bắt Bearer Token

Đây là "trái tim" — làm sao extension lấy được OAuth token của user mà
**không cần user copy-paste**.

```js
// extension/background.js
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const authHeader = details.requestHeaders.find(
      (h) => h.name?.toLowerCase() === 'authorization'
    );
    if (!authHeader?.value.startsWith('Bearer ya29.')) return;

    flowKey = authHeader.value.replace(/^Bearer\s+/i, '').trim();
    metrics.tokenCapturedAt = Date.now();
    chrome.storage.local.set({ flowKey, metrics });

    if (tokenChanged && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'token_captured', flowKey }));
      fetchAndPushUserInfo(token);
    }
  },
  { urls: ['https://aisandbox-pa.googleapis.com/*', 'https://labs.google/*'] },
  ['requestHeaders', 'extraHeaders'],
);
```

**Cơ chế hoạt động từng bước:**

1. User mở `https://labs.google/fx/tools/flow` trong Chrome.
2. Web của Google gọi `https://aisandbox-pa.googleapis.com/v1/...` với
   header `Authorization: Bearer ya29.…` (do Google OAuth cấp cho user).
3. `webRequest.onBeforeSendHeaders` chặn trước khi request rời browser
   (option `extraHeaders` bắt buộc vì `Authorization` bị coi là extra).
4. Extension lọc token, lưu vào `chrome.storage.local` + bộ nhớ.
5. So sánh với token cũ: chỉ gửi `token_captured` sang agent **khi token
   xoay** (`tokenChanged`). Lý do: poll loop của agent tạo hàng chục
   request/phút → nếu gửi `token_captured` mỗi lần sẽ spam `/v1/credits`
   fetch (infinite loop credits storm).
6. Sau khi có token, gọi `https://www.googleapis.com/oauth2/v2/userinfo`
   để lấy email/name/picture, đẩy sang agent qua `{type:"user_info"}`.

**Vòng đời của token:**

- User logout labs.google → Google app tự revoke token → request tiếp
  theo sẽ fail với 401.
- User login lại → `webRequest` bắt token mới → `tokenChanged=true` →
  agent nhận token mới.
- Agent có thể chủ động gửi `{type:"logout"}` sang extension khi user
  bấm logout trong frontend → extension clear `flowKey` + `cachedUserInfo`.

**Bảo mật token:**

- `flowKey` **không bao giờ** `console.log` trong extension.
- `cachedUserInfo` chỉ in-memory (PII), **không persist** vào
  `chrome.storage.local` — comment trong code giải thích: storage là
  plaintext trên disk + extension khác có `storage` permission có thể
  đọc.
- Khi extension restart, agent replay token từ state của nó; nếu user
  vẫn đang login ở Flow thì token được capture lại khi có request mới.

---

## 7. Cơ chế giải reCAPTCHA Enterprise

### 7.1. Vấn đề

Google Flow yêu cầu **reCAPTCHA Enterprise token** trong mỗi request
generation. Khác với reCAPTCHA v2/v3 miễn phí:

- Token **single-use** — gọi API xong là vô giá trị.
- Token **bound to browser context** — server không lấy được.
- Mỗi generation phải lấy token mới từ `window.grecaptcha.enterprise.execute()`.
- Site key chỉ work trên domain `labs.google`.

Token phải được vá vào **2 vị trí** trong body request:

```json
{
  "clientContext": {
    "recaptchaContext": {
      "applicationType": "RECAPTCHA_APPLICATION_TYPE_WEB",
      "token": "<TOKEN Ở ĐÂY>"
    }
  }
}
// hoặc cho batch:
{
  "requests": [
    { "clientContext": { "recaptchaContext": { "token": "<TOKEN>" } } },
    { "clientContext": { "recaptchaContext": { "token": "<TOKEN>" } } }
  ]
}
```

### 7.2. Ba lớp JavaScript context

Chrome MV3 ngăn cách các world bằng `ISOLATED` boundary. Service worker
và content script **không thể** truy cập `window.grecaptcha` của page.
Vì vậy extension dùng **3 lớp**:

```
┌────────────────────────────────────────────────────────────┐
│ LỚP 1: Background (service worker)                         │
│   background.js                                            │
│   - KHÔNG có window, KHÔNG có grecaptcha                   │
│   - Gọi chrome.tabs.sendMessage(tabId, {GET_CAPTCHA})      │
│   - Validate response → vá token vào body → fetch()        │
└──────────────────────┬─────────────────────────────────────┘
                       │ chrome.runtime.onMessage
                       ▼
┌────────────────────────────────────────────────────────────┐
│ LỚP 2: Content script (ISOLATED world)                     │
│   content.js — chạy document_start trên labs.google        │
│   - Inject injected.js vào MAIN world                      │
│   - KHÔNG có window.grecaptcha (cross-world)               │
│   - Bridge: nhận message từ background                     │
│     → dispatch CustomEvent 'GET_CAPTCHA' lên window        │
│     → nghe CustomEvent 'CAPTCHA_RESULT'                    │
│     → reply về background                                  │
└──────────────────────┬─────────────────────────────────────┘
                       │ CustomEvent (window.dispatchEvent)
                       ▼
┌────────────────────────────────────────────────────────────┐
│ LỚP 3: Injected script (MAIN world)                        │
│   injected.js — nạp vào <head> bằng <script src=…>         │
│   - CÓ window.grecaptcha.enterprise.execute()              │
│   - Nhận CustomEvent 'GET_CAPTCHA'                         │
│   - await waitForGrecaptcha() — chờ grecaptcha load       │
│   - token = await grecaptcha.enterprise.execute(siteKey,   │
│       { action: 'IMAGE_GENERATION' hoặc 'VIDEO_GENERATION' })│
│   - dispatch CustomEvent 'CAPTCHA_RESULT' {token}          │
└────────────────────────────────────────────────────────────┘
```

### 7.3. Site key & action

```js
// extension/injected.js
const SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';
const token = await window.grecaptcha.enterprise.execute(SITE_KEY, {
  action: pageAction,  // 'IMAGE_GENERATION' / 'VIDEO_GENERATION'
});
```

```python
# agent/flowboard/services/flow_sdk.py
CAPTCHA_IMAGE = "IMAGE_GENERATION"
CAPTCHA_VIDEO = "VIDEO_GENERATION"
```

Site key `6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV` là public (lộ trong
HTML của labs.google). Nếu Google xoay key, hệ thống gãy → cần update
hardcoded constant.

### 7.4. Code chi tiết từng lớp

**content.js** (~30 dòng):

```js
(function () {
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('injected.js');
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);
})();

chrome.runtime.onMessage.addListener((msg, _, reply) => {
  if (msg.type !== 'GET_CAPTCHA') return;
  const { requestId, pageAction } = msg;

  const handler = (e) => {
    if (e.detail?.requestId === requestId) {
      window.removeEventListener('CAPTCHA_RESULT', handler);
      clearTimeout(timer);
      reply({ token: e.detail.token, error: e.detail.error });
    }
  };

  const timer = setTimeout(() => {
    window.removeEventListener('CAPTCHA_RESULT', handler);
    reply({ error: 'CONTENT_TIMEOUT' });
  }, 25000);

  window.addEventListener('CAPTCHA_RESULT', handler);

  window.dispatchEvent(new CustomEvent('GET_CAPTCHA', {
    detail: { requestId, pageAction },
  }));

  return true;  // keep channel open for async reply
});
```

**injected.js** (~40 dòng):

```js
const SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';

window.addEventListener('GET_CAPTCHA', async ({ detail }) => {
  const { requestId, pageAction } = detail;
  try {
    await waitForGrecaptcha();
    const token = await window.grecaptcha.enterprise.execute(SITE_KEY, {
      action: pageAction,
    });
    window.dispatchEvent(new CustomEvent('CAPTCHA_RESULT', {
      detail: { requestId, token },
    }));
  } catch (e) {
    window.dispatchEvent(new CustomEvent('CAPTCHA_RESULT', {
      detail: { requestId, error: e.message },
    }));
  }
});

function waitForGrecaptcha(timeout = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (window.grecaptcha?.enterprise?.execute) return resolve();
      if (Date.now() - start > timeout) return reject(new Error('grecaptcha not available'));
      setTimeout(check, 200);
    };
    check();
  });
}
```

### 7.5. solveCaptcha — full pipeline trong background

```js
// extension/background.js (rút gọn)
async function solveCaptcha(requestId, captchaAction) {
  const tabs = await chrome.tabs.query({ url: flowUrls });

  // Không có Flow tab nào → mở mới (kể cả khi Chrome không có window)
  if (!tabs.length) {
    try {
      await openFlowTabResilient(false);
      await sleep(3000);
    } catch (e) {
      return { error: e.message || 'NO_FLOW_TAB' };
    }
  }

  // Thử từng tab — skip tab chết, tab discarded
  const candidates = await chrome.tabs.query({ url: flowUrls });
  for (const tab of candidates) {
    const live = await reviveTabIfNeeded(tab);
    if (!live) continue;
    try {
      const resp = await Promise.race([
        requestCaptchaFromTab(live.id, requestId, captchaAction),
        new Promise((_, rej) => setTimeout(() => rej(new Error('CAPTCHA_TIMEOUT')), 30000)),
      ]);
      return resp;
    } catch (e) {
      // Tab chết mid-call → thử tab tiếp theo
      if (msg.includes('No current window') || msg.includes('No tab with id')) continue;
      return { error: msg };
    }
  }

  // Last resort: mở tab mới
  // ...
}
```

### 7.6. Resilience (đã phải đối mặt thực tế)

Từ comment trong code, đây là những edge case đã gặp và xử lý:

- **Tab bị Chrome discard** do RAM: `chrome.tabs.query` vẫn trả về tab
  nhưng `sendMessage` fail với "No current window". `reviveTabIfNeeded`
  reload tab, đợi 2.5s rồi mới gọi lại.
- **Không có Chrome window nào mở**: `chrome.tabs.create` throw "No
  current window". `openFlowTabResilient` fallback sang
  `chrome.windows.create`.
- **Content script chưa inject** (tab mở trước khi extension install):
  `sendMessage` throw "Receiving end does not exist". Extension tự inject
  `content.js` rồi retry.
- **Tab navigate away** mid-call: "No tab with id" → skip sang tab sau.
- **grecaptcha chưa load**: `waitForGrecaptcha` poll 200ms tối đa 10s.
- **Tổng timeout 30s** ở background cho cả hành trình.
- **Content timeout 25s** riêng trong content.js.

---

## 8. Hai loại request: api_request vs trpc_request

### 8.1. `api_request` — media generation

```python
# agent gửi
{ id, method: "api_request", params: {
    url: "https://aisandbox-pa.googleapis.com/v1/...",
    method: "POST",
    headers: { "content-type": "application/json", "accept": "*/*" },
    body: { clientContext: { recaptchaContext: { token: "" }, ... }, ... },
    captchaAction: "VIDEO_GENERATION"   // optional — nếu cần captcha
}}
```

```js
// extension xử lý — handleApiRequest
if (!url.startsWith('https://aisandbox-pa.googleapis.com/')) → 400 INVALID_URL
if (!flowKey) → 503 NO_FLOW_KEY  // fail-fast trước khi giải captcha (waste)

if (captchaAction) {
  const captchaResult = await solveCaptcha(id, captchaAction);
  if (!captchaResult?.token) → 403 CAPTCHA_FAILED
}

// Vá captcha token vào body
if (captchaToken) {
  finalBody = JSON.parse(JSON.stringify(body));  // deep clone
  if (finalBody.clientContext?.recaptchaContext) {
    finalBody.clientContext.recaptchaContext.token = captchaToken;
  }
  for (const req of finalBody.requests || []) {
    if (req.clientContext?.recaptchaContext) {
      req.clientContext.recaptchaContext.token = captchaToken;
    }
  }
}

const resp = await fetch(url, {
  method, headers, credentials: 'include',
  body: method === 'GET' ? undefined : JSON.stringify(finalBody),
});

sendToAgent({ id, status: resp.status, data: parsedJson });
```

**Endpoints hay dùng** (xem `agent/flowboard/services/flow_sdk.py`):

| Endpoint | Captcha? | Dùng cho |
|---|---|---|
| `POST /v1/projects/{id}/flowMedia:batchGenerateImages` | `IMAGE_GENERATION` | Tạo ảnh (GEM_PIX_2 / NARWHAL) |
| `POST /v1/video:batchAsyncGenerateVideoStartImage` | `VIDEO_GENERATION` | Veo 3.1 i2v |
| `POST /v1/video:batchAsyncGenerateVideoReferenceImages` | `VIDEO_GENERATION` | Omni Flash r2v (multi-ref) |
| `POST /v1/video:batchCheckAsyncVideoGenerationStatus` | không | Poll trạng thái operation |
| `GET  /v1/credits` | không | Detect tier Pro/Ultra (gọi thẳng từ httpx) |
| `POST /v1/flow/uploadImage` | không | Upload ảnh reference |

### 8.2. `trpc_request` — project management

```python
{ id, method: "trpc_request", params: {
    url: "https://labs.google/fx/api/trpc/project.createProject",
    method: "POST",
    headers: {},
    body: { json: { ... }, meta: { values: { ... } } }
}}
```

```js
// extension/background.js — handleTrpcRequest
if (!url.startsWith('https://labs.google/fx/api/trpc/')) → error INVALID_TRPC_URL
// No captcha. Just Bearer + cookies.
const resp = await fetch(url, { method, headers, body, credentials: 'include' });
```

Dùng cho: `project.createProject`, `project.searchUserProjects` — tạo
và liệt kê project trên Flow web của user.

### 8.3. So sánh

| | api_request | trpc_request |
|---|---|---|
| URL prefix | `aisandbox-pa.googleapis.com/*` | `labs.google/fx/api/trpc/*` |
| Captcha | Có (cho gen) | Không |
| Log/metrics | Có (request log, success/fail count) | Silent |
| Timeout mặc định | 180s | 30s |
| `credentials: 'include'` | Có | Có |
| Bearer | Có | Có |

---

## 9. Quy trình end-to-end (một generation request)

Ví dụ: user bấm `▶ Generate` trên canvas để tạo video từ ảnh reference.

```
Tầng 1: Frontend (React)
  User click ▶ Generate trên video node
    ↓
  POST /api/requests { node_id, type: 'video_i2v', params }
    ↓

Tầng 2: Agent (Python)
  routes/requests.py nhận request → tạo row trong DB (status=queued)
    ↓
  worker/processor.py đẩy job vào asyncio queue
    ↓
  flow_sdk.gen_video_i2v() build body:
    - clientContext.userPaygateTier = "PAYGATE_TIER_TWO" (Ultra)
    - clientContext.recaptchaContext.token = ""  ← placeholder
    - videoModelKey = "veo_3_1_i2v_s_fast_portrait_ultra"
    - startImage.mediaId = "<id ảnh từ node trước>"
    - requests[] có 1 item
    ↓
  flow_client.api_request(VIDEO_I2V_URL, body, captcha_action='VIDEO_GENERATION')
    ↓
  → WS frame: {id: "uuid-xxx", method: "api_request", params: {...}}
    ↓

Tầng 3: Extension (Chrome)
  background.js nhận WS message
    ↓
  handleApiRequest(msg):
    1. Validate URL prefix ✓
    2. flowKey exists ✓ (đã capture từ trước)
    3. solveCaptcha("uuid-xxx", "VIDEO_GENERATION"):
       - Tìm tab Flow → có sẵn
       - chrome.tabs.sendMessage(tabId, {type: 'GET_CAPTCHA', ...})
         ↓
       - content.js nhận → dispatch CustomEvent 'GET_CAPTCHA'
         ↓
       - injected.js nhận → grecaptcha.enterprise.execute(
           "6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV",
           { action: "VIDEO_GENERATION" }
         ) → token
         ↓
       - injected.js dispatch CustomEvent 'CAPTCHA_RESULT' {token}
         ↓
       - content.js reply({token}) về background
    4. Vál token: body.clientContext.recaptchaContext.token = <new>
    5. fetch(VIDEO_I2V_URL, {
         method: 'POST',
         headers: {
           authorization: 'Bearer ya29.…',
           'content-type': 'application/json',
           'accept': '*/*',
         },
         credentials: 'include',  ← cookies từ labs.google session
         body: JSON.stringify(body),
       })
       + DNR tự sửa Referer: https://labs.google/  + Origin: https://labs.google
    6. Response 200 + JSON { operations: [{ operation: { name: "..." } }] }
    7. POST http://127.0.0.1:8101/api/ext/callback {
         id: "uuid-xxx",
         status: 200,
         data: { operations: [...] }
       }
       + X-Callback-Secret header
    ↓

Tầng 2: Agent (tiếp)
  main.py ext_callback() nhận:
    - Verify hmac.compare_digest(secret) ✓
    - flow_client.resolve_callback(payload) → resolve future
    ↓
  flow_client._send() future resolved → api_request returns
    ↓
  flow_sdk gen_video_i2v returns { raw, operation_name, ... }
    ↓
  worker lưu operation_name vào DB (request.status='processing')
    ↓
  worker gửi WS event 'node.updated' qua /ws/board/:id
    ↓

Tầng 1: Frontend (tiếp)
  React nhận WS event → re-render node với status='processing'
  Bắt đầu poll loop: gọi batchCheckAsyncVideoGenerationStatus
  mỗi vài giây (KHÔNG cần captcha)
    ↓
  Khi operation.done=true → response có fifeUrl
  → frontend download → lưu local qua /media/:uuid
  → node chuyển sang status='success', hiển thị video player
```

**Tổng cộng:** ít nhất 2 lần qua extension (1 gen + N poll), 1 lần giải
captcha cho gen. Poll loop chạy `api_request` không có captcha — nhẹ
hơn nhiều.

---

## 10. Quản lý tab Flow

Extension phải đảm bảo luôn có một tab `labs.google/fx/tools/flow` đang
mở để giải captcha. Nhưng tab có thể:

- **Được user đóng** → mở lại.
- **Bị Chrome discard** do RAM (background tab) → reload.
- **Bị navigate đi chỗ khác** → tìm tab khác hoặc mở mới.
- **Chrome không có window nào mở** (user đóng hết) → `windows.create`.

Tất cả được gom trong `openFlowTabResilient` và `reviveTabIfNeeded`:

```js
// Mở tab Flow — fallback khi không có Chrome window
async function openFlowTabResilient(active = false) {
  try {
    return await chrome.tabs.create({ url: FLOW_URL, active });
  } catch (e) {
    if (!e.message.includes('No current window')) throw e;
    const win = await chrome.windows.create({
      url: FLOW_URL,
      focused: false,
      state: 'minimized',  // không chiếm focus của user
    });
    return win.tabs?.[0] ?? null;
  }
}

// Revive tab bị Chrome discard
async function reviveTabIfNeeded(tab) {
  if (!tab?.discarded) return tab;
  try {
    await chrome.tabs.reload(tab.id);
    await sleep(2500);  // đợi page load
    return await chrome.tabs.get(tab.id);
  } catch { return null; }
}
```

Khi `solveCaptcha` chạy, nó:

1. Tìm tất cả tab match URL pattern.
2. Nếu không có → spawn tab mới (kể cả khi không có window).
3. Thử từng candidate, skip tab chết/discarded.
4. Last resort: spawn fresh tab và try once.

---

## 11. Trạng thái & metrics

Extension có 3 trạng thái hiển thị trên badge:

```js
const badges = { idle: '●', running: '▶', off: '○' };
const colors  = { idle: '#22c55e', running: '#f5b301', off: '#6b7280' };
```

Metrics tracked:

```js
{
  tokenCapturedAt: number,  // ms timestamp
  requestCount:    0,
  successCount:    0,
  failedCount:     0,
  lastError:       null,
}
```

Request log (ring buffer 50 entries):

```js
function classifyUrl(url) {
  if (url.includes('batchGenerateImages'))     return 'GEN_IMG';
  if (url.includes('batchAsyncGenerateVideo')) return 'GEN_VID';
  if (url.includes('batchCheckAsync'))         return 'POLL';
  return 'API';
}

addRequestLog({
  id, type, time: new Date().toISOString(),
  status: 'processing' | 'success' | 'failed',
  url, httpStatus?, error?,
});
```

`trpc_request` **không** log/metrics (silent) — chỉ log generation/poll.

Popup UI (`popup.html` 260px):

- Status: ● connected / ▶ running / ○ offline
- Token: "captured 5m ago" hoặc "none"
- Requests: `12 · ✓ 10 · ✗ 2`
- Error: nếu có
- 3 nút: **Open Flow tab** / **Refresh token** / **Disconnect**

---

## 12. Mô hình bảo mật

| Vấn đề | Cách xử lý | Dòng code |
|---|---|---|
| PII rò rỉ qua `chrome.storage` | `userInfo` chỉ in-memory, không persist | background.js init() |
| Token log ra console | `flowKey` không bao giờ `console.log` | toàn bộ background.js |
| Agent bị hijack gọi domain lạ | Whitelist URL prefix chặt | handleApiRequest, handleTrpcRequest |
| WS drop mất response | HTTP callback primary + WS fallback | sendToAgent |
| `token_captured` spam | Chỉ gửi khi token xoay (`tokenChanged`) | webRequest listener |
| Older extension vẫn spam | Agent cũng dedupe 60s | `_TIER_REFRESH_MIN_INTERVAL_S` |
| Captcha single-use bị waste | Fail-fast `NO_FLOW_KEY` trước khi giải captcha | handleApiRequest step 0 |
| Callback secret leaked trong URL | Secret chỉ trong header `X-Callback-Secret` | sendToAgent, main.py |
| Timing attack so sánh secret | `hmac.compare_digest` (constant-time) | main.py ext_callback |
| Race condition resolve future | `_resolve` check `fut.done()` trước `set_result` | flow_client.py |
| Secret rotated mỗi agent restart | `secrets.token_urlsafe(32)` | flow_client.py `__init__` |
| Tab lifecycle bất ổn | Resilient open + revive + skip dead tabs | openFlowTabResilient, reviveTabIfNeeded |

**Các giới hạn chưa giải quyết:**

- Nếu Google xoay reCAPTCHA site key → phải update `injected.js`.
- Nếu Google xoay model key (e.g. `veo_3_1_i2v_s_fast_portrait_ultra` →
  đổi tên) → phải update `flow_sdk.py`. Code có comment cảnh báo.
- Nếu user login ở 2 tài khoản cùng lúc → extension chỉ capture 1 token
  (token mới nhất thắng).

---

## 13. Declarative Net Request (sửa header đi)

Một quy tắc duy nhất nhưng **then chốt** để không bị server từ chối:

```json
{
  "id": 1,
  "priority": 1,
  "action": {
    "type": "modifyHeaders",
    "requestHeaders": [
      { "header": "Referer", "operation": "set", "value": "https://labs.google/" },
      { "header": "Origin",  "operation": "set", "value": "https://labs.google" }
    ]
  },
  "condition": {
    "urlFilter": "aisandbox-pa.googleapis.com",
    "resourceTypes": ["xmlhttprequest"]
  }
}
```

Mọi `fetch()` từ background tới `aisandbox-pa.googleapis.com` sẽ tự
động được gắn đúng `Referer` + `Origin`. Không cần extension tự set.

Không có rule này: request từ `chrome-extension://...` sẽ bị server-side
CORS check reject.

---

## 14. Phạm vi & giới hạn

### 14.1. Trong phạm vi (đã chạy)

- ✅ Capture Bearer token từ session labs.google
- ✅ Proxy `api_request` (Veo 3.1, GEM_PIX_2, NARWHAL, Omni Flash)
- ✅ Proxy `trpc_request` (project create/search)
- ✅ Giải reCAPTCHA Enterprise với 3-layer context bridge
- ✅ Detect paygate tier qua `/v1/credits`
- ✅ User info qua `/oauth2/v2/userinfo`
- ✅ Reconnect, keepalive, tab resilience
- ✅ Popup UI status + controls

### 14.2. Out of scope (chưa làm)

- ❌ Side panel (Chrome UI mới hơn popup)
- ❌ Agent-side listener tự động forward media URL từ TRPC response
  (hiện media URL lấy từ `data.media[].image.fifeUrl` trong response
  trực tiếp của `api_request`)
- ❌ Multi-account / multi-profile
- ❌ Auto token refresh khi gần hết hạn (token chỉ xoay khi user có
  request mới tới `aisandbox-pa`)
- ❌ Tự mở Flow tab khi agent boot (user phải mở thủ công lần đầu)

### 14.3. Cảnh báo vận hành

- **Gói Google Flow: chỉ Pro/Ultra** — tài khoản Free không có
  `PAYGATE_TIER_ONE/TWO` nên model key fail với "model not available"
  hoặc tương tự. Frontend hiển thị tier rõ ràng trước khi cho bấm
  Generate.
- **reCAPTCHA có rate limit per IP/device** — nếu giải quá nhiều trong
  thời gian ngắn (batch lớn), Google có thể trả challenge ảnh thay vì
  token. Chưa thấy trong thực tế với usage của Flowboard, nhưng cần
  lưu ý.
- **Model key có thể Google xoay bất cứ lúc nào** — repo có
  `docs/.../video_model.md` và `video_model_ultra.md` (curl exports thủ
  công từ DevTools) để verify khi cần update.

---

## 15. Tham chiếu file

### Extension

| File | Dòng | Mục đích |
|---|---|---|
| `extension/manifest.json` | ~30 | MV3 manifest, permissions |
| `extension/background.js` | 707 | Service worker — điều phối chính |
| `extension/content.js` | ~30 | ISOLATED world bridge |
| `extension/injected.js` | ~40 | MAIN world — grecaptcha |
| `extension/rules.json` | ~20 | DNR — sửa Referer/Origin |
| `extension/popup.html` | ~100 | UI 260px |
| `extension/popup.js` | ~100 | Polling + button handlers |
| `extension/README.md` | ~40 | Hướng dẫn cài đặt |

### Agent (phần liên quan)

| File | Mục đích |
|---|---|
| `agent/flowboard/services/ws_server.py` | WebSocket server :9223 |
| `agent/flowboard/services/flow_client.py` | Singleton `FlowClient` — gửi lệnh + nhận response |
| `agent/flowboard/services/flow_sdk.py` | High-level helpers (gen_image, gen_video, create_project…) |
| `agent/flowboard/main.py` | FastAPI app + `/api/ext/callback` endpoint |

### Tài liệu liên quan

- `README.md` — overview dự án (tiếng Việt)
- `docs/PLAN.md` — kế hoạch tổng thể + API surface
- `extension/README.md` — hướng dẫn cài extension

---

## 16. Glossary

| Thuật ngữ | Nghĩa |
|---|---|
| **Bearer token** | OAuth 2.0 access token, dạng `ya29.…`, Google cấp cho user login |
| **reCAPTCHA Enterprise** | reCAPTCHA bản trả phí của Google, anti-bot nâng cao |
| **site key** | Public key (lộ trong HTML) để `grecaptcha.execute()` gọi đúng widget |
| **action** | Tham số cho `execute()` — ở đây là `IMAGE_GENERATION` / `VIDEO_GENERATION` |
| **MAIN world** | JavaScript context của page — có `window.grecaptcha` |
| **ISOLATED world** | JavaScript context riêng của content script — KHÔNG có `window.grecaptcha` |
| **service worker** | Background script của MV3, có lifecycle riêng (bị Chrome ngủ khi idle) |
| **DNR** | `declarativeNetRequest` — Chrome API để sửa request mà không cần `webRequest` blocking |
| **PAYGATE_TIER_ONE/TWO** | Flow tier Pro / Ultra, gắn với gói trả phí |
| **TRPC** | Framework RPC của Vercel; Flow web dùng nó cho project mgmt |
| **flowKey** | Tên nội bộ của Bearer token trong code (chỉ là alias cho dễ đọc) |
