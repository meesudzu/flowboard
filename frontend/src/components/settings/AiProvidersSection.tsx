import { useCallback, useEffect, useRef, useState } from "react";
import {
  getLlmConfig,
  getLlmProviders,
  setLlmApiKey,
  setLlmConfig,
  testLlmProvider,
  type LLMConfig,
  type LLMProviderInfo,
  type LLMProviderName,
} from "../../api/client";
import { ProviderCard } from "./ProviderCard";
import { ProviderSetupModal } from "./ProviderSetupModal";

/**
 * MiniMax-only AI Providers section.
 *
 * Single-provider model — one AI provider serves all 3 features
 * (Auto-Prompt / Vision / Planner). The user pastes a MiniMax Bearer
 * key, runs ONE connection test, then Apply commits the change to all
 * 3 features.
 *
 * Why one test instead of three: in single-provider mode, the 3 tests
 * were 3 identical pings against the same endpoint with the same
 * prompt. Three parallel pings used to trigger rate limits on
 * MiniMax (per-user concurrent call budget), so we collapsed to a
 * single ping — if MiniMax answers `.` once, all 3 dispatch paths can
 * use it.
 *
 * MiniMax-only philosophy: the cloud-VPS image has no OAuth CLIs
 * installed (Claude / Gemini / OpenAI Codex), so the only viable
 * transport is REST. xAI Grok was considered but never shipped an
 * end-user CLI. The earlier multi-provider design (CLI + REST) was
 * removed for this build.
 *
 * Layout:
 *   1. MiniMax card
 *   2. Selection panel (visible after card is selected):
 *      a. Inline API-key paste (when no key set, or when "Update API
 *         key" was clicked to rotate).
 *      b. Connection test + Apply (when key is set).
 */

const REFRESH_INTERVAL_MS = 30_000;
// MiniMax-only: there's a single provider surfaced. Keeping the array
// shape (instead of a single literal) so a future cloud-VPS image that
// re-enables another API-key provider can add it by editing this file
// only.
const SHOWN_PROVIDERS: LLMProviderName[] = ["minimax"];
// First-run default selection. The MiniMax card is the only one in
// the cloud-VPS build, so it's also the default that gets
// pre-selected on a fresh install to avoid a blank panel.
const FIRST_RUN_DEFAULT: LLMProviderName = "minimax";

// No install command — MiniMax is REST-only. The record is keyed by
// LLMProviderName so the CliReference component can stay generic, but
// only the MiniMax entry is reachable from the UI. Unknown / disabled
// entries carry empty URLs so the CliReference footer skips them
// cleanly.
const API_REFERENCE: Record<
  LLMProviderName,
  { docsUrl: string; docsLabel: string }
> = {
  minimax: {
    docsUrl: "https://platform.minimax.io/docs/api-reference/text-post",
    docsLabel: "Tài liệu API MiniMax",
  },
};
type TestState = "untested" | "testing" | "ok" | "fail";
interface ConnectionTestResult {
  state: TestState;
  error?: string;
  latencyMs?: number;
}

const INITIAL_TEST: ConnectionTestResult = { state: "untested" };

function deriveCurrent(config: LLMConfig | null): LLMProviderName | null {
  // "Nhà cung cấp đang dùng" = the one all 3 features point at. Any
  // null slot or any divergence (legacy mixed config / partial pick)
  // returns null so the UI prompts the user to consolidate.
  if (!config) return null;
  const a = config.auto_prompt;
  if (a === null) return null;
  if (a === config.vision && config.vision === config.planner) {
    return a;
  }
  return null;
}

