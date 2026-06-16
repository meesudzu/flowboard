// Static maps for type → label and status → color/icon. Kept in one
// file so adding a new activity type means touching one place. Icons
// (SVG) live in ActivityIcon.tsx; status icons stay as ASCII glyphs
// since they read clean at small sizes.

export const ACTIVITY_TYPE_META: Record<
  string,
  { label: string; group: "llm" | "gen" | "upload" }
> = {
  auto_prompt:       { label: "Tự sinh prompt",         group: "llm" },
  auto_prompt_batch: { label: "Tự sinh prompt (lô)", group: "llm" },
  vision:            { label: "Phân tích ảnh",              group: "llm" },
  planner:           { label: "Lập kế hoạch",             group: "llm" },
  gen_image:         { label: "Tạo ảnh",      group: "gen" },
  gen_video:         { label: "Tạo video",      group: "gen" },
  edit_image:        { label: "Sửa ảnh",          group: "gen" },
  upload:            { label: "Upload (file)",       group: "upload" },
  upload_url:        { label: "Upload (link)",       group: "upload" },
};

// Fallback for unknown types — keeps the UI rendering forward-compat
// when the backend ships a new type before the frontend catches up.
export function metaFor(type: string) {
  return (
    ACTIVITY_TYPE_META[type] ?? { label: type, group: "llm" as const }
  );
}

export const STATUS_META: Record<
  string,
  { icon: string; label: string; tone: "muted" | "đang chạy" | "ok" | "fail" }
> = {
  queued:   { icon: "⋯", label: "đang chờ",   tone: "muted" },
  running:  { icon: "⟳", label: "đang chạy",  tone: "đang chạy" },
  done:     { icon: "✓", label: "xong",     tone: "ok" },
  failed:   { icon: "✗", label: "thất bại",   tone: "fail" },
  // User-initiated cancel — soft, not an error. Muted tone so it
  // doesn't compete visually with real failures.
  canceled: { icon: "⊘", label: "đã huỷ", tone: "muted" },
  // Auto-cancel after the 5-minute video-gen budget elapses. Treated
  // as a soft failure so the badge still pings the user.
  timeout:  { icon: "⏱", label: "hết thời gian",  tone: "fail" },
};

export function statusMeta(status: string) {
  return STATUS_META[status] ?? { icon: "•", label: status, tone: "muted" as const };
}

export function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  if (diff < 0) return "vừa xong";
  const sec = Math.round(diff / 1000);
  if (sec < 5) return "vừa xong";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${min}m ${s}s`;
}
