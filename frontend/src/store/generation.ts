import { create } from "zustand";
import {
  ensureBoardProject,
  createRequest,
  getRequest,
  getActivityList,
  patchNode,
} from "../api/client";
import { useBoardStore } from "./board";
import { useSettingsStore } from "./settings";

type PollEntry = { requestId: number; timerId: ReturnType<typeof setTimeout> | null };

interface GenerationState {
  active: Record<string, PollEntry>;
  openDialog: { rfId: string | null; prompt: string };
  openViewer: { rfId: string | null; idx: number };
  projectId: string | null;
  // Auto-detected from Flow's createProject response — used as the
  // default tier for every dispatch so the UI no longer needs to ask.
  // Null until the first successful project bootstrap.
  paygateTier: "PAYGATE_TIER_ONE" | "PAYGATE_TIER_TWO" | null;
  error: string | null;

  openGenerationDialog(rfId: string, prompt: string): void;
  closeGenerationDialog(): void;
  openResultViewer(rfId: string, idx?: number): void;
  closeResultViewer(): void;

  ensureProjectId(): Promise<string | null>;

  dispatchGeneration(
    rfId: string,
    opts: {
      prompt: string;
      aspectRatio?: string;
      paygateTier?: string;
      kind?: "image" | "video";
      sourceMediaId?: string;
      // Multi-source-image i2v: when the upstream image has N variants
      // we generate one video per variant. Backend sends N items in the
      // batchAsyncGenerate body so all are dispatched together.
      sourceMediaIds?: string[];
      variantCount?: number;
      // Per-variant prompts. When provided, each variant uses its own
      // prompt — required for batch auto-prompt to keep poses distinct
      // across the 4 generated images.
      prompts?: string[];
    },
  ): Promise<void>;

  refineImage(
    rfId: string,
    opts: { prompt: string; refMediaIds?: string[]; aspectRatio?: string },
  ): Promise<void>;

  cancelGeneration(rfId: string): void;
  clearError(): void;

  // Re-attach poll loops for in-flight requests on page load.
  // Fetches Request rows with status in (queued, running), maps each
  // to a node by node_id, and resumes the same poll state machine the
  // dispatch path uses. Without this a page reload wipes the in-memory
  // `active` map and the affected node falls back to whatever status
  // was last persisted on the board (typically "idle" for a never-rendered
  // node, never "running") — leaving the user staring at a card that
  // looks idle while the backend is still rendering.
  rehydrateRunningPolls(): Promise<void>;
}

// Walk the board to collect mediaIds of every upstream media-bearing node
// (character / image / visual_asset) feeding into this image-target node.
// All of these are passed to Flow as IMAGE_INPUT_TYPE_REFERENCE inputs so the
// new image is composed from them.
//
// Per-edge variant pinning: each edge from a multi-variant source
// remembers exactly WHICH variant feeds the downstream — stored on
// `edge.data.sourceVariantIdx`. Resolution rules per edge:
//   1. If the edge has a pinned `sourceVariantIdx` AND the source has
//      a `mediaIds[idx]` entry there → use it.
//   2. Else if the source has an active `mediaId` → use it
//      (single-variant case; or multi-variant where the user hasn't
//      pinned yet — variant 0 is the natural default).
//   3. Else if the source has a non-empty `mediaIds[]` → use index 0.
// One ref per edge means one Flow API call regardless of how many
// variants the upstream has — the user picks which variant feeds
// which downstream by clicking the variant tile (Stage 2 UX).
const REF_SOURCE_TYPES = new Set(["character", "image", "visual_asset", "Storyboard"]);