export function AiProvidersSection() {
  const [providers, setProviders] = useState<LLMProviderInfo[] | null>(null);
  const [config, setConfig] = useState<LLMConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // The card the user has clicked (their pending selection). Defaults
  // to whatever's currently active so opening the dialog doesn't show
  // a blank state.
  const [pending, setPending] = useState<LLMProviderName | null>(null);
  const [test, setTest] = useState<ConnectionTestResult>(INITIAL_TEST);
  const [applying, setApplying] = useState(false);
  // True when the user is replacing an already-saved API key (the
  // "ready" branch normally hides the paste input; this flag re-shows
  // it with a "rotate key" affordance).
  const [editingKey, setEditingKey] = useState(false);
  const [helpFor, setHelpFor] = useState<LLMProviderName | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // Module-level ref shared with ApiKeyInput so the input can no-op
  // its setState after the component unmounts (the parent refreshes
  // + re-renders after save, which would otherwise race against
  // in-flight state updates).
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [p, c] = await Promise.all([getLlmProviders(), getLlmConfig()]);
      if (!aliveRef.current) return;
      setProviders(p);
      setConfig(c);
      setLoadError(null);
    } catch (err) {
      if (!aliveRef.current) return;
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Initial load + 30s polling, visibility-aware.
  useEffect(() => {
    void refresh();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, REFRESH_INTERVAL_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refresh]);

  // Once the first /config arrives, seed the pending selection. Two
  // cases:
  //   - User already has a configured provider → seed with it so Apply
  //     is a no-op until they pick something different.
  //   - Fresh install (no current) → seed with FIRST_RUN_DEFAULT
  //     (MiniMax) so the panel opens with the card pre-selected and
  //     the user sees the API-key paste input immediately, instead of
  //     a blank state.
  const current = deriveCurrent(config);
  useEffect(() => {
    if (pending !== null || config === null) return;
    if (current !== null && SHOWN_PROVIDERS.includes(current)) {
      setPending(current);
    } else {
      setPending(FIRST_RUN_DEFAULT);
    }
  }, [current, pending, config]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }

  function handleSelect(name: LLMProviderName) {
    if (name === pending) return;
    setPending(name);
    // Switching the candidate provider invalidates any prior test
    // result — it was against a different target.
    setTest(INITIAL_TEST);
    setEditingKey(false);
  }

  async function runTest() {
    if (!pending) return;
    setTest({ state: "testing" });
    const result = await testLlmProvider(pending);
    setTest(
      result.ok
        ? { state: "ok", latencyMs: result.latencyMs }
        : { state: "fail", error: result.error || "test failed" },
    );
  }

  async function handleApply() {
    if (!pending || applying) return;
    setApplying(true);
    try {
      // Single-provider model: every feature points at the same name.
      await setLlmConfig({
        auto_prompt: pending,
        vision: pending,
        planner: pending,
      });
      showToast(`Đã chuyển nhà cung cấp AI sang ${labelOf(pending)}.`);
      await refresh();
      // Broadcast so the badge + ForcedSetupGate refresh immediately
      // instead of waiting up to 30s for their own poll. Plain window
      // event keeps the contract loose — anyone interested subscribes,
      // no shared store coupling.
      window.dispatchEvent(new CustomEvent("flowboard:llm-config-changed"));
      // Tests stay valid after Apply — provider hasn't changed, we
      // just persisted the selection.
    } catch (err) {
      showToast(
        `Không thể áp dụng: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      if (aliveRef.current) setApplying(false);
    }
  }

  // ── Render guards ───────────────────────────────────────────────

  if (!providers && !config && !loadError) {
    return (
      <div className="ai-providers-section">
        <div className="ai-providers-section__skeleton">
          <div className="ai-providers-section__skeleton-row" />
          <div className="ai-providers-section__skeleton-row" />
          <div className="ai-providers-section__skeleton-row ai-providers-section__skeleton-row--tall" />
        </div>
      </div>
    );
  }

  if (loadError && (!providers || !config)) {
    return (
      <div className="ai-providers-section">
        <div className="ai-providers-section__error" role="alert">
          ⚠ Không tải được trạng thái nhà cung cấp AI.
          <button
            type="button"
            className="ai-providers-section__retry"
            onClick={() => void refresh()}
          >
            Thử lại
          </button>
          <div className="ai-providers-section__error-detail">{loadError}</div>
        </div>
      </div>
    );
  }

  // Past this point, providers + config are non-null.
  const byName: Record<LLMProviderName, LLMProviderInfo | undefined> = {
    minimax: providers!.find((p) => p.name === "minimax"),
  };

  const pendingProvider = pending ? byName[pending] : null;
  const ready = !!pendingProvider && pendingProvider.available && pendingProvider.configured;
  const testPassed = test.state === "ok";
  const testRunning = test.state === "testing";
  const selectionUnchanged = pending !== null && pending === current;
  const canApply =
    ready
    && testPassed
    && !applying
    && !testRunning
    && !selectionUnchanged;

  return (
    <div className="ai-providers-section">
      <div className="ai-providers-section__intro">
        MiniMax vận hành Flowboard trên bản này — dán API key, kiểm tra
        kết nối, rồi bấm Áp dụng. Một nhà cung cấp phục vụ cả ba tính
        năng (Tự viết prompt / Xem ảnh / Lập kế hoạch).
      </div>

      {current === null && config !== null && !config.configured
        && (config.auto_prompt || config.vision || config.planner) && (
        // Mixed-state notice — at least one feature has been pinned but
        // not all three (or they diverge). Click the card below to
        // consolidate every feature onto MiniMax.
        <div className="ai-providers-section__mixed-notice" role="alert">
          ⓘ Các tính năng chưa dùng cùng nhà cung cấp
          ({config.auto_prompt ?? "—"} / {config.vision ?? "—"} / {config.planner ?? "—"}).
          Bấm vào thẻ MiniMax bên dưới rồi Áp dụng để gộp lại.
        </div>
      )}

      {/* MiniMax-only build: only the MiniMax card is rendered. The
          `provider-group__title` is dropped because there's no
          "OAuth vs API Key" distinction on the cloud-VPS image. */}
      <div className="provider-group">
        <div className="provider-group__cards">
          {SHOWN_PROVIDERS.map((name) => {
            const p = byName[name];
            if (!p) return null;
            return (
              <ProviderCard
                key={name}
                provider={p}
                selected={pending === name}
                current={current === name}
                onSelect={handleSelect}
              />
            );
          })}
        </div>
      </div>

      {pending && pendingProvider && (
        <div className="selection-panel">
          {ready && pendingProvider.requiresKey && editingKey ? (
            // Edit-in-place branch — the user clicked "Cập nhật API key"
            // on an already-configured provider, so we re-render the
            // paste input (with a Cancel button) on top of the
            // test/apply row. Saving rotates the key in
            // ~/.flowboard/secrets.json; the test row resets to
            // "untested" so the next ping goes against the new key.
            <ApiKeyInput
              provider={pending}
              editing
              onSaved={async () => {
                setEditingKey(false);
                setTest(INITIAL_TEST);
                await refresh();
              }}
              onCancel={() => setEditingKey(false)}
            />
          ) : !ready ? (
            // API-key-only build: show a paste-key input. Saving
            // the key moves the panel into the "ready" branch
            // and the user can run the connection test.
            <ApiKeyInput
              provider={pending}
              onSaved={refresh}
              onShowHelp={() => setHelpFor(pending)}
            />
          ) : (
            // Ready branch: provider is connected. Show ONE connection
            // test + Apply. One ping is sufficient — Auto-Prompt /
            // Vision / Planner all hit the same provider in
            // single-provider mode, so a working ping for one is a
            // working ping for all three.
            <>
              <div className="selection-panel__heading">
                Kiểm tra kết nối, rồi bấm Áp dụng
              </div>
              <ConnectionTestRow
                providerLabel={labelOf(pending)}
                result={test}
                onTest={runTest}
              />

              {pendingProvider.requiresKey && (
                // Rotate-key affordance sits directly under the test
                // box (not below the Apply button) so the user can
                // swap a leaked/expired key in one motion: Test →
                // Update API key → Test again. Clicking flips the
                // panel into the editingKey branch above; the next
                // save overwrites ~/.flowboard/secrets.json in place.
                <button
                  type="button"
                  className="selection-panel__update-key-btn"
                  onClick={() => setEditingKey(true)}
                >
                  Cập nhật API key
                </button>
              )}

              <div className="selection-panel__actions">
                <button
                  type="button"
                  className="selection-panel__apply-btn"
                  onClick={handleApply}
                  disabled={!canApply}
                  title={
                    selectionUnchanged
                      ? `${labelOf(pending)} đã đang được dùng.`
                      : !testPassed
                        ? "Chạy kiểm tra kết nối thành công để bật nút Áp dụng."
                        : `Áp dụng ${labelOf(pending)} cho tất cả tính năng.`
                  }
                >
                  {applying
                    ? "Đang áp dụng…"
                    : selectionUnchanged
                      ? "Đang dùng"
                      : "Áp dụng thay đổi"}
                </button>
              </div>

              <ApiReference provider={pending} />
            </>
          )}
        </div>
      )}

      {toast && (
        <div className="ai-providers-section__toast" role="alert">
          {toast}
        </div>
      )}

      <ProviderSetupModal
        provider={helpFor ?? "minimax"}
        open={helpFor !== null}
        onClose={() => setHelpFor(null)}
      />
    </div>
  );
}

interface ConnectionTestRowProps {
  providerLabel: string;
  result: ConnectionTestResult;
  onTest(): void;
}

/** Single connection test for the selected provider. Replaces the old
 * 3-feature test list — one ping is sufficient because all 3 features
 * point at the same provider in single-provider mode. */
function ConnectionTestRow({ providerLabel, result, onTest }: ConnectionTestRowProps) {
  const icon =
    result.state === "ok"
      ? "✓"
      : result.state === "fail"
        ? "✗"
        : result.state === "testing"
          ? "⏳"
          : "○";
  const subtitle =
    result.state === "ok" && result.latencyMs != null
      ? `Đã kết nối · ${result.latencyMs}ms · phục vụ Tự viết prompt, Xem ảnh, Lập kế hoạch`
      : result.state === "fail" && result.error
        ? result.error
        : result.state === "testing"
          ? "Đang gọi MiniMax…"
          : "Gửi một prompt ngắn để kiểm tra MiniMax có phản hồi không.";
  return (
    <div className={`feature-test-row feature-test-row--${result.state}`}>
      <span
        className={`feature-test-row__icon feature-test-row__icon--${result.state}`}
        aria-hidden="true"
      >
        {icon}
      </span>
      <div className="feature-test-row__body">
        <span className="feature-test-row__name">
          Kết nối {providerLabel}
        </span>
        <span
          className={
            result.state === "fail"
              ? "feature-test-row__error"
              : result.state === "ok"
                ? "feature-test-row__latency"
                : "feature-test-row__hint"
          }
        >
          {subtitle}
        </span>
      </div>
      <button
        type="button"
        className="feature-test-row__btn"
        onClick={onTest}
        disabled={result.state === "testing"}
      >
        {result.state === "testing"
          ? "Đang kiểm tra…"
          : result.state === "ok"
            ? "Kiểm tra lại"
            : result.state === "fail"
              ? "Thử lại"
              : "Kiểm tra"}
      </button>
    </div>
  );
}

/**
 * Footer shown below the test checklist with a link to the provider's
 * API reference docs. Replaces the old CLI install reference (no
 * install commands in the API-only build) but keeps the same DOM
 * shape so the surrounding layout doesn't shift.
 */
interface ApiReferenceProps {
  provider: LLMProviderName;
}

function ApiReference({ provider }: ApiReferenceProps) {
  const ref = API_REFERENCE[provider];
  return (
    <div className="cli-reference">
      <a
        className="cli-reference__docs-link"
        href={ref.docsUrl}
        target="_blank"
        rel="noopener noreferrer"
      >
        Mở {ref.docsLabel} ↗
      </a>
    </div>
  );
}

/**
 * Inline API-key paste row for providers that take a Bearer key. Shown
 * when the user picks MiniMax on a fresh install (no key set yet)
 * and also when they click "Cập nhật API key" on an already-configured
 * provider (with `editing=true`). Save is gated on a non-empty
 * value; the backend chmods secrets.json to 0o600 and busts the
 * provider's availability cache so the panel flips to the "ready /
 * test" branch immediately after a successful save.
 */
interface ApiKeyInputProps {
  provider: LLMProviderName;
  onSaved(): void | Promise<void>;
  /** First-time-setup only — the "Setup help →" link. Omit when
   *  `editing=true` since the user is past setup. */
  onShowHelp?(): void;
  /** True when the user is rotating an already-saved key. Flips the
   *  copy (heading / hint) and swaps the "Trợ giúp cài đặt" CTA for a
   *  Cancel button so the user can back out of the rotation without
   *  saving. */
  editing?: boolean;
  /** Required when `editing=true`. Called from the Cancel button. */
  onCancel?(): void;
}

function ApiKeyInput({ provider, onSaved, onShowHelp, editing, onCancel }: ApiKeyInputProps) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function handleSave() {
    if (!value.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await setLlmApiKey(provider, value.trim());
      setSaved(true);
      setValue("");
      // Force the parent to re-fetch providers so the `ready` check
      // flips and the panel moves into the test row.
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (aliveRefGlobal.current) setSaving(false);
    }
  }

  return (
    <div className="selection-panel__setup">
      <div className="selection-panel__heading">
        {editing
          ? `Cập nhật ${labelOf(provider)} API key`
          : `${labelOf(provider)} cần một API key`}
      </div>
      <div className="selection-panel__setup-text">
        {editing
          ? `Dán Bearer key mới để thay thế key cũ. Key mới sẽ ghi đè entry cũ trong \`~/.flowboard/secrets.json\` và bài kiểm tra kết nối sẽ chạy lại với key mới.`
          : `${labelOf(provider)} chỉ dùng API — dán Bearer key từ tài khoản của bạn, chúng tôi sẽ gọi endpoint thay bạn. Key được lưu trong \`~/.flowboard/secrets.json\` (quyền 600) và không bao giờ rời khỏi máy của bạn.`}
      </div>
      <div className="api-key-input">
        <input
          type="password"
          className="api-key-input__field"
          placeholder="sk-…"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setSaved(false);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleSave();
          }}
          autoComplete="off"
          spellCheck={false}
          disabled={saving}
        />
        <button
          type="button"
          className="api-key-input__save"
          onClick={() => void handleSave()}
          disabled={!value.trim() || saving}
        >
          {saving ? "Đang lưu…" : "Lưu khoá"}
        </button>
      </div>
      {error && (
        <div className="selection-panel__error" role="alert">
          {error}
        </div>
      )}
      {saved && !error && (
        <div className="selection-panel__hint" role="status">
          {editing
            ? "✓ Đã cập nhật key — chạy kiểm tra kết nối để xác minh key mới."
            : "✓ Đã lưu key — lần kiểm tra kết nối tiếp theo sẽ xác minh key từ đầu đến cuối."}
        </div>
      )}
      {editing ? (
        <button
          type="button"
          className="selection-panel__setup-btn"
          onClick={() => onCancel?.()}
        >
          Huỷ
        </button>
      ) : (
        <button
          type="button"
          className="selection-panel__setup-btn"
          onClick={() => onShowHelp?.()}
        >
          Hướng dẫn cài đặt →
        </button>
      )}
    </div>
  );
}

// Module-level ref shared with ApiKeyInput so the input can no-op the
// setState after the component unmounts (the parent refreshes + re-
// renders after save, which would otherwise race against in-flight
// state updates).
const aliveRefGlobal = { current: true };

function labelOf(_name: LLMProviderName): string {
  // MiniMax-only build: the union has a single member.
  return "MiniMax";
}
