// Locked prompt template for Storyboard nodes. The node IS an image
// node — it just wraps the user's topic in a deterministic preamble
// so Flow renders a single composite grid that visually narrates the
// topic. Tweak wording here, never inline at the dispatch site.
import type { StoryboardGrid } from "../store/board";

export const STORYBOARD_GRIDS: readonly StoryboardGrid[] = [
  "2x2",
  "2x3",
  "2x4",
] as const;

// Normalise whatever was persisted on a node (incl. legacy "3x3" from
// 1.2.15-1.2.18) into a valid grid. Unknown / legacy → "2x2" (the
// simplest baseline; user can re-pick).
export function normaliseStoryboardGrid(
  value: unknown,
  fallback: StoryboardGrid = "2x2",
): StoryboardGrid {
  return value === "2x2" || value === "2x3" || value === "2x4"
    ? value
    : fallback;
}

export function totalPanels(grid: StoryboardGrid): number {
  return grid === "2x2" ? 4 : grid === "2x3" ? 6 : 8;
}

// Map grid + image aspect ratio → concrete rows × cols. For asymmetric
// grids (2x3, 2x4), the larger dimension follows the longer edge of
// the image so panels remain readable: landscape → wider grid (cols
// = larger), portrait → taller grid (rows = larger). 2x2 is symmetric.
export function resolveStoryboardLayout(
  grid: StoryboardGrid,
  aspectRatio?: string,
): { rows: number; cols: number; total: number } {
  if (grid === "2x2") return { rows: 2, cols: 2, total: 4 };
  const big = grid === "2x3" ? 3 : 4; // total = 6 or 8
  // Flow's aspect-ratio enums look like IMAGE_ASPECT_RATIO_PORTRAIT
  // or VIDEO_ASPECT_RATIO_PORTRAIT — substring match catches both.
  const isPortrait = aspectRatio?.includes("PORTRAIT") ?? false;
  return isPortrait
    ? { rows: big, cols: 2, total: 2 * big }
    : { rows: 2, cols: big, total: 2 * big };
}

export function buildStoryboardPrompt(
  topic: string,
  grid: StoryboardGrid = "2x2",
  aspectRatio?: string,
): string {
  const { rows, cols, total } = resolveStoryboardLayout(grid, aspectRatio);
  const t = topic.trim() || "câu chuyện chưa đặt tên";
  // Verbose template — earlier short version produced overlapping borders
  // (no clear tile separators) and no per-tile captions, so the result
  // read like a montage instead of a storyboard. This version pins the
  // layout, numbering, and caption rules so each tile is self-explanatory
  // at a glance.
  //
  // Intentionally STYLE-NEUTRAL — vocabulary chosen to avoid biasing the
  // model toward illustration/comic medium. We keep the word "storyboard"
  // (it's the user-facing label and a common neutral term) but drop
  // illustration-coded words ("panel", "illustrates", "filled circle",
  // "gutters", "scenes") that pulled Flow toward cartoon output even
  // when source refs were real photos. Tile / shows / margin / number
  // label are medium-agnostic. Only layout / numbering / caption rules
  // remain — those are the actual non-negotiables for a readable grid.
  return [
    `Tạo storyboard trực quan cho "${t}" dưới dạng MỘT ảnh ghép DUY NHẤT`,
    `arranged in a ${rows}x${cols} grid (${rows} rows, ${cols} columns, ${total} tiles total).`,
    `Mỗi ô thể hiện một nhịp của câu chuyện.`,
    `Các ô đọc từ trái sang phải, trên xuống dưới theo thứ tự kể chuyện (1 → ${total}).`,
    `Quy tắc bố cục NGHIÊM NGẶT:`,
    `  • LỀ TRẮNG sạch giữa các ô — không viền chồng, không tràn giữa các ô.`,
    `  • Mỗi ô là hình chữ nhật, kích thước giống nhau, tách bạch rõ ràng với ô kế bên.`,
    `  • Ở góc TRÊN-TRÁI của mỗi ô, đặt nhãn SỐ nhỏ (1, 2, 3, …, ${total}) — dễ đọc và đồng nhất giữa tất cả các ô.`,
    `  • BÊN DƯỚI mỗi ô (ngoài vùng ảnh, trong lề trắng phía dưới), in một CHÚ THÍCH ngắn một câu mô tả hành động của nhịp đó. Dùng chữ rõ ràng, dễ đọc. Chú thích bằng cùng ngôn ngữ với chủ đề.`,
  ].join(" ");
}

// Locked motion prompt for video nodes whose upstream image is a
// Storyboard composite. Forces Flow to animate the panels in order
// (1 → N) rather than re-interpret the composite as one scene.
//   2x2 grid → 4 panels → "frame 1 to frame 4"
//   2x3 grid → 6 panels → "frame 1 to frame 6"
//   2x4 grid → 8 panels → "frame 1 to frame 8"
// Other refs (character / location / visual_asset) still flow into
// the video request alongside the storyboard source — the prompt
// itself is what's locked.
export function buildStoryboardVideoPrompt(
  grid: StoryboardGrid = "2x2",
): string {
  const lastFrame = totalPanels(grid);
  return `Một trailer phim hoạt hình điện ảnh 10 giây theo tiến trình kể chuyện từ chính xác khung hình 1 đến khung hình ${lastFrame} của ảnh tham chiếu`;
}