function collectUpstreamRefMediaIds(targetRfId: string): string[] {
  const { nodes, edges } = useBoardStore.getState();
  const ids: string[] = [];
  for (const e of edges) {
    if (e.target !== targetRfId) continue;
    const src = nodes.find((n) => n.id === e.source);
    if (!src || !REF_SOURCE_TYPES.has(src.data.type)) continue;

    const variants = Array.isArray(src.data.mediaIds) ? src.data.mediaIds : [];
    const pinned = (e.data?.sourceVariantIdx ?? null) as number | null;

    let chosen: string | null = null;
    if (
      pinned !== null
      && pinned >= 0
      && pinned < variants.length
      && typeof variants[pinned] === "string"
      && variants[pinned]
    ) {
      chosen = variants[pinned] as string;
    } else if (typeof src.data.mediaId === "string" && src.data.mediaId) {
      chosen = src.data.mediaId;
    } else if (variants.length > 0 && typeof variants[0] === "string" && variants[0]) {
      chosen = variants[0] as string;
    }

    if (chosen) ids.push(chosen);
  }
  return ids;
}

export const useGenerationStore = create<GenerationState>((set, get) => ({
  active: {},
  openDialog: { rfId: null, prompt: "" },
  openViewer: { rfId: null, idx: 0 },
  projectId: null,
  paygateTier: null,
  error: null,

  openGenerationDialog(rfId, prompt) {
    set({ openDialog: { rfId, prompt } });
  },

  closeGenerationDialog() {
    set({ openDialog: { rfId: null, prompt: "" } });
  },

  openResultViewer(rfId, idx = 0) {
    set({ openViewer: { rfId, idx } });
  },

  closeResultViewer() {
    set({ openViewer: { rfId: null, idx: 0 } });
  },

  async ensureProjectId() {
    const cached = get().projectId;
    if (cached !== null) return cached;
    const boardId = useBoardStore.getState().boardId;
    if (boardId === null) {
      set({ error: "chưa load bảng vẽ" });
      return null;
    }
    try {
      const proj = await ensureBoardProject(boardId);
      set({ projectId: proj.flow_project_id });
      return proj.flow_project_id;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  async dispatchGeneration(rfId, opts: {
    prompt: string;
    aspectRatio?: string;
    paygateTier?: string;
    kind?: "image" | "video";
    sourceMediaId?: string;
    sourceMediaIds?: string[];
    variantCount?: number;
    prompts?: string[];
  }) {
    const projectId = await get().ensureProjectId();
    if (projectId === null) return;

    // Pre-flight: refuse to dispatch if the paygate tier is unknown.
    // The backend would reject with `paygate_tier_unknown` anyway (since
    // Phase 1 stopped silently defaulting to Pro), but bailing here gives
    // the user a clearer hint without spending a captcha round-trip and
    // without leaving a `failed` request row in the DB. The
    // AccountPanel's "Tier unknown — Open Flow" banner is the recovery
    // path.
    const knownTier = opts.paygateTier ?? get().paygateTier;
    if (!knownTier) {
      set({
        error: "Mở Flow một lần để tiện ích nhận diện gói của bạn, rồi thử lại. (Xem banner Tier-unknown ở góc dưới bên trái.)",
      });
      useBoardStore.getState().updateNodeData(rfId, {
        status: "error",
        error: "paygate_tier_unknown",
      });
      return;
    }

    // Cancel existing poll for this node if any
    const existingEntry = get().active[rfId];
    if (existingEntry && existingEntry.timerId !== null) {
      clearTimeout(existingEntry.timerId);
    }

    // Optimistically update node — record variantCount so the placeholder
    // grid matches the eventual variant count even before generation finishes.
    const variantCount = Math.max(1, Math.min(opts.variantCount ?? 1, 4));
    useBoardStore.getState().updateNodeData(rfId, {
      status: "queued",
      prompt: opts.prompt,
      error: undefined,
      variantCount,
      mediaIds: undefined,
      mediaId: undefined,
    });

    // Create request
    const kind = opts.kind ?? "image";
    let reqDto;
    try {
      const nodeDbId = parseInt(rfId, 10);
      if (kind === "video") {
        const settings = useSettingsStore.getState();
        const isOmni = settings.videoModel === "omni_flash";

        // Omni Flash takes a fundamentally different input shape from
        // Veo i2v. Veo wants ONE source image to use as the literal
        // start frame (multi-source = batch of N parallel i2v calls,
        // one per variant). Omni Flash takes "ingredients" — a list of
        // referenceImages[] where each entry is IMAGE_USAGE_TYPE_ASSET.
        // The model conditions on the assets but doesn't use any of
        // them as a literal frame. So we walk EVERY upstream image-
        // bearing edge (character / image / visual_asset / Storyboard)
        // and pass them all, not just the one edge the i2v UI picked.
        if (isOmni) {
          const ingredients = collectUpstreamRefMediaIds(rfId);
          if (ingredients.length === 0) {
            useBoardStore.getState().updateNodeData(rfId, {
              status: "error",
              error: "chưa có nguyên liệu",
            });
            set({
              error:
                "Omni Flash cần ít nhất một nguyên liệu (kết nối một Character/Image/Visual asset phía trên).",
            });
            return;
          }
          reqDto = await createRequest({
            type: "gen_video_omni",
            node_id: isNaN(nodeDbId) ? undefined : nodeDbId,
            params: {
              prompt: opts.prompt,
              project_id: projectId,
              ref_media_ids: ingredients,
              duration_s: settings.omniFlashDuration,
              aspect_ratio:
                opts.aspectRatio ?? "VIDEO_ASPECT_RATIO_PORTRAIT",
              paygate_tier:
                opts.paygateTier ?? get().paygateTier ?? "PAYGATE_TIER_ONE",
            },
          });
        } else {
          // Veo i2v path — still validates "must have a single source
          // image / variant batch" because that's the model's input
          // contract. Omni's ingredient validation above runs first
          // when isOmni; this check only fires for the Veo branch.
          const hasMulti =
            Array.isArray(opts.sourceMediaIds) && opts.sourceMediaIds.length > 0;
          if (!hasMulti && !opts.sourceMediaId) {
            useBoardStore.getState().updateNodeData(rfId, { status: "error", error: "chưa có media nguồn" });
            set({ error: "Veo i2v cần một ảnh nguồn (kết nối một ô ảnh phía trên)" });
            return;
          }
          const videoParams: Record<string, unknown> = {
            prompt: opts.prompt,
            project_id: projectId,
            aspect_ratio: opts.aspectRatio ?? "VIDEO_ASPECT_RATIO_LANDSCAPE",
            // Tier precedence: explicit caller arg > auto-detected from
            // Flow > TIER_ONE fallback. The dialog no longer asks the user.
            paygate_tier:
              opts.paygateTier ?? get().paygateTier ?? "PAYGATE_TIER_ONE",
            // Backend resolves [tier][quality][aspect] → Flow model key.
            video_quality: settings.videoQuality,
          };
          if (hasMulti) {
            videoParams.start_media_ids = opts.sourceMediaIds;
          } else {
            videoParams.start_media_id = opts.sourceMediaId;
          }
          reqDto = await createRequest({
            type: "gen_video",
            node_id: isNaN(nodeDbId) ? undefined : nodeDbId,
            params: videoParams,
          });
        }
      } else {
        const refMediaIds = collectUpstreamRefMediaIds(rfId);
        const params: Record<string, unknown> = {
          prompt: opts.prompt,
          project_id: projectId,
          aspect_ratio: opts.aspectRatio ?? "IMAGE_ASPECT_RATIO_LANDSCAPE",
          paygate_tier:
            opts.paygateTier ?? get().paygateTier ?? "PAYGATE_TIER_ONE",
          variant_count: variantCount,
          // User's image model preference from the Settings panel.
          // Backend resolves the nickname → real Flow model identifier.
          image_model: useSettingsStore.getState().imageModel,
        };
        if (refMediaIds.length > 0) {
          params.ref_media_ids = refMediaIds;
        }
        // Per-variant prompts: when present, each variant uses its own
        // text instead of all sharing `params.prompt`. Backend falls back
        // to single prompt when missing/short.
        if (opts.prompts && opts.prompts.length > 0) {
          params.prompts = opts.prompts;
        }
        reqDto = await createRequest({
          type: "gen_image",
          node_id: isNaN(nodeDbId) ? undefined : nodeDbId,
          params,
        });
      }
    } catch (err) {
      useBoardStore.getState().updateNodeData(rfId, { status: "error", error: err instanceof Error ? err.message : "yêu cầu thất bại" });
      set({ error: err instanceof Error ? err.message : "Tạo thất bại" });
      return;
    }

    // Hand the loop off to the shared helper so the dispatch path and
    // the boot-time rehydration path share the same Request → node
    // state machine. The inline scheduleNextPoll closure used to live
    // here; factored out to `scheduleGenerationPoll` at the bottom of
    // this module so `rehydrateRunningPolls` can call it without the
    // dispatch opts.
    const requestId = reqDto.id;
    set((s) => ({
      active: {
        ...s.active,
        [rfId]: { requestId, timerId: null },
      },
    }));
    scheduleGenerationPoll(rfId, requestId);
  },

  async refineImage(rfId, opts) {
    const projectId = await get().ensureProjectId();
    if (projectId === null) return;

    const node = useBoardStore.getState().nodes.find((n) => n.id === rfId);
    const sourceMediaId = node?.data.mediaId;
    if (!sourceMediaId) {
      set({ error: "chưa có ảnh nguồn để tinh chỉnh" });
      return;
    }

    const existing = get().active[rfId];
    if (existing && existing.timerId !== null) clearTimeout(existing.timerId);

    useBoardStore.getState().updateNodeData(rfId, {
      status: "queued",
      prompt: opts.prompt,
      error: undefined,
      variantCount: 1,
      mediaIds: undefined,
    });

    const nodeDbId = parseInt(rfId, 10);
    let reqDto;
    try {
      reqDto = await createRequest({
        type: "edit_image",
        node_id: isNaN(nodeDbId) ? undefined : nodeDbId,
        params: {
          prompt: opts.prompt,
          project_id: projectId,
          source_media_id: sourceMediaId,
          ref_media_ids: opts.refMediaIds ?? [],
          aspect_ratio: opts.aspectRatio ?? "IMAGE_ASPECT_RATIO_LANDSCAPE",
          paygate_tier: get().paygateTier ?? "PAYGATE_TIER_ONE",
          image_model: useSettingsStore.getState().imageModel,
        },
      });
    } catch (err) {
      useBoardStore.getState().updateNodeData(rfId, {
        status: "error",
        error: err instanceof Error ? err.message : "tinh chỉnh thất bại",
      });
      set({ error: err instanceof Error ? err.message : "tinh chỉnh thất bại" });
      return;
    }

    // Same shared poll loop as the dispatch path — see
    // `scheduleGenerationPoll` at the bottom of this module. The
    // request row carries prompt/aspectRatio in `params` so the
    // rehydrated result stamp survives a reload without us needing
    // the original `opts` closure.
    const requestId = reqDto.id;
    set((s) => ({
      active: { ...s.active, [rfId]: { requestId, timerId: null } },
    }));
    scheduleGenerationPoll(rfId, requestId);
  },

  cancelGeneration(rfId) {
    const entry = get().active[rfId];
    if (entry && entry.timerId !== null) {
      clearTimeout(entry.timerId);
    }
    set((s) => {
      const next = { ...s.active };
      delete next[rfId];
      return { active: next };
    });
  },

  async rehydrateRunningPolls() {
    // Walk the Request table for any in-flight work the in-memory
    // `active` map lost when the page reloaded. For each, find the
    // matching node on the current board and resume the same poll
    // state machine `dispatchGeneration` uses.
    //
    // `type` is restricted to the request types the generation store
    // knows how to poll — the worker also has a few LLM-driven types
    // (auto_prompt, vision, etc.) that don't drive a node card, so we
    // filter them out at the source rather than carrying dead
    // `requestId`s in `active` that no node maps to.
    const POLLED_TYPES = ["gen_image", "gen_video", "gen_video_omni", "edit_image"];
    let items: { id: number; node_id: number | null }[];
    try {
      const res = await getActivityList({
        status: ["queued", "running"],
        type: POLLED_TYPES,
        limit: 200,
      });
      items = res.items;
    } catch {
      // Network blip on boot — the user will see the activity bell
      // update on the next poll cycle; nothing to do here.
      return;
    }
    if (items.length === 0) return;

    const knownRfIds = new Set(useBoardStore.getState().nodes.map((n) => n.id));
    for (const it of items) {
      if (it.node_id == null) continue;
      const rfId = String(it.node_id);
      // If the node was deleted from the board while the request was
      // in flight, the worker still finishes the row — we just don't
      // surface it. The user removed the node, the variant was a
      // casualty of that decision.
      if (!knownRfIds.has(rfId)) continue;
      // Don't double-attach if a poll for this node is somehow already
      // alive (e.g. two App instances racing the boot).
      if (get().active[rfId] !== undefined) continue;
      // Optimistic UI: flip the node to "running" immediately so the
      // user sees the spinner the moment the board renders, rather
      // than after the first 1.5s poll tick.
      useBoardStore.getState().updateNodeData(rfId, { status: "running" });
      set((s) => ({
        active: { ...s.active, [rfId]: { requestId: it.id, timerId: null } },
      }));
      scheduleGenerationPoll(rfId, it.id);
    }
  },

  clearError() {
    set({ error: null });
  },
}));

// `scheduleGenerationPoll` is a free function so the rehydration path
// can call it without going through dispatchGeneration. It owns the
// Request → node state-machine: running/queued → reschedule, done →
// stamp node + patch backend, failed/timeout → node error,
// canceled → node idle, network error → retry with cap.
//
// All stamp-side-effects (model name, aspect ratio, partial-error
// summary, slot_errors, prompt) read from `req.params` / `req.result`
// so this works for both fresh dispatches (where the caller already
// updated the in-memory node) AND rehydrated polls (where the only
// source of truth is the Request row the backend is still mutating).
//
// We deliberately do NOT take the original `opts.prompt` /
// `opts.aspectRatio` here — those were captured by the dispatch
// closure and are lost on reload, but they're also persisted in
// `req.params` by the request row so re-reading them is correct.
function scheduleGenerationPoll(rfId: string, requestId: number) {
  const MAX_NETWORK_RETRIES = 8;
  let networkRetries = 0;

  function tick() {
    if (useGenerationStore.getState().active[rfId] === undefined) return;
    const t = setTimeout(async () => {
      if (useGenerationStore.getState().active[rfId] === undefined) return;
      try {
        const req = await getRequest(requestId);
        networkRetries = 0;
        if (req.status === "running" || req.status === "queued") {
          useBoardStore
            .getState()
            .updateNodeData(rfId, { status: req.status });
          useGenerationStore.setState((s) => ({
            active: { ...s.active, [rfId]: { requestId, timerId: null } },
          }));
          tick();
          return;
        }
        if (req.status === "done") {
          // `media_ids` may contain `null` placeholders for variants
          // the backend marked as partial-failures. Keep positional
          // alignment so the frontend can map slot i ↔ upstream
          // variant i, but pick the first non-null entry as the
          // "primary" mediaId for legacy single-tile UI consumers.
          const mediaIds = (req.result["media_ids"] as (string | null)[] | undefined) ?? [];
          const mediaId = mediaIds.find(
            (m): m is string => typeof m === "string" && m.length > 0,
          );
          const partialError = (req.result["partial_error"] as string | undefined) ?? null;
          const slotErrors =
            (req.result["slot_errors"] as (string | null)[] | undefined) ?? null;
          // Model is read from req.params (what was dispatched) so the
          // stamp survives a reload — the in-memory `opts` from
          // dispatchGeneration isn't available here.
          const stampedImageModel =
            req.type === "gen_image"
              ? (req.params["image_model"] as string | undefined)
              : undefined;
          let stampedVideoQuality: string | undefined;
          if (req.type === "gen_video") {
            stampedVideoQuality = req.params["video_quality"] as
              | string
              | undefined;
          } else if (req.type === "gen_video_omni") {
            const d = req.params["duration_s"] as number | undefined;
            if (d === 4 || d === 6 || d === 8 || d === 10) {
              stampedVideoQuality = `abra_r2v_${d}s`;
            }
          }
          // Aspect ratio also lives on req.params (backend echoes what
          // was dispatched) — falling back keeps the result stamp
          // honest across reloads even if the dispatch closure's
          // `opts.aspectRatio` is gone.
          const aspectRatio = (req.params["aspect_ratio"] as string | undefined) ?? undefined;
          // Prompt the same way: backend stored what the user asked
          // for, so rehydrate from there rather than the in-memory
          // dispatch closure.
          const prompt = (req.params["prompt"] as string | undefined) ?? undefined;
          useBoardStore.getState().updateNodeData(rfId, {
            status: "done",
            mediaId,
            mediaIds,
            slotErrors: slotErrors ?? undefined,
            aiBrief: undefined,
            aspectRatio,
            renderedAt: new Date().toISOString(),
            error: partialError ?? undefined,
            ...(prompt ? { prompt } : {}),
            ...(stampedImageModel ? { imageModel: stampedImageModel } : {}),
            ...(stampedVideoQuality ? { videoQuality: stampedVideoQuality } : {}),
          });
          const dbId = parseInt(rfId, 10);
          if (!isNaN(dbId) && mediaId) {
            const n = useBoardStore.getState().nodes.find((x) => x.id === rfId);
            const d = n?.data;
            patchNode(dbId, {
              status: "done",
              data: {
                prompt: prompt ?? null,
                mediaId,
                mediaIds,
                slotErrors: slotErrors ?? null,
                variantCount: d?.variantCount ?? mediaIds.length,
                aiBrief: null,
                aspectRatio: aspectRatio ?? null,
                renderedAt: new Date().toISOString(),
                error: partialError ?? null,
                ...(stampedImageModel ? { imageModel: stampedImageModel } : {}),
                ...(stampedVideoQuality ? { videoQuality: stampedVideoQuality } : {}),
              },
            }).catch(() => {});
          }
          useGenerationStore.setState((s) => {
            const next = { ...s.active };
            delete next[rfId];
            return { active: next };
          });
          return;
        }
        if (req.status === "failed" || req.status === "timeout") {
          // 'timeout' is the dedicated terminal state for the
          // 5-minute video-gen budget. We render it as a node error
          // so the card visually flags the stuck run, but tag the
          // message so the user can tell auto-timeout apart from a
          // generation failure.
          const errMsg =
            req.status === "timeout"
              ? `Timed out after 5 minutes (${req.error ?? "video_timeout"})`
              : (req.error ?? "unknown");
          useBoardStore
            .getState()
            .updateNodeData(rfId, { status: "error", error: errMsg });
          useGenerationStore.setState((s) => {
            const next = { ...s.active };
            delete next[rfId];
            return { active: next, error: errMsg };
          });
          return;
        }
        if (req.status === "canceled") {
          useBoardStore.getState().updateNodeData(rfId, { status: "idle" });
          useGenerationStore.setState((s) => {
            const next = { ...s.active };
            delete next[rfId];
            return { active: next };
          });
          return;
        }
      } catch (err) {
        networkRetries += 1;
        if (networkRetries >= MAX_NETWORK_RETRIES) {
          const msg = err instanceof Error ? err.message : "network error";
          useBoardStore
            .getState()
            .updateNodeData(rfId, { status: "error", error: msg });
          useGenerationStore.setState((s) => {
            const next = { ...s.active };
            delete next[rfId];
            return { active: next, error: `Generation poll failed: ${msg}` };
          });
          return;
        }
        tick();
      }
    }, 1500);
    useGenerationStore.setState((s) => ({
      active: { ...s.active, [rfId]: { requestId, timerId: t } },
    }));
  }
  tick();
}
