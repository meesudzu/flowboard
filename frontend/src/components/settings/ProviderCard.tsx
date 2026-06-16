import type { LLMProviderInfo, LLMProviderName } from "../../api/client";

/**
 * One provider card — clickable tile that shows provider identity +
 * connection status + selection state. Used in the AI Providers section
 * inside the Settings dialog.
 *
 * MiniMax-only build: this card always renders the MiniMax row. The
 * CLI provider cards (Claude / Gemini / OpenAI Codex) were dropped —
 * the cloud-VPS image doesn't bundle any of their CLIs, so showing
 * "CLI not installed" rows would just be visual noise.
 *
 * Visual contract:
 *   - Logo dot + name on the left, status badge below
 *   - Right-edge indicator: filled when this card is the user's
 *     pending selection, hollow when not
 *   - Active border when selected; muted border otherwise
 *   - "Setup needed" or "API key needed" badge when the key isn't set
 *     (clicking still selects so the panel below can guide the user
 *     through pasting the key).
 */

interface ProviderCardProps {
  provider: LLMProviderInfo;
  /** True when this card is the user's pending selection (highlighted). */
  selected: boolean;
  /** True when this card matches the currently-applied config (badge). */
  current: boolean;
  /** Click handler — flips selection. Always fires; the section above
   * decides whether to render setup guidance vs. test flow. */
  onSelect(name: LLMProviderName): void;
}

const PROVIDER_META: Record<
  LLMProviderName,
  { name: string; tagline: string }
> = {
  minimax: { name: "MiniMax", tagline: "Cloud API · Bearer key" },
};

function statusLabel(p: LLMProviderInfo): string {
  if (p.available && p.configured) return "Đã kết nối";
  if (p.requiresKey && !p.configured) return "Cần API key";
  return "Cần cài đặt";
}

function statusKind(p: LLMProviderInfo): "ok" | "warn" {
  return p.available && p.configured ? "ok" : "warn";
}

export function ProviderCard({ provider, selected, current, onSelect }: ProviderCardProps) {
  const meta = PROVIDER_META[provider.name];
  const kind = statusKind(provider);

  return (
    <button
      type="button"
      className={`provider-card${selected ? " provider-card--selected" : ""}${
        kind === "warn" ? " provider-card--unconfigured" : ""
      }`}
      onClick={() => onSelect(provider.name)}
      aria-pressed={selected}
    >
      <div className="provider-card__head">
        <span className="provider-card__name">{meta.name}</span>
        <span className="provider-card__tagline">{meta.tagline}</span>
      </div>
      <div className="provider-card__foot">
        <span className={`provider-card__status provider-card__status--${kind}`}>
          <span className="provider-card__status-dot" aria-hidden="true">●</span>
          {statusLabel(provider)}
        </span>
        {current && !selected && (
          <span className="provider-card__current-badge">Đang dùng</span>
        )}
      </div>
      <span
        className={`provider-card__radio${selected ? " provider-card__radio--on" : ""}`}
        aria-hidden="true"
      />
    </button>
  );
}
